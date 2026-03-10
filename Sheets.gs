function getAllRows(sheetName) {
  const sheet = SS.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet not found: ' + sheetName);
  const allData = sheet.getDataRange().getValues();
  const headers = allData.length ? allData[0] : [];
  const rows = allData.length > 1 ? allData.slice(1) : [];
  return { headers: headers, rows: rows, sheet: sheet };
}

function rowToObj(headers, row) {
  const obj = {};
  for (let i = 0; i < headers.length; i++) obj[headers[i]] = row[i];
  return obj;
}

function ensureSheetColumnsByName_(sheetName, requiredColumns) {
  const sheet = SS.getSheetByName(sheetName);
  if (!sheet) throw new Error('Missing sheet: ' + sheetName);
  const lastCol = Math.max(1, sheet.getLastColumn());
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h || '').trim(); });
  let changed = false;
  requiredColumns.forEach(function(col) {
    if (headers.indexOf(col) === -1) {
      headers.push(col);
      changed = true;
    }
  });
  if (changed) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return headers;
}

function ensureCurriculumDatabaseColumns() {
  ensureSheetColumnsByName_(SHEET_COURSES, ['CourseID','Course Title','Course Description','Entry Module','Module IDs','Module Names','Total Modules','Total Lessons','Audience','Difficulty Range','Delivery Mode','Status']);
  ensureSheetColumnsByName_(SHEET_MODULES, ['ModuleID','Module Number','Module Name','Module Description','CourseID','Difficulty Tier','Audience','Total Lessons','Week Range','Focus Areas','Delivery Mode','Estimated Duration']);
  ensureSheetColumnsByName_(SHEET_COURSE_MODULE_MAP, ['CourseID','ModuleID','Sequence','Is Entry Module','Total Lessons in Module']);
  ensureSheetColumnsByName_(SHEET_LESSONS, ['LessonID','CourseID','ModuleID','Month','Week','Lesson Title','Type','Hook','Core Content','Insight','Takeaway','Objective','Intent','Mission','Verification','Submit Code','Difficulty','Focus Area','Tone','Status','Lesson Order']);
  ensureSheetColumnsByName_(SHEET_MISSIONS, ['MissionID','LessonID','Activity','Instructions','Submit Code','Activity Type','Response Format']);
  ensureSheetColumnsByName_(SHEET_METRICS, ['Lesson','Word Count Total','Word Count Core','Word Count Insight','Word Count Takeaway','Brand Compliance Score','PED Flags','Last Reviewed','Reviewer']);
  ensureSheetColumnsByName_(SHEET_QA, ['Lesson','QA Score','QA Verdict','QA Detail','QA Run Date','Revision Count','SOP-5 Validated','Spot Check','Priority','Status','Golden Example']);
  ensureSheetColumnsByName_(SHEET_SLACK_DELIVERY, ['LessonID','Slack Thread Text','Submit Code','Mapped Focus','Mapped Action','Mapped Channel Name','Template Source Message','Delivery Status','Slack TS','Slack Channel','Send Order']);
  ensureSheetColumnsByName_(SHEET_LEARNERS, ['UserID','Name','Email','Enrolled Course','Current Module','Progress (%)','Status','Joined Date','Completed Missions','Completed Lessons','Last LessonID','Last MissionID']);
  ensureSheetColumnsByName_(SHEET_SUBMISSIONS, ['Timestamp','Learner','Lesson','MissionID','Submit Code','Evidence','Method','Score']);
}

function validateRequiredSchema() {
  const required = [
    { name: SHEET_COURSES, cols: ['CourseID', 'Course Title'] },
    { name: SHEET_MODULES, cols: ['ModuleID', 'CourseID'] },
    { name: SHEET_COURSE_MODULE_MAP, cols: ['CourseID', 'ModuleID', 'Sequence'] },
    { name: SHEET_LESSONS, cols: ['LessonID', 'CourseID', 'ModuleID', 'Status', 'Lesson Order'] },
    { name: SHEET_MISSIONS, cols: ['MissionID', 'LessonID', 'Submit Code'] },
    { name: SHEET_QA, cols: ['Lesson', 'QA Verdict', 'Status'] },
    { name: SHEET_SLACK_DELIVERY, cols: ['LessonID', 'Slack Thread Text', 'Submit Code', 'Slack TS', 'Slack Channel'] },
    { name: SHEET_LEARNERS, cols: ['UserID', 'Enrolled Course', 'Current Module', 'Progress (%)'] },
    { name: SHEET_SUBMISSIONS, cols: ['Timestamp', 'Learner', 'Lesson', 'MissionID', 'Submit Code', 'Score'] },
    { name: SHEET_QUEUE, cols: ['Created', 'User_Id', 'Payload_Json', 'Status', 'Retry_Count', 'Last_Error'] }
  ];

  const missingSheets = [];
  const missingColumns = [];
  required.forEach(function(spec) {
    const sheet = SS.getSheetByName(spec.name);
    if (!sheet) {
      missingSheets.push(spec.name);
      return;
    }
    const headers = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0].map(function(h) { return String(h || '').trim(); });
    spec.cols.forEach(function(col) {
      if (headers.indexOf(col) === -1) missingColumns.push(spec.name + ':' + col);
    });
  });

  return {
    ok: missingSheets.length === 0 && missingColumns.length === 0,
    missingSheets: missingSheets,
    missingColumns: missingColumns
  };
}

