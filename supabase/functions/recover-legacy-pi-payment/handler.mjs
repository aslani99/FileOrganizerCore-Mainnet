// One explicitly reviewed historical Testnet payment; never a general orphan-payment bypass.
export const CASE = Object.freeze({
 paymentId:'TxAukfUSGN7V1pTOEsNN1SUpHiyf', amount:18,
 txid:'fbe8485f450a31140dab386b6d0b13a92449afa44f4d1ced1ad7988daaa949e2',
 tokenHash:'01e7a97c331cb0eebb3189b909b1032ecefc94d26324d200e7fa2bc88b30ccb6'
});
export function createLegacyRecovery({client,env,fetcher=fetch}) {
 const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
 const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
 const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
 const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
 async function verify(p) {
  if(p?.identifier!==CASE.paymentId || p.network!=='Pi Testnet' || p.direction!=='user_to_app' ||
     typeof p.amount!=='number' || p.amount!==CASE.amount || typeof p.user_uid!=='string' || !p.user_uid ||
     typeof p.metadata?.sessionToken!=='string' || p.metadata.sessionToken.length>512 ||
     await hash(p.metadata.sessionToken)!==CASE.tokenHash ||
     p.status?.developer_approved!==true || p.status?.transaction_verified!==true ||
     p.status?.cancelled!==false || p.status?.user_cancelled!==false ||
     typeof p.status?.developer_completed!=='boolean' || p.transaction?.verified!==true || p.transaction?.txid!==CASE.txid) fail('payment_evidence_mismatch');
 }
 return async req=>{
  if(req.method==='OPTIONS') return new Response(null,{status:204,headers});
  if(req.method!=='POST') return reply({error:'method_not_allowed'},405);
  try {
   const jwt=req.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
   if(!jwt) fail('unauthorized',401);
   const {data:auth,error:authError}=await client.auth.getUser(jwt);
   if(authError || !auth?.user) fail('unauthorized',401);
   const {data:admin,error:adminError}=await client.from('admin_users').select('role,is_active').eq('user_id',auth.user.id).maybeSingle();
   if(adminError) fail('admin_lookup_failed',503);
   if(admin?.role!=='owner' || admin.is_active!==true) fail('owner_required',403);
   if(env('PI_SANDBOX')!=='true' || !env('PI_SERVER_API_KEY')) fail('testnet_configuration_required',503);
   const raw=await req.text();if(raw.length>512) fail('invalid_confirmation',400);
   let body;try{body=JSON.parse(raw);}catch{fail('invalid_confirmation',400);}
   if(body?.paymentId!==CASE.paymentId || body?.confirm!=='COMPLETE_OLD_TESTNET_PAYMENT' || Object.keys(body).length!==2) fail('invalid_confirmation',400);
   const url='https://api.minepi.com/v2/payments/'+CASE.paymentId;
   async function pi(complete=false) {
    const res=await fetcher(url+(complete?'/complete':''),{method:complete?'POST':'GET',headers:{Authorization:'Key '+env('PI_SERVER_API_KEY'),'Content-Type':'application/json'},...(complete?{body:JSON.stringify({txid:CASE.txid})}:{}),signal:AbortSignal.timeout(15000)});
    if(!res.ok) fail('pi_unavailable_retry_after_3_minutes',502);
    return res.json();
   }
   let payment=await pi();await verify(payment);
   // Match by all three identifiers. A linked payment must use the normal lifecycle.
   for(const [column,value] of [['token',payment.metadata.sessionToken],['pi_payment_id',CASE.paymentId],['tx_id',CASE.txid]]){
    const {data,error}=await client.from('payment_sessions').select('id').eq(column,value).limit(1);
    if(error) fail('session_lookup_failed',503);
    if(data?.length) fail('session_exists_use_normal_recovery');
   }
   const attempt=crypto.randomUUID();
   async function record(phase) {
    const {data,error}=await client.rpc('record_legacy_pi_recovery',{p_admin:auth.user.id,p_attempt:attempt,p_phase:phase});
    if(error) fail('recovery_record_failed_retry_after_3_minutes',503);
    return data;
   }
   const started=await record('prepare');
   if(started?.state==='busy') fail('recovery_in_progress_retry_after_3_minutes');
   if(started?.state==='confirmed') {
    if(payment.status.developer_completed!==true) fail('provider_record_conflict');
    return reply({ok:true,paymentId:CASE.paymentId,developerCompleted:true,alreadyCompleted:true,subscriptionGranted:false});
   }
   if(started?.state!=='prepared') fail('recovery_record_failed',503);
   const uid=payment.user_uid;
   if(!payment.status.developer_completed) {await pi(true);payment=await pi();await verify(payment);}
   if(payment.user_uid!==uid || payment.status.developer_completed!==true) fail('completion_unconfirmed_retry_after_3_minutes',502);
   const finished=await record('confirm');
   if(finished?.state!=='confirmed') fail('recovery_record_failed_retry_after_3_minutes',503);
   return reply({ok:true,paymentId:CASE.paymentId,developerCompleted:true,subscriptionGranted:false});
  } catch(error) {return reply({error:error.status?error.message:'recovery_unavailable_retry_after_3_minutes'},error.status||502);}
 };
}
