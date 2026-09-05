/**
 * Eliphace Weekly FM Report Hub (Slides-bound Apps Script)
 * Master production single-file server logic.
 */

const APP_TZ = 'Africa/Dar_es_Salaam';
const APP_NAME = 'Eliphace Hub';
const LICENSE_USER = 'Eliphace';
const MASTER_DECK_ID = 'PUT_MASTER_SLIDES_DECK_ID_HERE';
const STORAGE_SHEET_NAME = 'ELIPHACE_FM_STORAGE';

const SHEET_NAMES = {
  STATIC: 'StaticMemory',
  OPEN: 'OpenMatters',
  ARCHIVE: 'WeeklyArchive',
  ACTION: 'ActionHistory',
  LOG: 'ReportLog'
};

const MONTHLY_CODES = {
  '2026-04': 'EliphaceApril007',
  '2026-05': 'EliphaceMay008',
  '2026-06': 'EliphaceJune007',
  '2026-07': 'EliphaceJuly008'
};

const PROP = {
  LICENSE_MONTH: 'license.active.month',
  LICENSE_AT: 'license.active.at',
  DRAFT_JSON: 'draft.json',
  CURRENT_DECK_ID: 'current.deck.id',
  CURRENT_REPORT_ID: 'current.report.id'
};

const SLIDE_INDEX = {
  COVER: 0,
  EXEC_SUMMARY: 1,
  FACILITY: 2,
  HOA: 3,
  ARREARS: 4,
  COLLECTIONS: 5,
  TITLE: 6,
  LEGAL: 7,
  SITE: 8,
  PIPELINE: 9,
  APPROACHED: 10,
  VALUATIONS: 11,
  MEETINGS: 12,
  CHALLENGES: 13,
  BLOCKERS: 14,
  AOB: 15,
  PREVIOUS_ACTIONS: 16,
  NEW_ACTIONS: 17,
  CLOSING: 18
};

const TABLE_INDEX = {
  DEFAULT: 0
};

const STATUS_COLORS = {
  critical: '#d32f2f',
  high: '#f57c00',
  attention: '#f57c00',
  urgent: '#d32f2f',
  'needs improvement': '#ef6c00',
  overdue: '#d32f2f',
  healthy: '#2e7d32',
  'on track': '#2e7d32',
  good: '#2e7d32',
  complete: '#2e7d32',
  'in progress': '#1565c0',
  low: '#607d8b'
};

const FALLBACKS = {
  noneWeek: 'None this week',
  noUpdates: 'No new updates this period',
  noAdditional: 'No additional matters reported',
  noFmOps: 'No new FM opportunities recorded this week',
  noApproached: 'No new facilities approached this week',
  noBlocked: 'No blocked maintenance items reported this week',
  noChallenges: 'No major challenges reported this week'
};

function onOpen() {
  initializeStorageIfNeeded();
  SlidesApp.getUi()
    .createMenu(APP_NAME)
    .addItem('Create New Weekly Report', 'createNewWeeklyReport')
    .addItem('Resume Draft Report', 'resumeDraftReport')
    .addSeparator()
    .addItem('License Status', 'showLicenseStatusDialog')
    .addItem('Enter Access Code', 'promptForAccessCode')
    .addItem('Clear Current Activation (testing only)', 'clearCurrentActivationForTesting')
    .addToUi();
}

function createNewWeeklyReport() {
  initializeStorageIfNeeded();
  if (!isMonthActivated_()) {
    const ok = promptForAccessCode();
    if (!ok) return;
  }
  const duplicated = duplicateMasterDeck();
  const props = PropertiesService.getUserProperties();
  props.setProperty(PROP.CURRENT_DECK_ID, duplicated.id);
  const reportId = buildReportId_(new Date());
  props.setProperty(PROP.CURRENT_REPORT_ID, reportId);
  const prefill = getPrefillDataForNewReport();
  prefill.meta = prefill.meta || {};
  prefill.meta.deck_id = duplicated.id;
  prefill.meta.deck_url = duplicated.url;
  prefill.meta.report_id = reportId;
  props.setProperty(PROP.DRAFT_JSON, JSON.stringify(prefill));
  SlidesApp.getUi().alert('New report deck created. Opening questionnaire sidebar now.');
  SlidesApp.openById(duplicated.id);
  showSidebar();
}

function resumeDraftReport() {
  initializeStorageIfNeeded();
  const props = PropertiesService.getUserProperties();
  const deckId = props.getProperty(PROP.CURRENT_DECK_ID);
  if (deckId) {
    SlidesApp.openById(deckId);
  }
  showSidebar();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Index').setTitle('Eliphace Weekly Report');
  SlidesApp.getUi().showSidebar(html);
}

function getSidebarData() {
  initializeStorageIfNeeded();
  const props = PropertiesService.getUserProperties();
  const rawDraft = props.getProperty(PROP.DRAFT_JSON);
  const prefill = rawDraft ? JSON.parse(rawDraft) : getPrefillDataForNewReport();

  const out = {
    mode: prefill.mode || 'quick',
    prefill,
    static_memory: getStaticMemoryMap(),
    license: getLicenseStatus(),
    month_key: getCurrentMonthKey(),
    quick_highlights: prefill.key_highlights || [],
    quick_ceo_attention: prefill.ceo_attention || [],
    quick_meetings: prefill.meetings || [],
    quick_previous_actions: prefill.previous_actions || [],
    quick_new_actions: prefill.new_actions || [],
    quick_open_matters: prefill.open_matters || [],
    quick_kilima_update: (prefill.facility_updates || []).find(r => /kilima/i.test(r.facility || '')) || {},
    quick_emerald_update: (prefill.facility_updates || []).find(r => /emerald/i.test(r.facility || '')) || {},
    quick_hoa_balances: prefill.bank_balances || {},
    quick_aob: prefill.aob || {}
  };

  Logger.log('latest report loaded successfully: %s', !!prefill);
  Logger.log('number of highlights loaded: %s', out.quick_highlights.length);
  Logger.log('number of CEO items loaded: %s', out.quick_ceo_attention.length);
  Logger.log('number of meetings loaded: %s', out.quick_meetings.length);
  Logger.log('number of previous actions loaded: %s', out.quick_previous_actions.length);
  Logger.log('number of new actions loaded: %s', out.quick_new_actions.length);
  Logger.log('number of open matters loaded: %s', out.quick_open_matters.length);

  return out;
}

function saveDraftData(payload) {
  initializeStorageIfNeeded();
  const merged = mergeWithLatestForQuickMode_(payload || {});
  PropertiesService.getUserProperties().setProperty(PROP.DRAFT_JSON, JSON.stringify(merged));
  return { ok: true, message: 'Draft saved.', report_id: merged.meta && merged.meta.report_id };
}

