/* Pure validation shared by the landing page and its regression tests. */
(function (root) {
  'use strict';
  function checkoutLink(raw, base, configured) {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    let url, home;
    try { url = new URL(raw.trim()); home = new URL(base); } catch { return null; }
    if (url.username || url.password || url.hash || url.protocol !== 'https:') return null;
    const routes = [new URL('checkout.html', home).href,
      'https://fileorganizercore.ir/web/checkout.html',
      'https://fileorganizerpro.mohammadaslanidev.ir/web/checkout.html',
      'https://fileorganizerpro.mohammadaslanidev.ir/checkout.html',
      'https://fileorganizercore.ir/checkout.html',
      'https://aslani99.github.io/FileOrganizerPro-Pi/web/checkout.html'];
    if (configured) {
      try { const c = new URL(configured); if (c.protocol === 'https:' && !c.username && !c.password) routes.push(c.origin + c.pathname); } catch { }
    }
    if (!routes.some(route => { const r = new URL(route); return url.origin === r.origin && url.pathname === r.pathname; })) return null;
    const tokens = url.searchParams.getAll('token');
    if (tokens.length !== 1 || !/^[A-Za-z0-9._~-]{1,512}$/.test(tokens[0])) return null;
    if ([...url.searchParams.keys()].some(k => !['token', 'lang'].includes(k))) return null;
    if (url.searchParams.getAll('lang').length > 1) return null;
    const lang = url.searchParams.get('lang');
    if (lang && !/^[a-zA-Z]{2,3}(?:-[a-zA-Z]{2,8})?$/.test(lang)) return null;
    return url;
  }
  function authLink(raw, base) {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    let u, home; try { u = new URL(raw.trim()); home = new URL(base); } catch { return null; }
    // Login secrets must never be forwarded to another origin or an arbitrary path.
    if (u.protocol !== 'https:' || u.origin !== home.origin || u.username || u.password || u.search) return null;
    const target = new URL('pi-login.html', home);
    if (![target.pathname, target.pathname.replace(/\.html$/, '')].includes(u.pathname)) return null;
    const fragment = u.hash.slice(1).split('?');
    if (fragment.length > 2 || !/^[a-f0-9]{64}$/.test(fragment[0])) return null;
    const q = new URLSearchParams(fragment[1] || '');
    if ([...q.keys()].some(k => !['lang','theme'].includes(k)) || q.getAll('lang').length > 1 || q.getAll('theme').length > 1) return null;
    if (q.has('lang') && !/^[a-zA-Z]{2,3}(?:-[a-zA-Z]{2,8})?$/.test(q.get('lang'))) return null;
    if (q.has('theme') && !['light','dark'].includes(q.get('theme'))) return null;
    u.pathname = target.pathname;
    return u;
  }
  function cameraRank(label) {
    const name=String(label||'').toLowerCase();
    // Labels are hints, not a portable lens-type API. Ordinary "wide" often IS the main camera.
    if (/front|user|selfie|facetime|前置|جلو|أمام/.test(name)) return -100;
    if (/ultra[ -]?wide|ultra[ -]?angle|0[.,]5|0[.,]6|超广|فوق.*عریض|فائق/.test(name)) return -60;
    if (/telephoto|tele camera|macro|depth|infrared/.test(name)) return -40;
    return (/back|rear|environment|پشت|خلف|后置|後置/.test(name)?20:0)+(/main|primary|standard|1[x×]|اصلی|رئيس|主摄/.test(name)?40:0);
  }
  function preferredCamera(devices, currentId, savedId) {
    const cameras=devices.filter(d=>d.kind==='videoinput' && d.deviceId);
    const saved=cameras.find(d=>d.deviceId===savedId);if(saved)return saved.deviceId;
    const current=cameras.find(d=>d.deviceId===currentId);
    const best=cameras.reduce((a,d)=>!a||cameraRank(d.label)>cameraRank(a.label)?d:a,null);
    // Keep the browser's rear choice when labels provide no better evidence.
    return best && (!current || cameraRank(best.label)>cameraRank(current.label)) ? best.deviceId : currentId;
  }
  function automaticCamera(devices, currentId) {
    const cameraZero=devices.find(d=>d.kind==='videoinput' && d.deviceId &&
      /\bcamera\s*0\s*,?\s*facing\s*back\b/i.test(String(d.label||'')));
    return cameraZero ? cameraZero.deviceId : preferredCamera(devices,currentId,'');
  }
  function downloadLink(raw) {
    try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; }
  }
  function freshPi(plan, now = Date.now()) {
    const amount = Number(plan.pi_amount), timestamp = Date.parse(plan.pi_rate_updated_at);
    const source = String(plan.pi_rate_source || '').trim().toLowerCase();
    return Number.isFinite(amount) && amount > 0 && Number.isFinite(timestamp) && now - timestamp <= 1800000 && timestamp - now <= 90000 && source && source !== 'manual' ? amount : null;
  }
  function validPlans(data) {
    if (!Array.isArray(data)) return [];
    const seen = new Set();
    return data.filter(p => {
      if (!p || !['free','pro','max'].includes(p.plan_id) || seen.has(p.plan_id) || p.is_active === false) return false;
      if (p.price_usd === null || p.price_usd === '' || !Number.isFinite(Number(p.price_usd)) || Number(p.price_usd) < 0) return false;
      if ((p.plan_id === 'free') !== (Number(p.price_usd) === 0)) return false;
      if (!Number.isInteger(Number(p.duration_days)) || Number(p.duration_days) <= 0) return false;
      if (p.organization_limit_bytes != null && (!Number.isSafeInteger(Number(p.organization_limit_bytes)) || Number(p.organization_limit_bytes) <= 0)) return false;
      if (p.plan_id === 'free' && p.organization_limit_bytes == null) return false;
      seen.add(p.plan_id); return true;
    }).sort((a,b) => ['free','pro','max'].indexOf(a.plan_id) - ['free','pro','max'].indexOf(b.plan_id));
  }
  const api = {automaticCamera, cameraRank, preferredCamera, authLink, checkoutLink, downloadLink, freshPi, validPlans};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FOP_HOME_POLICY = api;
})(typeof window !== 'undefined' ? window : globalThis);
