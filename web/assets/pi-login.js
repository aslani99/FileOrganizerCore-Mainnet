/* Only browser approval occurs here; desktop credentials never enter this page. */
'use strict';
(() => {
 const $=id=>document.getElementById(id), texts=window.FOC_PI_TEXT, cfg=window.FOP_CONFIG||{};
 const fragment=location.hash.slice(1).split('?'), secret=fragment[0];
 const query=new URLSearchParams(fragment[1]||'');
 history.replaceState(null,'',location.pathname);
 // Browser detection is a presentation hint only, never authentication proof.
 let inPiBrowser=/pi[ -]?browser/i.test(navigator.userAgent),browserChecked=inPiBrowser;
 async function detectBrowser(){
  if(!inPiBrowser && typeof window.Pi?.nativeFeaturesList==='function'){
   try{const features=await Promise.race([window.Pi.nativeFeaturesList(),new Promise(resolve=>setTimeout(()=>resolve(null),1800))]);if(Array.isArray(features))inPiBrowser=true}catch{}
  }
  browserChecked=true;render();
 }
 const requestedTheme=query.get('theme');
 if(['light','dark'].includes(requestedTheme))document.documentElement.dataset.theme=requestedTheme;
 const names={en:'English',fa:'فارسی',ar:'العربية',az:'Azərbaycanca',de:'Deutsch',es:'Español',fr:'Français',hi:'हिन्दी',id:'Bahasa Indonesia',it:'Italiano',ja:'日本語',ko:'한국어',pt:'Português',ru:'Русский',tr:'Türkçe',ur:'اردو',vi:'Tiếng Việt','zh-Hans':'简体中文','zh-Hant':'繁體中文'};
 const normalize=s=>texts[s]?s:s?.toLowerCase().startsWith('zh')?(/tw|hk|hant/i.test(s)?'zh-Hant':'zh-Hans'):texts[s?.split('-')[0]]?s.split('-')[0]:'en';
 let lang=normalize(query.get('lang')||navigator.language),challenge=null,busy=false,done=false,loading=true,statusKey='',username='',expired=false;
 let remainingAtSync=0,syncedAt=performance.now(),timer=null;
 const t=k=>texts[lang]?.[k]||texts.en[k]||'';
 const remaining=()=>Math.max(0,remainingAtSync-(performance.now()-syncedAt));
 function syncClock(r,roundTrip){
  // Do not compare with the phone clock; use server time plus elapsed monotonic time.
  const expiry=Date.parse(r.expires_at),server=Date.parse(r.server_now);
  if(!Number.isFinite(expiry)||!Number.isFinite(server))throw new Error('not_configured');
  remainingAtSync=Math.max(0,expiry-server);syncedAt=performance.now();
 }
 for(const [value,label]of Object.entries(names)){const o=document.createElement('option');o.value=value;o.textContent=label;$('language').append(o)}
 function render(){
  document.documentElement.lang=lang;document.documentElement.dir=['fa','ar','ur'].includes(lang)?'rtl':'ltr';$('language').value=lang;
  $('language').setAttribute('aria-label',t('language'));
  $('title').textContent=t(challenge?.purpose==='link'?'link':'login');$('help').textContent=t('open_browser');$('browserNotice').hidden=done||!browserChecked||inPiBrowser;
  $('matchText').textContent=t('match');$('approveText').textContent=t('browser_confirm');$('loadingText').textContent=t('loading');
  $('loadingText').hidden=!loading;$('codeSpinner').hidden=!loading;$('challengePanel').setAttribute('aria-busy',String(loading));
  $('approveSpinner').hidden=!busy;$('approve').setAttribute('aria-busy',String(busy));
  $('approve').disabled=loading||busy||done||expired||!challenge||!$('match').checked;
  $('match').disabled=busy||done||expired||!challenge;
  $('status').textContent=statusKey?t(statusKey):'';$('status').hidden=!statusKey;$('status').dataset.tone=done?'success':'error';
  $('account').hidden=!done||!username;$('accountLabel').textContent=t('account');$('accountName').textContent=username;
  $('returnHome').hidden=!done;$('returnHome').textContent=t('return_home');
  $('agreement').hidden=done;$('approve').hidden=done;$('challengePanel').hidden=done;
 }
 function tick(){
  if(done){clearInterval(timer);return}
  const seconds=Math.max(0,Math.ceil(remaining()/1000));
  $('timer').textContent=Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
  if(!seconds){expired=true;if(!busy)statusKey='expired';render()}
 }
 $('language').addEventListener('change',()=>{lang=$('language').value;render()});$('match').addEventListener('change',render);
 async function call(body){
  const started=performance.now();
  const response=await fetch(cfg.SUPABASE_URL+'/functions/v1/pi-auth',{method:'POST',headers:{'Content-Type':'application/json',apikey:cfg.SUPABASE_ANON_KEY},body:JSON.stringify({...body,browser_secret:secret}),credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(25000)});
  const r=await response.json();if(!response.ok)throw new Error(r.error||'error');
  return {data:r,elapsed:performance.now()-started};
 }
 function approved(r){
  done=true;expired=false;username=r.username||'';statusKey='browser_done';clearInterval(timer);
  if(username && username.length<=128)try{sessionStorage.setItem('foc-pi-display',JSON.stringify({username,network:cfg.PI_SANDBOX===true?'testnet':'mainnet',expires:Date.now()+15*60*1000}))}catch{}
 }
 function error(e){statusKey=({expired:'expired',not_configured:'unavailable',identity_conflict:'conflict'})[e.message]||'error';if(e.message==='expired')expired=true;render()}
 $('approve').addEventListener('click',async()=>{
  if(busy||done||expired||!challenge||!$('match').checked)return;
  busy=true;statusKey='';render();
  try{
   if(!window.Pi)throw new Error('not_configured');
   await window.Pi.init({version:'2.0',sandbox:cfg.PI_SANDBOX===true});
   const auth=await window.Pi.authenticate(['username'],()=>{});
   if(!auth?.accessToken)throw new Error('error');
   const token=auth.accessToken;auth.accessToken='';
   const {data}=await call({action:'approve',pi_token:token});approved(data);
  }catch(e){
   // A lost approval response is ambiguous. Inspect the same request before declaring failure.
   try {const {data}=await call({action:'inspect'});if(data.state==='approved')approved(data);else error(e)}catch{error(e)}
  }finally{busy=false;render()}
 });
 async function load(){
  render();
  if(!/^[a-f0-9]{64}$/.test(secret)){loading=false;error(new Error('expired'));return}
  try{
   const {data:r,elapsed}=await call({action:'inspect'});challenge=r;$('codeValue').textContent=r.code;
   if(r.state==='approved')approved(r);else{syncClock(r,elapsed);tick();timer=setInterval(tick,1000)}
  }catch(e){error(e)}finally{loading=false;render()}
 }
 load();detectBrowser();
})();