function fillCurrentReport(payload) {
  initializeStorageIfNeeded();
  const resolved = mergeWithLatestForQuickMode_(payload || {});
  const validation = validateReportPayload_(resolved);
  if (!validation.ok) {
    return { ok: false, message: validation.errors.join('\n') };
  }
  const props = PropertiesService.getUserProperties();
  const deckId = (resolved.meta && resolved.meta.deck_id) || props.getProperty(PROP.CURRENT_DECK_ID);
  if (!deckId) return { ok: false, message: 'No working deck found. Create a new report first.' };

  const deck = SlidesApp.openById(deckId);
  fillCoverSlide(deck, resolved);
  fillExecutiveSummary(deck, resolved);
  fillFacilityTable(deck, resolved);
  fillHoaTable(deck, resolved);
  fillArrearsTable(deck, resolved);
  fillCollectionsTable(deck, resolved);
  fillTitleTransfersTable(deck, resolved);
  fillLegalTable(deck, resolved);
  fillSiteManagersTable(deck, resolved);
  fillPipelineTable(deck, resolved);
  fillApproachedFacilitiesTable(deck, resolved);
  fillValuationsTable(deck, resolved);
  fillMeetingsTable(deck, resolved);
  fillChallengesTable(deck, resolved);
  fillBlockersTable(deck, resolved);
  fillAob(deck, resolved);
  fillPreviousActionsTable(deck, resolved);
  fillNewActionsTable(deck, resolved);
  applyStatusColors(deck);
  cleanUnusedRows(deck, resolved);
  clearResidualPlaceholders(deck);

  updateStaticMemoryFromReport(resolved);
  updateOpenMattersFromReport(resolved);
  saveCompletedReportData(resolved, deckId);
  rolloverActionsToNextWeek(resolved);
  props.setProperty(PROP.DRAFT_JSON, JSON.stringify(resolved));

  return { ok: true, message: 'Report slides filled and saved.', deck_url: deck.getUrl() };
}

function duplicateMasterDeck() {
  if (MASTER_DECK_ID === 'PUT_MASTER_SLIDES_DECK_ID_HERE') {
    throw new Error('Please set MASTER_DECK_ID in Code.gs before creating reports.');
  }
  const dateLabel = Utilities.formatDate(new Date(), APP_TZ, 'dd MMM yyyy');
  const file = DriveApp.getFileById(MASTER_DECK_ID).makeCopy('Eliphace Weekly FM Report - ' + dateLabel);
  return { id: file.getId(), url: 'https://docs.google.com/presentation/d/' + file.getId() + '/edit' };
}

function getCurrentMonthKey() {
  return Utilities.formatDate(new Date(), APP_TZ, 'yyyy-MM');
}

function validateAccessCode(code) {
  const monthKey = getCurrentMonthKey();
  const expected = MONTHLY_CODES[monthKey];
  if (!expected) return false;
  const ok = String(code || '').trim() === expected;
  if (ok) {
    const props = PropertiesService.getUserProperties();
    props.setProperty(PROP.LICENSE_MONTH, monthKey);
    props.setProperty(PROP.LICENSE_AT, new Date().toISOString());
  }
  return ok;
}

