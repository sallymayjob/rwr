/**
 * Sequential Slack lesson delivery automation backed by a CSV-imported Google Sheet.
 */

function getConfig() {
  return {
    SLACK_BOT_TOKEN: PROPS.getProperty('SLACK_BOT_TOKEN') || '',
    DEFAULT_CHANNEL: PROPS.getProperty('DEFAULT_CHANNEL') || '',
    SHEET_NAME: PROPS.getProperty('SHEET_NAME') || 'lesson_slack_threads_filled_from_lessons',
    DRY_RUN: (PROPS.getProperty('DRY_RUN') || 'false').toLowerCase() === 'true',
    BATCH_LIMIT: Number(PROPS.getProperty('BATCH_LIMIT') || 25)
  };
}

function getLessonSheet() {
  const cfg = getConfig();
  const sheet = SS.getSheetByName(cfg.SHEET_NAME);
  if (!sheet) {
    throw new Error('Missing sheet: ' + cfg.SHEET_NAME + '. Import lesson_slack_threads_filled_from_lessons.csv and set SHEET_NAME if needed.');
  }
  return sheet;
}

function ensureTrackingColumns() {
  const sheet = getLessonSheet();
  const required = ['Posted Status', 'Posted At', 'Slack TS', 'Slack Channel', 'Lesson Order', 'Error Log'];

  const lastCol = Math.max(1, sheet.getLastColumn());
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h || '').trim(); });

  let changed = false;
  required.forEach(function(col) {
    if (headers.indexOf(col) === -1) {
      headers.push(col);
      changed = true;
    }
  });

  if (changed) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  return headers;
}

function getLessons() {
  const sheet = getLessonSheet();
  const headers = ensureTrackingColumns();

  const mandatory = ['LessonID', 'Slack Thread Text', 'Submit Code', 'Topic'];
  mandatory.forEach(function(col) {
    if (headers.indexOf(col) === -1) {
      throw new Error('Missing required column: ' + col);
    }
  });

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const lessons = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const lesson = {};
    for (let c = 0; c < headers.length; c++) {
      lesson[headers[c]] = row[c];
    }
    lesson.__rowIndex = i + 2;

    const parsed = parseLessonId(String(lesson['LessonID'] || '').trim());
    lesson.__order = parsed.order;
    lesson.__orderKey = parsed.key;

    lessons.push(lesson);
  }

  lessons.sort(function(a, b) {
    return a.__order - b.__order;
  });

  writeLessonOrder_(lessons, headers);
  return lessons;
}

function getNextLesson() {
  const lessons = getLessons();
  for (let i = 0; i < lessons.length; i++) {
    const l = lessons[i];
    const posted = String(l['Posted Status'] || '').toLowerCase() === 'true';
    const ts = String(l['Slack TS'] || '').trim();
    if (!posted && !ts) return l;
  }
  return null;
}

