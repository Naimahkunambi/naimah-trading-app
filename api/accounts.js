export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { appId, token } = req.body || {};
  if (!appId || !token) return res.status(400).json({ error: 'App ID and token are required.' });

  try {
    // Deriv's GET endpoint lists existing Options accounts.
    // POST on this path creates an account and requires account_manage fields,
    // which is why the old "Load accounts" flow failed.
    const r = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
      method: 'GET',
      headers: {
        'Deriv-App-ID': String(appId),
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      cache: 'no-store'
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        error: j?.errors?.[0]?.message || `Failed to load accounts (${r.status}).`
      });
    }

    const data = j?.data;
    const accounts = Array.isArray(data) ? data : [data].filter(Boolean);
    return res.status(200).json({ accounts });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Unexpected error.' });
  }
}