function promptForAccessCode() {
  const ui = SlidesApp.getUi();
  const resp = ui.prompt(APP_NAME + ' License', 'Enter access code for ' + getCurrentMonthKey(), ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return false;
  const ok = validateAccessCode(resp.getResponseText());
  if (!ok) {
    ui.alert('Invalid access code for current month.');
    return false;
  }
  ui.alert('Access granted for ' + LICENSE_USER + ' (' + getCurrentMonthKey() + ').');
  return true;
}

function getLicenseStatus() {
  const props = PropertiesService.getUserProperties();
  const activeMonth = props.getProperty(PROP.LICENSE_MONTH);
  const nowMonth = getCurrentMonthKey();
  const active = activeMonth === nowMonth;
  return {
    license_user: LICENSE_USER,
    current_month: nowMonth,
    activated_month: activeMonth || '',
    activated_at: props.getProperty(PROP.LICENSE_AT) || '',
    is_active: active,
    has_code_for_month: !!MONTHLY_CODES[nowMonth]
  };
}

function clearCurrentActivationForTesting() {
  const p = PropertiesService.getUserProperties();
  p.deleteProperty(PROP.LICENSE_MONTH);
  p.deleteProperty(PROP.LICENSE_AT);
  SlidesApp.getUi().alert('Current activation cleared.');
}

function showLicenseStatusDialog() {
  const s = getLicenseStatus();
  SlidesApp.getUi().alert(
    'License User: ' + s.license_user +
    '\nCurrent Month: ' + s.current_month +
    '\nActivated Month: ' + (s.activated_month || '-') +
    '\nActive: ' + (s.is_active ? 'Yes' : 'No')
  );
}

function initializeStorageIfNeeded() {
  const ss = getOrCreateStorageSpreadsheet_();
  ensureSheet_(ss, SHEET_NAMES.STATIC, ['key', 'value', 'category', 'active', 'last_updated']);
  ensureSheet_(ss, SHEET_NAMES.OPEN, ['matter_id', 'category', 'facility', 'short_title', 'details', 'first_identified_date', 'latest_status', 'severity', 'owner', 'deadline', 'ceo_attention', 'resolved', 'resolved_date', 'last_updated']);
  ensureSheet_(ss, SHEET_NAMES.ARCHIVE, ['report_id', 'report_date', 'month_key', 'deck_id', 'deck_url', 'section', 'record_type', 'payload_json', 'created_at', 'status']);
  ensureSheet_(ss, SHEET_NAMES.ACTION, ['report_id', 'action_number', 'action_item', 'assigned_to', 'deadline', 'status', 'completion_date', 'notes', 'carried_from_report_id']);
  ensureSheet_(ss, SHEET_NAMES.LOG, ['report_id', 'report_date', 'month_key', 'deck_id', 'deck_url', 'created_at', 'license_month_used', 'draft_or_final', 'facilities_managed', 'total_arrears', 'collection_rate', 'title_transfers', 'new_prospects']);

  seedInitialStaticMemory();
  seedInitialOpenMatters();
  seedInitialArchiveData();
}

function seedInitialStaticMemory() {
  const map = getStaticMemoryMap();
  if (Object.keys(map).length > 0) return;
  const sheet = getSheet_(SHEET_NAMES.STATIC);
  const now = new Date().toISOString();
  const rows = [
    ['presenter_name', 'Eliphace', 'general', 'Y', now],
    ['presenter_title', 'Facility Management Division', 'general', 'Y', now],
    ['presenter_email', 'eliphace@cbcworldwide.tz', 'general', 'Y', now],
    ['presenter_phone', '0765885594', 'general', 'Y', now],
    ['company_name', 'Coldwell Banker Commercial Blue Ridge', 'general', 'Y', now],
    ['report_title', 'Weekly FM & Operations Review', 'general', 'Y', now],
    ['facility_1_name', 'Kilima Villas', 'facilities', 'Y', now],
    ['facility_1_location', 'Paje', 'facilities', 'Y', now],
    ['facility_1_units', '5', 'facilities', 'Y', now],
    ['facility_2_name', 'Emerald Paje', 'facilities', 'Y', now],
    ['facility_2_location', 'Paje', 'facilities', 'Y', now],
    ['facility_2_units', '20', 'facilities', 'Y', now],
    ['emerald_site_manager', 'Kevin', 'staff', 'Y', now],
    ['kilima_site_manager', 'Mr Danny', 'staff', 'Y', now],
    ['kilima_vendor', 'Mr Amir', 'staff', 'Y', now],
    ['hans_chris_seller', 'Lydia', 'staff', 'Y', now],
    ['additional_contact', 'Ramazan Swadik', 'staff', 'Y', now],
    ['title_name_1', 'Hans Chris', 'title', 'Y', now],
    ['title_name_2', 'Ralf and Petra', 'title', 'Y', now]
  ];
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

function seedInitialOpenMatters() {
  const sheet = getSheet_(SHEET_NAMES.OPEN);
  if (sheet.getLastRow() > 1) return;
  const now = new Date().toISOString();
  const rows = [
    ['OM-001', 'Facility Issue', 'Kilima Villas', 'Owners rejecting current site manager', '', '2026-04-18', 'Open', 'Critical', 'Ops', 'Immediate', 'Yes', 'No', '', now],
    ['OM-002', 'Utilities Transparency', 'Kilima Villas', 'Utility billing transparency complaint', '', '2026-04-18', 'Open', 'High', 'Ops / Vendor', 'Immediate', 'Yes', 'No', '', now],
    ['OM-003', 'Vendor Performance', 'Kilima Villas', 'Vendor Amir non-responsive', '', '2026-04-18', 'Open', 'High', 'Ops', 'Immediate', 'Yes', 'No', '', now],
    ['OM-004', 'Title Transfer', 'Hans Chris', 'Seller approval pending from Lydia', '', '2026-04-18', 'Open', 'High', 'CEO / Ops', 'Immediate', 'Yes', 'No', '', now],
    ['OM-005', 'Title Transfer', 'Ralf and Petra', 'Seller meeting pending', '', '2026-04-18', 'Open', 'Medium', 'Elphas', 'Friday', 'No', 'No', '', now],
    ['OM-006', 'Arrears', 'Kilima Villas', 'Bogdan Q1 and Q2 outstanding', '', '2026-04-18', 'Open', 'High', 'Elphas', 'This week', 'No', 'No', '', now]
  ];
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

function seedInitialArchiveData() {
  const sheet = getSheet_(SHEET_NAMES.ARCHIVE);
  if (sheet.getLastRow() > 1) return;
  const seed = buildSeedReportData_();
  const reportId = 'RPT-SEED-2026-04-18';
  const createdAt = new Date().toISOString();
  const rows = [];
  Object.keys(seed).forEach(section => {
    rows.push([reportId, '2026-04-18', '2026-04', '', '', section, 'seed', JSON.stringify(seed[section]), createdAt, 'completed']);
  });
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);

  const log = getSheet_(SHEET_NAMES.LOG);
  log.getRange(2, 1, 1, 13).setValues([[reportId, '2026-04-18', '2026-04', '', '', createdAt, '2026-04', 'final', 2, '3097363', 70, '0/2', 1]]);
}

function loadLatestReportData() {
  const sheet = getSheet_(SHEET_NAMES.ARCHIVE);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return null;
  const rows = data.slice(1).filter(r => String(r[9]).toLowerCase() === 'completed');
  if (!rows.length) return null;
  rows.sort((a, b) => new Date(b[8]).getTime() - new Date(a[8]).getTime());
  const latestReportId = rows[0][0];
  const sameReportRows = rows.filter(r => r[0] === latestReportId);
  const out = {};
  sameReportRows.forEach(r => {
    try {
      out[r[5]] = JSON.parse(r[7]);
    } catch (e) {
      out[r[5]] = r[7];
    }
  });
  out.meta = out.meta || {};
  out.meta.report_id = latestReportId;
  return out;
}

function saveCompletedReportData(reportData, deckId) {
  const sheet = getSheet_(SHEET_NAMES.ARCHIVE);
  const now = new Date();
  const createdAt = now.toISOString();
  const reportDate = normalizeDate_(reportData.report_date || Utilities.formatDate(now, APP_TZ, 'yyyy-MM-dd'));
  const monthKey = getCurrentMonthKey();
  const reportId = (reportData.meta && reportData.meta.report_id) || buildReportId_(now);
  const deckUrl = 'https://docs.google.com/presentation/d/' + deckId + '/edit';
  const rows = [];

  const sections = [
    'executive_summary','key_highlights','ceo_attention','facility_updates','bank_balances','arrears','collection_actions',
    'title_transfers','legal_updates','site_manager_reviews','pipeline','approached_facilities','valuations',
    'meetings','challenges','blockers','aob','previous_actions','new_actions','open_matters','meta'
  ];
  sections.forEach(section => {
    rows.push([reportId, reportDate, monthKey, deckId, deckUrl, section, 'final', JSON.stringify(reportData[section] || null), createdAt, 'completed']);
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

  const log = getSheet_(SHEET_NAMES.LOG);
  const es = reportData.executive_summary || {};
  log.getRange(log.getLastRow() + 1, 1, 1, 13).setValues([[reportId, reportDate, monthKey, deckId, deckUrl, createdAt, monthKey, 'final', es.facilities_managed || '', es.total_arrears || '', es.collection_rate || '', es.title_transfers || '', es.new_prospects || '']]);
}

function updateStaticMemoryFromReport(reportData) {
  const sheet = getSheet_(SHEET_NAMES.STATIC);
  const map = getStaticMemoryMap();
  const presenter = reportData.presenter || {};
  const updates = {
    presenter_name: presenter.name,
    presenter_title: presenter.title,
    presenter_email: presenter.email,
    presenter_phone: presenter.phone
  };
  const now = new Date().toISOString();
  const values = sheet.getDataRange().getValues();
  Object.keys(updates).forEach(key => {
    const val = sanitizeText_(updates[key]);
    if (!val) return;
    if (map[key] === val) return;
    let found = false;
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === key) {
        sheet.getRange(i + 1, 2).setValue(val);
        sheet.getRange(i + 1, 5).setValue(now);
        found = true;
        break;
      }
    }
    if (!found) {
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, 5).setValues([[key, val, 'general', 'Y', now]]);
    }
  });
}

function updateOpenMattersFromReport(reportData) {
  const sheet = getSheet_(SHEET_NAMES.OPEN);
  const current = getActiveOpenMatters_();
  const incoming = reportData.open_matters || [];
  const byId = {};
  current.forEach(m => byId[m.matter_id] = m);
  const now = new Date().toISOString();
  const output = [];

  incoming.forEach(item => {
    const action = (item.carry_action || 'Still Open').toLowerCase();
    if (action === 'remove') return;
    const base = byId[item.matter_id] || {};
    const merged = Object.assign({}, base, item);
    merged.last_updated = now;
    if (action === 'resolved') {
      merged.resolved = 'Yes';
      merged.resolved_date = merged.resolved_date || Utilities.formatDate(new Date(), APP_TZ, 'yyyy-MM-dd');
      merged.latest_status = merged.latest_status || 'Resolved';
    } else {
      merged.resolved = 'No';
      merged.resolved_date = '';
    }
    output.push(merged);
  });

  sheet.clearContents();
  sheet.getRange(1, 1, 1, 14).setValues([['matter_id','category','facility','short_title','details','first_identified_date','latest_status','severity','owner','deadline','ceo_attention','resolved','resolved_date','last_updated']]);
  if (output.length) {
    const rows = output.map(m => [
      m.matter_id || buildMatterId_(), m.category || '', m.facility || '', m.short_title || '', m.details || '',
      m.first_identified_date || Utilities.formatDate(new Date(), APP_TZ, 'yyyy-MM-dd'), m.latest_status || 'Open',
      m.severity || 'Medium', m.owner || '', m.deadline || '', m.ceo_attention || 'No', m.resolved || 'No',
      m.resolved_date || '', m.last_updated || now
    ]);
    sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
}

function rolloverActionsToNextWeek(reportData) {
  const actionSheet = getSheet_(SHEET_NAMES.ACTION);
  const reportId = (reportData.meta && reportData.meta.report_id) || buildReportId_(new Date());
  const prevId = (loadLatestReportData() && loadLatestReportData().meta && loadLatestReportData().meta.report_id) || '';
  const nowRows = (reportData.new_actions || []).map((a, idx) => [
    reportId, idx + 1, a.action_item || '', a.assigned_to || '', a.deadline || '', a.status || 'In Progress', a.completion_date || '', a.notes || '', prevId
  ]);
  if (nowRows.length) {
    actionSheet.getRange(actionSheet.getLastRow() + 1, 1, nowRows.length, nowRows[0].length).setValues(nowRows);
  }
}

function getPrefillDataForNewReport() {
  const staticMap = getStaticMemoryMap();
  const latest = loadLatestReportData();
  const open = getActiveOpenMatters_();
  const base = latest || buildSeedReportData_();

  const out = JSON.parse(JSON.stringify(base));
  out.report_date = Utilities.formatDate(new Date(), APP_TZ, 'yyyy-MM-dd');
  out.presenter = {
    name: staticMap.presenter_name || 'Eliphace',
    title: staticMap.presenter_title || 'Facility Management Division',
    email: staticMap.presenter_email || 'eliphace@cbcworldwide.tz',
    phone: staticMap.presenter_phone || '0765885594'
  };
  out.open_matters = open.length ? open : (out.open_matters || []);
  out.meta = out.meta || {};
  out.meta.report_id = buildReportId_(new Date());
  out.meta.source = latest ? 'latest_archive' : 'seed_data';
  return out;
}

function getStaticMemoryMap() {
  const sheet = getSheet_(SHEET_NAMES.STATIC);
  const values = sheet.getDataRange().getValues();
  const map = {};
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][3]).toUpperCase() !== 'Y') continue;
    map[values[i][0]] = values[i][1];
  }
  return map;
}

