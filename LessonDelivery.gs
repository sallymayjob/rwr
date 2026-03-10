/** LMS lesson delivery uses Slack_Delivery as canonical source. */

function getConfig() {
  return {
    DEFAULT_LESSON_CHANNEL: PROPS.getProperty('DEFAULT_LESSON_CHANNEL') || '',
    DEFAULT_ONBOARDING_CHANNEL: PROPS.getProperty('DEFAULT_ONBOARDING_CHANNEL') || '',
    ONBOARDING_SHEET_NAME: PROPS.getProperty('ONBOARDING_SHEET_NAME') || SHEET_ONBOARDING,
    DRY_RUN: String(PROPS.getProperty('DRY_RUN') || 'false').toLowerCase() === 'true',
    BATCH_LIMIT: Number(PROPS.getProperty('BATCH_LIMIT') || 25),
    SLACK_BOT_TOKEN: PROPS.getProperty('SLACK_BOT_TOKEN') || ''
  };
}

function getSheetByName(name) { return SS.getSheetByName(name); }
function getLessonSheet() { return SS.getSheetByName(SHEET_SLACK_DELIVERY); }
function getOnboardingSheet() { return SS.getSheetByName(getConfig().ONBOARDING_SHEET_NAME); }
function logInfo(message) { Logger.log(message); }
function logError(message) { Logger.log(message); }

function getHeaderMap(sheet) {
  const headers = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0].map(function(h) { return String(h || '').trim(); });
  const map = {};
  headers.forEach(function(h, i) { map[h] = i; });
  return { headers: headers, map: map };
}

function ensureLessonTrackingColumns() {
  const required = ['LessonID','Slack Thread Text','Submit Code','Delivery Status','Slack TS','Slack Channel','Send Order'];
  return { headers: ensureSheetColumnsByName_(SHEET_SLACK_DELIVERY, required) };
}

function ensureOnboardingTrackingColumns() {
  const sheetName = getConfig().ONBOARDING_SHEET_NAME;
  const required = ['Step ID','Slack Message','Posted Status','Posted At','Slack TS','Slack Channel','Error Log','Completed Status','Submission JSON'];
  return { headers: ensureSheetColumnsByName_(sheetName, required) };
}

function ensureTrackingColumns() {
  ensureCurriculumDatabaseColumns();
  ensureLessonTrackingColumns();
  ensureOnboardingTrackingColumns();
  ensureGovernanceSheetsAndColumns();
  return { ok: true };
}

function buildRows_(sheet, headers) {
  const values = sheet.getDataRange().getValues();
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const obj = rowToObj(headers, values[r]);
    obj.__rowIndex = r + 1;
    out.push(obj);
  }
  return out;
}

function getLessonRows() {
  const sheet = getLessonSheet();
  const meta = ensureLessonTrackingColumns();
  const rows = buildRows_(sheet, meta.headers);
  rows.sort(function(a, b) { return Number(a['Send Order'] || 999999) - Number(b['Send Order'] || 999999); });
  return rows;
}

function getOrderedLessonsForCourseOrModule(courseId, moduleId) {
  const lessonsData = getAllRows(SHEET_LESSONS);
  const rows = lessonsData.rows.map(function(r) { return rowToObj(lessonsData.headers, r); }).filter(function(r) {
    const status = String(r['Status'] || '').toLowerCase();
    if (status === 'archived') return false;
    if (moduleId) return String(r['ModuleID']) === String(moduleId);
    return String(r['CourseID']) === String(courseId);
  });

  if (!moduleId && courseId) {
    const mapRows = getCourseModuleMapRows(courseId);
    const moduleOrder = {};
    mapRows.forEach(function(m, idx) { moduleOrder[String(m['ModuleID'])] = idx; });
    rows.sort(function(a, b) {
      const am = moduleOrder[String(a['ModuleID'])];
      const bm = moduleOrder[String(b['ModuleID'])];
      const av = am == null ? 9999 : am;
      const bv = bm == null ? 9999 : bm;
      if (av !== bv) return av - bv;
      return Number(a['Lesson Order'] || 99999) - Number(b['Lesson Order'] || 99999);
    });
    return rows;
  }

  rows.sort(function(a, b) { return Number(a['Lesson Order'] || 99999) - Number(b['Lesson Order'] || 99999); });
  return rows;
}