function postLessonToSlack(lesson) {
  const cfg = getConfig();
  if (!cfg.SLACK_BOT_TOKEN) throw new Error('Missing SLACK_BOT_TOKEN in Script Properties.');

  const text = String(lesson['Slack Thread Text'] || '');
  if (!text.trim()) throw new Error('Empty Slack Thread Text for lesson ' + lesson['LessonID']);

  const channel = String(lesson['Slack Channel'] || cfg.DEFAULT_CHANNEL || '').trim();
  if (!channel) throw new Error('Missing Slack channel. Set DEFAULT_CHANNEL or Slack Channel column value.');

  if (cfg.DRY_RUN) {
    Logger.log('[DRY_RUN] Would post lesson ' + lesson['LessonID'] + ' to channel ' + channel);
    return {
      ok: true,
      ts: 'dryrun-' + Date.now(),
      channel: channel,
      dry_run: true
    };
  }

  const resp = UrlFetchApp.fetch(SLACK_API_BASE + 'chat.postMessage', {
    method: 'post',
    headers: {
      Authorization: 'Bearer ' + cfg.SLACK_BOT_TOKEN
    },
    contentType: 'application/json; charset=utf-8',
    payload: JSON.stringify({
      channel: channel,
      text: text
    }),
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  const body = resp.getContentText() || '{}';
  let json;
  try {
    json = JSON.parse(body);
  } catch (e) {
    throw new Error('Slack API non-JSON response (' + code + '): ' + body);
  }

  if (code >= 300 || !json.ok) {
    throw new Error('Slack API error (' + code + '): ' + (json.error || body));
  }

  return json;
}

function markLessonPosted(rowIndex, slackResponse) {
  const sheet = getLessonSheet();
  const headers = ensureTrackingColumns();

  const iPosted = headers.indexOf('Posted Status');
  const iPostedAt = headers.indexOf('Posted At');
  const iTs = headers.indexOf('Slack TS');
  const iChannel = headers.indexOf('Slack Channel');
  const iError = headers.indexOf('Error Log');

  if (iPosted === -1 || iPostedAt === -1 || iTs === -1 || iChannel === -1 || iError === -1) {
    throw new Error('Tracking columns are not available for markLessonPosted.');
  }

  sheet.getRange(rowIndex, iPosted + 1).setValue(true);
  sheet.getRange(rowIndex, iPostedAt + 1).setValue(new Date());
  sheet.getRange(rowIndex, iTs + 1).setValue(String(slackResponse.ts || ''));
  sheet.getRange(rowIndex, iChannel + 1).setValue(String(slackResponse.channel || ''));
  sheet.getRange(rowIndex, iError + 1).setValue('');
}

function markLessonError(rowIndex, errorMessage) {
  const sheet = getLessonSheet();
  const headers = ensureTrackingColumns();
  const iError = headers.indexOf('Error Log');
  if (iError === -1) throw new Error('Tracking column Error Log not found.');

  const msg = '[' + new Date().toISOString() + '] ' + String(errorMessage || 'Unknown error');
  sheet.getRange(rowIndex, iError + 1).setValue(msg);
  Logger.log('Lesson row ' + rowIndex + ' error: ' + msg);
}

function postNextLesson() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    throw new Error('Another posting process is running. Try again in a few seconds.');
  }

  try {
    const lesson = getNextLesson();
    if (!lesson) {
      Logger.log('No unposted lessons found.');
      return { ok: true, posted: false, message: 'No unposted lessons found.' };
    }

    return postLessonInternal_(lesson);
  } finally {
    lock.releaseLock();
  }
}

function postAllLessons() {
  const cfg = getConfig();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    throw new Error('Another posting process is running. Try again in a few seconds.');
  }

  try {
    const lessons = getLessons();
    let posted = 0;
    for (let i = 0; i < lessons.length; i++) {
      if (posted >= cfg.BATCH_LIMIT) break;
      const lesson = lessons[i];
      const isPosted = String(lesson['Posted Status'] || '').toLowerCase() === 'true';
      const hasTs = !!String(lesson['Slack TS'] || '').trim();
      if (isPosted || hasTs) continue;

      postLessonInternal_(lesson);
      posted++;
      Utilities.sleep(250);
    }

    return { ok: true, posted: posted, batch_limit: cfg.BATCH_LIMIT };
  } finally {
    lock.releaseLock();
  }
}

function postLessonById(lessonId) {
  const target = String(lessonId || '').trim();
  if (!target) throw new Error('lessonId is required.');
  parseLessonId(target);

  const lessons = getLessons();
  const lesson = lessons.filter(function(l) {
    return String(l['LessonID'] || '').trim() === target;
  })[0];

  if (!lesson) throw new Error('Lesson not found: ' + target);

  const alreadyPosted = String(lesson['Posted Status'] || '').toLowerCase() === 'true' || !!String(lesson['Slack TS'] || '').trim();
  if (alreadyPosted) {
    throw new Error('Duplicate posting blocked. Lesson already posted: ' + target);
  }

  return postLessonInternal_(lesson);
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Slack LMS')
    .addItem('Post Next Lesson', 'menuPostNextLesson')
    .addItem('Post All Lessons', 'menuPostAllLessons')
    .addItem('Post Lesson by ID', 'menuPostLessonById')
    .addSeparator()
    .addItem('Reset Post Status', 'resetPostStatus')
    .addItem('Test Slack Connection', 'testSlackConnection')
    .addToUi();
}

