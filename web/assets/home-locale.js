(function(root){
  'use strict';
  const names = {en:'English',fa:'فارسی',ar:'العربية',ur:'اردو',tr:'Türkçe',ru:'Русский','zh-hans':'简体中文','zh-hant':'繁體中文',id:'Bahasa Indonesia',vi:'Tiếng Việt',es:'Español',fr:'Français',de:'Deutsch',hi:'हिन्दी',ja:'日本語',ko:'한국어',it:'Italiano',pt:'Português',az:'Azərbaycanca'};
  function normalize(value){
    const tag=String(value||'').trim().toLowerCase().replace(/_/g,'-');
    if(Object.hasOwn(names,tag))return tag;
    const parts=tag.split('-'),base=parts[0];
    if(base==='zh'){
      if(parts.includes('hans'))return 'zh-hans';
      if(parts.includes('hant')||parts.some(p=>['tw','hk','mo'].includes(p)))return 'zh-hant';
      return 'zh-hans';
    }
    if(base==='in')return 'id';
    return Object.hasOwn(names,base)?base:null;
  }
  function choice(saved,query){return saved==='auto'?'auto':normalize(saved)||normalize(query)||'auto';}
  function resolve(selected,languages){return normalize(selected)||(languages||[]).map(normalize).find(Boolean)||'en';}
  const api={names,normalize,choice,resolve,rtl:['fa','ar','ur']};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.FOP_HOME_LOCALE=api;
})(typeof window==='undefined'?globalThis:window);
