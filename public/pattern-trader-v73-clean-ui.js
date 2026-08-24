const $ = id => document.getElementById(id);

function el(tag, cls, html='') {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html) node.innerHTML = html;
  return node;
}

function moveControl(id, host, labelText, cls='') {
  const node = $(id);
  if (!node) return;
  const wrap = el('label', `cleanField ${cls}`);
  if (labelText) wrap.appendChild(el('span', '', labelText));
  wrap.appendChild(node);
  host.appendChild(wrap);
}

function moveButton(id, host, text, kind='') {
  const node = $(id);
  if (!node) return;
  if (text) node.textContent = text;
  node.classList.add('cleanBtn');
  if (kind) node.classList.add(kind);
  host.appendChild(node);
}

function moveMetric(id, host, labelText) {
  const node = $(id);
  if (!node) return;
  const box = el('div', 'cleanMetric');
  box.appendChild(el('span', '', labelText));
  box.appendChild(node);
  host.appendChild(box);
}

function injectStyles() {
  if ($('v73CleanStyles')) return;
  const style = el('style');
  style.id = 'v73CleanStyles';
  style.textContent = `
    html,body{overflow-anchor:none!important;scroll-behavior:auto!important}
    body.v73CleanBody{background:#090b0f;color:#f3f5f8}
    body.v73CleanBody .observatoryShell> :not(#v73CleanShell){display:none!important}
    #v73CleanShell{display:block!important;max-width:1480px;margin:0 auto;padding:22px 24px 60px;contain:layout style}
    .cleanHeader{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-bottom:16px;min-height:72px}
    .cleanHeader .eyebrow{font-size:11px;letter-spacing:.17em;color:#8f97a7;font-weight:800}
    .cleanHeader h1{margin:4px 0 0;font-size:28px;line-height:1.05}.cleanHeader p{margin:6px 0 0;color:#8f97a7;font-size:12px}
    .cleanStatus{display:flex;gap:8px;align-items:center}.cleanStatus .pill{border:1px solid #2d3440;border-radius:999px;padding:8px 11px;background:#11151c;font-size:12px}
    .cleanCard{border:1px solid #252b35;background:#0e1117;border-radius:16px;padding:16px;margin-bottom:14px;contain:layout paint}
    .cleanCardTitle{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}.cleanCardTitle strong{font-size:15px}.cleanCardTitle small{color:#808999;font-size:11px}
    .cleanConnectGrid{display:grid;grid-template-columns:1fr 1.2fr 1.25fr auto;gap:10px;align-items:end}.cleanField{display:block;min-width:0}.cleanField span{display:block;color:#8f97a7;font-size:10px;margin:0 0 6px}.cleanField input,.cleanField select{width:100%;height:42px;border:1px solid #303744;border-radius:10px;background:#0a0d12;color:#f4f6f8;padding:0 11px;box-sizing:border-box}
    .cleanActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.cleanBtn{min-height:42px;padding:0 14px;border-radius:10px!important}.cleanBtn.primary{background:#f4f6f8!important;color:#0b0d11!important}.cleanBtn.danger{border-color:#6a2f38!important;color:#ff929e!important}
    #traderError{margin-top:10px!important;min-height:0}.cleanRunbar{display:grid;grid-template-columns:repeat(4,minmax(0,1fr)) auto;gap:10px;align-items:end;margin-top:12px;padding-top:12px;border-top:1px solid #202631}.cleanRunbar .cleanField input{height:40px}
    .cleanMetrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin-bottom:14px}.cleanMetric{border:1px solid #252b35;background:#0e1117;border-radius:13px;padding:12px;min-height:68px;box-sizing:border-box}.cleanMetric span{display:block;color:#7f8898;font-size:9px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}.cleanMetric strong{font-size:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
    #v73Dashboard{margin:0!important}.v73Decision{grid-template-columns:repeat(5,minmax(0,1fr))!important;min-height:102px}.v73Gate{min-height:96px!important}.v73Gate strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.v73Why{min-height:58px;box-sizing:border-box}.v73SetupCard{min-height:132px;box-sizing:border-box}.v73RichMetrics{margin-bottom:0!important}
    .cleanChartWrap{height:500px;overflow:hidden}.cleanChartWrap #v73ModeBar{margin:0 0 10px!important;min-height:42px}.cleanChartCanvas{height:420px;position:relative;overflow:hidden;border:1px solid #202632;border-radius:12px;background:#090c11}.cleanChartCanvas #masterCanvas{display:block;width:100%!important;height:420px!important;max-height:420px!important}.cleanChartWrap .v73Legend{min-height:20px;margin-top:8px!important}
    .cleanDetails{border:1px solid #252b35;background:#0e1117;border-radius:14px;margin-bottom:12px;overflow:hidden}.cleanDetails>summary{cursor:pointer;list-style:none;padding:14px 16px;font-weight:700;font-size:13px}.cleanDetails>summary::-webkit-details-marker{display:none}.cleanDetails>summary:after{content:'＋';float:right;color:#7f8898}.cleanDetails[open]>summary:after{content:'−'}.cleanDetailsBody{padding:0 14px 14px}.cleanDetails .tableWrap{max-height:340px!important;overflow:auto!important;scrollbar-gutter:stable}.cleanDetails #ptLogs{height:220px!important;max-height:220px!important;overflow:auto!important}
    .cleanTinyActions{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px}.cleanTinyActions button{min-height:34px;padding:0 10px}
    .cleanFooter{color:#697383;font-size:10px;text-align:center;padding:10px 0 0}
    @media(max-width:1050px){.cleanConnectGrid{grid-template-columns:1fr 1fr}.cleanRunbar{grid-template-columns:1fr 1fr}.cleanMetrics{grid-template-columns:repeat(3,1fr)}.v73Decision{grid-template-columns:repeat(3,1fr)!important}.cleanChartWrap{height:460px}.cleanChartCanvas,.cleanChartCanvas #masterCanvas{height:380px!important}}
    @media(max-width:680px){#v73CleanShell{padding:14px 12px 40px}.cleanHeader{align-items:flex-start;flex-direction:column}.cleanConnectGrid,.cleanRunbar{grid-template-columns:1fr}.cleanMetrics{grid-template-columns:1fr 1fr}.v73Decision{grid-template-columns:1fr 1fr!important}.cleanChartWrap{height:420px}.cleanChartCanvas,.cleanChartCanvas #masterCanvas{height:340px!important}}
  `;
  document.head.appendChild(style);
}