function fillCoverSlide(deck, reportData) {
  const slide = getSlide_(deck, SLIDE_INDEX.COVER);
  const staticMap = getStaticMemoryMap();
  replaceInSlide_(slide, {
    '[Date]': reportData.report_date || Utilities.formatDate(new Date(), APP_TZ, 'dd MMM yyyy'),
    '[Presenter]': (reportData.presenter && reportData.presenter.name) || staticMap.presenter_name || 'Eliphace',
    '[Company]': staticMap.company_name || 'Coldwell Banker Commercial Blue Ridge',
    '[ReportTitle]': staticMap.report_title || 'Weekly FM & Operations Review'
  });
}

function fillExecutiveSummary(deck, reportData) {
  const slide = getSlide_(deck, SLIDE_INDEX.EXEC_SUMMARY);
  const es = reportData.executive_summary || {};
  const body = [
    'Facilities Managed: ' + nz_(es.facilities_managed, '2'),
    'Total Arrears: ' + normalizeCurrency_(es.total_arrears || 'TZS 3,097,363'),
    'Collection Rate: ' + nz_(es.collection_rate, '70') + '%',
    'Title Transfers: ' + nz_(es.title_transfers, '0/2'),
    'New Prospects: ' + nz_(es.new_prospects, '1'),
    '',
    'Key Highlights:',
    ...toBullets_(reportData.key_highlights || [FALLBACKS.noUpdates]),
    '',
    'Items Requiring CEO Attention:',
    ...toBullets_(reportData.ceo_attention || [FALLBACKS.noAdditional])
  ].join('\n');
  writeToFirstShape_(slide, body);
}

function fillFacilityTable(deck, reportData) {
  const slide = getSlide_(deck, SLIDE_INDEX.FACILITY);
  const rows = reportData.facility_updates || [];
  writeListAsText_(slide, rows, row => [row.facility, row.units, row.occupancy, row.status, row.main_challenge || row.challenge, row.pending_payment].join(' | '), FALLBACKS.noUpdates);
}

function fillHoaTable(deck, reportData) {
  const slide = getSlide_(deck, SLIDE_INDEX.HOA);
  const b = reportData.bank_balances || {};
  const lines = [
    'Kilima: Opening ' + nz_(b.kilima_opening, 'TZS 203230 / USD 2431.99') + ', Deposits ' + nz_(b.kilima_deposits, '0') + ', Withdrawals ' + nz_(b.kilima_withdrawals, '0') + ', Closing ' + nz_(b.kilima_closing, 'Unchanged') + ', Status ' + nz_(b.kilima_status, 'Critical'),
    'Emerald: Opening ' + nz_(b.emerald_opening, '32769775.98') + ', Deposits ' + nz_(b.emerald_deposits, '1753966.20') + ', Withdrawals ' + nz_(b.emerald_withdrawals, '2040000') + ', Closing ' + nz_(b.emerald_closing, '34523742.18') + ', Status ' + nz_(b.emerald_status, 'Healthy')
  ];
  writeToFirstShape_(slide, lines.join('\n'));
}

function fillArrearsTable(deck, reportData) {
  const slide = getSlide_(deck, SLIDE_INDEX.ARREARS);
  const rows = reportData.arrears || [];
  writeListAsText_(slide, rows, row => [row.facility, row.unit, row.homeowner, row.invoice_number, row.amount_due, row.due_date, row.status].join(' | '), FALLBACKS.noneWeek);
}

function fillCollectionsTable(deck, reportData) {
  const slide = getSlide_(deck, SLIDE_INDEX.COLLECTIONS);
  const rows = reportData.collection_actions || [];
  writeListAsText_(slide, rows, row => [row.homeowner, row.facility, row.amount, yn_(row.reminder_sent), yn_(row.call_made), yn_(row.meeting_held), yn_(row.payment_plan), yn_(row.legal_action), row.next_step].join(' | '), FALLBACKS.noneWeek);
}

function fillTitleTransfersTable(deck, reportData) {
  const slide = getSlide_(deck, SLIDE_INDEX.TITLE);
  writeListAsText_(slide, reportData.title_transfers || [], row => [row.property_unit, row.owner_name, row.transfer_type, row.ministry_of_land, row.condo_board, row.start_date, row.target_date, row.status, row.blocker].join(' | '), FALLBACKS.noneWeek);
}

