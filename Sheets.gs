function getAllRows(sheetName) {
  const sheet = SS.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet not found: ' + sheetName);
  const allData = sheet.getDataRange().getValues();
  const headers = allData.length ? allData[0] : [];
  const rows = allData.length > 1 ? allData.slice(1) : [];
  return { headers: headers, rows: rows, sheet: sheet };
}

function ensureSheetColumnsByName_(sheetName, requiredColumns) {
  const sheet = SS.getSheetByName(sheetName);
  if (!sheet) throw new Error('Missing sheet: ' + sheetName);

  const lastCol = Math.max(1, sheet.getLastColumn());
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) {
    return String(h || '').trim();
  });

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

  return headers;
}

function ensureCurriculumDatabaseColumns() {
  const moduleColumns = [
    'ModuleID',
    'Module Number',
    'Module Name',
    'Module Description',
    'CourseID',
    'Course Title',
    'Status',
    'Difficulty Tier',
    'Audience',
    'Total Lessons',
    'Week Range',
    'Lesson Types',
    'Focus Areas',
    'Lesson IDs',
    'Sample Topics'
  ];

  const courseColumns = [
    'CourseID',
    'Course Title',
    'Course Description',
    'Start ModuleID',
    'Start Module Name',
    'Module IDs',
    'Module Names',
    'Total Modules',
    'Total Lessons',
    'Audience',
    'Difficulty Range',
    'Status'
  ];

  ensureSheetColumnsByName_(SHEET_MODULES, moduleColumns);
  ensureSheetColumnsByName_(SHEET_COURSES, courseColumns);
}

function rowToObj(headers, row) {
  const obj = {};
  for (let i = 0; i < headers.length; i++) obj[headers[i]] = row[i];
  return obj;
}

function getLearnerRecord(slackUserId) {
  const data = getAllRows(SHEET_LEARNERS);
  for (let i = 0; i < data.rows.length; i++) {
    if (String(data.rows[i][0]) === String(slackUserId)) {
      const obj = rowToObj(data.headers, data.rows[i]);
      obj._rowIndex = i + 2;
      return obj;
    }
  }
  return null;
}