function getLearnerRecord(slackUserId) {
  const data = getAllRows(SHEET_LEARNERS);
  const idxUser = data.headers.indexOf('UserID');
  for (let i = 0; i < data.rows.length; i++) {
    if (String(data.rows[i][idxUser]) === String(slackUserId)) {
      const obj = rowToObj(data.headers, data.rows[i]);
      obj._rowIndex = i + 2;
      return obj;
    }
  }
  return null;
}

function getLessonRow(lessonId) {
  const data = getAllRows(SHEET_LESSONS);
  const idx = data.headers.indexOf('LessonID');
  for (let i = 0; i < data.rows.length; i++) {
    if (String(data.rows[i][idx]) === String(lessonId)) {
      const obj = rowToObj(data.headers, data.rows[i]);
      obj._rowIndex = i + 2;
      return obj;
    }
  }
  return null;
}

function getModuleRow(moduleId) {
  const data = getAllRows(SHEET_MODULES);
  const idx = data.headers.indexOf('ModuleID');
  for (let i = 0; i < data.rows.length; i++) {
    if (String(data.rows[i][idx]) === String(moduleId)) {
      const obj = rowToObj(data.headers, data.rows[i]);
      obj._rowIndex = i + 2;
      return obj;
    }
  }
  return null;
}

function getCourseModuleMapRows(courseId) {
  const data = getAllRows(SHEET_COURSE_MODULE_MAP);
  const out = [];
  data.rows.forEach(function(r) {
    const obj = rowToObj(data.headers, r);
    if (String(obj['CourseID']) === String(courseId)) out.push(obj);
  });
  out.sort(function(a, b) { return Number(a['Sequence'] || 9999) - Number(b['Sequence'] || 9999); });
  return out;
}

function getLessonDeliveryRow(lessonId) {
  const data = getAllRows(SHEET_SLACK_DELIVERY);
  const idx = data.headers.indexOf('LessonID');
  for (let i = 0; i < data.rows.length; i++) {
    if (String(data.rows[i][idx]) === String(lessonId)) {
      const obj = rowToObj(data.headers, data.rows[i]);
      obj._rowIndex = i + 2;
      return obj;
    }
  }
  return null;
}

function getSlackThread(lessonId) { return getLessonDeliveryRow(lessonId); }

function findLessonDeliveryBySlackMessage(channel, ts) {
  const data = getAllRows(SHEET_SLACK_DELIVERY);
  const idxCh = data.headers.indexOf('Slack Channel');
  const idxTs = data.headers.indexOf('Slack TS');
  for (let i = 0; i < data.rows.length; i++) {
    if (String(data.rows[i][idxCh]) === String(channel) && String(data.rows[i][idxTs]) === String(ts)) {
      const obj = rowToObj(data.headers, data.rows[i]);
      obj._rowIndex = i + 2;
      return obj;
    }
  }
  return null;
}

function getMissionBySubmitCode(submitCode) {
  const code = String(submitCode || '').trim().toLowerCase();
  if (!code) return null;
  const data = getAllRows(SHEET_MISSIONS);
  const idx = data.headers.indexOf('Submit Code');
  for (let i = 0; i < data.rows.length; i++) {
    if (String(data.rows[i][idx] || '').trim().toLowerCase() === code) {
      const obj = rowToObj(data.headers, data.rows[i]);
      obj._rowIndex = i + 2;
      return obj;
    }
  }
  return null;
}

