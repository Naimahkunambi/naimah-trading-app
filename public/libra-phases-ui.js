const $ = id => document.getElementById(id);
const money = value => `${Number(value || 0) >= 0 ? '+' : '-'}$${Math.abs(Number(value || 0)).toFixed(2)}`;
const pct = value => `${Number(value || 0).toFixed(1)}%`;
const formatClock = ms => {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(minutes).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
};

let lastPhase = '';

function installPhaseUi() {
  const stats = document.querySelector('.libraBrainStats');
  if (stats && !document.getElementById('libraSaniShadow')) {
    stats.insertAdjacentHTML('beforeend', `
      <div><small>SANI SHADOW</small><strong id="libraSaniShadow">0T · $0.00</strong></div>
      <div><small>LIBRA SHADOW</small><strong id="libraShadowScore">0T · $0.00</strong></div>
      <div><small>NEXT SELF-REVIEW</small><strong id="libraNextReview">—</strong></div>
    `);
  }

  const oracleButtons = document.querySelector('.libraOracleButtons');
  if (oracleButtons && !document.getElementById('libraMissionNext')) {
    oracleButtons.insertAdjacentHTML('beforebegin', `
      <section id="libraMissionNext" class="libraLesson" hidden>
        <small>LIBRA'S RECOMMENDATION</small>
        <p id="libraMissionRecommendation">I am reviewing the run.</p>
        <div class="libraOracleButtons">
          <button id="libraContinue10" type="button">CONTINUE 10 MIN</button>
          <button id="libraContinue30" type="button">CONTINUE 30 MIN</button>
          <button id="libraNewMission" type="button">NEW MISSION</button>
        </div>
      </section>
    `);
  }

  const sourceTitle = document.querySelector('#libraSourceLane small');
  if (sourceTitle) sourceTitle.textContent = 'SANI / SMFN SHADOW SAYS';
  const finalTitle = document.querySelector('#libraFinalLane small');
  if (finalTitle) finalTitle.textContent = 'LIBRA SHADOW / FINAL HAND';

  document.querySelectorAll('.libraLegend span').forEach(span => {
    if (span.textContent.includes('LIBRA ENTRY')) span.lastChild.textContent = 'LIBRA ENTRY / SHADOW';
    if (span.textContent.includes('SMFN INTENT') || span.textContent.includes('SANI INTENT')) span.lastChild.textContent = 'SANI / SMFN INTENT';
  });

  const hint = document.querySelector('.libraCommandGrid .libraHint');
  if (hint) hint.textContent = 'START LIBRA turns SANI and Libra on together. LEARN is virtual-only. Every 7 minutes Libra reviews fresh shadow evidence and earns, keeps, or loses paid Demo authority.';
}

function phaseVoice(detail) {
  const mission = detail.mission || {};
  const arb = detail.arbitration || {};
  const phase = mission.phase || 'IDLE';
  if (mission.status && !['ACTIVE','IDLE','PAUSED'].includes(mission.status)) {
    return {
      headline:'MISSION REVIEW.',
      text:`${mission.reason || 'The run ended.'} ${mission.recommendation || ''}`.trim(),
      action:mission.status,
      direction:'NONE'
    };
  }
  if (phase === 'LEARN') {
    return {
      headline:'SANI AND I ARE BOTH PAPER TRADING.',
      text:`Nobody is spending money yet. I am comparing every SANI entry with what I would do. Next self-review in ${formatClock(mission.reviewRemainingMs)}.`,
      action:'SHADOW LEARN',
      direction:arb.shadowDirection || arb.tradeDirection || 'NONE'
    };
  }
  if (phase === 'WORK') return {headline:"I'VE SEEN ENOUGH.",text:mission.reason || 'My fresh shadow policy earned paid Demo authority.',action:'WORK',direction:arb.tradeDirection || 'NONE'};
  if (phase === 'RECOVER') return {headline:'I AM REPAIRING THIS, NOT CHASING IT.',text:mission.reason || 'The run is negative. I stay selective and keep SANI running as my virtual control.',action:'RECOVER',direction:arb.tradeDirection || 'NONE'};
  if (phase === 'PROTECT') return {headline:'THE MONEY HAS A FLOOR.',text:`Current run ${money(mission.runPnl)} · peak ${money(mission.peakPnl)} · protected floor ${money(mission.protectedFloor)}. SANI remains my shadow control.`,action:'PROTECT',direction:arb.tradeDirection || 'NONE'};
  return null;
}

