/*
 * FileOrganizerCore website account session and subscription sync.
 * Pi authentication is completed by the existing server-side pi-auth challenge flow.
 * This page stores short-lived session material in sessionStorage only.
 */
(() => {
  'use strict';

  const cfg = window.FOP_CONFIG || {};
  const $ = id => document.getElementById(id);
  const button = $('piAuth');
  const card = $('accountCard');
  if (!button || !card || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return;

  const SESSION_KEY = 'foc-web-auth-session';
  const PENDING_KEY = 'foc-web-auth-pending';
  const AUTH_URL = `${cfg.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/pi-auth`;
  const SUPABASE_URL = cfg.SUPABASE_URL.replace(/\/$/, '');
  const copy = {
    en: {
      login: 'Sign in / Sign up with Pi', logout: 'Sign out', working: 'Completing Pi sign-in…',
      piIntro: 'Sign in or create your FileOrganizerCore account with Pi. Your plan and usage will sync from the server.',
      waiting: 'Waiting for Pi approval. Return here after approving in Pi Browser.',
      signedIn: 'Signed in successfully.', sync: 'Refreshing account status…', synced: 'Account status is up to date.',
      offline: 'You are offline. Connect to the internet to refresh your account status.',
      failed: 'Could not synchronize your account. Check your connection and try again.',
      expired: 'Your sign-in session expired. Sign in with Pi again.',
      account: 'Pi account', plan: 'Current plan', quota: 'Remaining quota', expiry: 'Valid until',
      unlimited: 'Unlimited', noExpiry: 'No expiry date', refresh: 'Refresh account status',
      free: 'Free', pro: 'Pro', max: 'Max', gib: 'GiB remaining',
      expiredPlan: 'Expired plan',
      startFailed: 'Could not start Pi sign-in. Open this website in Pi Browser and try again.',
      challengeExpired: 'The Pi sign-in request expired. Please start again.',
      accountEmail: 'Email linked', quotaUnavailable: 'Quota information unavailable'
    },
    fa: {
      login: 'ورود / ثبت‌نام با Pi', logout: 'خروج از حساب', working: 'در حال تکمیل ورود با Pi…',
      piIntro: 'با Pi وارد شوید یا حساب FileOrganizerCore بسازید. پلن و میزان مصرف از سرور همگام‌سازی می‌شود.',
      waiting: 'در انتظار تأیید Pi هستیم. پس از تأیید در Pi Browser به این صفحه برگردید.',
      signedIn: 'ورود با موفقیت انجام شد.', sync: 'در حال دریافت آخرین وضعیت حساب…', synced: 'وضعیت حساب به‌روز است.',
      offline: 'اتصال اینترنت برقرار نیست. برای همگام‌سازی وضعیت حساب به اینترنت متصل شوید.',
      failed: 'همگام‌سازی حساب انجام نشد. اتصال اینترنت را بررسی و دوباره تلاش کنید.',
      expired: 'نشست ورود منقضی شده است. دوباره با Pi وارد شوید.',
      account: 'حساب Pi', plan: 'پلن فعلی', quota: 'سهمیه باقی‌مانده', expiry: 'اعتبار تا',
      unlimited: 'نامحدود', noExpiry: 'بدون تاریخ انقضا', refresh: 'به‌روزرسانی وضعیت حساب',
      free: 'رایگان', pro: 'پرو', max: 'مکس', gib: 'گیگابایت باقی‌مانده',
      expiredPlan: 'پلن منقضی‌شده',
      startFailed: 'شروع ورود با Pi ممکن نشد. وب‌سایت را در Pi Browser باز کنید و دوباره تلاش کنید.',
      challengeExpired: 'درخواست ورود با Pi منقضی شد. دوباره شروع کنید.',
      accountEmail: 'ایمیل متصل‌شده', quotaUnavailable: 'اطلاعات سهمیه در دسترس نیست'
    }
  };
  const language = () => (document.documentElement.lang || 'en').toLowerCase().split('-')[0];
  const t = key => (copy[language()] || copy.en)[key] || copy.en[key] || key;
  const safeJson = value => { try { return JSON.parse(value || 'null'); } catch { return null; } };
  const storageGet = key => { try { return sessionStorage.getItem(key); } catch { return null; } };
  const storageSet = (key, value) => { try { sessionStorage.setItem(key, value); return true; } catch { return false; } };
  const storageRemove = key => { try { sessionStorage.removeItem(key); } catch { } };
  const readSession = () => safeJson(storageGet(SESSION_KEY));
  const writeSession = value => { if (!storageSet(SESSION_KEY, JSON.stringify(value))) throw new Error('session_storage_unavailable'); };
  const delay = ms => new Promise(resolve => window.setTimeout(resolve, ms));
  let busy = false;
  let syncBusy = false;
  let lastProfile = null;

  function updateStaticLabels() {
    document.querySelectorAll('[data-account-key]').forEach(element => {
      const key = element.dataset.accountKey;
      if (copy[language()]?.[key] || copy.en[key]) element.textContent = t(key);
    });
    if (!readSession()?.accessToken && !safeJson(storageGet(PENDING_KEY))) $('piStatus').textContent = t('piIntro');
  }

  function setStatus(message, isError = false) {
    const status = $('accountSyncStatus');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('error', isError);
    const piStatus = $('piStatus');
    if (piStatus) { piStatus.textContent = message; piStatus.classList.toggle('error', isError); }
  }

  function setButtonLabel() {
    const session = readSession();
    const pending = safeJson(storageGet(PENDING_KEY));
    const label = session?.accessToken ? t('logout') : pending ? t('working') : t('login');
    if (button.textContent !== label) button.textContent = label;
    button.disabled = busy;
    if (!session?.accessToken) {
      $('piUser').hidden = true;
      $('piUser').textContent = '';
    }
  }

  function decodeExpiry(jwt) {
    try {
      const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')));
      return Number(payload.exp) * 1000;
    } catch { return 0; }
  }

  async function postAuth(body) {
    const response = await fetch(AUTH_URL, {
      method: 'POST',
      headers: { apikey: cfg.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(20000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'auth_request_failed');
    return data;
  }

  async function beginPiSignIn() {
    if (busy) return;
    busy = true;
    setButtonLabel();
    setStatus(t('working'));
    try {
      const result = await postAuth({ action: 'start', purpose: 'login' });
      if (typeof result.device_secret !== 'string' || !/^[a-f0-9]{64}$/.test(result.device_secret)
          || typeof result.url !== 'string' || typeof result.expires_at !== 'string'
          || typeof result.server_now !== 'string') throw new Error('invalid_challenge');
      const target = new URL(result.url, location.href);
      if (target.origin !== location.origin || !target.pathname.endsWith('/pi-login.html')
          || !/^[a-f0-9]{64}$/.test(target.hash.slice(1).split('?')[0])) throw new Error('invalid_challenge_url');
      const duration = Date.parse(result.expires_at) - Date.parse(result.server_now);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 10 * 60 * 1000) throw new Error('invalid_challenge_expiry');
      if (!storageSet(PENDING_KEY, JSON.stringify({
        deviceSecret: result.device_secret,
        deadline: Date.now() + duration
      }))) throw new Error('session_storage_unavailable');
      setStatus(t('waiting'));
      location.assign(target.href);
    } catch (error) {
      console.error('[FileOrganizerCore account] Pi sign-in start failed:', error?.message || 'unknown');
      setStatus(t('startFailed'), true);
      busy = false;
      setButtonLabel();
    }
  }

  async function completePendingSignIn() {
    if (busy) return false;
    const pending = safeJson(storageGet(PENDING_KEY));
    if (!pending || typeof pending.deviceSecret !== 'string' || !/^[a-f0-9]{64}$/.test(pending.deviceSecret)) return false;
    if (!Number.isFinite(pending.deadline) || pending.deadline <= Date.now()) {
      storageRemove(PENDING_KEY);
      setStatus(t('challengeExpired'), true);
      setButtonLabel();
      return false;
    }

    busy = true;
    setButtonLabel();
    setStatus(t('working'));
    try {
      while (Date.now() < pending.deadline) {
        let state;
        try {
          state = await postAuth({ action: 'poll', device_secret: pending.deviceSecret });
        } catch (error) {
          if (['expired', 'unauthorized', 'invalid_request'].includes(error.message)) throw error;
          await delay(2200);
          continue;
        }
        if (state.state === 'approved') {
          // redeem is deliberately single-use on the server; a lost reply requires a fresh challenge.
          const result = await postAuth({ action: 'redeem', device_secret: pending.deviceSecret, confirm: true });
          if (result.state !== 'signed_in' || typeof result.access_token !== 'string'
              || typeof result.refresh_token !== 'string' || !result.user?.id) throw new Error('session_failed');
          const session = {
            accessToken: result.access_token,
            refreshToken: result.refresh_token,
            user: result.user,
            expiresAt: decodeExpiry(result.access_token)
          };
          if (!session.expiresAt) throw new Error('invalid_session');
          writeSession(session);
          storageRemove(PENDING_KEY);
          setStatus(t('signedIn'));
          setButtonLabel();
          await syncAccount();
          return true;
        }
        if (state.state !== 'pending') throw new Error('expired');
        await delay(1800);
      }
      throw new Error('expired');
    } catch (error) {
      console.error('[FileOrganizerCore account] Pi sign-in could not be completed:', error?.message || 'unknown');
      storageRemove(PENDING_KEY);
      storageRemove('foc-pi-display');
      setStatus(error.message === 'expired' ? t('challengeExpired') : t('startFailed'), true);
      return false;
    } finally {
      busy = false;
      setButtonLabel();
    }
  }

  async function refreshSession(session) {
    if (session.expiresAt > Date.now() + 90000) return session;
    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: cfg.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
      credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string')
      throw new Error('session_expired');
    const updated = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      user: { ...(session.user || {}), id: session.user.id, email: (typeof data.user?.email === 'string' && !data.user.email.endsWith('@pi-auth.invalid') ? data.user.email : session.user.email || null), pi_username: session.user?.pi_username || data.user?.user_metadata?.pi_username },
      expiresAt: decodeExpiry(data.access_token)
    };
    if (!updated.expiresAt) throw new Error('session_expired');
    writeSession(updated);
    return updated;
  }

  async function authorizedFetch(path, session, options = {}) {
    const response = await fetch(`${SUPABASE_URL}${path}`, {
      ...options,
      headers: {
        apikey: cfg.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session.accessToken}`,
        ...(options.headers || {})
      },
      credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000)
    });
    if (response.status === 401) throw new Error('session_expired');
    if (!response.ok) throw new Error(`account_http_${response.status}`);
    return response;
  }

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return t('quotaUnavailable');
    return `${new Intl.NumberFormat(language(), { maximumFractionDigits: 2 }).format(value / (1024 ** 3))} ${t('gib')}`;
  }

  function renderAccount(profile, plans, session) {
    const plan = String(profile.plan || 'free').toLowerCase();
    if (!['free', 'pro', 'max'].includes(plan)) throw new Error('invalid_plan');
    const planInfo = plans.find(item => item.plan_id === plan);
    const freeInfo = plans.find(item => item.plan_id === 'free');
    const used = Math.max(0, Number(profile.bytes_organized_total) || 0);
    const limit = planInfo?.organization_limit_bytes == null ? null : Number(planInfo.organization_limit_bytes);
    let quotaText = t('unlimited');
    if (limit !== null && Number.isFinite(limit) && limit >= 0) quotaText = formatBytes(Math.max(0, limit - used));
    else if (plan === 'free' && freeInfo?.organization_limit_bytes != null) {
      const freeLimit = Number(freeInfo.organization_limit_bytes);
      quotaText = Number.isFinite(freeLimit) ? formatBytes(Math.max(0, freeLimit - used)) : t('quotaUnavailable');
    }

    const expiry = profile.plan_expires_at ? new Date(profile.plan_expires_at) : null;
    const expiryText = expiry && Number.isFinite(expiry.getTime())
      ? new Intl.DateTimeFormat(document.documentElement.lang || 'en', { dateStyle: 'medium' }).format(expiry)
      : t('noExpiry');
    const user = session.user || {};
    const username = String(user.pi_username || 'Pi user').slice(0, 128);
    $('accountName').textContent = username;
    $('accountEmail').textContent = user.email ? `${t('accountEmail')}: ${user.email}` : t('account');
    $('accountPlanValue').textContent = t(plan);
    $('accountQuotaValue').textContent = quotaText;
    $('accountExpiryValue').textContent = expiryText;
    $('accountPlanBadge').textContent = t(plan);
    $('accountPlanBadge').dataset.plan = plan;
    $('accountPlanNote').textContent = profile.last_expired_plan
      ? `${t('expiredPlan')}: ${t(String(profile.last_expired_plan).toLowerCase())}` : '';
    card.hidden = false;
    $('piUser').hidden = false;
    $('piUser').textContent = `${t('account')}: ${username}`;
    lastProfile = profile;
  }

  async function syncAccount() {
    if (syncBusy) return;
    let session = readSession();
    if (!session?.accessToken || !session?.refreshToken || !session?.user?.id) {
      card.hidden = true;
      setButtonLabel();
      return;
    }
    if (!navigator.onLine) { setStatus(t('offline'), true); return; }
    syncBusy = true;
    setStatus(t('sync'));
    try {
      session = await refreshSession(session);
      // refresh_subscription applies server-side expiry transitions before we read the profile.
      await authorizedFetch('/rest/v1/rpc/refresh_subscription', session, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      });
      const userId = encodeURIComponent(session.user.id);
      const [profileResponse, plansResponse] = await Promise.all([
        authorizedFetch(`/rest/v1/profiles?select=plan,plan_expires_at,bytes_organized_total,last_expired_plan&id=eq.${userId}`, session),
        fetch(`${SUPABASE_URL}/rest/v1/plans?select=plan_id,organization_limit_bytes`, {
          headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}` },
          credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000)
        })
      ]);
      if (!plansResponse.ok) throw new Error('plans_unavailable');
      const profiles = await profileResponse.json();
      const plans = await plansResponse.json();
      if (!Array.isArray(profiles) || profiles.length !== 1 || !Array.isArray(plans)) throw new Error('profile_unavailable');
      renderAccount(profiles[0], plans, session);
      setStatus(t('synced'));
    } catch (error) {
      console.error('[FileOrganizerCore account] Account sync failed:', error?.message || 'unknown');
      if (error.message === 'session_expired') {
        storageRemove(SESSION_KEY);
        card.hidden = true;
        setStatus(t('expired'), true);
      } else {
        setStatus(t('failed'), true);
      }
      setButtonLabel();
    } finally {
      syncBusy = false;
    }
  }

  function signOut() {
    storageRemove(SESSION_KEY);
    storageRemove(PENDING_KEY);
    storageRemove('foc-pi-display');
    lastProfile = null;
    card.hidden = true;
    $('piUser').hidden = true;
    setStatus('');
    setButtonLabel();
  }

  button.onclick = () => readSession()?.accessToken ? signOut() : beginPiSignIn();
  $('accountRefresh')?.addEventListener('click', syncAccount);
  $('language')?.addEventListener('change', () => {
    updateStaticLabels();
    if (lastProfile) syncAccount();
    setButtonLabel();
  });
  const languageObserver = new MutationObserver(() => { updateStaticLabels(); setButtonLabel(); });
  languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  window.addEventListener('online', () => { syncAccount(); $('reloadPlans')?.click(); });
  window.addEventListener('focus', syncAccount);
  window.addEventListener('pageshow', async () => {
    if (safeJson(storageGet(PENDING_KEY))) await completePendingSignIn();
    else await syncAccount();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncAccount(); });

  updateStaticLabels();
  setButtonLabel();
  if (safeJson(storageGet(PENDING_KEY))) completePendingSignIn();
  else syncAccount();
})();