function isLessonQaApproved(lessonId) {
  const data = getAllRows(SHEET_QA);
  const idxLesson = data.headers.indexOf('Lesson');
  const idxVerdict = data.headers.indexOf('QA Verdict');
  const idxStatus = data.headers.indexOf('Status');
  for (let i = 0; i < data.rows.length; i++) {
    if (String(data.rows[i][idxLesson]) !== String(lessonId)) continue;
    const verdict = String(data.rows[i][idxVerdict] || '').toLowerCase();
    const status = String(data.rows[i][idxStatus] || '').toLowerCase();
    return (verdict === 'pass' || verdict === 'approved') && (status === 'ready' || status === 'approved' || status === 'pass');
  }
  return false;
}

function getLearnerSubmissions(slackUserId) {
  const data = getAllRows(SHEET_SUBMISSIONS);
  const idxLearner = data.headers.indexOf('Learner');
  const out = [];
  for (let i = 0; i < data.rows.length; i++) {
    if (String(data.rows[i][idxLearner]) === String(slackUserId)) out.push(rowToObj(data.headers, data.rows[i]));
  }
  return out;
}

function writeSubmission(lessonId, slackUserId, score, method, missionId, submitCode, evidence) {
  const data = getAllRows(SHEET_SUBMISSIONS);
  const row = data.headers.map(function(h) {
    if (h === 'Timestamp') return new Date();
    if (h === 'Learner') return slackUserId;
    if (h === 'Lesson') return lessonId;
    if (h === 'MissionID') return missionId || '';
    if (h === 'Submit Code') return submitCode || '';
    if (h === 'Evidence') return evidence || '';
    if (h === 'Method') return method || '';
    if (h === 'Score') return score == null ? '' : score;
    return '';
  });
  data.sheet.appendRow(row);
}

function getCurrentLessonId(learner) {
  const courseId = learner['Enrolled Course'];
  const submissions = getLearnerSubmissions(learner['UserID']);
  const done = {};
  submissions.forEach(function(s) { done[String(s['Lesson'])] = true; });

  const mapRows = getCourseModuleMapRows(courseId);
  const lessonsData = getAllRows(SHEET_LESSONS);
  const sorted = lessonsData.rows.map(function(r) { return rowToObj(lessonsData.headers, r); }).filter(function(r) {
    return String(r['CourseID']) === String(courseId) && String(r['Status']).toLowerCase() !== 'archived';
  }).sort(function(a, b) { return Number(a['Lesson Order'] || 99999) - Number(b['Lesson Order'] || 99999); });

  if (!mapRows.length) {
    for (let i = 0; i < sorted.length; i++) if (!done[String(sorted[i]['LessonID'])]) return sorted[i]['LessonID'];
    return null;
  }

  const moduleOrder = {};
  mapRows.forEach(function(m, idx) { moduleOrder[String(m['ModuleID'])] = idx; });
  sorted.sort(function(a, b) {
    const am = moduleOrder[String(a['ModuleID'])];
    const bm = moduleOrder[String(b['ModuleID'])];
    const av = am == null ? 9999 : am;
    const bv = bm == null ? 9999 : bm;
    if (av !== bv) return av - bv;
    return Number(a['Lesson Order'] || 99999) - Number(b['Lesson Order'] || 99999);
  });
  for (let i = 0; i < sorted.length; i++) if (!done[String(sorted[i]['LessonID'])]) return sorted[i]['LessonID'];
  return null;
}

function updateLearnerProgress(slackUserId, lessonId, missionId) {
  const learner = getLearnerRecord(slackUserId);
  if (!learner) return;
  const submissions = getLearnerSubmissions(slackUserId);
  const completedLessons = {};
  const completedMissions = {};
  submissions.forEach(function(s) {
    if (s['Lesson']) completedLessons[String(s['Lesson'])] = true;
    if (s['MissionID']) completedMissions[String(s['MissionID'])] = true;
  });

  const lessonsData = getAllRows(SHEET_LESSONS);
  const totalForCourse = lessonsData.rows.filter(function(r) {
    const obj = rowToObj(lessonsData.headers, r);
    return String(obj['CourseID']) === String(learner['Enrolled Course']);
  }).length;

  const progress = totalForCourse ? Math.round((Object.keys(completedLessons).length / totalForCourse) * 100) : 0;
  const data = getAllRows(SHEET_LEARNERS);
  const row = learner._rowIndex;
  const idxProgress = data.headers.indexOf('Progress (%)');
  const idxDoneMissions = data.headers.indexOf('Completed Missions');
  const idxDoneLessons = data.headers.indexOf('Completed Lessons');
  const idxLastLesson = data.headers.indexOf('Last LessonID');
  const idxLastMission = data.headers.indexOf('Last MissionID');
  const idxModule = data.headers.indexOf('Current Module');
  if (idxProgress >= 0) data.sheet.getRange(row, idxProgress + 1).setValue(progress);
  if (idxDoneMissions >= 0) data.sheet.getRange(row, idxDoneMissions + 1).setValue(Object.keys(completedMissions).length);
  if (idxDoneLessons >= 0) data.sheet.getRange(row, idxDoneLessons + 1).setValue(Object.keys(completedLessons).length);
  if (idxLastLesson >= 0 && lessonId) data.sheet.getRange(row, idxLastLesson + 1).setValue(lessonId);
  if (idxLastMission >= 0 && missionId) data.sheet.getRange(row, idxLastMission + 1).setValue(missionId);
  const lessonRow = getLessonRow(lessonId);
  if (lessonRow && idxModule >= 0) data.sheet.getRange(row, idxModule + 1).setValue(lessonRow['ModuleID'] || '');
}