function fillLegalTable(deck, reportData) {
  const slide = getSlide_(deck, SLIDE_INDEX.LEGAL);
  const rows = reportData.legal_updates || [];
  const notes = reportData.legal_notes || [];
  const text = rows.map(r => [r.matter_property, r.type, r.date_submitted, r.status, r.expected_resolution, r.fees_tzs, r.action_required].join(' | ')).concat(['', 'Notes:']).concat(toBullets_(notes.length ? notes : [FALLBACKS.noUpdates])).join('\n');
  writeToFirstShape_(slide, text);
}

function fillSiteManagersTable(deck, reportData) {
  const slide = getSlide_(deck, SLIDE_INDEX.SITE);
  const rows = reportData.site_manager_reviews || [];
  const commend = reportData.site_manager_commendations || [];
  const concerns = reportData.site_manager_concerns || [];
  const text = rows.map(r => [r.site_manager, r.facility, r.rating, r.achievements, r.concerns, r.training_needs, r.action_items].join(' | ')).concat(['', 'Commendations:']).concat(toBullets_(commend.length ? commend : [FALLBACKS.noUpdates])).concat(['', 'Performance Concerns:']).concat(toBullets_(concerns.length ? concerns : [FALLBACKS.noUpdates])).join('\n');
  writeToFirstShape_(slide, text);
}

function fillPipelineTable(deck, reportData) {
  const slide = getSlide_(deck, SLIDE_INDEX.PIPELINE);
  const rows = reportData.pipeline || [];
  const summary = reportData.pipeline_summary || {};
  const text = rows.map(r => [r.prospect_name, r.location, r.type, r.units, r.contact_person, r.contact_info, r.status, r.est_revenue_tzs_month, r.next_steps].join(' | ')).concat([
    '',
    'Hot: ' + nz_(summary.hot, 0),
    'Warm: ' + nz_(summary.warm, 1),
    'Cold: ' + nz_(summary.cold, 0),
    'Conversion Target: ' + nz_(summary.conversion_target, 'Confirm next step after follow-up')
  ]).join('\n');
  writeToFirstShape_(slide, text);
}

function fillApproachedFacilitiesTable(deck, reportData) {
  const slide = getSlide_(deck, SLIDE_INDEX.APPROACHED);
  const rows = reportData.approached_facilities || [];
  const strategy = reportData.approach_strategy || [];
  const text = rows.map(r => [r.date, r.facility_name, r.location, r.contact_person, r.method, r.response, r.proposal_sent, r.follow_up_date].join(' | ')).concat(['', 'Prospecting Targets & Strategy:']).concat(toBullets_(strategy.length ? strategy : [FALLBACKS.noApproached])).join('\n');
  writeToFirstShape_(slide, text);
}

function fillValuationsTable(deck, reportData) {
  const slide = getSlide_(deck, SLIDE_INDEX.VALUATIONS);
  const rows = reportData.valuations || [{ item: 'None this week' }];
  const summary = reportData.valuations_summary || { total_requests: 0, completed: 0, in_progress: 0, overdue: 0, revenue: 'TZS 0' };
  const text = rows.map(r => r.item || JSON.stringify(r)).concat([
    '',
    'Total Requests: ' + nz_(summary.total_requests, 0),
    'Completed: ' + nz_(summary.completed, 0),
    'In Progress: ' + nz_(summary.in_progress, 0),
    'Overdue: ' + nz_(summary.overdue, 0),
    'Revenue: ' + nz_(summary.revenue, 'TZS 0')
  ]).join('\n');
  writeToFirstShape_(slide, text);
}

function fillMeetingsTable(deck, reportData) {
  const slide = getSlide_(deck, SLIDE_INDEX.MEETINGS);
  writeListAsText_(slide, reportData.meetings || [], row => [row.date, row.time, row.title, row.type, row.location, row.key_attendees, row.preparation_required, row.owner].join(' | '), FALLBACKS.noneWeek);
}

function fillChallengesTable(deck, reportData) {
  const slide = getSlide_(deck, SLIDE_INDEX.CHALLENGES);
  const rows = reportData.challenges || [];
  const ceoBlock = reportData.ceo_intervention_required || [];
  const text = rows.map(r => [r.issue, r.facility, r.severity, r.date_identified, r.root_cause, r.current_status, r.proposed_resolution, r.owner, r.deadline].join(' | ')).concat(['', 'CEO Intervention Required:']).concat(toBullets_(ceoBlock.length ? ceoBlock : [FALLBACKS.noChallenges])).join('\n');
  writeToFirstShape_(slide, text);
}

function fillBlockersTable(deck, reportData) {
  const slide = getSlide_(deck, SLIDE_INDEX.BLOCKERS);
  const rows = reportData.blockers || [];
  const summary = reportData.blockers_budget_summary || {};
  const text = rows.map(r => [r.item_work_required, r.facility, r.category, r.estimated_cost, r.blocked_reason, r.funds_available, r.days_blocked, r.priority, r.action_needed].join(' | ')).concat([
    '',
    'Total blocked maintenance requiring CEO approval: ' + nz_(summary.total_blocked, 'TBC'),
    'Recommended immediate release: ' + nz_(summary.recommended_release, 'TBC')
  ]).join('\n');
  writeToFirstShape_(slide, text || FALLBACKS.noBlocked);
}

function fillAob(deck, reportData) {
  const slide = getSlide_(deck, SLIDE_INDEX.AOB);
  const a = reportData.aob || {};
  const text = ['Other Updates:']
    .concat(toBullets_(a.other_updates || [FALLBACKS.noUpdates]))
    .concat(['', 'Discussion Points:'])
    .concat(toBullets_(a.discussion_points || [FALLBACKS.noAdditional]))
    .concat(['', 'Questions / Decisions Required From CEO:'])
    .concat(toBullets_(a.questions_for_ceo || [FALLBACKS.noAdditional]))
    .join('\n');
  writeToFirstShape_(slide, text);
}

function fillPreviousActionsTable(deck, reportData) {
  const slide = getSlide_(deck, SLIDE_INDEX.PREVIOUS_ACTIONS);
  const rows = reportData.previous_actions || [];
  const summary = reportData.previous_actions_summary || {};
  const text = rows.map(r => [r.action_item, r.assigned_to, r.deadline, r.status, r.completion_date, r.notes].join(' | ')).concat([
    '',
    nz_(summary.completion_rate_text, '2/5 items completed (40%)'),
    'Carried over: ' + nz_(summary.carried_over, 3),
    'Overdue: ' + nz_(summary.overdue, 0)
  ]).join('\n');
  writeToFirstShape_(slide, text || FALLBACKS.noUpdates);
}

function fillNewActionsTable(deck, reportData) {
  const slide = getSlide_(deck, SLIDE_INDEX.NEW_ACTIONS);
  const rows = reportData.new_actions || [];
  writeListAsText_(slide, rows, r => [r.action_item, r.assigned_to, r.priority, r.deadline, r.dependencies, r.notes].join(' | '), FALLBACKS.noneWeek);
}