export function installCleanV73() {
  injectStyles();
  document.body.classList.add('v73CleanBody');
  const shell = document.querySelector('.observatoryShell');
  if (!shell || $('v73CleanShell')) return;

  const clean = el('div');
  clean.id = 'v73CleanShell';

  const header = el('header', 'cleanHeader');
  header.innerHTML = `<div><div class="eyebrow">SANI TRADING LAB</div><h1>Pattern + Structure Sniper v7.3</h1><p>Demo only · strict 200+80 · PRIME BOS · Pattern 40/88/58 + top10 7/10 · fixed 5T</p></div><div class="cleanStatus"><span class="pill">LIVE ENGINE</span><span class="pill">WORKER ON</span></div>`;
  clean.appendChild(header);

  const metrics = el('section', 'cleanMetrics');
  moveMetric('ptStatus', metrics, 'Trader');
  moveMetric('ptAccountPill', metrics, 'Account');
  moveMetric('ptPnl', metrics, 'Session P/L');
  moveMetric('ptWL', metrics, 'Wins / Losses');
  moveMetric('ptOpen', metrics, 'Open');
  clean.appendChild(metrics);

  const connectCard = el('section', 'cleanCard');
  connectCard.appendChild(el('div', 'cleanCardTitle', '<strong>1. Connect Demo account</strong><small>Credentials stay in this browser session</small>'));
  const connectGrid = el('div', 'cleanConnectGrid');
  moveControl('ptAppId', connectGrid, 'Deriv App ID');
  moveControl('ptToken', connectGrid, 'Trade token');
  moveControl('ptAccount', connectGrid, 'Demo account');
  const loadActions = el('div', 'cleanActions');
  moveButton('ptLoadAccounts', loadActions, 'Load Demo Accounts', 'primary');
  connectGrid.appendChild(loadActions);
  connectCard.appendChild(connectGrid);

  const connectActions = el('div', 'cleanActions');
  moveButton('ptConnect', connectActions, 'Connect Demo', 'primary');
  moveButton('ptDisconnect', connectActions, 'Disconnect');
  connectCard.appendChild(connectActions);
  if ($('traderError')) connectCard.appendChild($('traderError'));

  const runbar = el('div', 'cleanRunbar');
  moveControl('ptStake', runbar, 'Stake ($)');
  moveControl('ptTakeProfit', runbar, 'Session TP ($)');
  moveControl('ptStopLoss', runbar, 'Session SL ($)');
  moveControl('ptMaxTrades', runbar, 'Max trades');
  const runActions = el('div', 'cleanActions');
  moveButton('ptStart', runActions, 'Start Sniper', 'primary');
  moveButton('ptPause', runActions, 'Pause');
  moveButton('ptStop', runActions, 'Stop', 'danger');
  runbar.appendChild(runActions);
  connectCard.appendChild(runbar);
  clean.appendChild(connectCard);

  const decisionCard = el('section', 'cleanCard');
  decisionCard.appendChild(el('div', 'cleanCardTitle', '<strong>2. Live decision</strong><small>No trade unless all five gates pass</small>'));
  if ($('v73Dashboard')) decisionCard.appendChild($('v73Dashboard'));
  if ($('ptSignal')) decisionCard.appendChild($('ptSignal'));
  clean.appendChild(decisionCard);

  const chartCard = el('section', 'cleanCard cleanChartWrap');
  chartCard.appendChild(el('div', 'cleanCardTitle', '<strong>3. Entry / Exit chart</strong><small>LIVE or REPLAY without moving the page</small>'));
  if ($('v73ModeBar')) chartCard.appendChild($('v73ModeBar'));
  const canvasBox = el('div', 'cleanChartCanvas');
  if ($('masterCanvas')) canvasBox.appendChild($('masterCanvas'));
  chartCard.appendChild(canvasBox);
  if ($('masterCanvasCaption')) {
    const cap = $('masterCanvasCaption');
    cap.style.display = 'block';
    cap.style.marginTop = '7px';
    cap.style.color = '#7f8898';
    cap.style.fontSize = '10px';
    chartCard.appendChild(cap);
  }
  const legend = document.querySelector('.v73Legend');
  if (legend) chartCard.appendChild(legend);
  clean.appendChild(chartCard);

  const trades = el('details', 'cleanDetails');
  trades.innerHTML = '<summary>Trades</summary><div class="cleanDetailsBody"></div>';
  const tradeBody = trades.querySelector('.cleanDetailsBody');
  const tradeWrap = $('ptTradeRows')?.closest('.tableWrap');
  if (tradeWrap) tradeBody.appendChild(tradeWrap);
  clean.appendChild(trades);

  const audit = el('details', 'cleanDetails');
  audit.innerHTML = '<summary>Setup audit & replay data</summary><div class="cleanDetailsBody"></div>';
  const auditBody = audit.querySelector('.cleanDetailsBody');
  const tiny = el('div', 'cleanTinyActions');
  moveButton('ptExportLedger', tiny, 'Export v7.3 CSV');
  moveButton('ptClearLedger', tiny, 'Clear v7.3 cohort');
  moveButton('ptResetCalibration', tiny, 'Reset entry calibration');
  auditBody.appendChild(tiny);
  const ledgerWrap = $('ptLedgerRows')?.closest('.tableWrap');
  if (ledgerWrap) auditBody.appendChild(ledgerWrap);
  clean.appendChild(audit);

  const journal = el('details', 'cleanDetails');
  journal.innerHTML = '<summary>Trader journal</summary><div class="cleanDetailsBody"></div>';
  if ($('ptLogs')) journal.querySelector('.cleanDetailsBody').appendChild($('ptLogs'));
  clean.appendChild(journal);

  const advanced = el('details', 'cleanDetails');
  advanced.innerHTML = '<summary>Advanced / reset</summary><div class="cleanDetailsBody"><div class="cleanActions" id="v73AdvancedActions"></div></div>';
  moveButton('ptReset', advanced.querySelector('#v73AdvancedActions'), 'Reset engine session');
  clean.appendChild(advanced);

  clean.appendChild(el('div', 'cleanFooter', 'v7.3 Demo-only research engine · one open trade · no martingale'));
  shell.insertBefore(clean, shell.firstChild);

  // Any old live/replay chrome left behind becomes irrelevant because the legacy shell is hidden.
  // Keep all original nodes in the DOM so observatory.js and the trading controller retain their IDs.
}