function menuPostNextLesson() {
  const result = postNextLesson();
  SpreadsheetApp.getUi().alert(JSON.stringify(result));
}

function menuPostAllLessons() {
  const result = postAllLessons();
  SpreadsheetApp.getUi().alert(JSON.stringify(result));
}

function menuPostLessonById() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Post Lesson by ID', 'Enter LessonID (e.g. M01-W01-L01):', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;

  const lessonId = (response.getResponseText() || '').trim();
  if (!lessonId) {
    ui.alert('LessonID is required.');
    return;
  }

  const result = postLessonById(lessonId);
  ui.alert(JSON.stringify(result));
}

function resetPostStatus() {
  const sheet = getLessonSheet();
  const headers = ensureTrackingColumns();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var colsToClear = ['Posted Status', 'Posted At', 'Slack TS', 'Slack Channel', 'Error Log'];
  colsToClear.forEach(function(colName) {
    const idx = headers.indexOf(colName);
    if (idx !== -1) {
      sheet.getRange(2, idx + 1, lastRow - 1, 1).clearContent();
    }
  });

  Logger.log('Reset post status completed for ' + (lastRow - 1) + ' rows.');
}

function testSlackConnection() {
  const cfg = getConfig();
  if (!cfg.SLACK_BOT_TOKEN) throw new Error('Missing SLACK_BOT_TOKEN in Script Properties.');

  if (cfg.DRY_RUN) {
    Logger.log('[DRY_RUN] Slack connection test skipped.');
    return { ok: true, dry_run: true };
  }

  const resp = UrlFetchApp.fetch(SLACK_API_BASE + 'auth.test', {
    method: 'post',
    headers: {
      Authorization: 'Bearer ' + cfg.SLACK_BOT_TOKEN
    },
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  const body = resp.getContentText() || '{}';
  const json = JSON.parse(body);
  if (code >= 300 || !json.ok) {
    throw new Error('Slack auth.test failed: ' + (json.error || body));
  }

  Logger.log('Slack connection OK for team: ' + (json.team || 'unknown'));
  return json;
}

function postLessonInternal_(lesson) {
  try {
    const response = postLessonToSlack(lesson);
    markLessonPosted(lesson.__rowIndex, response);
    const result = {
      ok: true,
      posted: true,
      lesson_id: lesson['LessonID'],
      row_index: lesson.__rowIndex,
      ts: response.ts || '',
      channel: response.channel || ''
    };
    Logger.log('Posted lesson ' + lesson['LessonID'] + ' to ' + result.channel + ' ts=' + result.ts);
    return result;
  } catch (err) {
    markLessonError(lesson.__rowIndex, err.message || err);
    throw err;
  }
}

function writeLessonOrder_(lessons, headers) {
  const iOrder = headers.indexOf('Lesson Order');
  if (iOrder === -1 || !lessons.length) return;

  const sheet = getLessonSheet();
  const rows = lessons.map(function(l, idx) {
    return [idx + 1];
  });

  for (var i = 0; i < lessons.length; i++) {
    sheet.getRange(lessons[i].__rowIndex, iOrder + 1).setValue(rows[i][0]);
  }
}

function parseLessonId(lessonId) {
  const value = String(lessonId || '').trim();
  const m = /^M(\d+)-W(\d+)-L(\d+)$/i.exec(value);
  if (!m) {
    throw new Error('Invalid LessonID format: ' + value + '. Expected M##-W##-L##.');
  }

  const month = Number(m[1]);
  const week = Number(m[2]);
  const lesson = Number(m[3]);
  const order = month * 10000 + week * 100 + lesson;

  return {
    key: 'M' + month + '-W' + week + '-L' + lesson,
    month: month,
    week: week,
    lesson: lesson,
    order: order
  };
}
