-- UI guidance only. Never changes payment status, amounts, discounts or entitlement.
ALTER TABLE public.payment_sessions
  ADD COLUMN IF NOT EXISTS recovery_requires_new_checkout boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.mark_payment_restart_required(
  p_session_id uuid, p_payment text, p_uid text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE affected integer;
BEGIN
  UPDATE public.payment_sessions SET recovery_requires_new_checkout = true
  WHERE id = p_session_id AND pi_payment_id = p_payment AND pi_user_uid = p_uid
    AND status IN ('pending', 'approved') AND tx_id IS NULL
    AND subscription_synced IS NOT TRUE;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_payment_restart_required(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_payment_restart_required(uuid,text,text) TO service_role;
