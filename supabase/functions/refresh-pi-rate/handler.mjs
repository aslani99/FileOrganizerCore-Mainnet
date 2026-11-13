// Dependency injection keeps provider/auth failure paths testable without network access.
export function createRateHandler({ client, fetcher = fetch, env, now = Date.now }) {
  const reply = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store' }
  });
  return async req => {
    if (req.method !== 'POST') return reply({ error:'method_not_allowed' },405);
    const secret = env('FOP_RATE_SECRET');
    if (!secret || req.headers.get('Authorization') !== `Bearer ${secret}`) return reply({ error:'unauthorized' },401);
    try {
      const key = env('COINGECKO_DEMO_API_KEY');
      const response = await fetcher('https://api.coingecko.com/api/v3/simple/price?ids=pi-network&vs_currencies=usd&include_last_updated_at=true', {
        headers: key ? { 'x-cg-demo-api-key':key } : {}, signal:AbortSignal.timeout(10000)
      });
      if (!response.ok) return reply({ error:'provider_unavailable', providerStatus:response.status },502);
      const data = (await response.json())?.['pi-network'];
      const rate = data?.usd, observed = data?.last_updated_at;
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 ||
          typeof observed !== 'number' || !Number.isSafeInteger(observed) ||
          observed * 1000 < now() - 15 * 60000 || observed * 1000 > now() + 60000) {
        return reply({ error:'invalid_or_stale_provider_data' },502);
      }
      const { data: result, error } = await client.rpc('apply_pi_rate', {
        p_usd:rate, p_observed:new Date(observed * 1000).toISOString()
      });
      if (error) return reply({ error:'rate_save_failed' },500);
      return reply({ ok:true, ...result });
    } catch { return reply({ error:'rate_refresh_failed' },502); }
  };
}