function applyStatusColors(deck) {
  deck.getSlides().forEach(slide => {
    slide.getShapes().forEach(shape => {
      const tr = shape.getText();
      const content = tr.asString();
      Object.keys(STATUS_COLORS).forEach(key => {
        const re = new RegExp('\\b' + key.replace(/\s+/g, '\\s+') + '\\b', 'ig');
        let m;
        while ((m = re.exec(content)) !== null) {
          tr.getRange(m.index, m.index + m[0].length).getTextStyle().setForegroundColor(STATUS_COLORS[key]);
        }
      });
    });
  });
}

function cleanUnusedRows(deck, reportData) {
  const sections = [
    'valuations', 'approached_facilities', 'pipeline', 'blockers', 'challenges', 'new_actions', 'previous_actions'
  ];
  sections.forEach(sec => {
    if (!reportData[sec] || !reportData[sec].length) reportData[sec] = [{ item: FALLBACKS.noneWeek }];
  });
}

function clearResidualPlaceholders(deck) {
  const placeholders = ['[X]', '[Amount]', '[Date]', '[Status]', '[Facility]', '[Notes]'];
  deck.getSlides().forEach(slide => {
    placeholders.forEach(p => slide.replaceAllText(p, ''));
  });
}

function validateReportPayload_(reportData) {
  const errors = [];
  const warnings = [];
  const staticMap = getStaticMemoryMap();
  const presenter = reportData.presenter || {};
  const resolvedPresenter = {
    name: presenter.name || staticMap.presenter_name,
    title: presenter.title || staticMap.presenter_title,
    email: presenter.email || staticMap.presenter_email,
    phone: presenter.phone || staticMap.presenter_phone
  };
  ['name','title','email','phone'].forEach(f => {
    if (!sanitizeText_(resolvedPresenter[f])) errors.push('Presenter ' + f + ' is required.');
  });

  const es = reportData.executive_summary || {};
  if (Number(es.collection_rate || 0) > 100) errors.push('Collection rate cannot exceed 100.');

  const bank = reportData.bank_balances || {};
  validateBankFormula_('Kilima', bank.kilima_opening, bank.kilima_deposits, bank.kilima_withdrawals, bank.kilima_closing, warnings);
  validateBankFormula_('Emerald', bank.emerald_opening, bank.emerald_deposits, bank.emerald_withdrawals, bank.emerald_closing, warnings);

  (reportData.facility_updates || []).forEach(row => {
    if (/critical/i.test(String(row.status || '')) && !sanitizeText_(row.main_challenge || row.challenge)) {
      warnings.push('Critical status selected for ' + (row.facility || 'a facility') + ' but challenge note is blank.');
    }
  });

  const actionCount = (reportData.new_actions || []).length;
  const declared = Number((es.title_transfers || '0/0').toString().split('/')[1] || 0);
  if (declared && (reportData.title_transfers || []).length !== declared) {
    warnings.push('Executive summary title transfer total does not match detail rows.');
  }
  if (actionCount === 0) warnings.push('No new action items captured.');

  if (!isMonthActivated_()) errors.push('License inactive for month ' + getCurrentMonthKey() + '.');

  return { ok: !errors.length, errors: errors.concat(warnings.map(w => 'Warning: ' + w)) };
}

function validateBankFormula_(label, opening, deposits, withdrawals, closing, warnings) {
  const o = parseNumber_(opening);
  const d = parseNumber_(deposits);
  const w = parseNumber_(withdrawals);
  const c = parseNumber_(closing);
  if ([o, d, w, c].some(v => isNaN(v))) return;
  const calc = +(o + d - w).toFixed(2);
  if (Math.abs(calc - c) > 0.01) warnings.push(label + ' bank balance formula mismatch: opening + deposits - withdrawals should equal closing.');
}

function mergeWithLatestForQuickMode_(payload) {
  const latest = loadLatestReportData() || buildSeedReportData_();
  const draft = PropertiesService.getUserProperties().getProperty(PROP.DRAFT_JSON);
  const base = draft ? JSON.parse(draft) : latest;
  const merged = deepMerge_(base, payload);
  merged.report_date = payload.report_date || base.report_date || Utilities.formatDate(new Date(), APP_TZ, 'yyyy-MM-dd');
  merged.meta = merged.meta || {};
  merged.meta.report_id = merged.meta.report_id || buildReportId_(new Date());
  return merged;
}

function isMonthActivated_() {
  const s = getLicenseStatus();
  return s.is_active;
}

function getOrCreateStorageSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('storage.sheet.id');
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e) {}
  }
  const ss = SpreadsheetApp.create(STORAGE_SHEET_NAME);
  props.setProperty('storage.sheet.id', ss.getId());
  return ss;
}

function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  sheet.hideSheet();
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    const needs = headers.some((h, i) => firstRow[i] !== h);
    if (needs) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

function getSheet_(name) {
  const ss = getOrCreateStorageSpreadsheet_();
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Missing sheet: ' + name);
  return sh;
}

function getActiveOpenMatters_() {
  const sheet = getSheet_(SHEET_NAMES.OPEN);
  const vals = sheet.getDataRange().getValues();
  const out = [];
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][11]).toLowerCase() === 'yes') continue;
    out.push({
      matter_id: vals[i][0],
      category: vals[i][1],
      facility: vals[i][2],
      short_title: vals[i][3],
      details: vals[i][4],
      first_identified_date: vals[i][5],
      latest_status: vals[i][6],
      severity: vals[i][7],
      owner: vals[i][8],
      deadline: vals[i][9],
      ceo_attention: vals[i][10],
      resolved: vals[i][11],
      resolved_date: vals[i][12],
      last_updated: vals[i][13],
      carry_action: 'Still Open'
    });
  }
  return out;
}

function getSlide_(deck, idx) {
  const slides = deck.getSlides();
  if (!slides[idx]) throw new Error('Slide index ' + idx + ' not found in template.');
  return slides[idx];
}

function writeToFirstShape_(slide, text) {
  const shapes = slide.getShapes();
  if (!shapes.length) return;
  shapes[0].getText().setText(sanitizeTextBlock_(text));
}

function writeListAsText_(slide, rows, formatter, fallback) {
  if (!rows || !rows.length) {
    writeToFirstShape_(slide, fallback || FALLBACKS.noneWeek);
    return;
  }
  writeToFirstShape_(slide, rows.map(formatter).join('\n'));
}

function replaceInSlide_(slide, pairs) {
  Object.keys(pairs).forEach(k => slide.replaceAllText(k, sanitizeText_(pairs[k])));
}

