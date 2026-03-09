/**
 * Training + onboarding Slack automation (Google Apps Script only).
 * Supports:
 *  - Sequential lesson delivery from lesson_slack_threads_filled_from_lessons
 *  - Sequential onboarding delivery from onboarding_workflow_filled_slack_messages
 */

function getConfig() {
  const dryRunProp = (PROPS.getProperty('DRY_RUN') || 'false').toLowerCase();
  const batchLimit = Number(PROPS.getProperty('BATCH_LIMIT') || 25);
  return {
    SLACK_BOT_TOKEN: PROPS.getProperty('SLACK_BOT_TOKEN') || '',
    LESSONS_SHEET_NAME: PROPS.getProperty('LESSONS_SHEET_NAME') || PROPS.getProperty('SHEET_NAME') || 'lesson_slack_threads_filled_from_lessons',
    ONBOARDING_SHEET_NAME: PROPS.getProperty('ONBOARDING_SHEET_NAME') || 'onboarding_workflow_filled_slack_messages',
    DEFAULT_LESSON_CHANNEL: PROPS.getProperty('DEFAULT_LESSON_CHANNEL') || PROPS.getProperty('DEFAULT_CHANNEL') || '',
    DEFAULT_ONBOARDING_CHANNEL: PROPS.getProperty('DEFAULT_ONBOARDING_CHANNEL') || '',
    SLACK_SIGNING_SECRET: PROPS.getProperty('SLACK_SIGNING_SECRET') || '',
    WEBAPP_URL: PROPS.getProperty('WEBAPP_URL') || '',
    DRY_RUN: dryRunProp === 'true',
    BATCH_LIMIT: isNaN(batchLimit) || batchLimit < 1 ? 25 : batchLimit
  };
}

function getSheetByName(name) {
  const sheetName = String(name || '').trim();
  if (!sheetName) throw new Error('Sheet name is required.');
  const sheet = SS.getSheetByName(sheetName);
  if (!sheet) throw new Error('Missing sheet: ' + sheetName);
  return sheet;
}

function getLessonSheet() {
  return getSheetByName(getConfig().LESSONS_SHEET_NAME);
}

function getOnboardingSheet() {
  return getSheetByName(getConfig().ONBOARDING_SHEET_NAME);
}

function getHeaderMap(sheet) {
  const lastCol = Math.max(1, sheet.getLastColumn());
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) {
    return String(h || '').trim();
  });
  const headerMap = {};
  headers.forEach(function(header, idx) {
    if (header) headerMap[header] = idx + 1;
  });
  return { headers: headers, map: headerMap };
}

function ensureColumns(sheet, requiredColumns) {
  const meta = getHeaderMap(sheet);
  const headers = meta.headers.slice();
  var changed = false;

  requiredColumns.forEach(function(col) {
    if (headers.indexOf(col) === -1) {
      headers.push(col);
      changed = true;
    }
  });

  if (changed) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  return getHeaderMap(sheet);
}

function safeCellWrite(sheet, rowIndex, colIndex, value) {
  if (!rowIndex || !colIndex) return;
  sheet.getRange(rowIndex, colIndex).setValue(value);
}

function logInfo(message) {
  Logger.log('[INFO] ' + message);
}

function logError(message) {
  Logger.log('[ERROR] ' + message);
}

function normalizePostedStatus_(value) {
  const text = String(value || '').trim().toLowerCase();
  return text === 'true' || text === 'posted' || text === 'yes';
}

function isRowAlreadyPosted_(rowObj) {
  return normalizePostedStatus_(rowObj['Posted Status']) || !!String(rowObj['Slack TS'] || '').trim();
}

function ensureLessonTrackingColumns() {
  const sheet = getLessonSheet();
  return ensureColumns(sheet, ['Posted Status', 'Posted At', 'Slack TS', 'Slack Channel', 'Error Log']);
}

function ensureOnboardingTrackingColumns() {
  const sheet = getOnboardingSheet();
  return ensureColumns(sheet, [
    'Step ID',
    'Posted Status',
    'Posted At',
    'Slack TS',
    'Slack Channel',
    'Modal Status',
    'Modal Opened At',
    'Submitted At',
    'Completed Status',
    'Completed By',
    'Notes / Response',
    'Error Log'
  ]);
}

