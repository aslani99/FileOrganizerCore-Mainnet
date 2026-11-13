import { serviceClient, corsHeaders } from "../_shared/helpers.ts";
import { canAccess, pageArgs, searchText, validateWrite, InputError, writes } from "./validation.mjs";

const client = serviceClient();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});
function checked(result: any) { if (result.error) throw result.error; return result; }
const rows = (result: any) => checked(result).data || [];
async function withAccounts(items: any[], key = "user_id") {
  const ids = [...new Set(items.map(row => row[key]).filter(Boolean))];
  if (!ids.length) return items;
  const [profiles, identities] = await Promise.all([
    client.from("profiles").select("id,email").in("id", ids),
    client.from("pi_account_identities").select("user_id,username").in("user_id", ids),
  ]);
  const emails = new Map(rows(profiles).map((p: any) => [p.id,
    p.email && !p.email.toLowerCase().endsWith("@pi-auth.invalid") ? p.email : null]));
  const usernames = new Map<string, string[]>();
  for (const identity of rows(identities)) {
    if (!identity.username) continue;
    const names = usernames.get(identity.user_id) || [];
    if (!names.includes(identity.username)) names.push(identity.username);
    usernames.set(identity.user_id, names);
  }
  return items.map(row => ({ ...row, email: emails.get(row[key]) || null,
    pi_usernames: usernames.get(row[key]) || [] }));
}

