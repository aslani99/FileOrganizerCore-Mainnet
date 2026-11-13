// Shared, dependency-free request validation; exercised with node --test.
export class InputError extends Error {}
export const reads = new Set(['me', 'overview', 'users', 'payments', 'plans', 'discounts', 'system']);
export const writes = new Set(['update_plan', 'upsert_discount', 'update_discount', 'delete_discount', 'reconcile_user', 'reconcile_all']);
export function canAccess(role, action) {
  if (!['owner', 'admin', 'support'].includes(role)) return false;
  return reads.has(action) || (role !== 'support' && (writes.has(action) || action === 'audit'));
}
export function integer(value, min, max) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new InputError('invalid_input');
  return value;
}
export function pageArgs(body) {
  const page = integer(body.page ?? 1, 1, 100000);
  const pageSize = integer(body.pageSize ?? 25, 1, 50);
  return { page, pageSize, from: (page - 1) * pageSize, to: page * pageSize - 1 };
}
export function searchText(value = '') {
  if (typeof value !== 'string' || value.length > 120) throw new InputError('invalid_input');
  // PostgREST OR grammar and wildcard characters must never be interpolated.
  if (/[,%_*()"\\]/.test(value)) throw new InputError('invalid_search');
  return value.trim();
}
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new InputError('invalid_input');
  return value.trim();
}
function bool(value) { if (typeof value !== 'boolean') throw new InputError('invalid_input'); return value; }
function number(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new InputError('invalid_input');
  return value;
}
export function uuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new InputError('invalid_input');
  return value;
}
export function validateWrite(action, body) {
  if (action === 'reconcile_all') return {};
  if (action === 'reconcile_user') return { user_id: uuid(body.user_id) };
  if (action === 'update_plan') {
    if (!['free', 'pro', 'max'].includes(body.plan_id)) throw new InputError('invalid_input');
    // Pi amount is derived by the rate updater; never accept a manual override.
    if ('pi_amount' in body) throw new InputError('invalid_input');
    const p = { plan_id: body.plan_id, name: text(body.name, 100),
      price_usd: number(body.price_usd, 0, 100000),
      duration_days: integer(body.duration_days, 1, 3650), is_active: bool(body.is_active) };
    if ((p.plan_id === 'free' && p.price_usd !== 0) || (p.plan_id !== 'free' && p.price_usd <= 0)) throw new InputError('invalid_input');
    return p;
  }
  if (action === 'update_discount' || action === 'delete_discount') {
    // An existing primary key is opaque. Never normalize it on an update.
    // Historical codes may be mixed-case, Unicode or contain whitespace.
    if (typeof body.code !== 'string' || !body.code.trim() || body.code.length > 256) throw new InputError('invalid_input');
    return action === 'delete_discount' ? { code:body.code } : { code: body.code, is_active: bool(body.is_active) };
  }
  const code = text(body.code, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(code)) throw new InputError('invalid_input');
  const expires = body.expires_at ?? null;
  if (expires !== null && (typeof expires !== 'string' || !Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= Date.now())) throw new InputError('invalid_input');
  const plan = body.applies_to_plan ?? null;
  if (plan !== null && !['pro', 'max'].includes(plan)) throw new InputError('invalid_input');
  return { code, discount_percent: number(body.discount_percent, 1, 100), is_active: bool(body.is_active),
    max_uses: body.max_uses == null ? null : integer(body.max_uses, 1, 2147483647),
    expires_at: expires, applies_to_plan: plan };
}