function generateStepIdsIfMissing() {
  const sheet = getOnboardingSheet();
  const meta = ensureOnboardingTrackingColumns();
  const rows = buildRows_(sheet, meta.headers);
  const existing = {};

  rows.forEach(function(row) {
    const id = String(row['Step ID'] || '').trim();
    if (id) existing[id] = true;
  });

  rows.forEach(function(row) {
    const currentId = String(row['Step ID'] || '').trim();
    if (currentId) return;

    const taskLabel = String(row['Task / Checklist Step'] || row['Task'] || row['Checklist Step'] || '').trim();
    const base = taskLabel
      ? taskLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
      : 'row-' + row.__rowIndex;
    var candidate = 'step-' + base + '-' + row.__rowIndex;
    var seq = 1;
    while (existing[candidate]) {
      seq++;
      candidate = 'step-' + base + '-' + row.__rowIndex + '-' + seq;
    }

    existing[candidate] = true;
    safeCellWrite(sheet, row.__rowIndex, meta.map['Step ID'], candidate);
  });
}

function ensureTrackingColumns() {
  ensureLessonTrackingColumns();
  ensureOnboardingTrackingColumns();
}

function buildRows_(sheet, headers) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map(function(row, idx) {
    const obj = { __rowIndex: idx + 2 };
    headers.forEach(function(header, hIdx) {
      obj[header] = row[hIdx];
    });
    return obj;
  });
}

function parseLessonId(lessonId) {
  const value = String(lessonId || '').trim();
  const m = /^M(\d+)-W(\d+)-L(\d+)$/i.exec(value);
  if (!m) {
    throw new Error('Invalid LessonID format: ' + value + '. Expected M##-W##-L##.');
  }
  return {
    month: Number(m[1]),
    week: Number(m[2]),
    lesson: Number(m[3]),
    order: Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3])
  };
}

function sortLessonsByLessonId(rows) {
  return rows.slice().sort(function(a, b) {
    return a.__lessonOrder - b.__lessonOrder;
  });
}

function validateLessonRow(row) {
  const lessonId = String(row['LessonID'] || '').trim();
  if (!lessonId) return { ok: false, error: 'Missing LessonID' };
  try {
    row.__lessonOrder = parseLessonId(lessonId).order;
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }

  const text = String(row['Slack Thread Text'] || '').trim();
  if (!text) return { ok: false, error: 'Blank Slack Thread Text for LessonID ' + lessonId };
  return { ok: true };
}

function getLessonRows() {
  const sheet = getLessonSheet();
  const meta = ensureLessonTrackingColumns();
  ['LessonID', 'Slack Thread Text'].forEach(function(col) {
    if (meta.headers.indexOf(col) === -1) throw new Error('Missing required lesson column: ' + col);
  });

  const rows = buildRows_(sheet, meta.headers);
  const validRows = [];

  rows.forEach(function(row) {
    const validation = validateLessonRow(row);
    if (!validation.ok) {
      markRowError(sheet, meta.headers, row.__rowIndex, validation.error);
      return;
    }
    validRows.push(row);
  });

  return sortLessonsByLessonId(validRows);
}

function buildLessonMessage(row) {
  return String(row['Slack Thread Text'] || '');
}

function getNextLessonRow() {
  const rows = getLessonRows();
  for (var i = 0; i < rows.length; i++) {
    if (!isRowAlreadyPosted_(rows[i])) return rows[i];
  }
  return null;
}

function validateOnboardingRow(row) {
  const message = String(row['Slack Message'] || '').trim();
  if (!message) return { ok: false, error: 'Empty onboarding Slack Message' };
  return { ok: true };
}