function renderPhaseUi(detail) {
  installPhaseUi();
  const mission = detail.mission || {};
  const shadows = detail.shadows || {};
  const phase = mission.phase || 'IDLE';
  const active = mission.status === 'ACTIVE';

  if (document.getElementById('libraSaniShadow')) document.getElementById('libraSaniShadow').textContent = `${shadows.sani?.trades || 0}T · ${money(shadows.sani?.pnl || 0)}`;
  if (document.getElementById('libraShadowScore')) document.getElementById('libraShadowScore').textContent = `${shadows.libra?.trades || 0}T · ${money(shadows.libra?.pnl || 0)}`;
  if (document.getElementById('libraNextReview')) document.getElementById('libraNextReview').textContent = active ? formatClock(mission.reviewRemainingMs) : '—';

  if (document.getElementById('libraRunStatus')) document.getElementById('libraRunStatus').textContent = active ? `${phase} · ${mission.status}` : mission.status || phase;
  if (document.getElementById('libraHeaderState') && active) document.getElementById('libraHeaderState').textContent = phase;
  if (document.getElementById('libraSafetyState')) document.getElementById('libraSafetyState').textContent = active ? phase : (mission.status || 'READY');
  if (document.getElementById('libraReadiness') && active) {
    const last = mission.lastReview;
    document.getElementById('libraReadiness').textContent = phase === 'LEARN'
      ? `SHADOW LEARN · SANI ${shadows.sani?.trades || 0} vs LIBRA ${shadows.libra?.trades || 0} · review ${formatClock(mission.reviewRemainingMs)}`
      : `${phase} · last review ${last ? `Libra ${pct(last.libra?.winRate)} vs SANI ${pct(last.sani?.winRate)}` : 'passed'}`;
  }

  const source = detail.arbitration || {};
  const latestSignal = (detail.signals || [])[0] || {};
  if (document.getElementById('libraSourceState') && active) document.getElementById('libraSourceState').textContent = phase === 'LEARN' ? 'VIRTUAL' : (source.sourceApproved ? 'QUALIFIED' : 'QUIET');
  if (document.getElementById('libraSourceWhy') && active) {
    const shadow = latestSignal.shadowSani;
    document.getElementById('libraSourceWhy').textContent = shadow?.status === 'SETTLED'
      ? `SANI shadow ${shadow.direction}: ${shadow.outcome} ${money(shadow.profit)}.`
      : source.sourceApproved ? `SANI wants ${source.sourceDirection}. It is shadow-scored whether or not Libra later pays.` : 'SANI is quiet on the latest decision.';
  }
  if (document.getElementById('libraFinalState') && active && phase === 'LEARN') document.getElementById('libraFinalState').textContent = 'VIRTUAL';
  if (document.getElementById('libraFinalWhy') && active && phase === 'LEARN') {
    const shadow = latestSignal.shadowLibra;
    document.getElementById('libraFinalWhy').textContent = shadow?.status === 'SETTLED'
      ? `Libra shadow ${shadow.direction}: ${shadow.outcome} ${money(shadow.profit)}.`
      : `No paid order. ${source.reason || mission.reason || 'Learning.'}`;
  }

  const voice = phaseVoice(detail);
  if (voice) {
    if (document.getElementById('libraVoiceHeadline')) document.getElementById('libraVoiceHeadline').textContent = voice.headline;
    if (document.getElementById('libraVoiceText')) document.getElementById('libraVoiceText').textContent = voice.text;
    if (document.getElementById('libraVoiceAction')) document.getElementById('libraVoiceAction').textContent = voice.action;
    if (document.getElementById('libraVoiceDirection')) document.getElementById('libraVoiceDirection').textContent = voice.direction;
    if (document.getElementById('libraCommandAction')) document.getElementById('libraCommandAction').textContent = voice.action;
    if (document.getElementById('libraCommandReason')) document.getElementById('libraCommandReason').textContent = voice.text;
  }

  const panel = document.getElementById('libraMissionNext');
  if (panel) {
    const finished = Boolean(mission.status && !['ACTIVE','IDLE','PAUSED'].includes(mission.status));
    panel.hidden = !finished;
    if (document.getElementById('libraMissionRecommendation')) document.getElementById('libraMissionRecommendation').textContent = mission.recommendation || 'I recommend waiting for cleaner evidence.';
  }

  if (phase && phase !== lastPhase) {
    document.body.dataset.libraPhase = phase.toLowerCase();
    lastPhase = phase;
  }
}

window.addEventListener('libra-state', event => renderPhaseUi(event.detail || {}));
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installPhaseUi, {once:true});
else installPhaseUi();