function buildSeedReportData_() {
  return {
    report_date: '2026-04-18',
    presenter: { name: 'Eliphace', title: 'Facility Management Division', email: 'eliphace@cbcworldwide.tz', phone: '0765885594' },
    executive_summary: { facilities_managed: 2, total_arrears: 'TZS 3,097,363', collection_rate: 70, title_transfers: '0/2', new_prospects: 1 },
    key_highlights: [
      'Emerald HOA bank account opened successfully.',
      'CCTV servicing and security coordination completed at Emerald.',
      'Engagement continued to resolve Kilima owner and site manager issues.',
      'Hans Chris title transfer progressed from drawings stage to lease preparation.',
      'Ralf & Petra seller meeting scheduled for Friday.'
    ],
    ceo_attention: [
      'Kilima vendor Amir is not responding on time and is delaying reporting and issue handling.',
      'Three out of four Kilima owners reject the current site manager and may stop paying facilities fees if no change is made.',
      'Kilima owners continue to raise utility transparency complaints, especially around electricity and shared costs.',
      'Seller approval from Lydia is still needed to move the Hans Chris title transfer forward.'
    ],
    facility_updates: [
      { facility: 'Kilima Villas', units: 5, occupancy: '80%', status: 'Critical', main_challenge: '3 of 4 owners reject current site manager; utility transparency complaints', pending_payment: 'Bogdan Q1 and Q2 outstanding', site_manager_rating: 'Needs Improvement', site_manager_score: '4/10' },
      { facility: 'Emerald Paje', units: 20, occupancy: '100%', status: 'Healthy / On Track', main_challenge: 'None major', pending_payment: 'TZS 3,097,363', site_manager_rating: 'Good', site_manager_score: '8/10' }
    ],
    bank_balances: {
      emerald_opening: '32769775.98', emerald_deposits: '1753966.20', emerald_withdrawals: '2040000', emerald_closing: '34523742.18', emerald_status: 'Healthy',
      kilima_opening: '203230', kilima_deposits: '0', kilima_withdrawals: '0', kilima_closing: '203230', kilima_status: 'Critical',
      kilima_opening_usd: '2431.99'
    },
    arrears: [{ facility: 'Emerald Paje', unit: 'Villa 1', homeowner: 'Akil Sampson', invoice_number: '0153', amount_due: 'Needs confirmation', due_date: '8 Apr', status: 'Promised to pay' }],
    collection_actions: [
      { homeowner: 'Akil Sampson', facility: 'Emerald Paje', amount: 'Needs confirmation', reminder_sent: 'Yes', call_made: 'Yes', meeting_held: 'No', payment_plan: 'No', legal_action: 'No', next_step: 'Follow up this week' },
      { homeowner: 'Bogdan', facility: 'Kilima Villas', amount: 'Needs confirmation / USD-related outstanding', reminder_sent: 'Yes', call_made: 'Yes', meeting_held: 'No', payment_plan: 'No', legal_action: 'No', next_step: 'Await dispute/issue resolution and confirm outstanding amount' }
    ],
    title_transfers: [
      { property_unit: 'Hans Chris', owner_name: 'Hans Chris', transfer_type: 'Transfer', ministry_of_land: 'Lease preparation stage', condo_board: 'Pending', start_date: '-', target_date: '-', status: 'In Progress', blocker: 'Seller approval from Lydia' },
      { property_unit: 'Ralf & Petra', owner_name: 'Ralf & Petra', transfer_type: 'Transfer', ministry_of_land: 'Meeting scheduled', condo_board: 'Pending', start_date: '-', target_date: 'Friday', status: 'In Progress', blocker: 'Pending seller meeting outcome' }
    ],
    legal_updates: [
      { matter_property: 'Hans Chris title transfer', type: 'Title Transfer', date_submitted: '-', status: 'Pending seller approval', expected_resolution: 'TBC', fees_tzs: '-', action_required: 'Contact Lydia and secure approval' },
      { matter_property: 'Ralf & Petra title transfer', type: 'Title Transfer', date_submitted: '-', status: 'Meeting scheduled', expected_resolution: 'After Friday meeting', fees_tzs: '-', action_required: 'Proceed with meeting and confirm seller position' }
    ],
    legal_notes: [
      'Hans Chris has moved from drawings stage to lease preparation but still depends on seller approval.',
      'Ralf & Petra meeting is the next immediate legal coordination step.'
    ],
    site_manager_reviews: [
      { site_manager: 'Mr Danny', facility: 'Kilima Villas', rating: 'Needs Improvement', achievements: 'Maintained site coverage', concerns: 'Owner complaints on behavior and utility readings', training_needs: 'Professional meter reading and owner communication', action_items: 'Review with vendor and consider replacement' },
      { site_manager: 'Kevin', facility: 'Emerald Paje', rating: 'Good', achievements: 'Coordinated maintenance, CCTV, and security supervision', concerns: 'None major this week', training_needs: 'Routine monitoring', action_items: 'Maintain standards' }
    ],
    site_manager_commendations: ['Kevin: Strong operational support and good supervision of maintenance and CCTV work'],
    site_manager_concerns: ['Mr Danny: Repeated owner complaints and utility-reading concerns require corrective action'],
    pipeline: [{ prospect_name: 'Needs confirmation', location: '-', type: 'Facility Management', units: '-', contact_person: '-', contact_info: '-', status: 'Proposal Sent', est_revenue_tzs_month: 'TBC', next_steps: 'Follow up and confirm prospect details' }],
    pipeline_summary: { hot: 0, warm: 1, cold: 0, conversion_target: 'Confirm next step after follow-up' },
    approached_facilities: [{ date: '-', facility_name: 'None this week', location: '-', contact_person: '-', method: '-', response: '-', proposal_sent: '-', follow_up_date: '-' }],
    approach_strategy: [
      'New Outreach Calls: 0 / 0 / 0 / No outreach recorded this week',
      'Site Visits: 0 / 0 / 0 / No site visits recorded this week',
      'Proposals Sent: 1 / 1 / 0 / One proposal already sent; confirm prospect details next week'
    ],
    valuations: [{ item: 'None this week' }],
    valuations_summary: { total_requests: 0, completed: 0, in_progress: 0, overdue: 0, revenue: 'TZS 0' },
    meetings: [{ date: '18 Apr 2026', time: 'TBC', title: 'Ralf & Petra Title Transfer Meeting', type: 'Homeowner', location: 'TBC', key_attendees: 'Elphas, Ralf, Petra, relevant stakeholders', preparation_required: 'Prepare transfer status and required documents', owner: 'Elphas' }],
    challenges: [
      { issue: 'Owners rejecting current site manager', facility: 'Kilima Villas', severity: 'Critical', date_identified: 'This week', root_cause: 'Low trust in site management and repeated owner dissatisfaction', current_status: 'Unresolved', proposed_resolution: 'Review replacement or vendor-led corrective action', owner: 'CEO / Ops', deadline: 'Immediate' },
      { issue: 'Utility billing transparency complaints', facility: 'Kilima Villas', severity: 'High', date_identified: 'Ongoing', root_cause: 'Weak reporting transparency on electricity and shared utility costs', current_status: 'Active complaints', proposed_resolution: 'Improve reporting transparency and owner-facing breakdown', owner: 'Ops / Vendor', deadline: 'Immediate' },
      { issue: 'Vendor Amir non-responsive', facility: 'Kilima Villas', severity: 'High', date_identified: 'Ongoing', root_cause: 'Delays in responding to owner concerns and preparing reports', current_status: 'Not resolved', proposed_resolution: 'Escalate vendor accountability and performance review', owner: 'Ops', deadline: 'Immediate' },
      { issue: 'Seller approval pending for Hans Chris transfer', facility: 'Hans Chris', severity: 'High', date_identified: 'This week', root_cause: 'Seller Lydia has not yet approved continuation', current_status: 'Pending seller approval', proposed_resolution: 'CEO support to contact Lydia and secure approval', owner: 'CEO / Ops', deadline: 'Immediate' }
    ],
    ceo_intervention_required: [
      'Decision needed on Kilima site manager issue.',
      'Support needed to resolve Kilima utility transparency and vendor response concerns.',
      'Support needed to secure Lydia’s approval for Hans Chris title transfer.'
    ],
    blockers: [
      { item_work_required: 'Resolve Kilima owner refusal to continue paying under current site manager', facility: 'Kilima Villas', category: 'Operational', estimated_cost: 'TBC', blocked_reason: 'Owner dissatisfaction and vendor handling issues', funds_available: 'No', days_blocked: 'Ongoing', priority: 'Urgent', action_needed: 'Escalate decision on site manager and vendor accountability' },
      { item_work_required: 'Improve utility transparency reporting', facility: 'Kilima Villas', category: 'Utilities / Reporting', estimated_cost: 'TBC', blocked_reason: 'No clear owner-facing evidence for utility charges', funds_available: 'No', days_blocked: 'Ongoing', priority: 'High', action_needed: 'Prepare transparent utility reporting structure' },
      { item_work_required: 'CCTV servicing', facility: 'Emerald Paje', category: 'Security / Maintenance', estimated_cost: 'Completed', blocked_reason: 'None', funds_available: 'Yes', days_blocked: '0', priority: 'Low', action_needed: 'Monitor after servicing' }
    ],
    blockers_budget_summary: { total_blocked: 'TBC', recommended_release: 'TBC' },
    previous_actions: [
      { action_item: 'Open Emerald HOA account', assigned_to: 'Elphas', deadline: 'This week', status: 'Complete', completion_date: 'This week', notes: 'Account opened successfully' },
      { action_item: 'Complete CCTV servicing at Emerald', assigned_to: 'Elphas / Site Team', deadline: 'This week', status: 'Complete', completion_date: 'This week', notes: 'CCTV servicing completed' },
      { action_item: 'Resolve Kilima owner/site manager issue', assigned_to: 'Ops / CEO', deadline: 'Immediate', status: 'In Progress', completion_date: 'N/A', notes: 'Owners still dissatisfied; escalation continues' },
      { action_item: 'Progress Hans Chris title transfer', assigned_to: 'Elphas / Legal', deadline: 'This week', status: 'In Progress', completion_date: 'N/A', notes: 'Moved to lease preparation stage, seller approval still pending' },
      { action_item: 'Organize Ralf & Petra seller meeting', assigned_to: 'Elphas', deadline: 'Friday', status: 'In Progress', completion_date: 'N/A', notes: 'Meeting scheduled for Friday' }
    ],
    previous_actions_summary: { completion_rate_text: '2/5 items completed (40%)', carried_over: 3, overdue: 0 },
    new_actions: [
      { action_item: 'Follow up on Kilima vendor Amir response and accountability', assigned_to: 'Ops', priority: 'Urgent', deadline: 'Immediate', dependencies: 'Vendor response and owner complaint review', notes: 'Must address delayed reporting and complaint handling', status: 'In Progress' },
      { action_item: 'Escalate decision on Kilima site manager', assigned_to: 'CEO / Ops', priority: 'Urgent', deadline: 'Immediate', dependencies: 'Owner feedback and vendor discussion', notes: 'Three owners may refuse to continue paying under current setup', status: 'In Progress' },
      { action_item: 'Contact Lydia to secure Hans Chris transfer approval', assigned_to: 'CEO / Ops', priority: 'High', deadline: 'Immediate', dependencies: 'Ramazan Swadik / seller response', notes: 'Required to progress transfer', status: 'In Progress' },
      { action_item: 'Prepare for Ralf & Petra title transfer meeting', assigned_to: 'Elphas', priority: 'High', deadline: '18 Apr 2026', dependencies: 'Required documents and stakeholder availability', notes: 'Meeting already scheduled', status: 'In Progress' },
      { action_item: 'Follow up Emerald arrears promises', assigned_to: 'Elphas', priority: 'High', deadline: 'This week', dependencies: 'Owner responses', notes: 'Confirm payment from outstanding owners', status: 'In Progress' }
    ],
    aob: {
      other_updates: [
        'Emerald HOA account is now operational.',
        'CCTV servicing at Emerald has been completed.',
        'Kilima owner dissatisfaction remains the main operational concern.',
        'Hans Chris title transfer progressed to lease preparation.',
        'Ralf & Petra meeting is scheduled for Friday.'
      ],
      discussion_points: [
        'Whether Kilima site manager should be changed.',
        'How to improve utility transparency for Kilima owners.',
        'How to secure seller cooperation for Hans Chris.',
        'Follow-up strategy for Emerald arrears.'
      ],
      questions_for_ceo: [
        'Should management change the Kilima site manager?',
        'How should vendor Amir’s performance be handled?',
        'Can CEO intervene directly with Lydia on Hans Chris?'
      ]
    },
    open_matters: getActiveOpenMatters_()
  };
}

