// Owner/admin-only read-only lookup of a validated Pi Testnet payment identifier.
const defaultPaymentId='5B85K3ZM2Y2ehZQU4sG3daLEZc1C';
export function createInspector({client,env,fetcher=fetch}) {
 const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
 const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
 return async req=>{
  if(req.method==='OPTIONS') return new Response(null,{status:204,headers});
  if(req.method!=='POST') return reply({error:'method_not_allowed'},405);
  try {
   const token=req.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
   if(!token) return reply({error:'unauthorized'},401);
   const {data:auth,error:authError}=await client.auth.getUser(token);
   if(authError || !auth?.user) return reply({error:'unauthorized'},401);
   const {data:admin,error:adminError}=await client.from('admin_users').select('role,is_active').eq('user_id',auth.user.id).maybeSingle();
   if(adminError) return reply({error:'admin_lookup_failed'},500);
   if(!admin?.is_active || !['owner','admin'].includes(admin.role)) return reply({error:'forbidden'},403);
   const raw=await req.text();
   if(raw.length>1024) return reply({error:'invalid_input'},413);
   let body;try{body=raw?JSON.parse(raw):{};}catch{return reply({error:'invalid_input'},400);}
   if(!body || Array.isArray(body) || typeof body!=='object') return reply({error:'invalid_input'},400);
   const paymentId=body.paymentId===undefined?defaultPaymentId:body.paymentId;
   if(typeof paymentId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(paymentId)) return reply({error:'invalid_payment_id'},400);
   const key=env('PI_SERVER_API_KEY');if(!key) return reply({error:'pi_server_key_missing'},503);
   const response=await fetcher('https://api.minepi.com/v2/payments/'+paymentId,{method:'GET',headers:{Authorization:'Key '+key},signal:AbortSignal.timeout(15000)});
   if(!response.ok) return reply({error:'pi_lookup_failed',providerStatus:response.status},502);
   const p=await response.json();
   if(p?.identifier!==paymentId || p.network!=='Pi Testnet') return reply({error:'unexpected_payment_or_network'},409);
   const sessionToken=p.metadata?.sessionToken;
   const validToken=typeof sessionToken==='string' && sessionToken.length>0 && sessionToken.length<=512;
   const sessionTokenSha256=validToken ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(sessionToken))),b=>b.toString(16).padStart(2,'0')).join('') : null;
   let localSession=null;
   if(validToken){
    const {data,error}=await client.from('payment_sessions').select('id,status,requested_plan,amount_pi,subscription_synced').eq('token',sessionToken).maybeSingle();
    if(error) return reply({error:'session_lookup_failed'},500);
    localSession=data?{id:data.id,status:data.status,plan:data.requested_plan,amountPi:data.amount_pi,subscriptionSynced:data.subscription_synced}:null;
   }
   return reply({paymentId,amount:p.amount,network:p.network,
    status:Object.fromEntries(['developer_approved','transaction_verified','developer_completed','cancelled','user_cancelled'].map(k=>[k,typeof p.status?.[k]==='boolean'?p.status[k]:null])),
    transaction:p.transaction?{txid:p.transaction.txid,verified:p.transaction.verified===true}:null,
    hasSessionToken:validToken,sessionTokenSha256,localSession});
  }catch{return reply({error:'inspection_unavailable'},502);}
 };
}
