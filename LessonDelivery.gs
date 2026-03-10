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
  const required = ['Step ID','Slack Message','Posted Status','Posted At','Slack TS','Slack Channel','Error Log','Completed Status'];
  return { headers: ensureSheetColumnsByName_(sheetName, required) };
}

function ensureTrackingColumns() {
  ensureCurriculumDatabaseColumns();
  ensureLessonTrackingColumns();
  ensureOnboardingTrackingColumns();
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
function generateStepIdsIfMissing() { return true; }
function getOnboardingRows() { const s = getOnboardingSheet(); if (!s) return []; const m = ensureOnboardingTrackingColumns(); return buildRows_(s, m.headers); }
function getNextOnboardingRow() { const rows = getOnboardingRows(); for (let i=0;i<rows.length;i++) if (String(rows[i]['Posted Status']||'').toLowerCase() !== 'posted') return rows[i]; return null; }
function buildOnboardingMessage(row) { return String(row['Slack Message'] || ''); }
function postOnboardingInternal_(row) {
  const channel = String(row['Slack Channel'] || getConfig().DEFAULT_ONBOARDING_CHANNEL || '').trim();
  if (!channel) throw new Error('Missing onboarding channel');
  const res = postSlackMessage(channel, buildOnboardingMessage(row));
  const sheet = getOnboardingSheet(); const meta = getHeaderMap(sheet);
  const iStatus = meta.headers.indexOf('Posted Status'); const iAt = meta.headers.indexOf('Posted At'); const iTs = meta.headers.indexOf('Slack TS');
  if (iStatus>=0) sheet.getRange(row.__rowIndex, iStatus+1).setValue('Posted');
  if (iAt>=0) sheet.getRange(row.__rowIndex, iAt+1).setValue(new Date());
  if (iTs>=0) sheet.getRange(row.__rowIndex, iTs+1).setValue(res.ts || '');
  return { ok: true, posted: true };
}
function postNextOnboardingStep() { const row = getNextOnboardingRow(); if (!row) return {ok:true,posted:false}; return postOnboardingInternal_(row); }
function postAllOnboardingSteps(limit) { let p=0; const rows=getOnboardingRows(); for(let i=0;i<rows.length && p<Number(limit||25);i++){ if(String(rows[i]['Posted Status']||'').toLowerCase()==='posted') continue; postOnboardingInternal_(rows[i]); p++; } return {ok:true,posted:p}; }
function postOnboardingStepByIdentifier(id) { return postNextOnboardingStep(); }
function buildOnboardingModal(row) { return { type:'modal', title:{type:'plain_text',text:'Onboarding'}, close:{type:'plain_text',text:'Close'}, blocks:[{type:'section', text:{type:'mrkdwn', text: buildOnboardingMessage(row)}}]}; }
function openOnboardingModal(triggerId, row) { return openSlackModal(triggerId, buildOnboardingModal(row)); }
function updateOnboardingRowFromModal(rowIndex, submittedData) { return true; }
function handleOnboardingButtonClick(payload) { return true; }
function handleOnboardingModalSubmit(payload) { return true; }
function handleSlackInteraction(payload) {
  try {
    if (!payload) return { ok: false, skipped: true };

    if (payload.type === 'block_actions') {
      var action = payload.actions && payload.actions[0];
      if (!action) return { ok: true, skipped: true };

      // Lesson completion button path is processed asynchronously in queue worker.
      if (action.action_id === 'lesson_complete') {
        var userId = (payload.user && payload.user.id) || '';
        appendToQueue(userId, JSON.stringify({ kind: 'block_action', payload: payload }));
        scheduleQueuedPipeline_();
        return { ok: true, queued: true };
      }

      return handleOnboardingButtonClick(payload);
    }

    if (payload.type === 'view_submission') {
      return handleOnboardingModalSubmit(payload);
    }

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
function menuPostLessonById() {}
function menuPostNextOnboardingStep() { postNextOnboardingStep(); }
function menuPostAllOnboardingSteps() { postAllOnboardingSteps(); }
function menuPostOnboardingByIdentifier() {}
function menuTestSlackConnection() { testSlackConnection(); }
function menuEnsureCurriculumDatabaseColumns() { ensureCurriculumDatabaseColumns(); }
function reopenOnboardingStepModal(identifier) {}
function resetOnboardingPostedStatus(identifier) {}
function resolveOnboardingRowByIdentifier_(id) { return null; }
function menuGenerateStepIds() { generateStepIdsIfMissing(); }
function menuReopenOnboardingModal() {}
function menuResetOnboardingPostedStatus() {}
