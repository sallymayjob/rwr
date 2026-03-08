function callClaude(systemPrompt, userMessage, maxTokens) {
  try {
    const key = PROPS.getProperty('ANTHROPIC_API_KEY');
    const res = UrlFetchApp.fetch(ANTHROPIC_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens || 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      }),
      muteHttpExceptions: true
    });

    if (res.getResponseCode() !== 200) {
      Logger.log('Anthropic non-200: ' + res.getContentText());
      return 'I encountered an issue. Please try again in a moment.';
    }

    const data = JSON.parse(res.getContentText());
    if (!data.content || !data.content.length) return 'I encountered an issue. Please try again in a moment.';
    return data.content[0].text || 'I encountered an issue. Please try again in a moment.';
  } catch (err) {
    Logger.log('callClaude error: ' + err);
    return 'I encountered an issue. Please try again in a moment.';
  }
}

function getSystemPrompt(agentName) {
  const prompts = {
    quiz_master:
      'You are the RWR Group LMS Quiz Master. A recruiting professional has just submitted their mission for lesson {lessonId}. Your job is to score the submission.\n\n' +
      'Score on a 0–100 scale based on:\n' +
      '- Did they clearly complete the action described in the mission?\n' +
      '- Is the verification evidence specific and observable (not generic reflection)?\n' +
      '- Does the evidence demonstrate professional judgment, not just task completion?\n\n' +
      'Return JSON: { "score": 0-100, "feedback": "2-sentence feedback", "passed": true/false }.\n' +
      'Score ≥ 60 = passed. Be encouraging on first attempt. Be specific about what would improve a low score.\n' +
      'RWR voice: confident, people-first. Never condescending. Banned words: leverage, synergy, transformative, staff, human resources.',

    progress_assistant:
      'You are the RWR LMS progress assistant. Provide a brief, encouraging progress update for a recruiting professional. ' +
      'Reference their actual completion stats. Keep it under 100 words. Tone: collegial peer, not corporate system.',

    general_assistant:
      'You are the Agentic LMS for RWR Group — a specialist recruitment training system. You help recruiting professionals across ' +
      'RWR Health, Hospoworld, Retailworld, Retailworld, RWR Construction, and RWR Executive Search develop their professional skills. ' +
      'Answer questions about the LMS, their training, or recruiting practice. Keep responses concise and practical. RWR voice: confident, people-first, forward-looking. ' +
      'Core positioning: "We don\'t recruit — we empower those who do."'
  };
  return prompts[agentName] || prompts.general_assistant;
}

function agentTutor(payload) {
  const learner = getLearnerRecord(payload.user_id);
  if (!learner) return postDM(payload.user_id, "You're not enrolled yet. Use /enroll to get started.");

  const lessonId = getCurrentLessonId(learner);
  if (!lessonId) return postDM(payload.user_id, 'You are up to date. No pending lesson in your current module.');

  const thread = getSlackThread(lessonId);
  if (!thread) return postDM(payload.user_id, 'No lesson found for ' + lessonId + '. Contact your administrator.');

  const blocks = buildLessonBlocks(thread['Slack Thread Text'], lessonId, payload.user_id, learner._rowIndex);
  return postDM(payload.user_id, 'Here is your next lesson.', blocks);
}

function agentQuizMaster(payload) {
  const learner = getLearnerRecord(payload.user_id);
  if (!learner) return postDM(payload.user_id, "You're not enrolled yet. Use /enroll to get started.");

  const txt = (payload.text || '').trim();
  const parts = txt.split(/\s+/);
  if (parts.length < 2) {
    return postDM(payload.user_id, 'Usage: /submit {lessonId} {your verification evidence}');
  }

  const lessonId = parts.shift();
  const evidence = parts.join(' ');
  const prompt = getSystemPrompt('quiz_master').replace('{lessonId}', lessonId);

  const aiText = callClaude(prompt, 'Submission evidence:\n' + evidence, 300);
  let score = 0;
  let feedback = aiText;
  let passed = false;

  try {
    const parsed = JSON.parse(aiText);
    score = Number(parsed.score || 0);
    feedback = parsed.feedback || aiText;
    passed = !!parsed.passed;
  } catch (err) {
    Logger.log('Quiz parse fallback: ' + err);
    score = evidence.length > 40 ? 70 : 45;
    passed = score >= 60;
  }

  writeSubmission(lessonId, payload.user_id, score, 'slash_command');
  updateLearnerProgress(payload.user_id, lessonId);

  const resultText = '*Lesson:* ' + lessonId + '\n*Score:* ' + score + '\n*Status:* ' + (passed ? 'Passed ✅' : 'Needs improvement');
  return postDM(payload.user_id, resultText + '\n\n' + feedback);
}

