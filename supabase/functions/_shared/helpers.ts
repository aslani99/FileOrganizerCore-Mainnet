// این فایل بین همه‌ی Edge Function ها مشترک است.
// SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY به‌صورت خودکار توسط Supabase در محیط اجرای هر Function موجودند
// (نیازی به ست‌کردن دستی نیست)؛ کلید سرویس (service role) اجازه می‌دهد RLS دور زده شود، چون این کد
// همیشه سمت سرور (نه مرورگر/کلاینت) اجرا می‌شود.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, serviceKey);
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/// کاربر را از هدر Authorization: Bearer <token> (که اپ دسکتاپ بعد از لاگین می‌فرستد) تشخیص می‌دهد
export async function getUserFromRequest(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) return null;

  const client = serviceClient();
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

/// دیگر پیکربندی پلن‌ها هارد-کد نیست؛ همه‌چیز (قیمت، مدت، مبلغ پای) از جدول public.plans در دیتابیس
/// خوانده می‌شود تا بتوان بدون ریلیز جدید اپ دسکتاپ، قیمت/تخفیف/مدت را از طریق Supabase Dashboard تغییر داد.
export async function getPlan(planId: "pro" | "max") {
  const client = serviceClient();
  const { data, error } = await client
    .from("plans")
    .select("plan_id, price_usd, pi_amount, duration_days, is_active, pi_rate_updated_at")
    .eq("plan_id", planId)
    .single();

  if (error || !data || !data.is_active) return null;
  return data as {
    plan_id: string;
    price_usd: number;
    pi_amount: number;
    duration_days: number;
    is_active: boolean;
    pi_rate_updated_at: string | null;
  };
}

export const PI_PLATFORM_API_BASE = "https://api.minepi.com/v2";

/// جزئیات یک پرداخت را از سرورهای Pi می‌گیرد (برای تأیید مبلغ/کاربر قبل از تکمیل - نه صرفاً اعتماد به کلاینت)
export async function getPiUserFromAccessToken(accessToken: string) {
  if (!accessToken?.trim()) return null;

  try {
    const resp = await fetch(`${PI_PLATFORM_API_BASE}/me`, {
      headers: { Authorization: `Bearer ${accessToken.trim()}` },
    });
    if (!resp.ok) return null;

    const data = await resp.json();
    const uid = data?.uid ?? data?.user?.uid;
    return typeof uid === "string" && uid.trim() ? uid.trim() : null;
  } catch {
    return null;
  }
}

export const PAYMENT_SESSION_TTL_MS = 30 * 60 * 1000;

export function isPaymentSessionExpired(createdAt: string | null | undefined) {
  if (!createdAt) return true;
  const created = Date.parse(createdAt);
  return !Number.isFinite(created) || Date.now() - created > PAYMENT_SESSION_TTL_MS;
}

export async function getPiPayment(paymentId: string) {
  const piKey = Deno.env.get("PI_SERVER_API_KEY")!;
  console.log("[pi-payment] payment lookup request", {
    hasPaymentId: Boolean(paymentId?.trim()),
    hasServerApiKey: Boolean(piKey?.trim()),
  });

  try {
    const resp = await fetch(`${PI_PLATFORM_API_BASE}/payments/${paymentId}`, {
      headers: { Authorization: `Key ${piKey}` },
    });

    console.log("[pi-payment] payment lookup response", {
      status: resp.status,
      ok: resp.ok,
    });

    if (!resp.ok) {
      const details = await resp.text().catch(() => "");
      console.warn("[pi-payment] payment lookup failed", {
        status: resp.status,
        details: details.slice(0, 500),
      });
      return null;
    }

    const data = await resp.json();
    console.log("[pi-payment] payment lookup succeeded", {
      hasPayment: Boolean(data),
      status: data?.status,
      amount: data?.amount,
      direction: data?.direction,
      network: data?.network,
      userUidPresent: Boolean(data?.user_uid),
    });
    return data;
  } catch (error) {
    console.error("[pi-payment] payment lookup exception", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/// منطق واحد "فعال‌سازی/جمع‌زدن مدت اشتراک" - هم از pi-complete (مسیر معمول، بلافاصله بعد از
/// تکمیل پرداخت) و هم از payment-session-status (مسیر جبرانی: وقتی پرداخت completed شده ولی به
/// هر دلیلی - مثلاً یک خطای لحظه‌ای دیتابیس - بار اول آپدیت profiles fail شده بود) صدا زده می‌شود.
/// چون همیشه دقیقاً همین یک تابع مسئول محاسبه‌ی stacking است، این دو مسیر هیچ‌وقت نمی‌توانند با
/// هم ناهماهنگ شوند یا منطق تکراری داشته باشند.
///
/// The database atomically locks, activates and marks a completed session synced.
/// Repeated/concurrent calls do not extend the subscription twice.
export async function activateSubscriptionForSession(
  client: ReturnType<typeof serviceClient>,
  session: { id: string },
): Promise<{ ok: boolean; expiresAt?: string; newPlan?: string; error?: unknown }> {
  const { data, error } = await client.rpc("activate_payment_subscription", { p_session_id: session.id });
  if (error) return { ok: false, error };
  return data;
}
