/* Persistent website account session, received only from the Pi-login desktop handoff. */
(() => {
  'use strict';

  const cfg = window.FOP_CONFIG || {};
  const $ = id => document.getElementById(id);
  const button = $('piAuth');
  const card = $('accountCard');
  if (!button || !card || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return;

  const SESSION_KEY = 'foc-web-auth-session';
  const CACHE_KEY = 'foc-web-account-cache';
  const SUPABASE_URL = String(cfg.SUPABASE_URL).replace(/\/$/, '');
  const AUTH_URL = `${SUPABASE_URL}/auth/v1`;
  const ACCOUNT_TEXT = window.FOP_ACCOUNT_TEXT || {};
  const safeJson = value => { try { return JSON.parse(value || 'null'); } catch { return null; } };
  const language = () => {
    const raw = String(document.documentElement.lang || 'en').trim().toLowerCase();
    if (raw.startsWith('zh-hant') || raw.startsWith('zh-tw') || raw.startsWith('zh-hk')) return 'zh-Hant';
    if (raw.startsWith('zh')) return 'zh-Hans';
    return raw.split('-')[0] || 'en';
  };
  const t = key => (ACCOUNT_TEXT[language()] || ACCOUNT_TEXT.en || {})[key]
    || (ACCOUNT_TEXT.en || {})[key] || key;
  const storageGet = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const storageSet = (key, value) => { try { localStorage.setItem(key, value); return true; } catch { return false; } };
  const storageRemove = key => { try { localStorage.removeItem(key); } catch { } };
  const readSession = () => safeJson(storageGet(SESSION_KEY));
  const writeSession = value => {
    if (!storageSet(SESSION_KEY, JSON.stringify(value))) throw new Error('session_storage_unavailable');
  };
  const decodeExpiry = jwt => {
    try {
      const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')));
      return Number(payload.exp) * 1000;
    } catch { return 0; }
  };
  const sameOwner = (session, ownerId) => !!session?.user?.id && session.user.id === ownerId;
  const connected = () => {
    const session = readSession();
    return typeof session?.accessToken === 'string' && typeof session?.refreshToken === 'string'
      && !!session?.user?.id;
  };
  let syncBusy = false;
  let syncAgain = false;
  let requestGeneration = 0;
  let lastSnapshot = null;
  let refreshTimer = null;

  function notifyConnectionChanged() {
    window.dispatchEvent(new Event('foc-web-account-state'));
  }

  function updateStaticLabels() {
    document.querySelectorAll('[data-account-key]').forEach(element => {
      const key = element.dataset.accountKey;
      element.textContent = t(key);
    });
  }

  function setStatus(message, isError = false) {
    const status = $('accountSyncStatus');
    if (status) {
      status.textContent = message;
      status.classList.toggle('error', isError);
    }
    const piStatus = $('piStatus');
    if (piStatus) {
      piStatus.textContent = message;
      piStatus.classList.toggle('error', isError);
    }
  }

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return t('quotaUnavailable');
    return `${new Intl.NumberFormat(language(), { maximumFractionDigits: 2 }).format(value / (1024 ** 3))} ${t('gib')}`;
  }

  function renderAccount(profile, quota, session) {
    const plan = String(quota?.plan || profile?.plan || '').toLowerCase();
    if (!['free', 'pro', 'max'].includes(plan)) throw new Error('invalid_plan');
    const remaining = Number(quota?.remaining_bytes);
    let quotaText = t('quotaUnavailable');
    if (remaining === -1) quotaText = t('unlimited');
    else if (Number.isFinite(remaining) && remaining >= 0) quotaText = formatBytes(remaining);

    const expiry = profile.plan_expires_at ? new Date(profile.plan_expires_at) : null;
    const expiryText = expiry && Number.isFinite(expiry.getTime())
      ? new Intl.DateTimeFormat(language(), { dateStyle: 'medium' }).format(expiry)
      : t('noExpiry');
    const user = session.user || {};
    const username = String(user.pi_username || user.user_metadata?.pi_username || 'Pi user').slice(0, 128);
    const email = typeof user.email === 'string' && !user.email.endsWith('@pi-auth.invalid') ? user.email : '';

    $('accountName').textContent = username;
    $('accountEmail').textContent = email ? `${t('accountEmail')}: ${email}` : t('account');
    $('accountPlanValue').textContent = t(plan);
    $('accountQuotaValue').textContent = quotaText;
    $('accountExpiryValue').textContent = expiryText;
    $('accountPlanBadge').textContent = t(plan);
    $('accountPlanBadge').dataset.plan = plan;
    const expiredPlan = String(profile.last_expired_plan || '').toLowerCase();
    $('accountPlanNote').textContent = ['free', 'pro', 'max'].includes(expiredPlan)
      ? `${t('expiredPlan')}: ${t(expiredPlan)}` : '';
    card.hidden = false;

    lastSnapshot = { ownerId: session.user.id, profile, quota, savedAt: Date.now() };
    storageSet(CACHE_KEY, JSON.stringify(lastSnapshot));
  }

  function restoreCachedAccount(session) {
    const cached = safeJson(storageGet(CACHE_KEY));
    if (!sameOwner(session, cached?.ownerId) || !cached.profile || !cached.quota) return false;
    try {
      renderAccount(cached.profile, cached.quota, session);
      return true;
    } catch {
      storageRemove(CACHE_KEY);
      return false;
    }
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
    if (!response.ok) throw new Error('account_sync_failed');
    return response;
  }

  async function refreshSession(session) {
    const expiry = decodeExpiry(session.accessToken);
    if (expiry > Date.now() + 90000) return { ...session, expiresAt: expiry };
    const response = await fetch(`${AUTH_URL}/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: cfg.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
      credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 400 || response.status === 401) throw new Error('session_expired');
      throw new Error('account_sync_failed');
    }
    if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string')
      throw new Error('account_sync_failed');
    if (data.user?.id !== session.user.id) throw new Error('session_expired');
    const updated = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      user: {
        ...(session.user || {}),
        id: session.user.id,
        email: typeof data.user?.email === 'string' && !data.user.email.endsWith('@pi-auth.invalid')
          ? data.user.email : session.user.email || null,
        pi_username: session.user?.pi_username || data.user?.user_metadata?.pi_username || null
      },
      expiresAt: decodeExpiry(data.access_token),
      piChallengeId: session.piChallengeId || null
    };
    if (!updated.expiresAt) throw new Error('account_sync_failed');
    writeSession(updated);
    return updated;
  }

  async function syncAccount() {
    if (syncBusy) { syncAgain = true; return; }
    const initial = readSession();
    if (!initial?.accessToken || !initial?.refreshToken || !initial?.user?.id) {
      card.hidden = true;
      storageRemove(CACHE_KEY);
      try { sessionStorage.removeItem('foc-pi-display'); } catch { }
      window.FOC_CLEAR_PI_DISPLAY?.();
      notifyConnectionChanged();
      return;
    }

    syncBusy = true;
    syncAgain = false;
    const generation = ++requestGeneration;
    const ownerId = initial.user.id;
    let expectedRefreshToken = initial.refreshToken;
    const isCurrent = () => {
      const current = readSession();
      return generation === requestGeneration && sameOwner(current, ownerId)
        && current.refreshToken === expectedRefreshToken;
    };
    const refreshButton = $('accountRefresh');
    if (refreshButton) refreshButton.disabled = true;
    setStatus(t('sync'));

    try {
      if (!navigator.onLine) {
        restoreCachedAccount(initial);
        setStatus(t('offline'), true);
        return;
      }
      let session = await refreshSession(initial);
      expectedRefreshToken = session.refreshToken;
      if (!isCurrent()) return;
      // Apply any expired-plan transition before reading the current plan and quota.
      await authorizedFetch('/rest/v1/rpc/refresh_subscription', session, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      });
      if (!isCurrent()) return;
      const userId = encodeURIComponent(ownerId);
      const [profileResponse, quotaResponse] = await Promise.all([
        authorizedFetch(`/rest/v1/profiles?select=plan,plan_expires_at,last_expired_plan&id=eq.${userId}`, session),
        authorizedFetch('/rest/v1/rpc/get_organization_quota_status', session, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        })
      ]);
      const [profiles, quota] = await Promise.all([profileResponse.json(), quotaResponse.json()]);
      if (!isCurrent()) return;
      if (!Array.isArray(profiles) || profiles.length !== 1 || !quota || typeof quota !== 'object')
        throw new Error('account_sync_failed');
      // Never show a response belonging to an account that has since disconnected or changed.
      const latest = readSession();
      if (!sameOwner(latest, ownerId) || latest.refreshToken !== session.refreshToken) return;
      renderAccount(profiles[0], quota, session);
      setStatus(t('synced'));
      notifyConnectionChanged();
    } catch (error) {
      if (!isCurrent()) return;
      if (error?.message === 'session_expired') {
        storageRemove(SESSION_KEY);
        storageRemove(CACHE_KEY);
        lastSnapshot = null;
        card.hidden = true;
        try { sessionStorage.removeItem('foc-pi-display'); } catch { }
        window.FOC_CLEAR_PI_DISPLAY?.();
        setStatus(t('expired'), true);
        notifyConnectionChanged();
      } else {
        restoreCachedAccount(initial);
        console.error('[FileOrganizerCore account] Account sync failed:', error?.message || 'unknown');
        setStatus(t('failed'), true);
      }
    } finally {
      syncBusy = false;
      if (refreshButton) refreshButton.disabled = false;
      if (syncAgain) { syncAgain = false; void syncAccount(); }
    }
  }

  function disconnect() {
    const session = readSession();
    requestGeneration++;
    storageRemove(SESSION_KEY);
    storageRemove(CACHE_KEY);
    lastSnapshot = null;
    card.hidden = true;
    try { sessionStorage.removeItem('foc-pi-display'); } catch { }
    window.FOC_CLEAR_PI_DISPLAY?.();
    setStatus(t('disconnected'));
    notifyConnectionChanged();
    // The browser has its own session, separate from the desktop app's independently minted session.
    if (session?.accessToken) {
      void fetch(`${AUTH_URL}/logout`, {
        method: 'POST', headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: `Bearer ${session.accessToken}` },
        credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(8000)
      }).catch(() => { });
    }
  }

  window.FOC_WEB_ACCOUNT = { isConnected: connected, disconnect };
  $('accountRefresh')?.addEventListener('click', () => { void syncAccount(); });
  $('language')?.addEventListener('change', () => {
    updateStaticLabels();
    if (lastSnapshot) void syncAccount();
  });
  const languageObserver = new MutationObserver(() => updateStaticLabels());
  languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  window.addEventListener('online', () => { void syncAccount(); $('reloadPlans')?.click(); });
  window.addEventListener('focus', () => { void syncAccount(); });
  window.addEventListener('pageshow', () => { void syncAccount(); });
  window.addEventListener('storage', event => {
    if (event.key === SESSION_KEY) { notifyConnectionChanged(); void syncAccount(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncAccount(); });
  refreshTimer = window.setInterval(() => { if (!document.hidden && navigator.onLine) void syncAccount(); }, 5 * 60 * 1000);
  window.addEventListener('pagehide', () => { if (refreshTimer) window.clearInterval(refreshTimer); });

  updateStaticLabels();
  try { sessionStorage.removeItem('foc-web-auth-pending'); } catch { }
  if (connected()) restoreCachedAccount(readSession());
  else storageRemove(CACHE_KEY);
  notifyConnectionChanged();
  void syncAccount();
})();
