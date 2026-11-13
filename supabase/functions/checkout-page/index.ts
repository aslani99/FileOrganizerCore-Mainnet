// این تابع فقط یک صفحه‌ی HTML برمی‌گرداند - همان صفحه‌ای که کاربر با گوشی خودش، داخل Pi Browser، باز می‌کند.
// چون از یک Edge Function سرو می‌شود، نیازی به هاست جداگانه‌ی استاتیک (مثل یک وب‌سرور دیگر) نیست:
// همه‌چیز (دیتابیس + توابع سرور + همین صفحه) در همان پروژه‌ی Supabase شماست.
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
  if (Deno.env.get("PI_SANDBOX") !== "true") return new Response("Testnet configuration required", {status:503});
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>پرداخت اشتراک FileOrganizerCore</title>
<script src="https://sdk.minepi.com/pi-sdk.js"></script>
<style>
  body { font-family: Tahoma, sans-serif; background:#1E1E23; color:#FAFAFC; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:20px; box-sizing:border-box; }
  .card { background:#292E37; border:1px solid #3A3B47; border-radius:16px; padding:24px; max-width:380px; width:100%; text-align:center; }
  h1 { font-size:18px; margin-bottom:6px; }
  p { color:#C7CBD6; font-size:14px; }
  button { margin-top:16px; width:100%; padding:12px; border:none; border-radius:10px; background:#5B8DEF; color:white; font-size:15px; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; }
  #status { margin-top:14px; font-size:13px; color:#3DD68C; min-height:18px; }
  #status.error { color:#FF6B6B; }
</style>
<link rel="icon" href="https://fileorganizercore.ir/assets/brand/favicon.ico?v=20261110">
</head>
<body>
  <div class="card">
    <img src="https://fileorganizercore.ir/assets/brand/logo.png" alt="FileOrganizerCore" width="48" height="48" style="border-radius:10px">
<h1>خرید اشتراک</h1>
    <p id="planInfo">در حال دریافت اطلاعات پرداخت...</p>
    <button id="payButton" disabled>پرداخت با Pi</button>
    <div id="status"></div>
  </div>

<script>
  const sessionToken = ${scriptJson(token)};
  const FUNCTIONS_BASE = ${scriptJson(supabaseUrl + "/functions/v1")};
  const ANON_KEY = ${scriptJson(anonKey)};
  const PI_SANDBOX = ${JSON.stringify(Deno.env.get("PI_SANDBOX") === "true")};
  let paymentPlan = null;
  let paymentAmount = null;
  let sessionStatus = null;

  const payButton = document.getElementById('payButton');
  const statusEl = document.getElementById('status');

  let piAccessToken = null;
  let pendingIncompletePayment = null;

  async function callFunction(name, body, accessToken = null) {
    const headers = {
      'Content-Type': 'application/json',
      'apikey': ANON_KEY
    };

    if (accessToken) {
      headers['Authorization'] = 'Bearer ' + accessToken;
    } else {
      headers['Authorization'] = 'Bearer ' + ANON_KEY;
    }

    const res = await fetch(FUNCTIONS_BASE + '/' + name, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || 'خطای سرور');
    }
    return data;
  }

  async function completeIncompletePayment(payment) {
    if (!piAccessToken || !payment?.identifier || !payment?.transaction?.txid) {
      return false;
    }

    statusEl.textContent = 'در حال بازیابی پرداخت قبلی...';

    try {
      await callFunction('pi-complete', {
        sessionToken,
        paymentId: payment.identifier,
        txId: payment.transaction.txid,
        accessToken: piAccessToken
      }, piAccessToken);

      statusEl.textContent = 'پرداخت قبلی با موفقیت بازیابی شد.';
      return true;
    } catch (err) {

      return false;
    }
  }

  async function init() {
    if (!sessionToken) {
      statusEl.textContent = 'لینک پرداخت نامعتبر است.';
      statusEl.className = 'error';
      return;
    }

    if (typeof Pi === 'undefined') {
      statusEl.textContent = 'این صفحه باید داخل Pi Browser باز شود.';
      statusEl.className = 'error';
      return;
    }

    // Read the authoritative plan and amount from the server-side session.
    // Query-string values are display-only and are never trusted for the actual charge.
    const sessionResponse = await fetch(
      FUNCTIONS_BASE + '/payment-session-status?token=' + encodeURIComponent(sessionToken),
      {
        headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY }
      }
    );

    const sessionData = await sessionResponse.json().catch(() => ({}));
    if (!sessionResponse.ok || !sessionData?.status || !sessionData?.plan || sessionData?.amountPi == null) {
      throw new Error(sessionData?.error || 'جلسه پرداخت معتبر نیست.');
    }

    sessionStatus = sessionData.status === 'pending' && sessionData.hasLinkedPayment ? 'approved' : sessionData.status;
    paymentPlan = String(sessionData.plan);
    paymentAmount = Number(sessionData.amountPi);

    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      throw new Error('مبلغ پرداخت معتبر نیست.');
    }

    document.getElementById('planInfo').textContent =
      'پلن ' + paymentPlan + ' — ' + paymentAmount + ' پای';

    if (sessionStatus === 'completed') {
      statusEl.textContent = 'این پرداخت قبلاً تکمیل شده است.';
      return;
    }

    if (sessionStatus === 'cancelled' || sessionStatus === 'error') {
      statusEl.textContent = 'این جلسه پرداخت دیگر فعال نیست.';
      statusEl.className = 'error';
      return;
    }

    // Sandbox is enabled only when the Edge Function environment explicitly says so.
    // Production therefore requires PI_SANDBOX=false.
    await Pi.init({ version: '2.0', sandbox: PI_SANDBOX });

    payButton.disabled = false;
  }

  payButton.addEventListener('click', async () => {
    payButton.disabled = true;
    statusEl.className = '';
    statusEl.textContent = 'در حال احراز هویت با Pi...';

    try {
      const auth = await Pi.authenticate(
        ['username', 'payments'],
        (incompletePayment) => {
          // The SDK can report an incomplete payment before authenticate() resolves.
          // Keep it in memory and recover it immediately after the verified token arrives.
          pendingIncompletePayment = incompletePayment;
        }
      );

      piAccessToken = auth?.accessToken;
      if (!piAccessToken) {
        throw new Error('توکن احراز هویت Pi دریافت نشد.');
      }

      if (pendingIncompletePayment) {
        const recovered = await completeIncompletePayment(pendingIncompletePayment);
        pendingIncompletePayment = null;
        if (!recovered) {
          throw new Error('پرداخت قبلی کامل‌نشده قابل بازیابی نیست.');
        }

        statusEl.textContent = 'پرداخت قبلی با موفقیت بازیابی شد.';
        payButton.disabled = true;
        return;
      }

      if (sessionStatus === 'approved') {
        throw new Error('یک پرداخت قبلی برای این جلسه در حال تکمیل است. صفحه را باز نگه دارید تا بازیابی شود.');
      }

      statusEl.textContent = 'در حال ایجاد پرداخت...';

      await Pi.createPayment(
        {
          amount: paymentAmount,
          memo: 'FileOrganizerCore',
          metadata: { sessionToken }
        },
        {
          onReadyForServerApproval: async (paymentId) => {
            statusEl.textContent = 'در حال تأیید پرداخت توسط سرور...';
            await callFunction(
              'pi-approve',
              { sessionToken, paymentId, accessToken: piAccessToken },
              piAccessToken
            );
          },

          onReadyForServerCompletion: async (paymentId, txid) => {
            statusEl.textContent = 'در حال تکمیل پرداخت...';

            await callFunction(
              'pi-complete',
              { sessionToken, paymentId, txId: txid, accessToken: piAccessToken },
              piAccessToken
            );

            statusEl.textContent = 'پرداخت با موفقیت انجام شد! می‌توانید این صفحه را ببندید و به اپ برگردید.';
          },

          onCancel: async (paymentId) => {
            statusEl.textContent = 'پرداخت لغو شد.';
            statusEl.className = 'error';

            if (piAccessToken) {
              await callFunction(
                'pi-cancel',
                { sessionToken, paymentId, accessToken: piAccessToken },
                piAccessToken
              ).catch(() => {});
            }

            payButton.disabled = true;
            statusEl.textContent += ' برای تلاش دوباره، از برنامه لینک جدید بگیرید.';
          },

          onError: async (error, payment) => {

            statusEl.textContent =
              'خطا در پرداخت: ' + (error?.message || 'نامشخص');
            statusEl.className = 'error';
            payButton.disabled = false;
          }
        }
      );
    } catch (err) {

      statusEl.textContent = 'خطا: ' + (err?.message || err);
      statusEl.className = 'error';
      payButton.disabled = false;
    }
  });

  init().catch((err) => {

    statusEl.textContent = 'راه‌اندازی پرداخت انجام نشد.';
    statusEl.className = 'error';
  });
</script>
</body>
</html>`;

  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });

  return new Response(html, {
    status: 200,
    headers,
  });
});
