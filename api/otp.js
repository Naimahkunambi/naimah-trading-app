const optionsHeaders = (appId, token) => ({
  'Deriv-App-ID': String(appId),
  Authorization: `Bearer ${token}`,
  Accept: 'application/json'
});

const errorMessage = (payload, fallback) => payload?.errors?.[0]?.message || fallback;

export function createOtpHandler(fetchImpl = fetch) {
  return async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { appId, token, accountId, demoOnly = false } = req.body || {};
  if (!appId || !token || !accountId) return res.status(400).json({ error: 'App ID, token and account ID are required.' });

  try {
    let verifiedAccount = null;
    if (demoOnly) {
      const accountsResponse = await fetchImpl('https://api.derivws.com/trading/v1/options/accounts', {
        method: 'GET',
        headers: optionsHeaders(appId, token),
        cache: 'no-store'
      });
      const accountsPayload = await accountsResponse.json().catch(() => ({}));
      if (!accountsResponse.ok) {
        return res.status(accountsResponse.status).json({
          error: errorMessage(accountsPayload, 'Could not verify the selected Demo account.')
        });
      }
      const accounts = Array.isArray(accountsPayload?.data) ? accountsPayload.data : [accountsPayload?.data].filter(Boolean);
      verifiedAccount = accounts.find(account => String(account?.account_id || '') === String(accountId));
      if (!verifiedAccount) return res.status(403).json({ error: 'REFUSED: selected account was not returned by Deriv.' });
      const type = String(verifiedAccount.account_type || '').toLowerCase();
      if (!['demo', 'virtual'].includes(type)) {
        return res.status(403).json({ error: 'REFUSED: Demo execution cannot authorize a real or unverified account.' });
      }
    }

    const otpResponse = await fetchImpl(
      `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
      { method: 'POST', headers: optionsHeaders(appId, token) }
    );
    const otpPayload = await otpResponse.json().catch(() => ({}));
    if (!otpResponse.ok) {
      return res.status(otpResponse.status).json({
        error: errorMessage(otpPayload, 'Failed to create WebSocket session.')
      });
    }
    return res.status(200).json({
      url: otpPayload?.data?.url,
      otpExpiresIn: 120,
      ...(verifiedAccount ? { account: verifiedAccount, demoOnly: true } : {})
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Unexpected error.' });
  }
  };
}

export default createOtpHandler();
