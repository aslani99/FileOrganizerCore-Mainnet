-- 9 GiB = 9 * 1024^3. Preserve consumption, reservations and trial dates.
BEGIN;
DO $quota$
DECLARE item record; definition text; repaired text;
BEGIN
  IF to_regclass('public.free_organization_routes') IS NULL
     OR to_regclass('public.organization_quota_reservations') IS NULL THEN
    RAISE EXCEPTION 'Quota tables are missing; install the quota service before this migration.';
  END IF;
  UPDATE public.plans SET organization_limit_bytes=9663676416
  WHERE plan_id='free';
  IF NOT FOUND THEN RAISE EXCEPTION 'Free plan is missing; no changes applied.'; END IF;

  -- Retain deployed fixes (ownership checks, locking, expiry and idempotence).
  -- Never replace newer RPCs with an old schema dump.
  FOR item IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind='f'
      AND p.proname IN ('begin_organization','complete_organization','get_organization_quota_status')
  LOOP
    definition:=pg_get_functiondef(item.oid);
    repaired:=regexp_replace(definition, '\m6442450944\M', '9663676416', 'g');
    IF repaired<>definition THEN EXECUTE repaired; END IF;
  END LOOP;

  FOR item IN
    SELECT conname, pg_get_constraintdef(oid) AS definition, convalidated
    FROM pg_constraint
    WHERE conrelid='public.free_organization_routes'::regclass AND contype='c'
  LOOP
    IF item.definition ~ '\mused_bytes\M' AND item.definition ~ '\m6442450944\M' THEN
      repaired:=regexp_replace(item.definition,'\m6442450944\M','9663676416','g');
      EXECUTE format('ALTER TABLE public.free_organization_routes DROP CONSTRAINT %I',item.conname);
      EXECUTE format('ALTER TABLE public.free_organization_routes ADD CONSTRAINT %I %s',item.conname,repaired);
    END IF;
  END LOOP;
END;
$quota$;
COMMIT;

-- Read-only verification. Expected cap: 9663676416; old-cap count: 0.
SELECT plan_id, organization_limit_bytes FROM public.plans WHERE plan_id='free';
SELECT count(*) AS quota_functions_with_old_6gib_cap
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prokind='f'
  AND p.proname IN ('begin_organization','complete_organization','get_organization_quota_status')
  AND p.prosrc ~ '\m6442450944\M';
