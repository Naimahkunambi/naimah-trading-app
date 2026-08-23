import { SaniEngine } from './core/engine.mjs';

const MIN_STRUCTURE_X = 6;
let qualified = 0;
let skipped = 0;

function accountType() {
  return String(document.getElementById('accountPill')?.textContent || '').trim().toUpperCase();
}

function ensureBanner() {
  let banner = document.getElementById('filteredDemoBanner');
  if (banner) return banner;
  const heading = [...document.querySelectorAll('.sectionTitle span')]
    .find(node => node.textContent?.trim() === 'Strategy + execution');
  const card = heading?.closest('.card');
  if (!card) return null;
  banner = document.createElement('p');
  banner.id = 'filteredDemoBanner';
  banner.className = 'muted';
  heading.closest('.sectionTitle')?.after(banner);
  return banner;
}

function renderBanner(extra = '') {
  const banner = ensureBanner();
  if (!banner) return;
  banner.innerHTML = `<b>Filtered Demo Executor ACTIVE</b> · CALL only · structure ≥ ${MIN_STRUCTURE_X}× avg move · qualified ${qualified} · skipped ${skipped}${extra ? ` · ${extra}` : ''}`;
}

const originalExecute = SaniEngine.prototype.execute;
SaniEngine.prototype.execute = function filteredDemoExecute(signal) {
  const type = accountType();
  if (type !== 'DEMO') {
    this.running = false;
    this.resumeAfterReconnect = false;
    this.status = this.connected ? 'ready' : this.status;
    this.log('error', 'FILTERED DEMO MODE: purchases are blocked unless the selected account is DEMO.');
    this.emit();
    renderBanner('REAL/unknown account blocked');
    return;
  }

  const direction = String(signal?.direction || '').toUpperCase();
  const structureX = Number(signal?.features?.structureRangeX);
  const qualifies = direction === 'CALL' && Number.isFinite(structureX) && structureX >= MIN_STRUCTURE_X;

  if (!qualifies) {
    skipped += 1;
    renderBanner();
    return;
  }

  qualified += 1;
  this.log('success', `FILTER QUALIFIED: CALL structure ${structureX.toFixed(2)}× ≥ ${MIN_STRUCTURE_X}×.`);
  renderBanner(`last qualified ${structureX.toFixed(2)}×`);
  return originalExecute.call(this, signal);
};

window.addEventListener('DOMContentLoaded', () => {
  const bull = document.getElementById('bullEnabled');
  const bear = document.getElementById('bearEnabled');
  if (bull) bull.checked = true;
  if (bear) {
    bear.checked = false;
    bear.disabled = true;
    bear.closest('label')?.setAttribute('title', 'Disabled in filtered Demo research mode');
  }
  renderBanner();
});
