import { serviceClient, activateSubscriptionForSession, jsonResponse, corsHeaders } from "../_shared/helpers.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  // Scheduler-only secret; never put this value in browser config.
  const secret = Deno.env.get("FOP_SYNC_SECRET");
  if (!secret || req.headers.get("Authorization") !== `Bearer ${secret}`) return jsonResponse({ error: "unauthorized" }, 401);
  const client = serviceClient();
  const { data: sessions, error } = await client.from("payment_sessions").select("id")
    .eq("status", "completed").eq("subscription_synced", false).order("created_at").order("id").limit(50);
  if (error) return jsonResponse({ error: "sync_failed" }, 500);
  let synced = 0;
  for (const session of sessions || []) {
    const result = await activateSubscriptionForSession(client, session);
    if (result.ok) synced++;
  }
  return jsonResponse({ ok: synced === sessions?.length, checked: sessions?.length || 0, synced, failed: (sessions?.length || 0) - synced });
});
