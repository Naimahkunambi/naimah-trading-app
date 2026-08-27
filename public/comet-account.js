const $ = id => document.getElementById(id);
const SELECTED_KEY = 'sani.comet.selectedDemo';

function setStatus(text, ok = false) {
  const el = $('cometAccountStatus');
  if (!el) return;
  el.textContent = text;
  el.dataset.ok = ok ? '1' : '0';
}

function selectedAccountReady() {
  const sel = $('cometAccount');
  if (!sel?.value) return false;
  setStatus('DEMO READY', true);
  try { localStorage.setItem(SELECTED_KEY, sel.value); } catch {}
  return true;
}

function restoreSelection() {
  const sel = $('cometAccount');
  if (!sel) return;
  let wanted = '';
  try { wanted = localStorage.getItem(SELECTED_KEY) || ''; } catch {}
  if (wanted && [...sel.options].some(o => o.value === wanted)) sel.value = wanted;
  if (sel.value) setStatus('DEMO READY', true);
}

async function loadDemoAccounts(event) {
  event?.preventDefault?.();
  event?.stopImmediatePropagation?.();

  const appId = $('cometAppId')?.value?.trim();
  const token = $('cometToken')?.value?.trim();
  const btn = $('cometLoadAccounts');
  const sel = $('cometAccount');

  if (!appId || !token) {
    setStatus('APP ID + TOKEN');
    return;
  }

  btn.disabled = true;
  setStatus('LOADING');

  try {
    const response = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, token }),
      cache: 'no-store'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);

    const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
    const demos = accounts.filter(account => String(account?.account_type || '').toLowerCase() !== 'real');

    if (!demos.length) {
      sel.innerHTML = '<option value="">No Demo accounts returned</option>';
      setStatus('NO DEMO');
      return;
    }

    const previous = sel.value || (() => { try { return localStorage.getItem(SELECTED_KEY) || ''; } catch { return ''; } })();
    sel.innerHTML = '';
    for (const account of demos) {
      const option = document.createElement('option');
      option.value = String(account.account_id || '');
      option.textContent = `DEMO · ${account.account_id || 'UNKNOWN'} · ${account.currency || ''} ${account.balance ?? ''}`;
      sel.appendChild(option);
    }
    if (previous && [...sel.options].some(o => o.value === previous)) sel.value = previous;

    try {
      sessionStorage.setItem('sani.comet.token', token);
      localStorage.setItem('sani.comet.appId', appId);
      localStorage.setItem(SELECTED_KEY, sel.value);
    } catch {}

    setStatus(`${demos.length} DEMO READY`, true);
  } catch (error) {
    // If the browser already has a valid Demo account selected, do not paint the
    // account as broken because a later refresh/storage/telemetry step failed.
    if (sel?.value) {
      setStatus('DEMO READY', true);
      console.warn('COMET account refresh warning:', error);
    } else {
      setStatus(`ERROR · ${String(error?.message || 'ACCOUNT LOAD').slice(0, 28)}`);
      console.error('COMET account load failed:', error);
    }
  } finally {
    btn.disabled = false;
  }
}

function bootAccountLayer() {
  const btn = $('cometLoadAccounts');
  const sel = $('cometAccount');
  if (!btn || !sel) return;

  // Capture phase owns account loading so the older comet.js handler cannot
  // overwrite a successful account load with a false ERROR state.
  btn.addEventListener('click', loadDemoAccounts, true);
  sel.addEventListener('change', selectedAccountReady);

  const observer = new MutationObserver(() => restoreSelection());
  observer.observe(sel, { childList: true });

  queueMicrotask(restoreSelection);
  setTimeout(restoreSelection, 250);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootAccountLayer, { once: true });
else bootAccountLayer();