function getOnboardingRows() {
  const sheet = getOnboardingSheet();
  ensureOnboardingTrackingColumns();
  generateStepIdsIfMissing();
  const meta = getHeaderMap(sheet);
  if (meta.headers.indexOf('Slack Message') === -1) {
    throw new Error('Missing required onboarding column: Slack Message');
  }

  const rows = buildRows_(sheet, meta.headers);
  const validRows = [];

  rows.forEach(function(row) {
    const validation = validateOnboardingRow(row);
    if (!validation.ok) {
      markRowError(sheet, meta.headers, row.__rowIndex, validation.error);
      return;
    }
    validRows.push(row);
  });

  return validRows;
}

function getNextOnboardingRow() {
  const rows = getOnboardingRows();
  for (var i = 0; i < rows.length; i++) {
    const completed = String(rows[i]['Completed Status'] || '').toLowerCase();
    if (completed === 'complete' || completed === 'completed') continue;
    if (!isRowAlreadyPosted_(rows[i])) return rows[i];
  }
  return null;
}

function getNextOnboardingStep() {
  return getNextOnboardingRow();
}

function getOnboardingStepById(stepId) {
  const target = String(stepId || '').trim();
  if (!target) return null;
  const rows = getOnboardingRows();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i]['Step ID'] || '').trim() === target) return rows[i];
  }
  return null;
}

function buildOnboardingMessage(row) {
  return String(row['Slack Message'] || '');
}

function callSlackApi(method, payload) {
  const cfg = getConfig();
  if (!cfg.SLACK_BOT_TOKEN) throw new Error('Missing SLACK_BOT_TOKEN in Script Properties.');

  if (cfg.DRY_RUN) {
    return {
      ok: true,
      ts: 'dryrun-' + Date.now(),
      channel: String(payload && payload.channel || ''),
      dry_run: true,
      method: method
    };
  }

  const response = UrlFetchApp.fetch(SLACK_API_BASE + method, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + cfg.SLACK_BOT_TOKEN },
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const body = response.getContentText() || '{}';
  let json;
  try {
    json = JSON.parse(body);
  } catch (err) {
    throw new Error('Slack API returned non-JSON for ' + method + ' (' + status + '): ' + body);
  }

  validateSlackResponse(json, status, method);
  return json;
}

function validateSlackResponse(response, httpCode, method) {
  if (httpCode >= 300 || !response || !response.ok) {
    const reason = response && response.error ? response.error : 'unknown_error';
    throw new Error('Slack API ' + method + ' failed (' + httpCode + '): ' + reason);
  }
}

function postSlackMessage(channel, text) {
  const targetChannel = String(channel || '').trim();
  if (!targetChannel) throw new Error('Slack channel is required.');
  const message = String(text || '');
  if (!message.trim()) throw new Error('Slack message text is empty.');
  return callSlackApi('chat.postMessage', { channel: targetChannel, text: message });
}

function openSlackModal(triggerId, view) {
  return callSlackApi('views.open', {
    trigger_id: triggerId,
    view: view
  });
}

function resolveOnboardingChannel_(row) {
  const cfg = getConfig();
  const candidates = ['Slack Channel', 'Channel', 'Channel ID', 'Responsible Channel', 'Team Channel'];
  for (var i = 0; i < candidates.length; i++) {
    const value = String(row[candidates[i]] || '').trim();
    if (value) return value;
  }
  return String(cfg.DEFAULT_ONBOARDING_CHANNEL || cfg.DEFAULT_LESSON_CHANNEL || '').trim();
}

function resolveOnboardingResponsibilityPrefix_(row) {
  const candidates = ['Responsible', 'Responsibility', 'Owner', 'Assignee', 'Responsible Team'];
  for (var i = 0; i < candidates.length; i++) {
    const value = String(row[candidates[i]] || '').trim();
    if (value) return '*Owner:* ' + value + '\n';
  }
  return '';
}

function postLessonToSlack(row) {
  const cfg = getConfig();
  const channel = String(row['Slack Channel'] || cfg.DEFAULT_LESSON_CHANNEL || '').trim();
  if (!channel) throw new Error('Missing lesson channel. Set DEFAULT_LESSON_CHANNEL or Slack Channel value.');
  return postSlackMessage(channel, buildLessonMessage(row));
}