function getSlackThread(lessonId) {
  const data = getAllRows(SHEET_THREADS);
  const idxText = data.headers.indexOf('Slack Thread Text');
  const idxLesson = data.headers.indexOf('Lesson');
  for (let i = 0; i < data.rows.length; i++) {
    if (String(data.rows[i][idxLesson]) === String(lessonId)) {
      return {
        'Slack Thread Text': data.rows[i][idxText],
        'Lesson': data.rows[i][idxLesson]
      };
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

function getLearnerSubmissions(slackUserId) {
  const data = getAllRows(SHEET_SUBMISSIONS);
  const idxLearner = data.headers.indexOf('Learner');
  const out = [];
  for (let i = 0; i < data.rows.length; i++) {
    if (String(data.rows[i][idxLearner]) === String(slackUserId)) {
      out.push(rowToObj(data.headers, data.rows[i]));
    }
  }
  return out;
}

function getCurrentLessonId(learner) {
  const lessonsData = getAllRows(SHEET_LESSONS);
  const headers = lessonsData.headers;
  const idxLessonId = headers.indexOf('LessonID');
  const idxModule = headers.indexOf('Module');
  const idxStatus = headers.indexOf('Status');

  const currentModule = learner['Current Module'];
  if (!currentModule) return null;

  const candidates = [];
  for (let i = 0; i < lessonsData.rows.length; i++) {
    const r = lessonsData.rows[i];
    if (String(r[idxModule]) === String(currentModule) && String(r[idxStatus]) === 'Ready') {
      candidates.push(String(r[idxLessonId]));
    }
  }

  candidates.sort();
  if (!candidates.length) return null;

  const submissions = getLearnerSubmissions(learner['UserID']);
  const submittedMap = {};
  submissions.forEach(function(s) {
    submittedMap[String(s['Lesson'])] = true;
  });

  for (let j = 0; j < candidates.length; j++) {
    if (!submittedMap[candidates[j]]) return candidates[j];
  }
  return null;
}

function writeSubmission(lessonId, slackUserId, score, method) {
  const sheet = SS.getSheetByName(SHEET_SUBMISSIONS);
  sheet.appendRow([Utilities.getUuid(), slackUserId, lessonId, new Date(), score, 'Complete', method]);
}

function updateLearnerProgress(slackUserId, lessonId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const learners = getAllRows(SHEET_LEARNERS);
    const lessons = getAllRows(SHEET_LESSONS);
    const submissions = getAllRows(SHEET_SUBMISSIONS);

    const idxLearnerId = learners.headers.indexOf('UserID');
    const idxProgress = learners.headers.indexOf('Progress (%)');
    const idxCourse = learners.headers.indexOf('Enrolled Course');
    const idxCurrentModule = learners.headers.indexOf('Current Module');
    const idxStatus = learners.headers.indexOf('Status');

    let learnerRowIndex = -1;
    let learnerRow = null;
    for (let i = 0; i < learners.rows.length; i++) {
      if (String(learners.rows[i][idxLearnerId]) === String(slackUserId)) {
        learnerRowIndex = i + 2;
        learnerRow = learners.rows[i];
        break;
      }
    }
    if (!learnerRow || String(learnerRow[idxStatus]) !== 'Active') return;

    const courseId = String(learnerRow[idxCourse] || 'COURSE_12M');
    const lessonsIdxCourse = lessons.headers.indexOf('Course');
    const lessonsIdxStatus = lessons.headers.indexOf('Status');
    const lessonsIdxLessonId = lessons.headers.indexOf('LessonID');
    const lessonsIdxModule = lessons.headers.indexOf('Module');

    let totalReady = 0;
    const readyByModule = {};
    for (let j = 0; j < lessons.rows.length; j++) {
      const lr = lessons.rows[j];
      if (String(lr[lessonsIdxCourse]) === courseId && String(lr[lessonsIdxStatus]) === 'Ready') {
        totalReady++;
        const m = String(lr[lessonsIdxModule]);
        readyByModule[m] = readyByModule[m] || [];
        readyByModule[m].push(String(lr[lessonsIdxLessonId]));
      }
    }

    const subIdxLearner = submissions.headers.indexOf('Learner');
    const subIdxLesson = submissions.headers.indexOf('Lesson');
    const completedSet = {};
    for (let k = 0; k < submissions.rows.length; k++) {
      const sr = submissions.rows[k];
      if (String(sr[subIdxLearner]) === String(slackUserId)) {
        completedSet[String(sr[subIdxLesson])] = true;
      }
    }

    const completedCount = Object.keys(completedSet).length;
    const progress = totalReady ? Math.round((completedCount / totalReady) * 100) : 0;

    learners.sheet.getRange(learnerRowIndex, idxProgress + 1).setValue(progress);

    const currentModule = String(learnerRow[idxCurrentModule] || '');
    if (currentModule && readyByModule[currentModule]) {
      const modLessons = readyByModule[currentModule];
      const allDone = modLessons.every(function(lid) { return !!completedSet[lid]; });
      if (allDone) {
        const mods = Object.keys(readyByModule).sort();
        const idxM = mods.indexOf(currentModule);
        if (idxM >= 0 && idxM + 1 < mods.length) {
          learners.sheet.getRange(learnerRowIndex, idxCurrentModule + 1).setValue(mods[idxM + 1]);
        }
      }
    }

    SpreadsheetApp.flush();
  } catch (err) {
    Logger.log('updateLearnerProgress error: ' + err);
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function syncModuleRollup(moduleId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const modules = getAllRows(SHEET_MODULES);
    const lessons = getAllRows(SHEET_LESSONS);
    const qa = getAllRows(SHEET_QA);

    const modIdx = modules.headers.indexOf('ModuleID');
    let modRowIndex = -1;
    let modRow = null;
    for (let i = 0; i < modules.rows.length; i++) {
      if (String(modules.rows[i][modIdx]) === String(moduleId)) {
        modRowIndex = i + 2;
        modRow = modules.rows[i];
        break;
      }
    }
    if (!modRow) return;

    const lIdxModule = lessons.headers.indexOf('Module');
    const lIdxLessonId = lessons.headers.indexOf('LessonID');
    const lIdxStatus = lessons.headers.indexOf('Status');

    const lessonIds = [];
    const lessonTypes = {};
    const focusAreas = {};
    const sampleTopics = [];
    const audienceValues = {};
    const difficultyValues = {};
    let published = 0;
    let drafts = 0;
    let needsRevision = 0;

    const lIdxType = lessons.headers.indexOf('Type');
    const lIdxFocus = lessons.headers.indexOf('Focus Area');
    const lIdxTopic = lessons.headers.indexOf('Topic');
    const lIdxAudience = lessons.headers.indexOf('Audience');
    const lIdxDifficulty = lessons.headers.indexOf('Difficulty Tier');

    for (let j = 0; j < lessons.rows.length; j++) {
      const lr = lessons.rows[j];
      if (String(lr[lIdxModule]) === String(moduleId)) {
        const lid = String(lr[lIdxLessonId]);
        lessonIds.push(lid);

        if (lIdxType >= 0 && lr[lIdxType]) lessonTypes[String(lr[lIdxType])] = true;
        if (lIdxFocus >= 0 && lr[lIdxFocus]) focusAreas[String(lr[lIdxFocus])] = true;
        if (lIdxAudience >= 0 && lr[lIdxAudience]) audienceValues[String(lr[lIdxAudience])] = true;
        if (lIdxDifficulty >= 0 && lr[lIdxDifficulty]) difficultyValues[String(lr[lIdxDifficulty])] = true;
        if (lIdxTopic >= 0 && lr[lIdxTopic] && sampleTopics.length < 5) sampleTopics.push(String(lr[lIdxTopic]));

        const st = String(lr[lIdxStatus]);
        if (st === 'Ready') published++;
        if (st === 'Draft' || st === 'SOP-5 Review') drafts++;
        if (st === 'Need Human Review') needsRevision++;
      }
    }

    const qaIdxLesson = qa.headers.indexOf('Lesson');
    const qaIdxScore = qa.headers.indexOf('QA Score');
    const qaIdxVerdict = qa.headers.indexOf('QA Verdict');

    let scoreSum = 0;
    let scoreCount = 0;
    let passCount = 0;
    const lessonSet = {};
    lessonIds.forEach(function(id) { lessonSet[id] = true; });

    for (let k = 0; k < qa.rows.length; k++) {
      const qrow = qa.rows[k];
      const rawLesson = String(qrow[qaIdxLesson] || '').replace(/^(QA_|MET_|ST_)/, '');
      if (lessonSet[rawLesson]) {
        const score = Number(qrow[qaIdxScore]);
        if (!isNaN(score)) {
          scoreSum += score;
          scoreCount++;
        }
        const verdict = String(qrow[qaIdxVerdict]);
        if (['STRONG_PASS', 'PASS', 'CONDITIONAL_PASS'].indexOf(verdict) !== -1) passCount++;
      }
    }

    const avgQa = scoreCount ? (scoreSum / scoreCount) : 0;
    const passRate = scoreCount ? Math.round((passCount / scoreCount) * 100) : 0;
    const status = needsRevision > 0 ? 'Need Human Review' : (drafts > 0 ? 'In Progress' : 'Ready');

    function setCol(header, val) {
      const idx = modules.headers.indexOf(header);
      if (idx >= 0) modules.sheet.getRange(modRowIndex, idx + 1).setValue(val);
    }

    setCol('Lessons', lessonIds.join('|'));
    setCol('Lesson IDs', lessonIds.join('|'));
    setCol('Total Lessons', lessonIds.length);
    setCol('Published Lessons', published);
    setCol('Draft Lessons', drafts);
    setCol('Needs Revision', needsRevision);
    setCol('Avg QA Score', Number(avgQa.toFixed(2)));
    setCol('QA Pass Rate', passRate);
    setCol('Status', status);
    setCol('Lesson Types', Object.keys(lessonTypes).join('|'));
    setCol('Focus Areas', Object.keys(focusAreas).join('|'));
    setCol('Sample Topics', sampleTopics.join('|'));
    setCol('Audience', Object.keys(audienceValues).join('|'));
    setCol('Difficulty Tier', Object.keys(difficultyValues).join('|'));
    setCol('Last Updated', new Date());

    SpreadsheetApp.flush();
  } catch (err) {
    Logger.log('syncModuleRollup error: ' + err);
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function syncCourseRollup(courseId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const courses = getAllRows(SHEET_COURSES);
    const modules = getAllRows(SHEET_MODULES);

    const cIdxId = courses.headers.indexOf('CourseID');
    let courseRowIndex = -1;
    for (let i = 0; i < courses.rows.length; i++) {
      if (String(courses.rows[i][cIdxId]) === String(courseId)) {
        courseRowIndex = i + 2;
        break;
      }
    }
    if (courseRowIndex < 0) return;

    const mIdxCourse = modules.headers.indexOf('Course');
    const mIdxCourseId = modules.headers.indexOf('CourseID');
    const mIdxModuleId = modules.headers.indexOf('ModuleID');
    const mIdxModuleName = modules.headers.indexOf('Module Name');
    const mIdxTotal = modules.headers.indexOf('Total Lessons');
    const mIdxPublished = modules.headers.indexOf('Published Lessons');
    const mIdxQa = modules.headers.indexOf('Avg QA Score');
    const mIdxLearners = modules.headers.indexOf('Learners');
    const mIdxAudience = modules.headers.indexOf('Audience');
    const mIdxDifficulty = modules.headers.indexOf('Difficulty Tier');

    const moduleIds = [];
    const moduleNames = [];
    const audiences = {};
    const difficulties = {};
    let totalLessons = 0;
    let published = 0;
    let qaSum = 0;
    let qaCount = 0;
    let learners = 0;

    for (let j = 0; j < modules.rows.length; j++) {
      const row = modules.rows[j];
      const moduleCourse = mIdxCourse >= 0 ? String(row[mIdxCourse]) : '';
      const moduleCourseId = mIdxCourseId >= 0 ? String(row[mIdxCourseId]) : '';
      if (moduleCourse === String(courseId) || moduleCourseId === String(courseId)) {
        moduleIds.push(String(row[mIdxModuleId]));
        if (mIdxModuleName >= 0 && row[mIdxModuleName]) moduleNames.push(String(row[mIdxModuleName]));
        totalLessons += Number(row[mIdxTotal] || 0);
        published += Number(row[mIdxPublished] || 0);
        const qaVal = Number(row[mIdxQa]);
        if (!isNaN(qaVal)) { qaSum += qaVal; qaCount++; }
        learners += Number(row[mIdxLearners] || 0);
        if (mIdxAudience >= 0 && row[mIdxAudience]) audiences[String(row[mIdxAudience])] = true;
        if (mIdxDifficulty >= 0 && row[mIdxDifficulty]) difficulties[String(row[mIdxDifficulty])] = true;
      }
    }

    const completionRate = totalLessons ? Math.round((published / totalLessons) * 100) : 0;
    const avgQa = qaCount ? qaSum / qaCount : 0;

    function setCourseCol(header, val) {
      const idx = courses.headers.indexOf(header);
      if (idx >= 0) courses.sheet.getRange(courseRowIndex, idx + 1).setValue(val);
    }

    setCourseCol('Modules', moduleIds.join('|'));
    setCourseCol('Module IDs', moduleIds.join('|'));
    setCourseCol('Module Names', moduleNames.join('|'));
    setCourseCol('Total Months', moduleIds.length);
    setCourseCol('Total Modules', moduleIds.length);
    setCourseCol('Total Lessons', totalLessons);
    setCourseCol('Published Lessons', published);
    setCourseCol('Completion Rate', completionRate);
    setCourseCol('Avg QA Score', Number(avgQa.toFixed(2)));
    setCourseCol('Last Updated', new Date());
    setCourseCol('Learners', learners);
    setCourseCol('Audience', Object.keys(audiences).join('|'));
    setCourseCol('Difficulty Range', Object.keys(difficulties).join('|'));
    setCourseCol('Start ModuleID', moduleIds.length ? moduleIds[0] : '');
    setCourseCol('Start Module Name', moduleNames.length ? moduleNames[0] : '');
    setCourseCol('Status', completionRate === 100 ? 'Ready' : 'In Progress');

    SpreadsheetApp.flush();
  } catch (err) {
    Logger.log('syncCourseRollup error: ' + err);
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function appendToQueue(userId, payloadJson) {
  const sheet = ensureQueueSheet();
  sheet.appendRow([new Date(), userId || '', payloadJson, 'PENDING']);
}


function updateLessonMediaColumns(lessonId, mediaRequired, mediaBriefText) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const lessons = getAllRows(SHEET_LESSONS);
    const idxLessonId = lessons.headers.indexOf('LessonID');
    const idxMediaRequired = lessons.headers.indexOf('Media Required');
    const idxMediaBrief = lessons.headers.indexOf('Media Brief');
    if (idxMediaRequired < 0 || idxMediaBrief < 0) {
      throw new Error('Lessons sheet is missing Media Required or Media Brief columns');
    }

    for (let i = 0; i < lessons.rows.length; i++) {
      if (String(lessons.rows[i][idxLessonId]) === String(lessonId)) {
        const rowIndex = i + 2;
        lessons.sheet.getRange(rowIndex, idxMediaRequired + 1).setValue(mediaRequired ? 'TRUE' : 'FALSE');
        lessons.sheet.getRange(rowIndex, idxMediaBrief + 1).setValue(mediaRequired ? String(mediaBriefText || '') : '');
        SpreadsheetApp.flush();
        return true;
      }
    }
    return false;
  } catch (err) {
    Logger.log('updateLessonMediaColumns error: ' + err);
    throw err;
  } finally {
    lock.releaseLock();
  }
}


function ensureQueueSheet() {
  let sheet = SS.getSheetByName(SHEET_QUEUE);
  const headers = ['Created', 'User_Id', 'Payload_Json', 'Status'];

  if (!sheet) {
    sheet = SS.insertSheet(SHEET_QUEUE);
    sheet.appendRow(headers);
    SpreadsheetApp.flush();
    return sheet;
  }

  const lastRow = sheet.getLastRow();
  if (lastRow === 0) {
    sheet.appendRow(headers);
    SpreadsheetApp.flush();
    return sheet;
  }

  const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const needsHeader = headers.some(function(h, i) { return String(firstRow[i] || '') !== h; });
  if (needsHeader) {
    sheet.insertRows(1, 1);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    SpreadsheetApp.flush();
  }

  return sheet;
}


function getFirstLessonIdForModule(moduleId) {
  var lessons = getAllRows(SHEET_LESSONS);
  var idxLessonId = lessons.headers.indexOf('LessonID');
  var idxModule = lessons.headers.indexOf('Module');
  var idxStatus = lessons.headers.indexOf('Status');

  var ids = [];
  for (var i = 0; i < lessons.rows.length; i++) {
    var r = lessons.rows[i];
    if (String(r[idxModule]) === String(moduleId) && String(r[idxStatus]) === 'Ready') {
      ids.push(String(r[idxLessonId]));
    }
  }
  ids.sort();
  return ids.length ? ids[0] : null;
}

function getFirstReadyLessonIdForCourse(courseId) {
  var lessons = getAllRows(SHEET_LESSONS);
  var idxLessonId = lessons.headers.indexOf('LessonID');
  var idxCourse = lessons.headers.indexOf('Course');
  var idxStatus = lessons.headers.indexOf('Status');

  var ids = [];
  for (var i = 0; i < lessons.rows.length; i++) {
    var r = lessons.rows[i];
    if (String(r[idxCourse]) === String(courseId) && String(r[idxStatus]) === 'Ready') {
      ids.push(String(r[idxLessonId]));
    }
  }
  ids.sort();
  return ids.length ? ids[0] : null;
}
