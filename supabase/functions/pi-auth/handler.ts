import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { requireChallenge, validateIdentity, requireOwner, validSecret, internalEmail, publicUser, consumeChallenge } from '../_shared/pi-auth-policy.mjs';
const env=(n:string)=>Deno.env.get(n)||'';
const enc=new TextEncoder();
const hex=(a:ArrayBuffer)=>Array.from(new Uint8Array(a),b=>b.toString(16).padStart(2,'0')).join('');
const random=()=>hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
const hash=async(s:string)=>hex(await crypto.subtle.digest('SHA-256',enc.encode(s)));
async function mac(s:string){const key=await crypto.subtle.importKey('raw',enc.encode(env('PI_AUTH_IDENTITY_SECRET')),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',key,enc.encode(s)));}
function fail(s:string):never { throw new Error(s); }
export async function handlePiAuth(req: Request): Promise<Response> {
 const origin=env('PI_AUTH_WEB_ORIGIN');
 const headers={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin'};
 let stage='request';
 const reply=(data:unknown,status=200)=>new Response(JSON.stringify({...data as Record<string,unknown>,server_now:new Date().toISOString()}),{status,headers});
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return reply({error:'method_not_allowed'},405);
 try {
  if(!/^https:\/\/[^/]+$/.test(origin) || env('PI_AUTH_IDENTITY_SECRET').length<32 || !env('PI_AUTH_APP_ID') || !['testnet','mainnet'].includes(env('PI_AUTH_NETWORK')))fail('not_configured');
  if(req.headers.get('Origin') && req.headers.get('Origin')!==origin)fail('unauthorized');
  const raw=await req.text();if(raw.length>16000)fail('invalid_request');
  const b=JSON.parse(raw);if(!b || typeof b!=='object')fail('invalid_request');
  const db=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
  const client=()=>createClient(env('SUPABASE_URL'),env('SUPABASE_ANON_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
  const ns=env('PI_AUTH_APP_ID')+':'+env('PI_AUTH_NETWORK');
  const rpc=async(name:string,args:Record<string,unknown>)=>{const r=await db.rpc(name,args);if(r.error)throw r.error;return r.data};
  const rate=async(key:string,limit:number,seconds:number)=>{if(!await rpc('pi_auth_rate',{p_bucket:await hash(ns+':'+key),p_limit:limit,p_seconds:seconds}))fail('rate_limited')};
  const auth=async()=>{const token=(req.headers.get('Authorization')||'').replace(/^Bearer /i,'');const r=await db.auth.getUser(token);if(r.error||!r.data.user)fail('unauthorized');return r.data.user!};
  // Account linking requires a valid authenticated session, regardless of sign-in age.
  const identity=async(userId:string)=>{const r=await db.from('pi_account_identities').select('*').eq('app_namespace',ns).eq('user_id',userId).maybeSingle();if(r.error)throw r.error;return r.data};
  const mintSession=async(userId:string,username:string)=>{
   const got=await db.auth.admin.getUserById(userId);if(got.error||!got.data.user?.email)fail('account_unavailable');
   stage='session_link';
   const generated=await db.auth.admin.generateLink({type:'magiclink',email:got.data.user.email});
   if(generated.error||generated.data.user?.id!==userId||!generated.data.properties?.hashed_token)fail('session_failed');
   stage='session_verify';
   const verified=await client().auth.verifyOtp({token_hash:generated.data.properties.hashed_token,type:'magiclink'});
   if(verified.error||!verified.data.session||verified.data.user?.id!==userId)fail('session_failed');
   return {state:'signed_in',access_token:verified.data.session.access_token,refresh_token:verified.data.session.refresh_token,user:publicUser(verified.data.user,username)};
  };
  const challenge=async(kind:'browser'|'device',allowConsumed=false)=>{
   const secret=b[kind+'_secret'];if(!validSecret(secret))fail('invalid_request');
   const digest=await hash(secret);await rate(kind+':'+digest,180,300);
   const r=await db.from('pi_login_challenges').select('*').eq(kind+'_hash',digest).eq('app_namespace',ns).maybeSingle();if(r.error)throw r.error;
   if(allowConsumed && r.data?.state==='consumed' && Date.parse(r.data.expires_at)>Date.now())return r.data;
   return requireChallenge(r.data);
  };
  const cas=async(row:any,from:string,to:string,extra:Record<string,unknown>={})=>{
   const r=await db.from('pi_login_challenges').update({state:to,...extra}).eq('id',row.id).eq('state',from).gt('expires_at',new Date().toISOString()).select('id').maybeSingle();
   if(r.error)throw r.error;if(!r.data)fail('expired');
  };
  if(b.action==='start'){
   if(!['login','link'].includes(b.purpose))fail('invalid_request');
   const u=b.purpose==='link'?await auth():null;
   // Gateway IP is only a supplementary abuse limit, never an identity credential.
   await rate('start:'+(req.headers.get('x-forwarded-for')||'unknown'),30,600);
   if(u){await rate('link:'+u.id,10,600);if(await identity(u.id))fail('identity_conflict')}
   const browser=random(),device=random();const code=crypto.getRandomValues(new Uint32Array(1))[0].toString(16).toUpperCase().padStart(8,'0');
   const r=await db.from('pi_login_challenges').insert({browser_hash:await hash(browser),device_hash:await hash(device),purpose:b.purpose,owner_id:u?.id||null,app_namespace:ns,display_code:code}).select('expires_at').single();if(r.error)throw r.error;
   // Bounded opportunistic cleanup. No credentials are ever stored in these rows.
   await db.from('pi_login_challenges').delete().lt('expires_at',new Date(Date.now()-86400000).toISOString());
   await db.from('pi_auth_limits').delete().lt('expires_at',new Date(Date.now()-86400000).toISOString());
   return reply({device_secret:device,url:origin+'/pi-login.html#'+browser,code,expires_at:r.data.expires_at});
  }
  if(b.action==='inspect'){
   const c=await challenge('browser',true);return reply({challenge_id:c.id,purpose:c.purpose,code:c.display_code,expires_at:c.expires_at,state:c.state,username:['approved','consumed'].includes(c.state)?c.pi_username:null});
  }
  if(b.action==='browser_session'){
   const c=await challenge('browser',true);
   if(!['login','link'].includes(c.purpose))fail('invalid_request');
   // Pi Browser approval alone never grants browser account access. Both login and
   // link flows wait until desktop redeem atomically changes the challenge to consumed.
   if(c.state!=='consumed')return reply({state:'waiting_for_desktop',expires_at:c.expires_at});
   const found=await db.from('pi_account_identities').select('user_id').eq('app_namespace',ns).eq('pi_uid',c.pi_uid).maybeSingle();
   if(found.error)throw found.error;
   let userId:string|null=null;
   if(c.purpose==='login') userId=found.data?.user_id||null;
   else if(c.owner_id && found.data?.user_id===c.owner_id) userId=c.owner_id;
   // For linking, the new Pi identity must be bound to the exact desktop owner.
   // A transient delay between challenge consumption and binding remains a wait state.
   if(!userId)return reply({state:'waiting_for_desktop',expires_at:c.expires_at});
   // The browser secret is a short-lived capability. Permit a small number of
   // retries after the first claim so a lost HTTP response does not strand the
   // user after the desktop has already confirmed this challenge.
   await rate('browser-session:'+await hash(ns+':'+b.browser_secret),5,300);
   if(c.browser_session_issued_at) return reply(await mintSession(userId,c.pi_username));
   const claimedAt=new Date().toISOString();
   const claim=await db.from('pi_login_challenges').update({browser_session_issued_at:claimedAt})
    .eq('id',c.id).eq('state','consumed').is('browser_session_issued_at',null)
    .gt('expires_at',new Date().toISOString()).select('id').maybeSingle();
   if(claim.error)throw claim.error;
   if(!claim.data) {
    // A concurrent request may have won the claim. Re-read before deciding;
    // the same browser capability may recover the session, but never before
    // the desktop has consumed the challenge and the Pi identity is bound.
    const latest=await db.from('pi_login_challenges').select('browser_session_issued_at')
     .eq('id',c.id).eq('state','consumed').gt('expires_at',new Date().toISOString()).maybeSingle();
    if(latest.error)throw latest.error;
    if(!latest.data?.browser_session_issued_at)fail('expired');
    return reply(await mintSession(userId,c.pi_username));
   }
   try {
    return reply(await mintSession(userId,c.pi_username));
   } catch(error) {
    // A transient Auth-provider failure may be retried while this challenge is still alive.
    const reset=await db.from('pi_login_challenges').update({browser_session_issued_at:null})
     .eq('id',c.id).eq('browser_session_issued_at',claimedAt);
    if(reset.error)console.warn(JSON.stringify({event:'pi_browser_session_claim_reset_failed'}));
    throw error;
   }
  }
  if(b.action==='approve'){
   const c=await challenge('browser');if(c.state!=='pending')fail('expired');
   if(typeof b.pi_token!=='string'||b.pi_token.length>8192)fail('invalid_request');
   const res=await fetch('https://api.minepi.com/v2/me',{headers:{Authorization:'Bearer '+b.pi_token},signal:AbortSignal.timeout(15000)});
   if(!res.ok)fail('pi_verification_failed');const me=validateIdentity(await res.json());
   // Only an approval received before the original expiry may extend the deadline.
   // Give the desktop two minutes to observe/confirm it; repeated approvals cannot extend it.
   const confirmedUntil=new Date(Date.now()+120000).toISOString();
   await cas(c,'pending','approved',{pi_uid:me.uid,pi_username:me.username,expires_at:confirmedUntil});
   return reply({state:'approved',username:me.username,expires_at:confirmedUntil});
  }
  if(b.action==='poll'||b.action==='cancel'||b.action==='redeem'){
   const c=await challenge('device');const u=c.purpose==='link'?await auth():null;requireOwner(c,u?.id);
   if(b.action==='cancel'){await cas(c,c.state,'cancelled');return reply({state:'cancelled'})}
   if(b.action==='poll'){
    let next_action='sign_in';
    if(c.state==='approved'){
     if(c.purpose==='link')next_action='link';
     else{
      const known=await db.from('pi_account_identities').select('user_id').eq('app_namespace',ns).eq('pi_uid',c.pi_uid).maybeSingle();if(known.error)throw known.error;
      next_action=known.data?'sign_in':'sign_up';
     }
    }
    return reply({state:c.state,username:c.state==='approved'?c.pi_username:null,next_action,expires_at:c.expires_at});
   }
   // Atomic single-use consume BEFORE minting any Auth session. Lost replies require a new flow.
   await consumeChallenge(c,u?.id,b.confirm,()=>cas(c,'approved','consumed',{
    // Give the already-approved browser one bounded window to claim its independent website session.
    expires_at:new Date(Date.now()+120000).toISOString()
   }));
   const found=await db.from('pi_account_identities').select('*').eq('app_namespace',ns).eq('pi_uid',c.pi_uid).maybeSingle();if(found.error)throw found.error;
   if(c.purpose==='link'){
    if(found.data && found.data.user_id!==u!.id)fail('identity_conflict');
    await rpc('pi_auth_bind',{p_namespace:ns,p_uid:c.pi_uid,p_user:u!.id,p_username:c.pi_username});
    return reply({state:'linked',user:publicUser(u!,c.pi_username)});
   }
   let userId=found.data?.user_id;
   if(!userId){
    // Internal routing address: not collected from the user, no mailbox and no chosen password.
    const email=await mac('pi-user:'+ns+':'+c.pi_uid)+'@pi-auth.invalid';
    userId=await rpc('pi_auth_internal_user',{p_email:email});
    if(!userId){
     stage='create_user';
     // Supabase bcrypt limit is 72 UTF-8 bytes. Keep 256 random bits plus required character classes.
     const made=await db.auth.admin.createUser({email,email_confirm:true,password:'Aa1!'+random(),app_metadata:{pi_internal:true}});
     userId=made.data.user?.id;
     if(!userId)userId=await rpc('pi_auth_internal_user',{p_email:email});
     if(!userId){
      console.warn(JSON.stringify({event:'pi_auth_provider_error',stage,code:String(made.error?.code||'unknown').replace(/[^a-zA-Z0-9_]/g,'').slice(0,60)}));
      fail('account_create_failed');
     }
    }
    stage='bind_identity';
    await rpc('pi_auth_bind',{p_namespace:ns,p_uid:c.pi_uid,p_user:userId,p_username:c.pi_username});
   }
   return reply(await mintSession(userId,c.pi_username));
  }
  if(b.action==='account'){
   const u=await auth(),pi=await identity(u.id);
   if(pi && u.app_metadata?.pi_internal===true && !pi.internal_auth_email){
    const alias=internalEmail(u.email)?u.email:await mac('pi-user:'+ns+':'+pi.pi_uid)+'@pi-auth.invalid';
    const saved=await db.from('pi_account_identities').update({internal_auth_email:alias}).eq('app_namespace',ns).eq('user_id',u.id);
    if(saved.error)throw saved.error;
   }
   if(pi && u.email && !internalEmail(u.email)) await db.from('profiles').update({email:u.email}).eq('id',u.id);
   return reply({pi_linked:!!pi,email_linked:!!u.email&&!internalEmail(u.email),username:pi?.username||null,email:internalEmail(u.email)?null:u.email,email_available:!!env('PI_AUTH_EMAIL_API_KEY')&&!!env('PI_AUTH_EMAIL_FROM')});
  }
  if(b.action==='email_start'){
   const u=await auth();if(!await identity(u.id)||!internalEmail(u.email))fail('identity_conflict');
   if(!env('PI_AUTH_EMAIL_API_KEY')||!env('PI_AUTH_EMAIL_FROM'))fail('email_unavailable');
   const email=typeof b.email==='string'?b.email.trim().toLowerCase():'';
   if(email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email)||internalEmail(email))fail('invalid_email');
   await rate('email:'+u.id,3,600);
   if(await rpc('pi_auth_email_exists',{p_email:email}))fail('identity_conflict');
   // 8 digits, crypto RNG, only five guesses, ten-minute lifetime, user-bound HMAC.
   const code=String(crypto.getRandomValues(new Uint32Array(1))[0]%100000000).padStart(8,'0');
   const code_hash=await mac('email:'+u.id+':'+code);
   const put=await db.from('pi_email_challenges').upsert({user_id:u.id,email,code_hash,attempts:0,consumed:false,expires_at:new Date(Date.now()+600000).toISOString()});if(put.error)throw put.error;
   const sent=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env('PI_AUTH_EMAIL_API_KEY'),'Content-Type':'application/json'},body:JSON.stringify({from:env('PI_AUTH_EMAIL_FROM'),to:[email],subject:'FileOrganizerCore',text:`FileOrganizerCore\n\n${code}\n\n10 min.\nfileorganizercore.ir`}),signal:AbortSignal.timeout(15000)});
   if(!sent.ok){await db.from('pi_email_challenges').delete().eq('user_id',u.id).eq('code_hash',code_hash);fail('email_unavailable')}
   return reply({state:'email_sent'});
  }
  if(b.action==='email_finish'){
   const u=await auth();if(!await identity(u.id)||!internalEmail(u.email))fail('identity_conflict');
   if(typeof b.code!=='string'||!/^\d{8}$/.test(b.code)||typeof b.password!=='string'||b.password.length<8||enc.encode(b.password).length>72)fail('invalid_request');
   const email=await rpc('pi_auth_verify_email',{p_user:u.id,p_hash:await mac('email:'+u.id+':'+b.code)});if(!email)fail('invalid_code');
   if(await rpc('pi_auth_email_exists',{p_email:email}))fail('identity_conflict');
   // Preserve the internal routing alias separately before changing the actual Auth email.
   const saved=await db.from('pi_account_identities').update({internal_auth_email:u.email}).eq('app_namespace',ns).eq('user_id',u.id);
   if(saved.error)fail('email_update_failed');
   stage='email_update';
   const changed=await db.auth.admin.updateUserById(u.id,{email,email_confirm:true,password:b.password});
   if(changed.error)fail('email_update_failed');
   // Do not announce success based only on the requested email or a profiles row.
   const confirmed=await db.auth.admin.getUserById(u.id);
   if(confirmed.error || confirmed.data.user?.id!==u.id || confirmed.data.user?.email?.toLowerCase()!==email || !confirmed.data.user?.email_confirmed_at)fail('email_update_failed');
   // Preserve profile id, plan, quota, expiry and all existing usage/payment rows.
   await db.from('profiles').update({email}).eq('id',u.id);
   const session=await mintSession(u.id,(await identity(u.id)).username);
   if(session.user.email?.toLowerCase()!==email)fail('email_update_failed');
   return reply({...session,state:'email_linked',email});
  }
  fail('invalid_request');
 }catch(e){
  const raw=e instanceof Error?e.message:String((e as any)?.message||'');
  const allowed=['expired','unauthorized','invalid_request','not_configured','rate_limited','reauthenticate','identity_conflict','pi_verification_failed','pi_identity_invalid','confirmation_required','email_unavailable','invalid_email','invalid_code','email_update_failed','account_create_failed','session_failed','account_unavailable','browser_session_already_issued'];
  const error=allowed.includes(raw)?raw:((e as any)?.code==='23505'?'identity_conflict':'temporarily_unavailable');
  // Diagnostic categories only: never log tokens, email, usernames, OTPs or provider messages.
  console.warn(JSON.stringify({event:'pi_auth_failed',stage,error}));
  return reply({error},error==='unauthorized'?401:error==='rate_limited'?429:400);
 }
}
