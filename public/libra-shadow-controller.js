// Libra's former external shadow wrapper is retired.
// This slot now loads the mountain/sniper intelligence and promotes an already-reviewed
// mission into SNIPER_FILTER as soon as the filtered SANI subset has enough evidence.
import './core/libra-sniper.mjs';

const MIN_SNIPER_TRADES = 12;
const PAYOUT = 0.92;
const BREAK_EVEN = 100 / (1 + PAYOUT);
const EDGE_CUSHION = 2;
let lastAttemptKey = '';
let reviewQueued = false;

function sniperEarned(detail = {}) {
  const mission = detail.mission || {};
  const sniper = detail.sniper?.sniper || {};
  const breakEven = Number(detail.sniper?.breakEven || BREAK_EVEN);
  return Boolean(
    mission.status === 'ACTIVE' &&
    Number(mission.reviewCount || 0) >= 1 &&
    detail.accountType === 'DEMO' &&
    detail.engine?.connected &&
    Number(sniper.trades || 0) >= MIN_SNIPER_TRADES &&
    Number(sniper.pnl || 0) > 0 &&
    Number(sniper.winRate || 0) > breakEven + EDGE_CUSHION
  );
}

function requestSniperAuthority(detail = {}) {
  const mission = detail.mission || {};
  if (!sniperEarned(detail)) return;
  if (mission.authorityMode === 'SNIPER_FILTER') return;

  const sniper = detail.sniper?.sniper || {};
  const key = `${mission.id}:${sniper.trades}:${Number(sniper.pnl || 0).toFixed(2)}:${Number(sniper.winRate || 0).toFixed(1)}`;
  if (key === lastAttemptKey || reviewQueued) return;
  lastAttemptKey = key;
  reviewQueued = true;

  setTimeout(() => {
    reviewQueued = false;
    const api = window.LIBRA;
    if (!api?.review) return;
    api.review();
  }, 0);
}

window.addEventListener('libra-state', event => requestSniperAuthority(event.detail || {}));