export async function handle(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const token = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json({ error: "unauthorized" }, 401);
  const { data: auth, error } = await client.auth.getUser(token);
  if (error || !auth.user) return json({ error: "unauthorized" }, 401);
  const admin = checked(await client.from("admin_users").select("user_id,role,is_active").eq("user_id", auth.user.id).maybeSingle()).data;
  if (!admin?.is_active) return json({ error: "forbidden" }, 403);
  const raw = await req.text();
  if (raw.length > 16384) return json({ error: "invalid_input" }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "invalid_input" }, 400); }
  if (!body || Array.isArray(body) || typeof body !== "object") return json({ error: "invalid_input" }, 400);
  const action = body.action;
  if (!canAccess(admin.role, action)) return json({ error: "forbidden" }, 403);
  if (action === "me") return json({ authorized: true, role: admin.role });

  if (writes.has(action)) {
    const payload = validateWrite(action, body);
    if (action === "delete_discount") return json(checked(await client.rpc("admin_delete_discount", { p_admin: admin.user_id, p_code: payload.code })).data);
    // The RPC rechecks the role and commits the mutation + audit in one transaction.
    if (action !== "reconcile_all") return json(checked(await client.rpc("admin_mutate", { p_admin: admin.user_id, p_action: action, p_body: payload })).data);
    const pending = rows(await client.from("payment_sessions").select("user_id").eq("status", "completed").eq("subscription_synced", false).order("created_at").order("id").limit(50));
    const userIds = [...new Set(pending.map((row: any) => row.user_id))];
    const results = [];
    for (const userId of userIds) {
      const result = await client.rpc("admin_mutate", { p_admin: admin.user_id, p_action: "reconcile_user", p_body: { user_id: userId } });
      results.push({ userId, ok: !result.error, error: result.error ? "repair_failed" : null, repaired: result.data?.repaired ?? 0 });
    }
    const remaining = checked(await client.from("payment_sessions").select("id", { count: "exact", head: true }).eq("status", "completed").eq("subscription_synced", false)).count;
    return json({ checkedUsers: userIds.length, reconciledUsers: results.filter(r => r.ok).length, remaining, results });
  }
  if (action === "overview") {
    const [stats, payments, users] = await Promise.all([
      client.rpc("admin_overview_stats"),
      client.from("payment_sessions").select("user_id,requested_plan,amount_pi,status,created_at").order("created_at", { ascending: false }).order("id").limit(8),
      client.from("profiles").select("id,email,plan,plan_expires_at,created_at").order("created_at", { ascending: false }).order("id").limit(8),
    ]);
    return json({ stats: checked(stats).data, recentPayments: await withAccounts(rows(payments)), recentUsers: await withAccounts(rows(users), "id") });
  }
  if (action === "users" || action === "payments" || action === "discounts" || action === "audit") {
    const { page, pageSize, from, to } = pageArgs(body);
    const search = searchText(body.search);
    const tables: Record<string, [string, string, string]> = {
      users: ["profiles", "id,email,plan,plan_expires_at,bytes_organized_total,created_at", "id"],
      payments: ["payment_sessions", "id,user_id,requested_plan,amount_pi,status,pi_payment_id,tx_id,pi_user_uid,discount_code,subscription_synced,created_at", "id"],
      discounts: ["discount_codes", "code,discount_percent,is_active,max_uses,used_count,expires_at,applies_to_plan,created_at", "code"],
      audit: ["admin_audit_logs", "id,admin_user_id,action,target_type,target_id,metadata,created_at", "id"],
    };
    const [table, fields, key] = tables[action];
    let q = client.from(table).select(fields, { count: "exact" }).order("created_at", { ascending: false }).order(key).range(from, to);
    if (search) {
      if (action === "payments") q = q.or(`status.ilike.%${search}%,pi_user_uid.ilike.%${search}%`);
      else q = q.ilike(action === "users" ? "email" : action === "discounts" ? "code" : "action", `%${search}%`);
    }
    if (action === "payments" && body.status) {
      if (!["pending", "approved", "completed", "cancelled", "error"].includes(body.status)) throw new InputError("invalid_input");
      q = q.eq("status", body.status);
    }
    const result = checked(await q);
    let items = result.data || [];
    if (action === "payments") items = await withAccounts(items);
    if (action === "users" && items.length) {
      items = await withAccounts(items, "id");
      const stats = rows(await client.rpc("admin_user_payment_stats", { p_ids: items.map((u: any) => u.id) }));
      const byId = new Map(stats.map((s: any) => [s.user_id, s]));
      items = items.map((u: any) => ({ ...u, ...(byId.get(u.id) || { completed_payment_count: 0, unsynced_completed_count: 0 }) }));
    }
    return json({ items, total: result.count, page, hasMore: result.count > page * pageSize });
  }
  if (action === "plans") return json({ items: rows(await client.from("plans").select("plan_id,name,price_usd,pi_amount,duration_days,is_active,pi_rate_updated_at,pi_rate_source").order("display_order").order("plan_id")) });
  if (action === "system") {
    const rate = checked(await client.from("pi_rate").select("usd_rate,updated_at,source").eq("id", 1).maybeSingle()).data;
    const pending = checked(await client.from("payment_sessions").select("id", { count: "exact", head: true }).eq("status", "completed").eq("subscription_synced", false)).count;
    return json({ role: admin.role, rate, unsynced: pending, serverTime: new Date().toISOString() });
  }
  return json({ error: "invalid_input" }, 400);
}
Deno.serve(async req => {
  try { return await handle(req); }
  catch (error: any) {
    if (error instanceof InputError) return json({ error: error.message }, 400);
    if (error?.code === "23505") return json({ error: "already_exists" }, 409);
    if (error?.message === "rate_stale") return json({ error: "rateStale" }, 409);
    if (error?.message === "legacy_duration_required") return json({ error: "legacy_duration_required" }, 409);
    const requestId = crypto.randomUUID();
    const knownCodes: Record<string, string> = {
      "42501": "database_permissions", "P0002": "record_not_found",
      "PGRST202": "backend_not_ready", "42883": "backend_not_ready",
      "42P01": "backend_not_ready", "42703": "backend_not_ready",
      "23514": "constraint_failed", "23502": "constraint_failed",
    };
    if (error?.code === "22023") return json({ error: "invalid_input" }, 400);
    // Correlate the UI error with the server log without logging tokens or row values.
    console.error("[admin-api] operation failed", { requestId, code: error?.code || "internal" });
    return json({ error: knownCodes[error?.code] || "operation_failed", requestId }, error?.code === "P0002" ? 404 : 500);
  }
});