function getSlackDeliveryRowForLesson(lessonId) {
  const row = getLessonDeliveryRow(lessonId);
  if (row) return row;

  // Legacy compatibility only: fallback to Slack_Threads alias if configured differently.
  if (SHEET_THREADS && SHEET_THREADS !== SHEET_SLACK_DELIVERY) {
    const data = getAllRows(SHEET_THREADS);
    const idx = data.headers.indexOf('LessonID');
    for (let i = 0; i < data.rows.length; i++) {
      if (String(data.rows[i][idx]) === String(lessonId)) {
        const obj = rowToObj(data.headers, data.rows[i]);
        obj._rowIndex = i + 2;
        return obj;
      }
    }
  }

  return null;
}

function canDeliverLesson(lessonId) {
  const ok = isLessonQaApproved(lessonId);
  if (!ok) {
    return { ok: false, blocked: true, reason: 'Lesson blocked by QA gate', lesson_id: lessonId };
  }
  return { ok: true, blocked: false, lesson_id: lessonId };
}

function buildLessonMessage(row) { return String(row['Slack Thread Text'] || ''); }

function markLessonPosted(rowIndex, response) {
  const sheet = getLessonSheet();
  const meta = getHeaderMap(sheet);
  const idxStatus = meta.headers.indexOf('Delivery Status');
  const idxTs = meta.headers.indexOf('Slack TS');
  const idxChannel = meta.headers.indexOf('Slack Channel');
  if (idxStatus >= 0) sheet.getRange(rowIndex, idxStatus + 1).setValue('Delivered');
  if (idxTs >= 0) sheet.getRange(rowIndex, idxTs + 1).setValue(response.ts || '');
  if (idxChannel >= 0) sheet.getRange(rowIndex, idxChannel + 1).setValue(response.channel || '');
}

function markLessonDelivered(learnerId, lessonId, channel, ts) {
  const row = getSlackDeliveryRowForLesson(lessonId);
  if (row && row._rowIndex) {
    markLessonPosted(row._rowIndex, { channel: channel || '', ts: ts || '' });
  }

  const learner = getLearnerRecord(learnerId);
  if (learner && learner._rowIndex) {
    const data = getAllRows(SHEET_LEARNERS);
    const idxLastLesson = data.headers.indexOf('Last LessonID');
    if (idxLastLesson >= 0) data.sheet.getRange(learner._rowIndex, idxLastLesson + 1).setValue(lessonId);
  }
}

function blockLessonDelivery(lessonId, reason) {
  Logger.log('Lesson delivery blocked for ' + lessonId + ': ' + reason);
  return { ok: false, posted: false, blocked: true, lesson_id: lessonId, reason: reason };
}

function markRowError(sheet, headers, rowIndex, errorMessage) {
  const idx = headers.indexOf('Error Log');
  if (idx >= 0) sheet.getRange(rowIndex, idx + 1).setValue(String(errorMessage || ''));
}