function postOnboardingMessage(row) {
  const channel = resolveOnboardingChannel_(row);
  if (!channel) throw new Error('Missing onboarding channel. Set DEFAULT_ONBOARDING_CHANNEL or a row channel field.');
  const text = buildOnboardingMessage(row);
  const blocks = buildOnboardingBlocks(row);
  return callSlackApi('chat.postMessage', { channel: channel, text: text, blocks: blocks });
}

function buildOnboardingBlocks(row) {
  const text = String(row['Slack Message'] || '').trim();
  const summary = String(row['Task / Checklist Step'] || row['Task'] || row['Checklist Step'] || '').trim();
  const responsible = String(row['Responsible'] || row['Responsibility'] || row['Owner'] || row['Assignee'] || row['Responsible Team'] || '').trim();
  const actionValue = JSON.stringify({
    workflow: 'onboarding',
    step_id: String(row['Step ID'] || ''),
    row_index: row.__rowIndex,
    channel: resolveOnboardingChannel_(row),
    slack_ts: String(row['Slack TS'] || '')
  });

  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: text }
    }
  ];

  if (summary || responsible) {
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: '*Step:* ' + (summary || 'Onboarding Step') },
        { type: 'mrkdwn', text: '*Responsible:* ' + (responsible || 'Unassigned') }
      ]
    });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: 'onboarding_open_workflow',
        text: { type: 'plain_text', text: 'Open Workflow' },
        style: 'primary',
        value: actionValue
      }
    ]
  });

  return blocks;
}

function markRowError(sheet, headers, rowIndex, errorMessage) {
  const errIdx = headers.indexOf('Error Log');
  if (errIdx === -1) {
    logError('Could not write Error Log for row ' + rowIndex + ': ' + errorMessage);
    return;
  }
  const message = '[' + new Date().toISOString() + '] ' + String(errorMessage || 'Unknown error');
  safeCellWrite(sheet, rowIndex, errIdx + 1, message);
  logError('Row ' + rowIndex + ': ' + message);
}

function markLessonPosted(rowIndex, response) {
  const sheet = getLessonSheet();
  const meta = ensureLessonTrackingColumns();
  safeCellWrite(sheet, rowIndex, meta.map['Posted Status'], 'Posted');
  safeCellWrite(sheet, rowIndex, meta.map['Posted At'], new Date());
  safeCellWrite(sheet, rowIndex, meta.map['Slack TS'], String(response.ts || ''));
  safeCellWrite(sheet, rowIndex, meta.map['Slack Channel'], String(response.channel || ''));
  safeCellWrite(sheet, rowIndex, meta.map['Error Log'], '');
}

function markOnboardingPosted(rowIndex, response) {
  const sheet = getOnboardingSheet();
  const meta = ensureOnboardingTrackingColumns();
  safeCellWrite(sheet, rowIndex, meta.map['Posted Status'], 'Posted');
  safeCellWrite(sheet, rowIndex, meta.map['Posted At'], new Date());
  safeCellWrite(sheet, rowIndex, meta.map['Slack TS'], String(response.ts || ''));
  safeCellWrite(sheet, rowIndex, meta.map['Slack Channel'], String(response.channel || ''));
  safeCellWrite(sheet, rowIndex, meta.map['Completed Status'], String(response.completed_status || 'Pending'));
  safeCellWrite(sheet, rowIndex, meta.map['Error Log'], '');
}

