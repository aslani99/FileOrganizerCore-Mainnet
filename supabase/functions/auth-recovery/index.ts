const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const html = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FileOrganizerCore — تغییر رمز عبور</title>
<style>
body{font-family:Tahoma,Arial,sans-serif;background:#15171c;color:#f5f7fb;min-height:100vh;margin:0;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box}
.card{width:min(420px,100%);background:#242832;border:1px solid #3a3f4a;border-radius:18px;padding:26px;box-sizing:border-box;box-shadow:0 16px 50px #0006}
h1{font-size:21px;margin:0 0 8px}.muted{color:#b9bfca;font-size:13px;line-height:1.8}label{display:block;margin-top:18px;font-size:13px}input{width:100%;box-sizing:border-box;margin-top:7px;padding:12px;border-radius:10px;border:1px solid #454b58;background:#171a20;color:#fff;outline:none}button{width:100%;margin-top:20px;padding:12px;border:0;border-radius:10px;background:#5b8def;color:#fff;font-weight:700;cursor:pointer}button:disabled{opacity:.5;cursor:default}.msg{margin-top:14px;font-size:13px;line-height:1.7}.error{color:#ff7777}.ok{color:#49d68b}
</style>
<link rel="icon" href="https://fileorganizercore.ir/assets/brand/favicon.ico?v=20261110">
</head>
<body>
<div class="card">
<img src="https://fileorganizercore.ir/assets/brand/logo.png" alt="FileOrganizerCore" width="48" height="48" style="border-radius:10px">
<h1>تغییر رمز عبور</h1>
<p id="intro" class="muted">رمز جدید خود را وارد کنید. این صفحه از لینک امن احراز هویت FileOrganizerCore استفاده می‌کند.</p>
<form id="form">
<label>رمز عبور جدید<input id="password" type="password" minlength="8" autocomplete="new-password" required></label>
<label>تکرار رمز عبور<input id="confirm" type="password" minlength="8" autocomplete="new-password" required></label>
<button id="submit" type="submit">ذخیره رمز جدید</button>
</form>
<div id="msg" class="msg"></div>
</div>
<script>
const SUPABASE_URL = ${JSON.stringify(supabaseUrl)};
const ANON_KEY = ${JSON.stringify(anonKey)};
const params = new URLSearchParams(location.hash.slice(1));
const accessToken = params.get('access_token');
const type = params.get('type');
const errorDescription = params.get('error_description');
const errorCode = params.get('error_code');
const msg = document.getElementById('msg');
const form = document.getElementById('form');
const submit = document.getElementById('submit');

if (errorDescription || params.get('error_code')) {
  msg.className = 'msg error';
  msg.textContent = 'لینک احراز هویت معتبر نیست یا منقضی شده است. لطفاً از ایمیل جدیدی که دریافت کرده‌اید استفاده کنید.';
  form.style.display = 'none';
} else if (!accessToken || !['recovery', 'signup'].includes(type)) {
  msg.className = 'msg error';
  msg.textContent = 'لینک احراز هویت معتبر نیست یا منقضی شده است.';
  form.style.display = 'none';
} else if (type === 'signup') {
  form.style.display = 'none';
  intro.textContent = 'ایمیل شما با موفقیت تأیید شد. اکنون می‌توانید برنامه FileOrganizerCore را باز کرده و وارد شوید.';
  msg.className = 'msg ok';
  msg.textContent = 'تأیید ایمیل با موفقیت انجام شد.';
  history.replaceState({}, document.title, location.pathname + location.search);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = document.getElementById('password').value;
  const confirm = document.getElementById('confirm').value;
  msg.className = 'msg';
  msg.textContent = '';

  if (password.length < 8) {
    msg.className = 'msg error';
    msg.textContent = 'رمز عبور باید حداقل ۸ کاراکتر باشد.';
    return;
  }
  if (password !== confirm) {
    msg.className = 'msg error';
    msg.textContent = 'تکرار رمز عبور یکسان نیست.';
    return;
  }

  submit.disabled = true;
  try {
    const response = await fetch(SUPABASE_URL + '/auth/v1/user', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'apikey': ANON_KEY,
        'Authorization': 'Bearer ' + accessToken
      },
      body: JSON.stringify({ password })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.msg || data?.message || 'تغییر رمز عبور انجام نشد.');

    form.style.display = 'none';
    msg.className = 'msg ok';
    msg.textContent = 'رمز عبور با موفقیت تغییر کرد. اکنون می‌توانید به FileOrganizerCore برگردید و وارد شوید.';
    history.replaceState({}, document.title, location.pathname + location.search);
  } catch (error) {
    msg.className = 'msg error';
    msg.textContent = error?.message || 'تغییر رمز عبور انجام نشد.';
    submit.disabled = false;
  }
});
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
});