function recordLessonMetricTouch(lessonId) {
  const data = getAllRows(SHEET_METRICS);
  const idxLesson = data.headers.indexOf('Lesson');
  const idxReviewed = data.headers.indexOf('Last Reviewed');
  const idxReviewer = data.headers.indexOf('Reviewer');
  for (let i = 0; i < data.rows.length; i++) {
    if (String(data.rows[i][idxLesson]) === String(lessonId)) {
      if (idxReviewed >= 0) data.sheet.getRange(i + 2, idxReviewed + 1).setValue(new Date());
      if (idxReviewer >= 0) data.sheet.getRange(i + 2, idxReviewer + 1).setValue('slack_delivery_bot');
      return;
    }
  }
}

function appendToQueue(userId, payloadJson) {
  const sheet = ensureQueueSheet();
  sheet.appendRow([new Date(), userId || '', payloadJson, 'PENDING', 0, '']);
}

function updateLessonMediaColumns(lessonId, mediaRequired, mediaBriefText) {
  const lessons = getAllRows(SHEET_LESSONS);
  const idxLessonId = lessons.headers.indexOf('LessonID');
  const idxMediaRequired = lessons.headers.indexOf('Media Required');
  const idxMediaBrief = lessons.headers.indexOf('Media Brief');
  if (idxMediaRequired < 0 || idxMediaBrief < 0) return false;
  for (let i = 0; i < lessons.rows.length; i++) {
    if (String(lessons.rows[i][idxLessonId]) === String(lessonId)) {
      lessons.sheet.getRange(i + 2, idxMediaRequired + 1).setValue(mediaRequired ? 'TRUE' : 'FALSE');
      lessons.sheet.getRange(i + 2, idxMediaBrief + 1).setValue(mediaRequired ? String(mediaBriefText || '') : '');
      return true;
    }
  }
  return false;
}

function ensureQueueSheet() {
  let sheet = SS.getSheetByName(SHEET_QUEUE);
  const headers = ['Created', 'User_Id', 'Payload_Json', 'Status', 'Retry_Count', 'Last_Error'];
  if (!sheet) {
    sheet = SS.insertSheet(SHEET_QUEUE);
    sheet.appendRow(headers);
    return sheet;
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  } else {
    ensureSheetColumnsByName_(SHEET_QUEUE, headers);
  }
  return sheet;
}

function getFirstLessonIdForModule(moduleId) {
  const lessons = getAllRows(SHEET_LESSONS);
  const rows = lessons.rows.map(function(r) { return rowToObj(lessons.headers, r); }).filter(function(r) {
    return String(r['ModuleID']) === String(moduleId);
  }).sort(function(a, b) { return Number(a['Lesson Order'] || 99999) - Number(b['Lesson Order'] || 99999); });
  return rows.length ? rows[0]['LessonID'] : null;
}

function getFirstReadyLessonIdForCourse(courseId) {
  const lessons = getAllRows(SHEET_LESSONS);
  const rows = lessons.rows.map(function(r) { return rowToObj(lessons.headers, r); }).filter(function(r) {
    return String(r['CourseID']) === String(courseId) && String(r['Status']).toLowerCase() !== 'archived';
  }).sort(function(a, b) { return Number(a['Lesson Order'] || 99999) - Number(b['Lesson Order'] || 99999); });
  return rows.length ? rows[0]['LessonID'] : null;
}