function agentProgress(payload) {
  const learner = getLearnerRecord(payload.user_id);
  if (!learner) return postDM(payload.user_id, "You're not enrolled yet. Use /enroll to get started.");
  const subs = getLearnerSubmissions(payload.user_id);
  const moduleRow = getModuleRow(learner['Current Module']);
  const blocks = buildProgressBlocks(learner, subs, moduleRow);
  return postDM(payload.user_id, 'Progress snapshot', blocks);
}

function agentEnroll(payload) {
  const userId = ((payload.text || '').trim() || payload.user_id);
  const courseId = 'COURSE_12M';
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const data = getAllRows(SHEET_LEARNERS);
    const idxUser = data.headers.indexOf('UserID');
    const idxCourse = data.headers.indexOf('Enrolled Course');
    const idxCurrentModule = data.headers.indexOf('Current Module');

    let target = -1;
    for (let i = 0; i < data.rows.length; i++) {
      if (String(data.rows[i][idxUser]) === String(userId)) {
        target = i + 2;
        break;
      }
    }
    if (target < 0) return postDM(payload.user_id, 'Learner not found. Use /onboard first.');

    data.sheet.getRange(target, idxCourse + 1).setValue(courseId);
    data.sheet.getRange(target, idxCurrentModule + 1).setValue('M01');
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return postDM(payload.user_id, 'Enrolled <@' + userId + '> in ' + courseId + '.');
}

function agentUnenroll(payload) {
  const userId = ((payload.text || '').trim() || payload.user_id);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const data = getAllRows(SHEET_LEARNERS);
    const idxUser = data.headers.indexOf('UserID');
    const idxCourse = data.headers.indexOf('Enrolled Course');
    const idxCurrentModule = data.headers.indexOf('Current Module');

    for (let i = 0; i < data.rows.length; i++) {
      if (String(data.rows[i][idxUser]) === String(userId)) {
        const rowIndex = i + 2;
        data.sheet.getRange(rowIndex, idxCourse + 1).setValue('');
        data.sheet.getRange(rowIndex, idxCurrentModule + 1).setValue('');
        SpreadsheetApp.flush();
        return postDM(payload.user_id, 'Unenrolled <@' + userId + '>.');
      }
    }
  } finally {
    lock.releaseLock();
  }
  return postDM(payload.user_id, 'Learner not found.');
}

function agentOnboard(payload) {
  const targetUser = ((payload.text || '').trim() || payload.user_id);
  const info = getUserInfo(targetUser);
  if (!info) return postDM(payload.user_id, 'Unable to fetch Slack user profile.');

  const learnersSheet = SS.getSheetByName(SHEET_LEARNERS);
  const existing = getLearnerRecord(targetUser);
  if (existing) return postDM(payload.user_id, 'Learner already exists.');

  learnersSheet.appendRow([
    targetUser,
    info.name,
    info.email,
    '',
    '',
    0,
    'Active',
    new Date(),
    ''
  ]);
  return postDM(targetUser, 'Welcome to the RWR Group LMS. You can now use /learn to start.');
}

