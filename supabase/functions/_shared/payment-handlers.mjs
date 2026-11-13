// Pi Platform is the source of truth. All database mutations use service-only RPCs.
export function createPaymentHandler(action, {client, env, fetcher=fetch}) {
 const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
 const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
 const fail=(error,status=400)=>{throw Object.assign(new Error(error),{status});};
 const text=v=>typeof v==='string' && v.length>0 && v.length<=512;
 async function rpc(name,args) {
   const {data,error}=await client.rpc(name,args);
   if(error) {
     const known=['quote_expired','invalid_plan','invalid_discount','discount_exhausted','rate_stale','zero_amount_not_supported','too_many_sessions','session_expired','session_closed'];
     fail(known.includes(error.message)?error.message:'payment_storage_failed',error.code==='23505'?409:error.code==='P0002'?404:known.includes(error.message)?400:500);
   }
   return data;
 }
 async function pi(path,token,body) {
   // Report only a fixed stage and numeric HTTP status, never provider bodies or credentials.
   const stage=path==='/me'?'identity':path.endsWith('/cancel')?'cancel':path.endsWith('/complete')?'complete':path.endsWith('/approve')?'approve':'lookup';
   let res;
   try {
     res=await fetcher('https://api.minepi.com/v2'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
   } catch(error) {
     fail('pi_'+stage+'_'+(['TimeoutError','AbortError'].includes(error?.name)?'timeout':'network_error'),502);
   }
   if(!res.ok) fail(path==='/me' && res.status===401?'invalid_pi_identity':'pi_'+stage+'_http_'+res.status,path==='/me' && res.status===401?401:502);
   try { return await res.json(); } catch { fail('pi_'+stage+'_invalid_response',502); }
 }
 function network() {
   // Legacy deployments may opt into Testnet only. Never infer Mainnet from sandbox=false.
   const configured=env('PI_AUTH_NETWORK');
   const value=configured || (env('PI_SANDBOX')==='true'?'testnet':null);
   if(!['testnet','mainnet'].includes(value) ||
      (value==='mainnet' && env('PI_SANDBOX')==='true') || !env('PI_SERVER_API_KEY'))
     fail('payment_configuration_required',503);
   return value==='mainnet'?'Pi Network':'Pi Testnet';
 }
 const check=(p,s,id,uid)=>{
   if(p.identifier!==id || p.user_uid!==uid || p.metadata?.sessionToken!==s.token || p.direction!=='user_to_app' || p.network!==network() ||
      !Number.isFinite(Number(p.amount)) || Number(p.amount)<=0 || Number(p.amount)!==Number(s.amount_pi) ||
      (s.pi_user_uid && s.pi_user_uid!==uid) || (s.pi_payment_id && s.pi_payment_id!==id)) fail('payment_mismatch',403);
 };
 return async req=>{
   if(req.method==='OPTIONS') return reply({ok:true});
   if(req.method!==(action==='status'?'GET':'POST')) return reply({error:'method_not_allowed'},405);
   try {
     const expectedNetwork=network();
     if(action==='status') {
       const token=new URL(req.url).searchParams.get('token');if(!text(token)) fail('invalid_token');
       const {data:stored,error}=await client.from('payment_sessions').select('*').eq('token',token).maybeSingle();
       let s=stored;
       if(error) fail('payment_storage_failed',500);if(!s) fail('session_not_found',404);
       // A browser can disappear after chain submission, before its completion callback.
       // Re-read the linked payment; a stored restart hint is not proof of non-payment.
       let awaitingVerification=false;
       if(['pending','approved','cancelled'].includes(s.status) && s.pi_payment_id) {
         if(!text(s.pi_payment_id) || !text(s.pi_user_uid)) fail('payment_mismatch',403);
         const id=s.pi_payment_id,key='Key '+env('PI_SERVER_API_KEY');
         let p=await pi('/payments/'+encodeURIComponent(id),key);
         check(p,s,id,s.pi_user_uid);
         const tx=p.transaction?.txid;
         if(tx) {
           const verified=value=>value.transaction?.txid===tx && value.transaction?.verified===true &&
             value.status?.transaction_verified===true && !value.status?.cancelled && !value.status?.user_cancelled;
           if(!text(tx) || !verified(p) || (s.tx_id && s.tx_id!==tx)) fail('transaction_unverified',409);
           if(p.status?.developer_completed!==true) {
             try { p=await pi('/payments/'+encodeURIComponent(id)+'/complete',key,{txid:tx}); }
             catch(completionError) {
               // A concurrent callback or a lost response may already have completed it.
               let latest;
               try { latest=await pi('/payments/'+encodeURIComponent(id),key); }
               catch { throw completionError; }
               check(latest,s,id,s.pi_user_uid);
               if(latest.status?.developer_completed!==true || !verified(latest)) throw completionError;
               p=latest;
             }
           }
           check(p,s,id,s.pi_user_uid);
           if(p.status?.developer_completed!==true || !verified(p)) fail('completion_unconfirmed',502);
           s=await rpc('transition_pi_payment',{p_token:s.token,p_payment:id,p_uid:s.pi_user_uid,p_action:'complete',p_tx:tx});
         } else if(p.status?.developer_completed || p.status?.transaction_verified || s.tx_id) {
           fail('transaction_unverified',409);
         } else if(p.status?.cancelled===true || p.status?.user_cancelled===true) {
           s=await rpc('transition_pi_payment',{p_token:s.token,p_payment:id,p_uid:s.pi_user_uid,p_action:'cancel',p_tx:null});
         } else {
           awaitingVerification=['pending','approved'].includes(s.status) || p.status?.developer_approved===true;
         }
       }
       let pending=false;
       if(s.status==='completed' && !s.subscription_synced) {
         const {data,error}=await client.rpc('activate_payment_subscription',{p_session_id:s.id});pending=!!error || !data?.ok;
       }
       // Expiration is a view, not a destructive mutation: a late genuine payment can settle.
       const expired=s.status==='pending' && !s.pi_payment_id && Date.parse(s.created_at)<Date.now()-1800000;
       return reply({status:expired?'error':awaitingVerification && s.status==='cancelled'?'approved':s.status,plan:s.requested_plan,amountPi:s.amount_pi,hasLinkedPayment:!!s.pi_payment_id,...(expired?{errorCode:'session_expired'}:awaitingVerification?{errorCode:'payment_verification_pending'}:{}),subscriptionPendingSync:pending});
     }
     const body=await req.json().catch(()=>null);if(!body || typeof body!=='object' || Array.isArray(body)) fail('invalid_body');
     if(action==='create') {
       const jwt=(req.headers.get('Authorization')||'').match(/^Bearer (.+)$/i)?.[1];if(!jwt) fail('unauthorized',401);
       const {data,error}=await client.auth.getUser(jwt);if(error || !data?.user) fail('unauthorized',401);
       if(!['pro','max'].includes(body.plan) || (body.discountCode!=null && (!text(body.discountCode)||body.discountCode.length>256))) fail('invalid_plan_or_discount');
       const base=env('APP_PUBLIC_CHECKOUT_URL');let url;try{url=new URL(base);}catch{fail('checkout_url_missing',503);}
       if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname))) fail('checkout_url_invalid',503);
       if(expectedNetwork==='Pi Network' && (url.protocol!=='https:' || url.origin!==env('PI_AUTH_WEB_ORIGIN'))) fail('checkout_url_invalid',503);
       if(body.quoteId!=null && (typeof body.quoteId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.quoteId))) fail('quote_expired');
       const args={p_user:data.user.id,p_plan:body.plan,p_discount:body.discountCode?.trim()||null};
       const s=body.quoteId
         ? await rpc('create_quoted_checkout_session',{...args,p_quote:body.quoteId})
         : await rpc('create_checkout_session',args); // Compatibility for older desktop releases only.
       url.searchParams.set('token',s.token);
       if(typeof body.language==='string' && /^[a-z]{2}(?:-[A-Za-z]{2,8})?$/.test(body.language)) url.searchParams.set('lang',body.language);
       return reply({token:s.token,checkoutUrl:url.href,amountPi:s.amount_pi,originalAmountPi:s.original_amount_pi,discountPercent:s.discount_percent,resumingLinkedPayment:s.resumingLinkedPayment===true});
     }
     const recovery=action==='complete' && body.recovery===true;
     let id=body.paymentId;
     const access=body.accessToken??body.piAccessToken;
     if(recovery) {
       if(!text(access)) fail('invalid_pi_identity',401);
       if(!id) {
         if(!text(body.sessionToken)) fail('invalid_token');
         const {data:linked,error}=await client.from('payment_sessions').select('*').eq('token',body.sessionToken).maybeSingle();
         if(error) fail('payment_storage_failed',500);
         if(!linked?.pi_payment_id) fail('linked_payment_not_found',404);
         id=linked.pi_payment_id;
       }
     }
     if(!text(id) || (action!=='complete' && !text(access)) || (action==='complete' && !recovery && !text(body.txId))) fail('missing_parameters');
     const key='Key '+env('PI_SERVER_API_KEY');
     let uid=null;if(access){if(!text(access)) fail('invalid_pi_identity',401);uid=(await pi('/me','Bearer '+access)).uid;if(!text(uid)) fail('invalid_pi_identity',401);}
     let payment=await pi('/payments/'+encodeURIComponent(id),key);
     // Incomplete callbacks can precede Pi.authenticate: only server-verified metadata resolves recovery.
     const token=action==='complete'?payment.metadata?.sessionToken:body.sessionToken;
     if(!text(token)) fail('invalid_token');
     const {data:s,error}=await client.from('payment_sessions').select('*').eq('token',token).maybeSingle();
     if(error) fail('payment_storage_failed',500);if(!s) fail('session_not_found',404);
     uid=uid||payment.user_uid;check(payment,s,id,uid);
     const transition=(step,tx=null)=>rpc('transition_pi_payment',{p_token:token,p_payment:id,p_uid:uid,p_action:step,p_tx:tx});
     if(action==='approve') {
       if(s.retry_of_session_id) {
         const {data:previous,error:previousError}=await client.from('payment_sessions').select('*').eq('id',s.retry_of_session_id).maybeSingle();
         if(previousError) fail('payment_storage_failed',500);
         if(!previous || previous.user_id!==s.user_id || previous.pi_user_uid!==uid || !text(previous.pi_payment_id)) fail('payment_mismatch',403);
         const oldPayment=await pi('/payments/'+encodeURIComponent(previous.pi_payment_id),key);
         check(oldPayment,previous,previous.pi_payment_id,uid);
         if(oldPayment.status?.developer_approved) fail('payment_verification_pending',409);
         if(oldPayment.transaction?.txid || oldPayment.status?.developer_completed || oldPayment.status?.transaction_verified) fail('previous_payment_requires_completion',409);
         if(!oldPayment.status?.cancelled && !oldPayment.status?.user_cancelled) fail('previous_payment_not_cancelled',409);
         // SDK replacement has cancelled the unpaid predecessor. Persist only verified facts.
         await rpc('transition_pi_payment',{p_token:previous.token,p_payment:previous.pi_payment_id,p_uid:uid,p_action:'cancel',p_tx:null});
       }
       if(payment.status?.cancelled || payment.status?.user_cancelled) fail('payment_cancelled',409);
       if(s.status==='completed') return reply({ok:true,alreadyCompleted:true});
       if(Date.parse(s.created_at)<Date.now()-1800000 && !payment.status?.developer_approved) fail('session_expired',410);
       await transition('bind');
       if(!payment.status?.developer_approved) payment=await pi('/payments/'+encodeURIComponent(id)+'/approve',key,{});
       check(payment,s,id,uid);if(payment.status?.developer_approved!==true) fail('approval_unconfirmed',502);
       await transition('approve');return reply({ok:true});
     }
     if(recovery) {
       // Reconcile only provider-verified state. Never trust a client txid for recovery.
       if(payment.transaction?.txid) body.txId=payment.transaction.txid;
       else if(payment.status?.developer_completed || payment.status?.transaction_verified || s.tx_id) fail('transaction_unverified',409);
       else if((payment.status?.cancelled===true || payment.status?.user_cancelled===true)) {
         const saved=await transition('cancel');
         return reply({ok:true,cancelled:saved.status!=='completed',alreadyCompleted:saved.status==='completed'});
       } else {
         // A missing Platform transaction is NOT proof that no chain transfer occurred.
         // Keep the original session recoverable; never instruct another purchase.
         return reply({ok:true,awaitingConfirmation:true,paymentId:id,recoverySessionToken:token});
       }
     }
     if(action==='cancel' || (recovery && body.cancel===true && !payment.transaction?.txid)) {
       if(s.status==='completed' || s.tx_id || payment.status?.developer_completed || payment.status?.transaction_verified || payment.transaction?.txid) fail('payment_requires_completion',409);
       if(payment.status?.developer_approved && payment.status?.cancelled!==true && payment.status?.user_cancelled!==true) return reply({ok:true,awaitingConfirmation:true,paymentId:id,recoverySessionToken:token});
       if(!payment.status?.cancelled && !payment.status?.user_cancelled) {
         try { payment=await pi('/payments/'+encodeURIComponent(id)+'/cancel',key,{}); }
         catch(cancelError) {
           // A timeout/error may follow a successful remote cancellation. Read back once;
           // never turn an unconfirmed cancellation into local success or repeat the POST.
           let latest;
           try { latest=await pi('/payments/'+encodeURIComponent(id),key); }
           catch { throw cancelError; }
           check(latest,s,id,uid);
           if(latest.transaction?.txid || latest.status?.developer_completed || latest.status?.transaction_verified) fail('payment_requires_completion',409);
           if(!latest.status?.cancelled && !latest.status?.user_cancelled) throw cancelError;
           payment=latest;
         }
       }
       check(payment,s,id,uid);
       if(payment.transaction?.txid || (!payment.status?.cancelled && !payment.status?.user_cancelled)) fail('cancellation_unconfirmed',409);
       const saved=await transition('cancel');return reply({ok:true,cancelled:saved.status!=='completed',alreadyCompleted:saved.status==='completed'});
     }
     if(payment.status?.cancelled || payment.status?.user_cancelled || payment.transaction?.txid!==body.txId || payment.transaction?.verified!==true || payment.status?.transaction_verified!==true) fail('transaction_unverified',409);
     if(!payment.status?.developer_completed) payment=await pi('/payments/'+encodeURIComponent(id)+'/complete',key,{txid:body.txId});
     check(payment,s,id,uid);
     if(payment.status?.developer_completed!==true || payment.transaction?.txid!==body.txId || payment.transaction?.verified!==true) fail('completion_unconfirmed',502);
     const saved=await transition('complete',body.txId);
     const {data,error:activationError}=await client.rpc('activate_payment_subscription',{p_session_id:saved.id});
     return reply({ok:true,subscriptionPendingSync:!!activationError || !data?.ok});
   } catch(error) { return reply({error:error.status?error.message:'payment_temporarily_unavailable'},error.status||502); }
 };
}
