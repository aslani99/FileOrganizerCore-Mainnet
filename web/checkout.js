(() => {
  'use strict';
  const cfg = window.FOP_CONFIG;
  const token = new URLSearchParams(location.search).get('token');
  const status = document.getElementById('status'), details = document.getElementById('details'), button = document.getElementById('payButton');
  const T = window.FOP_I18N.text;
  button.textContent = T.pay;
  document.getElementById('summary-label').textContent = T.summary;
  document.getElementById('checkout-heading').textContent = T.heading;
  document.getElementById('browser-note').textContent = T.browserNote;
  document.title = 'FileOrganizerCore — ' + T.pay;
  function closePage(key) {
    clearTimeout(verificationTimer);
    terminal = true; button.disabled = true; button.classList.add('hidden'); show(T[key]);
  }
  function showError(error) {
    const code = error?.code || error?.message;
    if (['session_expired','session_closed','session_not_found','invalid_token'].includes(code)) { closePage('closed'); return; }
    if (code === 'payment_verification_pending') { waitForVerification(); return; }
    if (code === 'payment_cancelled') { closePage('cancelled'); return; }
    show(code === 'network_error' ? T.network : code === 'request_timeout' ? T.timeout : T.error, true);
  }
  let verificationTimer, verificationToken = token, verificationWaiting = false;
  let busy = false, terminal = false, paymentInFlight = false, session, accessToken, recoveryPromise, incompleteSeen = false, incompletePayment;
  const show = (text, error = false) => {
    status.textContent = text;
    status.className = error ? 'error' : '';
    // Presentation only: never use visual state to authorize or retry a payment.
    if (document.body) document.body.dataset.state = error ? 'error'
      : text === T.success ? 'success'
      : text === T.closed || text === T.cancelled ? 'closed'
      : text === T.ready ? 'ready'
      : text === T.unfinished || text === T.syncPending || text === T.follow ? 'waiting' : 'checking';
  };
  function renderSession(data) {
    const amount = Number(data.amountPi);
    if (!['pro', 'max'].includes(data.plan) || !Number.isFinite(amount) || amount <= 0) return;
    document.getElementById('summary-label').textContent = T.summary + ' · ' + T[data.plan];
    document.getElementById('plan-label').textContent = T.amountLabel;
    document.getElementById('plan-amount').textContent = window.FOP_I18N.number(amount);
    details.classList.remove('hidden');
  }
  async function request(name, body) {
    
    let response;
    try { response = await fetch(cfg.SUPABASE_URL + '/functions/v1/' + name, {
      method: body ? 'POST' : 'GET', headers: {apikey: cfg.SUPABASE_ANON_KEY, ...(body ? {'Content-Type':'application/json'} : {})},
      ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(25000), cache:'no-store'
    });
    } catch(error) {
      throw Object.assign(new Error('request_failed'), {code:['TimeoutError','AbortError'].includes(error?.name)?'request_timeout':'network_error'});
    }
    const data = await response.json().catch(() => ({}));
    
    if (!response.ok) {  throw Object.assign(new Error('request_failed'), {code:data.error}); }
    return data;
  }
  async function loadSession() {
    const data = await request('payment-session-status?token=' + encodeURIComponent(token));
    if (!['pending','approved','completed','cancelled','error'].includes(data.status)) throw new Error('Invalid session response.');
    return data;
  }
  // One polling chain; a pending verification never enables a second purchase.
  function waitForVerification(sessionToken, allowRecovery = false) {
    verificationToken = sessionToken || verificationToken;
    verificationWaiting = true;
    terminal = !allowRecovery; button.disabled = !allowRecovery;
    if (allowRecovery) { button.textContent = T.checking; button.classList.remove('hidden'); }
    else button.classList.add('hidden');
    show(T.unfinished);
    clearTimeout(verificationTimer);
    verificationTimer = setTimeout(pollVerification, 8000);
  }
  async function pollVerification() {
    let delay = 8000;
    try {
      const current = await request('payment-session-status?token=' + encodeURIComponent(verificationToken));
      if (current.status === 'completed') {
        if (!current.subscriptionPendingSync) { verificationWaiting = false; finish(current); return; }
        show(T.syncPending);
      } else {
        // Even a provider cancellation does not prove that a transfer was refunded.
        show(T.unfinished);
      }
    } catch (_) {
      show(T.network, true);
      delay = 20000;
    }
    if (verificationWaiting) verificationTimer = setTimeout(pollVerification, delay);
  }
  window.addEventListener('pagehide', () => {
    verificationWaiting = false; clearTimeout(verificationTimer);
  });
  function finish(data) {
    if (data.subscriptionPendingSync) { waitForVerification(); show(T.syncPending); return; }
    verificationWaiting = false; clearTimeout(verificationTimer);
    
    terminal = true; button.disabled = true; button.classList.add('hidden');
    show(data.subscriptionPendingSync ? T.syncPending : T.success);
  }
  function recover(payment) {
    
    incompleteSeen = true;
    incompletePayment = payment;
    // Authentication can deliver this callback before its promise resolves.
    // Process it after we have the verified Pi identity.
    if (!accessToken) return Promise.resolve();
    return reconcile(payment?.identifier);
  }
  async function reconcile(paymentId, allowReplacement = false) {
    if (recoveryPromise) return recoveryPromise;
    
    show(T.checking);
    recoveryPromise = request('pi-complete', {recovery:true, sessionToken:token, ...(paymentId?{paymentId}:{}), accessToken})
      .then(result => {
        if (result.awaitingConfirmation) {
          waitForVerification(result.recoverySessionToken);
        } else if (result.cancelled) {
          terminal = true; button.disabled = true;
          closePage('cancelled');
        } else { finish(result); }
      }).catch(error => {
        
        waitForVerification();
        showError(error);
      }).finally(() => {
        recoveryPromise = null;
        if (!busy && !terminal && !paymentInFlight) button.disabled = false;
      });
    return recoveryPromise;
  }
  async function callback(name, body, success) {
    try { const result = await request(name, body); success?.(result); return result; }
    catch (error) { if (name === 'pi-complete') waitForVerification(); showError(error); throw error; }
  }
  button.addEventListener('click', async () => {
    if (busy || terminal || paymentInFlight) return;
    busy = true; button.disabled = true;
    try {
      incompleteSeen = false; incompletePayment = null; accessToken = null;
      session = await loadSession();
      renderSession(session);
      if (session.status === 'completed') { finish(session); return; }
      if (!['pending','approved'].includes(session.status)) { terminal = true; closePage(session.status === 'cancelled' ? 'cancelled' : 'closed'); return; }
      if (!window.Pi) throw new Error('Open this link in Pi Browser.');
      
      await Pi.init({version:'2.0', sandbox:cfg.PI_SANDBOX === true});
      
      show(T.checking);
      
      // A slow wallet interaction must not be cancelled or followed by a second auth call.
      const waitingNotice = setTimeout(() => {
        if (!incompleteSeen && !terminal) {
          
          show(T.follow);
        }
      }, 15000);
      let auth;
      try {
        const result = Pi.authenticate(['username','payments'], recover);
        
        auth = await result;
        
      } catch(error) {  throw error; }
      finally { clearTimeout(waitingNotice); }
      accessToken = auth?.accessToken;
      
      if (!accessToken) throw new Error('Pi authentication was not completed.');
      if (incompleteSeen && await reconcile(incompletePayment?.identifier, true) !== true) return;
      if (session.status === 'approved' || session.hasLinkedPayment) {
        await reconcile(); return;
      }
      const amount = Number(session.amountPi);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid payment amount.');
      show(T.checking);
      
      paymentInFlight = true;
      await Pi.createPayment({amount, memo:'FileOrganizerCore', metadata:{sessionToken:token}}, {
        onReadyForServerApproval: id => callback('pi-approve',{sessionToken:token,paymentId:id,accessToken},() => show(T.follow)),
        onReadyForServerCompletion: (id,txId) => callback('pi-complete',{sessionToken:token,paymentId:id,txId,accessToken},finish),
        onCancel: async id => {
          terminal = true; button.disabled = true;
          try {
            const result = await request('pi-cancel',{sessionToken:token,paymentId:id,accessToken});
            if(result.awaitingConfirmation) { waitForVerification(result.recoverySessionToken); return; }
            if(result.alreadyCompleted) finish(await loadSession());
            else closePage('cancelled');
          } catch(error) { showError(error); }
        },
        onError: () => {
          // The SDK may deliver an incomplete-payment callback after onError.
          terminal = true; button.disabled = true;
          if (!incompleteSeen) waitForVerification();
        }
      });
    } catch(error) { if (paymentInFlight) waitForVerification(); paymentInFlight = false;  showError(error); }
    finally { busy = false; if (!terminal && !paymentInFlight) button.disabled = false; }
  });
  (async () => {
    show(T.checking);
    try {
      if (!token || token.length > 512) throw Object.assign(new Error('invalid_token'), {code:'invalid_token'});
      if (!cfg?.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) throw new Error('Checkout configuration is missing.');
      session = await loadSession();
      renderSession(session);
      if (session.status === 'completed') { finish(session); return; }
      if (!['pending','approved'].includes(session.status)) { terminal = true; closePage(session.status === 'cancelled' ? 'cancelled' : 'closed'); return; }
      
      if (session.hasLinkedPayment || session.status === 'approved') { waitForVerification(undefined, true); return; }
      show(T.ready); button.classList.remove('hidden');
    } catch(error) { showError(error); if (!terminal) { button.disabled = false; button.classList.remove('hidden'); } }
  })();
})();