function callSlackApi(method, payload) {
  const cfg = getConfig();
  if (!cfg.SLACK_BOT_TOKEN) throw new Error('Missing SLACK_BOT_TOKEN in Script Properties.');
  if (cfg.DRY_RUN) return { ok: true, ts: 'dryrun-' + Date.now(), channel: payload.channel || '' };
  const response = UrlFetchApp.fetch(SLACK_API_BASE + method, {
    method: 'post', contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + cfg.SLACK_BOT_TOKEN },
    payload: JSON.stringify(payload || {}), muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const body = JSON.parse(response.getContentText() || '{}');
  if (status >= 300 || !body.ok) throw new Error('Slack API ' + method + ' failed: ' + (body.error || status));
  return body;
}

function postSlackMessage(channel, text) {
  return callSlackApi('chat.postMessage', { channel: channel, text: text || '' });
}

function openSlackModal(triggerId, view) { return callSlackApi('views.open', { trigger_id: triggerId, view: view }); }

function postLessonInternal_(row, targetChannel, learnerId) {
  const lessonId = String(row['LessonID'] || '').trim();
  if (!lessonId) throw new Error('Missing LessonID in Slack_Delivery row');

  const qaResult = canDeliverLesson(lessonId);
  if (!qaResult.ok) return blockLessonDelivery(lessonId, qaResult.reason || 'QA gate failed');

  const channel = String(targetChannel || row['Slack Channel'] || row['Mapped Channel Name'] || getConfig().DEFAULT_LESSON_CHANNEL).trim();
  if (!channel) throw new Error('No Slack channel for lesson ' + lessonId);

  const response = postSlackMessage(channel, buildLessonMessage(row));
  markLessonDelivered(learnerId || '', lessonId, response.channel, response.ts);
  recordLessonMetricTouch(lessonId);
  return { ok: true, posted: true, lesson_id: lessonId, ts: response.ts, channel: response.channel };
}

function getNextLessonForLearner(learnerId) {
  const learner = getLearnerRecord(learnerId);
  if (!learner) return null;

  // Canonical learner progression path.
  const canonicalLessonId = getCurrentLessonId(learner);
  if (canonicalLessonId) return String(canonicalLessonId);

  // Compatibility fallback only: infer from submissions + ordered lessons.
  const orderedLessons = getOrderedLessonsForCourseOrModule(learner['Enrolled Course'] || '', learner['Current Module'] || '');
  if (!orderedLessons.length) return null;

  const done = {};
  getLearnerSubmissions(learnerId).forEach(function(s) { done[String(s['Lesson'] || '')] = true; });
  for (let i = 0; i < orderedLessons.length; i++) {
    const lessonId = String(orderedLessons[i]['LessonID'] || '');
    if (lessonId && !done[lessonId]) return lessonId;
  }

  return null;
}

function getNextLessonRow() {
  const rows = getLessonRows();
  for (let i = 0; i < rows.length; i++) {
    const status = String(rows[i]['Delivery Status'] || '').toLowerCase();
    if (status === 'delivered') continue;
    return rows[i];
  }
  return null;
}

function postNextLesson() {
  const row = getNextLessonRow();
  if (!row) return { ok: true, posted: false, message: 'No pending lesson.' };
  return postLessonInternal_(row);
}

function postAllLessons(limit) {
  const maxToPost = Number(limit || getConfig().BATCH_LIMIT || 25);
  const rows = getLessonRows();
  let posted = 0;
  for (let i = 0; i < rows.length && posted < maxToPost; i++) {
    const status = String(rows[i]['Delivery Status'] || '').toLowerCase();
    if (status === 'delivered') continue;
    const result = postLessonInternal_(rows[i]);
    if (result && result.posted) posted++;
  }
  return { ok: true, posted: posted };
}

function postLessonById(lessonId) {
  const row = getSlackDeliveryRowForLesson(lessonId);
  if (!row) throw new Error('Lesson not found in Slack_Delivery: ' + lessonId);
  return postLessonInternal_(row);
}

function postNextLessonForUser(userId) {
  const learner = getLearnerRecord(userId);
  if (!learner) throw new Error('Learner not found');

  const lessonId = getNextLessonForLearner(userId);
  if (!lessonId) return { ok: true, posted: false, message: 'No pending lesson.' };

  const row = getSlackDeliveryRowForLesson(lessonId);
  if (!row) throw new Error('Slack_Delivery row missing for ' + lessonId);

  const qaResult = canDeliverLesson(lessonId);
  if (!qaResult.ok) return blockLessonDelivery(lessonId, qaResult.reason || 'QA gate failed');

  const dm = openDM(userId);
  const response = postSlackMessage(dm, buildLessonMessage(row));
  markLessonDelivered(userId, lessonId, response.channel, response.ts);
  return { ok: true, posted: true, lesson_id: lessonId, ts: response.ts, channel: response.channel };
}

// Onboarding isolated: only /onboard and onboarding interactivity use these handlers.
function generateStepIdsIfMissing() {
  if (!isFeatureEnabled('FEATURE_ONBOARDING_STEP_ID_AUTOGEN', false)) {
    Logger.log('generateStepIdsIfMissing skipped: FEATURE_ONBOARDING_STEP_ID_AUTOGEN disabled.');
    return false;
  }
  return true;
}
function getOnboardingRows() { const s = getOnboardingSheet(); if (!s) return []; const m = ensureOnboardingTrackingColumns(); return buildRows_(s, m.headers); }
function getNextOnboardingRow() { const rows = getOnboardingRows(); for (let i=0;i<rows.length;i++) if (String(rows[i]['Posted Status']||'').toLowerCase() !== 'posted') return rows[i]; return null; }
function buildOnboardingMessage(row) { return String(row['Slack Message'] || ''); }
function postOnboardingInternal_(row) {
  const channel = String(row['Slack Channel'] || getConfig().DEFAULT_ONBOARDING_CHANNEL || '').trim();
  if (!channel) throw new Error('Missing onboarding channel');
  const res = postSlackMessage(channel, buildOnboardingMessage(row));
  const sheet = getOnboardingSheet(); const meta = getHeaderMap(sheet);
  const iStatus = meta.headers.indexOf('Posted Status'); const iAt = meta.headers.indexOf('Posted At'); const iTs = meta.headers.indexOf('Slack TS'); const iCh = meta.headers.indexOf('Slack Channel');
  if (iStatus>=0) sheet.getRange(row.__rowIndex, iStatus+1).setValue('Posted');
  if (iAt>=0) sheet.getRange(row.__rowIndex, iAt+1).setValue(new Date());
  if (iTs>=0) sheet.getRange(row.__rowIndex, iTs+1).setValue(res.ts || '');
  if (iCh>=0) sheet.getRange(row.__rowIndex, iCh+1).setValue(res.channel || channel);
  return { ok: true, posted: true };
}
function postNextOnboardingStep() { const row = getNextOnboardingRow(); if (!row) return {ok:true,posted:false}; return postOnboardingInternal_(row); }
function postAllOnboardingSteps(limit) { let p=0; const rows=getOnboardingRows(); for(let i=0;i<rows.length && p<Number(limit||25);i++){ if(String(rows[i]['Posted Status']||'').toLowerCase()==='posted') continue; postOnboardingInternal_(rows[i]); p++; } return {ok:true,posted:p}; }
function postOnboardingStepByIdentifier(id) {
  var row = resolveOnboardingRowByIdentifier_(id, '', '');
  if (!row) return { ok: false, posted: false, error: 'onboarding_identifier_not_found' };
  return postOnboardingInternal_(row);
}
function buildOnboardingModal(row) {
  var privateMeta = JSON.stringify({ step_id: String(row['Step ID'] || ''), row_index: Number(row.__rowIndex || 0) || 0 });
  return {
    type:'modal',
    private_metadata: privateMeta,
    callback_id:'onboarding_modal',
    title:{type:'plain_text',text:'Onboarding'},
    close:{type:'plain_text',text:'Close'},
    submit:{type:'plain_text',text:'Complete'},
    blocks:[
      {type:'section', text:{type:'mrkdwn', text: buildOnboardingMessage(row)}},
      {
        type:'input',
        block_id:'completion_note',
        optional:true,
        label:{ type:'plain_text', text:'Notes (optional)' },
        element:{ type:'plain_text_input', action_id:'note' }
      }
    ]
  };
}
function openOnboardingModal(triggerId, row) { return openSlackModal(triggerId, buildOnboardingModal(row)); }
function resolveOnboardingRowByIdentifier_(identifier, channel, ts) {
  var id = String(identifier || '').trim();
  var rows = getOnboardingRows();
  for (var i = 0; i < rows.length; i++) {
    if (id && String(rows[i]['Step ID'] || '') === id) return rows[i];
    if (channel && ts && String(rows[i]['Slack Channel'] || '') === String(channel) && String(rows[i]['Slack TS'] || '') === String(ts)) return rows[i];
  }
  return null;
}

function updateOnboardingRowFromModal(rowIndex, submittedData) {
  var sheet = getOnboardingSheet();
  if (!sheet || !rowIndex) return false;
  var meta = getHeaderMap(sheet);
  var iCompleted = meta.headers.indexOf('Completed Status');
  var iError = meta.headers.indexOf('Error Log');
  var iPostedAt = meta.headers.indexOf('Posted At');
  var iPostedStatus = meta.headers.indexOf('Posted Status');
  var iSubmission = meta.headers.indexOf('Submission JSON');

  if (iCompleted >= 0) sheet.getRange(rowIndex, iCompleted + 1).setValue('Completed');
  if (iPostedStatus >= 0) sheet.getRange(rowIndex, iPostedStatus + 1).setValue('Posted');
  if (iPostedAt >= 0) sheet.getRange(rowIndex, iPostedAt + 1).setValue(new Date());
  if (iError >= 0) sheet.getRange(rowIndex, iError + 1).setValue('');
  if (iSubmission >= 0) sheet.getRange(rowIndex, iSubmission + 1).setValue(JSON.stringify(submittedData || {}));
  return true;
}

function handleOnboardingButtonClick(payload) {
  var action = payload && payload.actions && payload.actions[0];
  if (!action) return { ok: true, skipped: true };

  var stepId = String(action.value || '').trim();
  var channel = payload && payload.container && payload.container.channel_id;
  var ts = payload && payload.container && payload.container.message_ts;
  var row = resolveOnboardingRowByIdentifier_(stepId, channel, ts);
  if (!row) return { ok: false, error: 'onboarding_row_not_found' };

  var actionId = String(action.action_id || '').toLowerCase();
  var actor = (payload.user && payload.user.id) || '';
  var completeActionIds = {
    onboarding_complete: true,
    onboarding_done: true,
    onboarding_mark_done: true
  };

  if (actionId === 'onboarding_open_modal' || actionId === 'onboarding_modal_open') {
    if (!payload.trigger_id) return { ok: false, error: 'missing_trigger_id' };
    return openOnboardingModal(payload.trigger_id, row);
  }

  if (completeActionIds[actionId]) {
    updateOnboardingRowFromModal(row.__rowIndex, { source: 'button', action_id: actionId, user_id: actor });
    return { ok: true, completed: true };
  }

  Logger.log('Unknown onboarding action_id=' + actionId + ' user=' + actor + ' step_id=' + stepId);
  return { ok: false, error: 'unknown_onboarding_action_id', action_id: actionId };
}

function buildSlackViewValidationError_(blockId, message) {
  var err = {};
  err[String(blockId || 'completion_note')] = String(message || 'Please review this field.');
  return { ok: false, response_action: 'errors', errors: err };
}

function handleOnboardingModalSubmit(payload) {
  var md = {};
  try { md = JSON.parse((payload && payload.view && payload.view.private_metadata) || '{}'); } catch (ignore) { md = {}; }
  var rowIndex = Number(md.row_index || 0);
  var values = (((payload || {}).view || {}).state || {}).values || {};
  var out = { source: 'modal', user_id: (payload.user && payload.user.id) || '' };
  Object.keys(values).forEach(function(blockId) {
    var block = values[blockId] || {};
    Object.keys(block).forEach(function(actionId) {
      var item = block[actionId] || {};
      if (item.value != null) out[actionId] = item.value;
      else if (item.selected_option && item.selected_option.value != null) out[actionId] = item.selected_option.value;
    });
  });

  if (!rowIndex && md.step_id) {
    var row = resolveOnboardingRowByIdentifier_(md.step_id, '', '');
    rowIndex = row ? row.__rowIndex : 0;
  }
  if (!rowIndex) return buildSlackViewValidationError_('completion_note', 'This onboarding step could not be found. Please close and reopen the modal from the onboarding message.');

  updateOnboardingRowFromModal(rowIndex, out);
  return { ok: true, completed: true };
}

function isOnboardingShortcutEnabled_() {
  return isFeatureEnabled('FEATURE_ONBOARDING_SHORTCUTS', false);
}

function parseOnboardingShortcutMetadata_(payload) {
  var raw = ((payload || {}).callback_id || '').trim();
  if (!raw) return { action: '', step_id: '' };

  var match = raw.match(/^onboarding_shortcut(?::([^:]+))?(?::(.+))?$/);
  if (!match) return { action: '', step_id: '' };
  return {
    action: String(match[1] || 'open_modal').trim().toLowerCase(),
    step_id: String(match[2] || '').trim()
  };
}

function handleOnboardingShortcut(payload) {
  if (!isOnboardingShortcutEnabled_()) {
    Logger.log('Slack shortcut ignored because FEATURE_ONBOARDING_SHORTCUTS is disabled. callback_id=' + String(payload && payload.callback_id || ''));
    return { ok: true, skipped: true, reason: 'feature_flag_disabled' };
  }

  var triggerId = String(payload && payload.trigger_id || '').trim();
  if (!triggerId) return { ok: false, error: 'missing_trigger_id' };

  var md = parseOnboardingShortcutMetadata_(payload);
  var stepId = md.step_id;
  var row = stepId ? resolveOnboardingRowByIdentifier_(stepId, '', '') : getNextOnboardingRow();
  if (!row) {
    var actor = (payload && payload.user && payload.user.id) || '';
    if (actor) postDM(actor, 'No onboarding step is available to open right now.');
    return { ok: true, skipped: true, reason: 'onboarding_row_not_found' };
  }

  return openOnboardingModal(triggerId, row);
}

function routeSlackBlockAction_(payload) {
  var action = payload && payload.actions && payload.actions[0];
  if (!action) return { ok: true, skipped: true };

  var actionId = String(action.action_id || '').trim();
  if (!actionId) {
    Logger.log('Slack block_actions payload missing action_id: ' + JSON.stringify({ user: (payload.user && payload.user.id) || '', container: payload.container || {} }));
    return { ok: false, error: 'missing_action_id' };
  }

  if (actionId === 'lesson_complete') {
    var userId = (payload.user && payload.user.id) || '';
    appendToQueue(userId, JSON.stringify({ kind: 'block_action', payload: payload }));
    scheduleQueuedPipeline_();
    return { ok: true, queued: true };
  }

  if (actionId.indexOf('onboarding_') === 0) {
    return handleOnboardingButtonClick(payload);
  }

  Logger.log('Unknown Slack block action_id=' + actionId + ' user=' + ((payload.user && payload.user.id) || '') + ' callback_id=' + ((payload.view && payload.view.callback_id) || ''));
  return { ok: false, error: 'unknown_action_id', action_id: actionId };
}

function routeSlackViewSubmission_(payload) {
  var view = payload && payload.view || {};
  var callbackId = String(view.callback_id || '').trim();
  if (callbackId === 'onboarding_modal') return handleOnboardingModalSubmit(payload);

  Logger.log('Unknown Slack view_submission callback_id=' + callbackId + ' user=' + ((payload.user && payload.user.id) || ''));
  return { ok: true, skipped: true, reason: 'unknown_view_submission', callback_id: callbackId };
}

function routeSlackShortcut_(payload) {
  var callbackId = String(payload && payload.callback_id || '').trim();
  if (callbackId.indexOf('onboarding_shortcut') === 0) return handleOnboardingShortcut(payload);

  Logger.log('Unknown Slack shortcut callback_id=' + callbackId + ' user=' + ((payload.user && payload.user.id) || ''));
  return { ok: true, skipped: true, reason: 'unknown_shortcut', callback_id: callbackId };
}

function handleSlackInteraction(payload) {
  try {
    if (!payload) return { ok: false, skipped: true };

    if (payload.type === 'block_actions') return routeSlackBlockAction_(payload);
    if (payload.type === 'view_submission') return routeSlackViewSubmission_(payload);
    if (payload.type === 'shortcut' || payload.type === 'message_action') return routeSlackShortcut_(payload);

    Logger.log('Unknown Slack interaction type=' + String(payload.type || '') + ' payload=' + JSON.stringify({ user: (payload.user && payload.user.id) || '', callback_id: payload.callback_id || '' }));
    return { ok: true, skipped: true };
  } catch (err) {
    Logger.log('handleSlackInteraction error: ' + err);
    return { ok: false, error: String(err) };
  }
}

function testSlackConnection() { return callSlackApi('auth.test', {}); }
function onOpen() { SpreadsheetApp.getUi().createMenu('Slack Automation').addItem('Ensure Tracking Columns', 'menuEnsureTrackingColumns').addToUi(); }
function menuEnsureTrackingColumns() { ensureTrackingColumns(); }
function menuPostNextLesson() { postNextLesson(); }
function menuPostAllLessons() { postAllLessons(); }
function menuPostLessonById() {
  throw new Error('menuPostLessonById is not wired. Use postLessonById(lessonId) directly from Apps Script for targeted posting.');
}
function menuPostNextOnboardingStep() { postNextOnboardingStep(); }
function menuPostAllOnboardingSteps() { postAllOnboardingSteps(); }
function menuPostOnboardingByIdentifier() {
  throw new Error('menuPostOnboardingByIdentifier is not wired. Use postOnboardingStepByIdentifier(stepId) directly from Apps Script.');
}
function menuTestSlackConnection() { testSlackConnection(); }
function menuEnsureCurriculumDatabaseColumns() { ensureCurriculumDatabaseColumns(); }
function reopenOnboardingStepModal(identifier) {
  var row = resolveOnboardingRowByIdentifier_(identifier, '', '');
  if (!row) throw new Error('Onboarding row not found for identifier: ' + identifier);
  return { ok: true, requires_trigger: true, message: 'Use a button/shortcut trigger_id to open modal for this step.' };
}
function resetOnboardingPostedStatus(identifier) {
  var row = resolveOnboardingRowByIdentifier_(identifier, '', '');
  if (!row) throw new Error('Onboarding row not found for identifier: ' + identifier);
  var sheet = getOnboardingSheet();
  var meta = getHeaderMap(sheet);
  var iStatus = meta.headers.indexOf('Posted Status');
  var iTs = meta.headers.indexOf('Slack TS');
  var iAt = meta.headers.indexOf('Posted At');
  var iCompleted = meta.headers.indexOf('Completed Status');
  if (iStatus >= 0) sheet.getRange(row.__rowIndex, iStatus + 1).setValue('');
  if (iTs >= 0) sheet.getRange(row.__rowIndex, iTs + 1).setValue('');
  if (iAt >= 0) sheet.getRange(row.__rowIndex, iAt + 1).setValue('');
  if (iCompleted >= 0) sheet.getRange(row.__rowIndex, iCompleted + 1).setValue('');
  return { ok: true, reset: true };
}
function resolveOnboardingRowByIdentifierForMenu_(id) { return resolveOnboardingRowByIdentifier_(id, '', ''); }
function menuGenerateStepIds() { generateStepIdsIfMissing(); }
function menuReopenOnboardingModal() {
  throw new Error('menuReopenOnboardingModal requires a Slack trigger_id and cannot be run from the spreadsheet menu.');
}
function menuResetOnboardingPostedStatus() {
  throw new Error('menuResetOnboardingPostedStatus is not wired. Use resetOnboardingPostedStatus(stepId) directly from Apps Script.');
}