function buildReportId_(d) {
  return 'RPT-' + Utilities.formatDate(d, APP_TZ, 'yyyyMMdd-HHmmss');
}

function buildMatterId_() {
  return 'OM-' + Utilities.formatDate(new Date(), APP_TZ, 'yyyyMMddHHmmss');
}

function parseNumber_(v) {
  return Number(String(v || '').replace(/[^0-9.-]/g, ''));
}

function normalizeDate_(d) {
  if (!d) return Utilities.formatDate(new Date(), APP_TZ, 'yyyy-MM-dd');
  return String(d).trim();
}

function sanitizeText_(v) {
  const x = (v == null ? '' : String(v)).trim();
  return x.replace(/\s+/g, ' ');
}

function sanitizeTextBlock_(v) {
  return (v == null ? '' : String(v))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .trim();
}

function normalizeCurrency_(v) {
  const s = sanitizeText_(v);
  if (!s) return 'TZS 0';
  if (/^(TZS|USD)/i.test(s)) return s;
  return 'TZS ' + s;
}

function nz_(v, fallback) {
  const s = sanitizeText_(v);
  return s || String(fallback);
}

function yn_(v) {
  return /^(yes|true|y)$/i.test(String(v || '')) ? 'Yes' : 'No';
}

function toBullets_(arr) {
  return (arr || []).map((x, i) => (i + 1) + '. ' + sanitizeText_(x));
}

function deepMerge_(target, source) {
  if (source == null) return target;
  const out = Array.isArray(target) ? target.slice() : Object.assign({}, target);
  Object.keys(source).forEach(k => {
    const sv = source[k];
    if (Array.isArray(sv)) {
      out[k] = sv;
    } else if (sv && typeof sv === 'object') {
      out[k] = deepMerge_(out[k] && typeof out[k] === 'object' ? out[k] : {}, sv);
    } else {
      out[k] = sv;
    }
  });
  return out;
}