function buildOnboardingModal(row) {
  const title = String(row['Task / Checklist Step'] || row['Task'] || row['Checklist Step'] || 'Onboarding Step').trim();
  const responsible = String(row['Responsible'] || row['Responsibility'] || row['Owner'] || row['Assignee'] || row['Responsible Team'] || 'Unassigned').trim();
  const meta = {
    workflow: 'onboarding',
    step_id: String(row['Step ID'] || ''),
    row_index: row.__rowIndex,
    channel: String(row['Slack Channel'] || resolveOnboardingChannel_(row) || ''),
    message_ts: String(row['Slack TS'] || '')
  };

  return {
    type: 'modal',
    callback_id: 'onboarding_modal_submit',
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: 'Onboarding Step' },
    submit: { type: 'plain_text', text: 'Submit' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Step:* ' + title + '\n*Responsible:* ' + responsible }
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Task Summary:*\n' + String(row['Slack Message'] || '') }
      },
      {
        type: 'input',
        block_id: 'status_block',
        label: { type: 'plain_text', text: 'Completion status' },
        element: {
          type: 'static_select',
          action_id: 'status_action',
          options: [
            { text: { type: 'plain_text', text: 'Pending' }, value: 'Pending' },
            { text: { type: 'plain_text', text: 'Complete' }, value: 'Complete' },
            { text: { type: 'plain_text', text: 'Needs Review' }, value: 'Needs Review' }
          ]
        }
      },
      {
        type: 'input',
        block_id: 'notes_block',
        optional: true,
        label: { type: 'plain_text', text: 'Notes / response' },
        element: {
          type: 'plain_text_input',
          action_id: 'notes_action',
          multiline: true,
          placeholder: { type: 'plain_text', text: 'Add completion notes, confirmations, or blockers.' }
        }
      }
    ]
  };
}

function openOnboardingModal(triggerId, row) {
  return openSlackModal(triggerId, buildOnboardingModal(row));
}

function updateOnboardingRowFromModal(rowIndex, submittedData) {
  const sheet = getOnboardingSheet();
  const meta = ensureOnboardingTrackingColumns();
  safeCellWrite(sheet, rowIndex, meta.map['Modal Status'], String(submittedData.modal_status || 'Submitted'));
  safeCellWrite(sheet, rowIndex, meta.map['Submitted At'], new Date());
  safeCellWrite(sheet, rowIndex, meta.map['Completed Status'], String(submittedData.completed_status || 'Pending'));
  safeCellWrite(sheet, rowIndex, meta.map['Completed By'], String(submittedData.completed_by || ''));
  safeCellWrite(sheet, rowIndex, meta.map['Notes / Response'], String(submittedData.notes || ''));
  safeCellWrite(sheet, rowIndex, meta.map['Error Log'], '');
}

function handleOnboardingButtonClick(payload) {
  const action = payload.actions && payload.actions[0] || {};
  const value = action.value ? JSON.parse(action.value) : {};
  const row = (value.step_id && getOnboardingStepById(value.step_id)) || null;
  const targetRow = row || getOnboardingRows().filter(function(r) { return r.__rowIndex === Number(value.row_index); })[0];
  if (!targetRow) throw new Error('Could not resolve onboarding step for modal open.');

  openOnboardingModal(payload.trigger_id, targetRow);

  const sheet = getOnboardingSheet();
  const meta = ensureOnboardingTrackingColumns();
  safeCellWrite(sheet, targetRow.__rowIndex, meta.map['Modal Status'], 'Opened');
  safeCellWrite(sheet, targetRow.__rowIndex, meta.map['Modal Opened At'], new Date());
}

function handleOnboardingModalSubmit(payload) {
  const view = payload.view || {};
  const metadata = view.private_metadata ? JSON.parse(view.private_metadata) : {};
  const rowIndex = Number(metadata.row_index);
  if (!rowIndex) throw new Error('Missing row index in modal metadata.');

  const stateValues = view.state && view.state.values || {};
  const statusOption = stateValues.status_block && stateValues.status_block.status_action && stateValues.status_block.status_action.selected_option;
  const notesObj = stateValues.notes_block && stateValues.notes_block.notes_action;

  updateOnboardingRowFromModal(rowIndex, {
    modal_status: 'Submitted',
    completed_status: statusOption ? statusOption.value : 'Pending',
    completed_by: payload.user && payload.user.id || '',
    notes: notesObj && notesObj.value || ''
  });
}

function handleSlackInteraction(payload) {
  if (!payload || !payload.type) return false;

  if (payload.type === 'block_actions') {
    const action = payload.actions && payload.actions[0];
    if (action && action.action_id === 'onboarding_open_workflow') {
      handleOnboardingButtonClick(payload);
      return true;
    }
  }

  if (payload.type === 'view_submission' && payload.view && payload.view.callback_id === 'onboarding_modal_submit') {
    handleOnboardingModalSubmit(payload);
    return true;
  }

  return false;
}