function agentOffboard(payload) {
  const targetUser = ((payload.text || '').trim() || payload.user_id);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const data = getAllRows(SHEET_LEARNERS);
    const idxUser = data.headers.indexOf('UserID');
    const idxStatus = data.headers.indexOf('Status');

    for (let i = 0; i < data.rows.length; i++) {
      if (String(data.rows[i][idxUser]) === String(targetUser)) {
        data.sheet.getRange(i + 2, idxStatus + 1).setValue('Archived');
        SpreadsheetApp.flush();
        return postDM(payload.user_id, 'Archived learner <@' + targetUser + '>.');
      }
    }
  } finally {
    lock.releaseLock();
  }
  return postDM(payload.user_id, 'Learner not found.');
}

function agentReport(payload) {
  const learnerData = getAllRows(SHEET_LEARNERS);
  const subData = getAllRows(SHEET_SUBMISSIONS);
  const moduleData = getAllRows(SHEET_MODULES);

  const learners = learnerData.rows.map(function(r) { return rowToObj(learnerData.headers, r); });
  const submissions = subData.rows.map(function(r) { return rowToObj(subData.headers, r); });
  const modules = moduleData.rows.map(function(r) { return rowToObj(moduleData.headers, r); });

  return postDM(payload.user_id, 'Cohort report ready.', buildReportBlocks(learners, submissions, modules));
}

function agentHelp(payload) {
  const admin = isAdmin(payload.user_id);
  const learnerCmds = ['/learn', '/submit', '/progress', '/courses', '/help', '/cert'];
  const adminCmds = ['/enroll', '/unenroll', '/onboard', '/offboard', '/report', '/gaps', '/backup', '/mix'];
  let text = '*Available commands*\n' + learnerCmds.join('\n');
  if (admin) text += '\n\n*Admin commands*\n' + adminCmds.join('\n');
  return postDM(payload.user_id, text);
}

function agentCourses(payload) {
  const learner = getLearnerRecord(payload.user_id);
  const data = getAllRows(SHEET_COURSES);
  const courses = data.rows.map(function(r) { return rowToObj(data.headers, r); });

  const lines = courses.map(function(c) {
    const enrolled = learner && String(learner['Enrolled Course']) === String(c['CourseID']) ? ' (enrolled)' : '';
    return '• ' + c['CourseID'] + ': ' + c['Course Title'] + enrolled;
  });

  return postDM(payload.user_id, '*Courses*\n' + (lines.join('\n') || 'No courses found.'));
}

function agentCert(payload) {
  const learner = getLearnerRecord(payload.user_id);
  if (!learner) return postDM(payload.user_id, "You're not enrolled yet. Use /enroll to get started.");

  const moduleId = learner['Current Module'];
  const lessons = getAllRows(SHEET_LESSONS);
  const lIdxModule = lessons.headers.indexOf('Module');
  const lIdxStatus = lessons.headers.indexOf('Status');
  const lIdxLesson = lessons.headers.indexOf('LessonID');

  const required = [];
  for (let i = 0; i < lessons.rows.length; i++) {
    const r = lessons.rows[i];
    if (String(r[lIdxModule]) === String(moduleId) && String(r[lIdxStatus]) === 'Ready') {
      required.push(String(r[lIdxLesson]));
    }
  }

  const subs = getLearnerSubmissions(payload.user_id).map(function(s) { return String(s['Lesson']); });
  const doneSet = {};
  subs.forEach(function(id) { doneSet[id] = true; });

  const missing = required.filter(function(id) { return !doneSet[id]; });
  if (required.length && missing.length === 0) {
    return postDM(payload.user_id, 'You are certification-eligible for module ' + moduleId + '. 🎉');
  }
  return postDM(payload.user_id, 'Not yet eligible for certification in ' + moduleId + '. Remaining lessons: ' + missing.slice(0, 10).join(', '));
}

