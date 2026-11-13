/* Pi Browser approves the challenge; the website session is minted only after desktop redeem. */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const texts = window.FOC_PI_TEXT;
  const cfg = window.FOP_CONFIG || {};
  const fragment = location.hash.slice(1).split('?');
  const fragmentSecret = fragment[0];
  const query = new URLSearchParams(fragment[1] || '');
  const WEBSITE_SESSION_KEY = 'foc-web-auth-session';
  const PENDING_SECRET_KEY = 'foc-pi-browser-secret';
  let secret = fragmentSecret;
  try {
    if (/^[a-f0-9]{64}$/.test(fragmentSecret)) sessionStorage.setItem(PENDING_SECRET_KEY, fragmentSecret);
    else {
      const savedSecret = sessionStorage.getItem(PENDING_SECRET_KEY) || '';
      if (/^[a-f0-9]{64}$/.test(savedSecret)) secret = savedSecret;
    }
  } catch { }
  history.replaceState(null, '', location.pathname);

  // Browser detection is a presentation hint only, never authentication proof.
  let inPiBrowser = /pi[ -]?browser/i.test(navigator.userAgent);
  let browserChecked = inPiBrowser;
  async function detectBrowser() {
    if (!inPiBrowser && typeof window.Pi?.nativeFeaturesList === 'function') {
      try {
        const features = await Promise.race([
          window.Pi.nativeFeaturesList(),
          new Promise(resolve => setTimeout(() => resolve(null), 1800))
        ]);
        if (Array.isArray(features)) inPiBrowser = true;
      } catch { }
    }
    browserChecked = true;
    render();
  }

  const requestedTheme = query.get('theme');
  if (['light', 'dark'].includes(requestedTheme)) document.documentElement.dataset.theme = requestedTheme;
  const names = {
    en: 'English', fa: 'فارسی', ar: 'العربية', az: 'Azərbaycanca', de: 'Deutsch', es: 'Español',
    fr: 'Français', hi: 'हिन्दी', id: 'Bahasa Indonesia', it: 'Italiano', ja: '日本語', ko: '한국어',
    pt: 'Português', ru: 'Русский', tr: 'Türkçe', ur: 'اردو', vi: 'Tiếng Việt',
    'zh-Hans': '简体中文', 'zh-Hant': '繁體中文'
  };
  const normalize = value => texts[value] ? value
    : value?.toLowerCase().startsWith('zh') ? (/tw|hk|hant/i.test(value) ? 'zh-Hant' : 'zh-Hans')
      : texts[value?.split('-')[0]] ? value.split('-')[0] : 'en';
  let lang = normalize(query.get('lang') || navigator.language);
  let challenge = null;
  let busy = false;
  let awaitingDesktop = false;
  let done = false;
  let loading = true;
  let statusKey = '';
  let username = '';
  let expired = false;
  let remainingAtSync = 0;
  let syncedAt = performance.now();
  let timer = null;
  const t = key => texts[lang]?.[key] || texts.en[key] || '';
  const remaining = () => Math.max(0, remainingAtSync - (performance.now() - syncedAt));
  const delay = ms => new Promise(resolve => window.setTimeout(resolve, ms));

  function syncClock(response) {
    const expiry = Date.parse(response.expires_at);
    const server = Date.parse(response.server_now);
    if (!Number.isFinite(expiry) || !Number.isFinite(server)) throw new Error('not_configured');
    remainingAtSync = Math.max(0, expiry - server);
    syncedAt = performance.now();
  }

  for (const [value, label] of Object.entries(names)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    $('language').append(option);
  }

  function render() {
    document.documentElement.lang = lang;
    document.documentElement.dir = ['fa', 'ar', 'ur'].includes(lang) ? 'rtl' : 'ltr';
    $('language').value = lang;
    $('language').setAttribute('aria-label', t('language'));
    $('title').textContent = t(challenge?.purpose === 'link' ? 'link' : 'login');
    $('help').textContent = t('open_browser');
    $('browserNotice').hidden = done || !browserChecked || inPiBrowser;
    $('matchText').textContent = t('match');
    $('approveText').textContent = t('browser_confirm');
    $('loadingText').textContent = t('loading');
    $('loadingText').hidden = !loading;
    $('codeSpinner').hidden = !loading;
    $('challengePanel').setAttribute('aria-busy', String(loading || awaitingDesktop));
    $('approveSpinner').hidden = !busy;
    $('approve').setAttribute('aria-busy', String(busy));
    $('approve').disabled = loading || busy || awaitingDesktop || done || expired || !challenge || !$('match').checked;
    $('approve').hidden = done || awaitingDesktop;
    $('match').disabled = busy || awaitingDesktop || done || expired || !challenge;
    $('status').textContent = statusKey ? t(statusKey) : '';
    $('status').hidden = !statusKey;
    $('status').dataset.tone = done ? 'success' : statusKey === 'waiting_for_desktop' ? 'pending' : 'error';
    $('account').hidden = !done || !username;
    $('accountLabel').textContent = t('account');
    $('accountName').textContent = username;
    $('returnHome').hidden = !done;
    $('returnHomeLabel').textContent = t('return_home');
    $('agreement').hidden = done || awaitingDesktop;
    $('challengePanel').hidden = done;
  }

  function tick() {
    if (done) { clearInterval(timer); return; }
    const seconds = Math.max(0, Math.ceil(remaining() / 1000));
    $('timer').textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    if (!seconds) {
      expired = true;
      if (!busy) statusKey = 'expired';
      render();
    }
  }

  $('language').addEventListener('change', () => { lang = $('language').value; render(); });
  $('match').addEventListener('change', render);

  async function call(body) {
    const started = performance.now();
    const response = await fetch(cfg.SUPABASE_URL + '/functions/v1/pi-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.SUPABASE_ANON_KEY },
      body: JSON.stringify({ ...body, browser_secret: secret }),
      credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(25000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'error');
    return { data, elapsed: performance.now() - started };
  }

  function decodeExpiry(jwt) {
    try {
      const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')));
      return Number(payload.exp) * 1000;
    } catch { return 0; }
  }

  function saveWebsiteSession(response) {
    if (response.state !== 'signed_in' || typeof response.access_token !== 'string'
        || typeof response.refresh_token !== 'string' || !response.user?.id) throw new Error('session_failed');
    const session = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      user: response.user,
      expiresAt: decodeExpiry(response.access_token),
      piChallengeId: challenge?.challenge_id || null
    };
    if (!session.expiresAt) throw new Error('session_failed');
    try { localStorage.setItem(WEBSITE_SESSION_KEY, JSON.stringify(session)); }
    catch { throw new Error('session_storage_unavailable'); }
  }

  async function waitForDesktopRedeem() {
    // Pi Browser approval is only the identity check. The desktop app must still
    // show its confirmation dialog and successfully redeem this exact challenge.
    awaitingDesktop = true;
    expired = false;
    statusKey = 'waiting_for_desktop';
    render();
    try {
      while (true) {
        let response;
        try {
          response = await call({ action: 'browser_session' });
        } catch (error) {
          if (['expired', 'unauthorized', 'invalid_request', 'browser_session_already_issued'].includes(error.message)) throw error;
          await delay(1800);
          tick();
          continue;
        }
        // Use the server clock on every poll: desktop redeem grants a fresh, bounded claim window.
        if (response.data.expires_at && response.data.server_now) syncClock(response.data);
        if (response.data.state === 'signed_in') {
          saveWebsiteSession(response.data);
          try { sessionStorage.removeItem(PENDING_SECRET_KEY); } catch { }
          done = true;
          awaitingDesktop = false;
          expired = false;
          statusKey = 'browser_done';
          username = response.data.user.pi_username || username;
          clearInterval(timer);
          render();
          return;
        }
        if (response.data.state !== 'waiting_for_desktop') throw new Error('expired');
        expired = false;
        tick();
        await delay(1800);
      }
    } catch (error) {
      awaitingDesktop = false;
      expired = error.message === 'expired' || remaining() <= 0;
      statusKey = expired ? 'expired' : 'error';
      render();
    }
  }

  async function handleApproved(response, elapsed = 0) {
    challenge = { ...(challenge || {}), ...response, state: response.state || 'approved' };
    username = response.username || username;
    syncClock(response, elapsed);
    awaitingDesktop = true;
    statusKey = 'waiting_for_desktop';
    tick();
    if (!timer) timer = setInterval(tick, 1000);
    render();
    await waitForDesktopRedeem();
  }

  function showError(error) {
    statusKey = ({ expired: 'expired', not_configured: 'unavailable', identity_conflict: 'conflict' })[error.message] || 'error';
    if (error.message === 'expired') {
      expired = true;
      try { sessionStorage.removeItem(PENDING_SECRET_KEY); } catch { }
    }
    awaitingDesktop = false;
    render();
  }

  $('approve').addEventListener('click', async () => {
    if (busy || awaitingDesktop || done || expired || !challenge || !$('match').checked) return;
    busy = true;
    statusKey = '';
    render();
    try {
      if (!window.Pi) throw new Error('not_configured');
      await window.Pi.init({ version: '2.0', sandbox: cfg.PI_SANDBOX === true });
      const auth = await window.Pi.authenticate(['username'], () => { });
      if (!auth?.accessToken) throw new Error('error');
      const token = auth.accessToken;
      auth.accessToken = '';
      const response = await call({ action: 'approve', pi_token: token });
      await handleApproved(response.data, response.elapsed);
    } catch (error) {
      // A lost approval response is ambiguous. Inspect the same request before declaring failure.
      try {
        const inspected = await call({ action: 'inspect' });
        if (['approved', 'consumed'].includes(inspected.data.state)) {
          await handleApproved(inspected.data, inspected.elapsed);
        } else showError(error);
      } catch { showError(error); }
    } finally {
      busy = false;
      render();
    }
  });

  async function load() {
    render();
    if (!/^[a-f0-9]{64}$/.test(secret)) {
      loading = false;
      showError(new Error('expired'));
      return;
    }
    try {
      const inspected = await call({ action: 'inspect' });
      challenge = inspected.data;
      $('codeValue').textContent = challenge.code || '';
      const savedSession = (() => { try { return JSON.parse(localStorage.getItem(WEBSITE_SESSION_KEY) || 'null'); } catch { return null; } })();
      if (challenge.state === 'consumed' && savedSession?.piChallengeId === challenge.challenge_id
          && savedSession?.user?.id && savedSession?.accessToken && savedSession?.refreshToken) {
        try { sessionStorage.removeItem(PENDING_SECRET_KEY); } catch { }
        username = savedSession.user.pi_username || challenge.username || '';
        done = true; statusKey = 'browser_done'; loading = false; render(); return;
      }
      if (['approved', 'consumed'].includes(challenge.state)) {
        await handleApproved(challenge, inspected.elapsed);
      } else if (challenge.state === 'pending') {
        syncClock(challenge, inspected.elapsed);
        tick();
        timer = setInterval(tick, 1000);
      } else {
        throw new Error('expired');
      }
    } catch (error) {
      showError(error);
    } finally {
      loading = false;
      render();
    }
  }

  void load();
  void detectBrowser();
})();