function postOnboardingStep(row) {
  return postOnboardingInternal_(row);
}

function postLessonInternal_(row) {
  const sheet = getLessonSheet();
  const meta = ensureLessonTrackingColumns();

  if (isRowAlreadyPosted_(row)) {
    throw new Error('Duplicate posting blocked for lesson ' + row['LessonID']);
  }

  try {
    const response = postLessonToSlack(row);
    markLessonPosted(row.__rowIndex, response);
    logInfo('Lesson posted: ' + row['LessonID'] + ' row=' + row.__rowIndex);
    return {
      ok: true,
      workflow: 'lesson',
      lesson_id: row['LessonID'],
      row_index: row.__rowIndex,
      ts: response.ts || '',
      channel: response.channel || ''
    };
  } catch (err) {
    markRowError(sheet, meta.headers, row.__rowIndex, err.message || String(err));
    throw err;
  }
}

function postOnboardingInternal_(row) {
  const sheet = getOnboardingSheet();
  const meta = ensureOnboardingTrackingColumns();

  if (isRowAlreadyPosted_(row)) {
    throw new Error('Duplicate posting blocked for onboarding row ' + row.__rowIndex);
  }

  try {
    const response = postOnboardingMessage(row);
    markOnboardingPosted(row.__rowIndex, response);
    logInfo('Onboarding posted row=' + row.__rowIndex);
    return {
      ok: true,
      workflow: 'onboarding',
      row_index: row.__rowIndex,
      ts: response.ts || '',
      channel: response.channel || ''
    };
  } catch (err) {
    markRowError(sheet, meta.headers, row.__rowIndex, err.message || String(err));
    throw err;
  }
}

function postNextLesson() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Another posting process is running.');
  var row = null;
  try {
    row = getNextLessonRow();
    if (!row) return { ok: true, workflow: 'lesson', posted: false, message: 'No pending lessons.' };
    return postLessonInternal_(row);
  } finally {
    lock.releaseLock();
  }
}

function postAllLessons(limit) {
  const cfg = getConfig();
  const maxToPost = Number(limit || cfg.BATCH_LIMIT || 25);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Another posting process is running.');
  try {
    const rows = getLessonRows();
    var posted = 0;
    for (var i = 0; i < rows.length && posted < maxToPost; i++) {
      if (isRowAlreadyPosted_(rows[i])) continue;
      postLessonInternal_(rows[i]);
      posted++;
      Utilities.sleep(200);
    }
    return { ok: true, workflow: 'lesson', posted: posted, limit: maxToPost };
  } finally {
    lock.releaseLock();
  }
}

function postLessonById(lessonId) {
  const target = String(lessonId || '').trim();
  if (!target) throw new Error('lessonId is required.');

  const rows = getLessonRows();
  const row = rows.filter(function(r) {
    return String(r['LessonID'] || '').trim() === target;
  })[0];

  if (!row) throw new Error('Lesson not found: ' + target);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Another posting process is running.');
  try {
    return postLessonInternal_(row);
  } finally {
    lock.releaseLock();
  }
}

function postNextOnboardingStep() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Another posting process is running.');
  try {
    const row = getNextOnboardingRow();
    if (!row) return { ok: true, workflow: 'onboarding', posted: false, message: 'No pending onboarding steps.' };
    return postOnboardingInternal_(row);
  } finally {
    lock.releaseLock();
  }
}

function postAllOnboardingSteps(limit) {
  const cfg = getConfig();
  const maxToPost = Number(limit || cfg.BATCH_LIMIT || 25);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Another posting process is running.');
  try {
    const rows = getOnboardingRows();
    var posted = 0;
    for (var i = 0; i < rows.length && posted < maxToPost; i++) {
      if (isRowAlreadyPosted_(rows[i])) continue;
      postOnboardingInternal_(rows[i]);
      posted++;
      Utilities.sleep(200);
    }
    return { ok: true, workflow: 'onboarding', posted: posted, limit: maxToPost };
  } finally {
    lock.releaseLock();
  }
}