function agentGaps(payload) {
  const learnersData = getAllRows(SHEET_LEARNERS);
  const subsData = getAllRows(SHEET_SUBMISSIONS);

  const learners = learnersData.rows.map(function(r) { return rowToObj(learnersData.headers, r); });
  const subs = subsData.rows.map(function(r) { return rowToObj(subsData.headers, r); });

  const countByLearner = {};
  subs.forEach(function(s) {
    countByLearner[s['Learner']] = (countByLearner[s['Learner']] || 0) + 1;
  });

  const counts = learners.map(function(l) { return countByLearner[l['UserID']] || 0; }).sort(function(a, b) { return a - b; });
  const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;

  const behind = learners.filter(function(l) {
    return (countByLearner[l['UserID']] || 0) < (median - 3);
  });

  const text = behind.length
    ? behind.map(function(l) { return '• ' + (l['Name'] || l['UserID']) + ' (' + (countByLearner[l['UserID']] || 0) + ' complete)'; }).join('\n')
    : 'No learners are > 3 lessons behind median.';
  return postDM(payload.user_id, '*Gap Report*\nMedian completions: ' + median + '\n' + text);
}

function agentBackup(payload) {
  try {
    const rootId = PROPS.getProperty('DRIVE_ROOT_ID');
    const root = DriveApp.getFolderById(rootId);
    const backupFolderName = 'Backups';
    const folders = root.getFoldersByName(backupFolderName);
    const backupFolder = folders.hasNext() ? folders.next() : root.createFolder(backupFolderName);

    const names = [SHEET_LESSONS, SHEET_MODULES, SHEET_COURSES, SHEET_LEARNERS, SHEET_SUBMISSIONS, SHEET_QA, SHEET_METRICS, SHEET_THREADS];
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');

    names.forEach(function(name) {
      const data = getAllRows(name);
      const rows = [data.headers].concat(data.rows);
      const csv = rows.map(function(r) {
        return r.map(function(v) {
          const s = String(v == null ? '' : v).replace(/"/g, '""');
          return '"' + s + '"';
        }).join(',');
      }).join('\n');
      backupFolder.createFile(name + '_' + stamp + '.csv', csv, MimeType.CSV);
    });

    return postDM(payload.user_id, 'Backup complete: ' + stamp);
  } catch (err) {
    Logger.log('agentBackup error: ' + err);
    return postDM(payload.user_id, 'Backup failed. Please check logs.');
  }
}

function agentMix(payload) {
  const query = (payload.text || '').trim().toLowerCase();
  const lessons = getAllRows(SHEET_LESSONS);
  const idxLesson = lessons.headers.indexOf('LessonID');
  const idxTopic = lessons.headers.indexOf('Topic');
  const idxTitle = lessons.headers.indexOf('Title');
  const idxStatus = lessons.headers.indexOf('Status');

  const picks = [];
  for (let i = 0; i < lessons.rows.length; i++) {
    const r = lessons.rows[i];
    if (String(r[idxStatus]) !== 'Ready') continue;
    const hay = (String(r[idxTitle]) + ' ' + String(r[idxTopic])).toLowerCase();
    if (!query || hay.indexOf(query) !== -1) picks.push('• ' + r[idxLesson] + ' — ' + r[idxTitle]);
    if (picks.length >= 12) break;
  }

  return postDM(payload.user_id, '*Content Mix*\n' + (picks.join('\n') || 'No matching ready lessons found.'));
}

function handleMention(event) {
  const text = event.text || '';
  const reply = callClaude(getSystemPrompt('general_assistant'), text, 250);
  return postMessage(event.channel, reply, null);
}

function handleDirectMessage(event) {
  const text = event.text || '';
  const reply = callClaude(getSystemPrompt('general_assistant'), text, 250);
  return postMessage(event.channel, reply, null);
}

function handleReaction(event) {
  try {
    if (event.reaction !== 'white_check_mark') return;
    let lessonId = '';
    const m = (event.item && event.item.ts ? String(event.item.ts) : '').match(/M\d{2}-W\d{2}-(L\d{2}(?:\.\d+)?|DEEP)/);
    if (m) lessonId = m[0];
    if (!lessonId) return;

    writeSubmission(lessonId, event.user, null, 'reaction');
    updateLearnerProgress(event.user, lessonId);
    return postDM(event.user, 'Recorded completion for ' + lessonId + ' ✅');
  } catch (err) {
    Logger.log('handleReaction error: ' + err);
  }
}