function postOnboardingStepByIdentifier(id) {
  const target = String(id || '').trim();
  if (!target) throw new Error('Onboarding identifier is required.');

  const rows = getOnboardingRows();
  var row = null;

  const numeric = Number(target);
  if (!isNaN(numeric) && numeric >= 2) {
    row = rows.filter(function(r) { return r.__rowIndex === numeric; })[0] || null;
  }

  if (!row) {
    const idColumns = ['Task ID', 'Checklist Step ID', 'Step ID', 'Task', 'Checklist Step'];
    row = rows.filter(function(r) {
      for (var i = 0; i < idColumns.length; i++) {
        if (String(r[idColumns[i]] || '').trim() === target) return true;
      }
      return false;
    })[0] || null;
  }

  if (!row) throw new Error('Onboarding step not found for identifier: ' + target);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Another posting process is running.');
  try {
    return postOnboardingInternal_(row);
  } finally {
    lock.releaseLock();
  }
}

function postNextLessonForUser(userId) {
  const targetUser = String(userId || '').trim();
  if (!targetUser) throw new Error('userId is required for postNextLessonForUser.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Another posting process is running.');

  var row = null;
  try {
    row = getNextLessonRow();
    if (!row) return postDM(targetUser, 'You are up to date. No pending lesson.');

    const dmChannel = openDM(targetUser);
    if (!dmChannel) throw new Error('Could not open DM channel for user ' + targetUser);

    const response = postSlackMessage(dmChannel, buildLessonMessage(row));
    markLessonPosted(row.__rowIndex, response);

    return {
      ok: true,
      workflow: 'lesson',
      lesson_id: row['LessonID'],
      row_index: row.__rowIndex,
      ts: response.ts || '',
      channel: response.channel || dmChannel
    };
  } catch (err) {
    if (row && row.__rowIndex) {
      const meta = ensureLessonTrackingColumns();
      const sheet = getLessonSheet();
      markRowError(sheet, meta.headers, row.__rowIndex, err.message || String(err));
    }
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function testSlackConnection() {
  const result = callSlackApi('auth.test', {});
  logInfo('Slack connection OK for team=' + (result.team || 'unknown'));
  return result;
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Slack Automation')
    .addItem('Post Next Lesson', 'menuPostNextLesson')
    .addItem('Post All Lessons', 'menuPostAllLessons')
    .addItem('Post Lesson By ID', 'menuPostLessonById')
    .addSeparator()
    .addItem('Post Next Onboarding Step', 'menuPostNextOnboardingStep')
    .addItem('Post All Onboarding Steps', 'menuPostAllOnboardingSteps')
    .addItem('Post Onboarding Step By ID/Row', 'menuPostOnboardingByIdentifier')
    .addItem('Generate Missing Step IDs', 'menuGenerateStepIds')
    .addItem('Reopen Step Modal', 'menuReopenOnboardingModal')
    .addItem('Reset Posted Status', 'menuResetOnboardingPostedStatus')
    .addSeparator()
    .addItem('Ensure Tracking Columns', 'menuEnsureTrackingColumns')
    .addItem('Ensure Curriculum Database Columns', 'menuEnsureCurriculumDatabaseColumns')
    .addItem('Test Slack Connection', 'menuTestSlackConnection')
    .addToUi();
}

function menuPostNextLesson() {
  SpreadsheetApp.getUi().alert(JSON.stringify(postNextLesson()));
}

function menuPostAllLessons() {
  SpreadsheetApp.getUi().alert(JSON.stringify(postAllLessons()));
}

function menuPostLessonById() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt('Post Lesson by ID', 'Enter LessonID (for example: M01-W01-L01)', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  SpreadsheetApp.getUi().alert(JSON.stringify(postLessonById(resp.getResponseText())));
}

function menuPostNextOnboardingStep() {
  SpreadsheetApp.getUi().alert(JSON.stringify(postNextOnboardingStep()));
}

function menuPostAllOnboardingSteps() {
  SpreadsheetApp.getUi().alert(JSON.stringify(postAllOnboardingSteps()));
}

function menuPostOnboardingByIdentifier() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt('Post Onboarding Step', 'Enter row number or task/checklist identifier', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  SpreadsheetApp.getUi().alert(JSON.stringify(postOnboardingStepByIdentifier(resp.getResponseText())));
}

function menuEnsureTrackingColumns() {
  ensureTrackingColumns();
  SpreadsheetApp.getUi().alert('Tracking columns ensured for lessons and onboarding sheets.');
}

function menuTestSlackConnection() {
  SpreadsheetApp.getUi().alert(JSON.stringify(testSlackConnection()));
}

function menuEnsureCurriculumDatabaseColumns() {
  ensureCurriculumDatabaseColumns();
  SpreadsheetApp.getUi().alert('Curriculum database columns ensured for Modules and Courses sheets.');
}


function reopenOnboardingStepModal(identifier) {
  const row = resolveOnboardingRowByIdentifier_(identifier);
  const triggerId = String(PROPS.getProperty('TEST_SLACK_TRIGGER_ID') || '').trim();
  if (!triggerId) throw new Error('Set TEST_SLACK_TRIGGER_ID script property to use reopen modal from menu.');
  return openOnboardingModal(triggerId, row);
}

function resetOnboardingPostedStatus(identifier) {
  const row = resolveOnboardingRowByIdentifier_(identifier);
  const sheet = getOnboardingSheet();
  const meta = ensureOnboardingTrackingColumns();
  safeCellWrite(sheet, row.__rowIndex, meta.map['Posted Status'], '');
  safeCellWrite(sheet, row.__rowIndex, meta.map['Posted At'], '');
  safeCellWrite(sheet, row.__rowIndex, meta.map['Slack TS'], '');
  safeCellWrite(sheet, row.__rowIndex, meta.map['Modal Status'], '');
  safeCellWrite(sheet, row.__rowIndex, meta.map['Modal Opened At'], '');
  safeCellWrite(sheet, row.__rowIndex, meta.map['Submitted At'], '');
  safeCellWrite(sheet, row.__rowIndex, meta.map['Completed Status'], 'Pending');
  safeCellWrite(sheet, row.__rowIndex, meta.map['Completed By'], '');
  safeCellWrite(sheet, row.__rowIndex, meta.map['Notes / Response'], '');
  safeCellWrite(sheet, row.__rowIndex, meta.map['Error Log'], '');
  return { ok: true, row_index: row.__rowIndex };
}

function resolveOnboardingRowByIdentifier_(id) {
  const target = String(id || '').trim();
  if (!target) throw new Error('Onboarding identifier is required.');
  const rows = getOnboardingRows();
  var row = null;
  const numeric = Number(target);
  if (!isNaN(numeric) && numeric >= 2) {
    row = rows.filter(function(r) { return r.__rowIndex === numeric; })[0] || null;
  }
  if (!row) {
    row = rows.filter(function(r) {
      return String(r['Step ID'] || '').trim() === target ||
        String(r['Task ID'] || '').trim() === target ||
        String(r['Checklist Step ID'] || '').trim() === target ||
        String(r['Task'] || '').trim() === target ||
        String(r['Checklist Step'] || '').trim() === target ||
        String(r['Task / Checklist Step'] || '').trim() === target;
    })[0] || null;
  }
  if (!row) throw new Error('Onboarding step not found for identifier: ' + target);
  return row;
}

function menuGenerateStepIds() {
  generateStepIdsIfMissing();
  SpreadsheetApp.getUi().alert('Missing Step IDs generated.');
}

function menuReopenOnboardingModal() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt('Reopen Onboarding Modal', 'Enter row number or Step ID', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  SpreadsheetApp.getUi().alert(JSON.stringify(reopenOnboardingStepModal(resp.getResponseText())));
}

function menuResetOnboardingPostedStatus() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt('Reset Onboarding Step', 'Enter row number or Step ID', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  SpreadsheetApp.getUi().alert(JSON.stringify(resetOnboardingPostedStatus(resp.getResponseText())));
}
