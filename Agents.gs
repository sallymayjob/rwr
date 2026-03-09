function approxWords(text) {
  return String(text || '').trim().split(/\s+/).filter(function(w) { return !!w; }).length;
}

function logAIUsage(provider, agentName, inputApproxWords, outputApproxWords) {
  const inputTokens = Math.round(inputApproxWords / 0.75);
  const outputTokens = Math.round(outputApproxWords / 0.75);

  const rates = {
    claude: { input: 3.00, output: 15.00 },
    gemini: { input: 0.075, output: 0.30 }
  };

  const rate = rates[provider] || rates.claude;
  const cost = ((inputTokens * rate.input) + (outputTokens * rate.output)) / 1000000;

  Logger.log(
    'AI_USAGE | provider=' + provider + ' | agent=' + agentName + ' | ' +
    'input_tokens~' + inputTokens + ' | output_tokens~' + outputTokens + ' | ' +
    'cost~$' + cost.toFixed(6)
  );
}

function callClaude(systemPrompt, userMessage, maxTokens, agentName) {
  const response = 'AI integrations are disabled in this deployment. Please use command-driven LMS functions.';
  logAIUsage('claude', agentName || 'disabled', approxWords(systemPrompt) + approxWords(userMessage), approxWords(response));
  return response;
}

function callGemini(systemPrompt, userMessage, maxTokens, agentName) {
  const response = 'AI integrations are disabled in this deployment. Please use command-driven LMS functions.';
  logAIUsage('gemini', agentName || 'disabled', approxWords(systemPrompt) + approxWords(userMessage), approxWords(response));
  return response;
}

function callAI(agentName, systemPrompt, userMessage, maxTokens) {
  Logger.log('callAI disabled: ' + agentName);
  return 'AI integrations are disabled in this deployment.';
}



function sendAutomatedMessageOnce(userId, dedupeKey, text, blocks, nextCommand) {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'auto_msg:' + String(userId || '') + ':' + String(dedupeKey || 'default');
    if (cache.get(key)) return { ok: true, skipped: true };

    var finalText = String(text || '');
    if (nextCommand) {
      finalText += '\n\nNext command: ' + nextCommand;
    }

    var result = postDM(userId, finalText, blocks || null);
    cache.put(key, '1', 3600);
    return result;
  } catch (err) {
    Logger.log('sendAutomatedMessageOnce error: ' + err);
    var fallbackText = String(text || '') + (nextCommand ? ('\n\nNext command: ' + nextCommand) : '');
    return postDM(userId, fallbackText, blocks || null);
  }
}

function getSystemPrompt(agentName) {
  const prompts = {
    quiz_master:
      'You are the RWR Group LMS Quiz Master. A recruiting professional has just submitted their mission for lesson {lessonId}. Your job is to score the submission.\n\n' +
      'Score on a 0-100 scale based on:\n' +
      '- Did they clearly complete the action described in the mission?\n' +
      '- Is the verification evidence specific and observable (not generic reflection)?\n' +
      '- Does the evidence demonstrate professional judgment, not just task completion?\n\n' +
      'Return JSON: { "score": 0-100, "feedback": "2-sentence feedback", "passed": true/false }.\n' +
      'Score >= 60 = passed. Be encouraging on first attempt. Be specific about what would improve a low score.\n' +
      'RWR voice: confident, people-first. Never condescending. Banned words: leverage, synergy, transformative, staff, human resources.',

    progress_assistant:
      'You are the RWR Group LMS progress assistant. You receive a JSON object containing a learner\'s name, current module, lessons completed, completion percentage, and next lesson ID. Generate a brief, friendly progress update message (under 120 words) formatted for Slack. Use bold for key stats. No emoji unless contextually appropriate. Tone: collegial peer, not corporate system. Brand voice: confident, people-first. Do not use the words: leverage, synergy, transformative, staff, human resources.',

    report_generator:
      'You are the RWR Group LMS admin reporting assistant. You receive JSON containing cohort data: learner names, modules enrolled, lessons completed, and completion percentages. Generate a structured Slack-formatted cohort summary. Lead with the headline stat (overall cohort completion %). Then list each learner\'s status in a compact format. Flag anyone below 50% completion. Keep the full report under 400 words. No markdown headers - use Slack bold (*text*) and separators (---) only. Do not use the words: leverage, synergy, transformative, staff, human resources.',

    gaps_analyser:
      'You are the RWR Group LMS gaps analyst. You receive JSON containing learner progress data and the module median completion rate. Identify learners who are more than 3 lessons behind the cohort median. For each, state their name, their completion count, how many lessons behind they are, and a one-line suggested action. Format for Slack. Keep each learner entry to 2 lines maximum. If no learners are behind, confirm the cohort is on track. Do not use the words: leverage, synergy, transformative, staff, human resources.',

    general_assistant:
      'You are the Agentic LMS assistant for RWR Group, a specialist recruitment training organisation operating across New Zealand and Australia. Your brands are RWR Health, Hospoworld, Retailworld, RWR Construction, and RWR Executive Search. Answer questions about the LMS, training programme, or recruitment practice concisely and practically. Keep responses under 200 words unless the question clearly requires more. Slack formatting only - no markdown headers. Brand voice: confident, people-first, forward-looking. Core positioning: "We don\'t recruit - we empower those who do." Do not use: leverage, synergy, transformative, staff, human resources.',

    cert_checker:
      'You are the RWR Group LMS certification checker. You receive JSON containing a learner\'s name, their current module completion data, and the certification criteria (all lessons in the module at Ready status must be submitted with Score >= 60). Evaluate eligibility and return a clear, brief Slack message (under 100 words) stating whether they are eligible, and if not, exactly what is outstanding. Be direct. No padding. Brand voice: confident, people-first. Do not use: leverage, synergy, transformative, staff, human resources.',

    courses_lister:
      'You are the RWR Group LMS course listing assistant. You receive JSON with available courses and enrolment status. Return a concise Slack-formatted summary showing each course and whether the learner is enrolled. Keep it practical, clear, and under 120 words. Brand voice: confident, people-first. Do not use: leverage, synergy, transformative, staff, human resources.',

    mix_generator:
      'You are the RWR Group LMS mix generator assistant. You receive JSON with optional topic query and candidate ready lessons. Produce a concise Slack-formatted learning mix recommendation and short rationale under 160 words. Brand voice: confident, people-first. Do not use: leverage, synergy, transformative, staff, human resources.',

    media_agent:
      'Media Agent - RWR Slack LMS. Role: Media coordinator. Assess whether a lesson needs visual support and, if needed, produce a structured creative brief. You do not create the asset. Default stance is no media unless a visual would clearly reduce confusion or speed up understanding for recruiting professionals. Recommend media only for multi-step decisions, side-by-side comparisons, data storytelling, named frameworks, spatial mappings, or before/after transformations. Do not recommend media for short conceptual lessons, single-step missions, reflection content, or visuals that duplicate text. If media is needed, output strict JSON with: lesson_id, media_required, rationale, media_brief (asset_type, purpose, content, palette, design_notes, slack_constraints), status=MEDIA_BRIEF_READY. If not needed output media_required=false, media_brief=null, status=MEDIA_COMPLETE. Use RWR design language: rounded shapes, dot motif, minimal style, Poppins, people-first imagery, and palette {#000000,#FFFFFF,#0054FF,#F58220,#E63976,#3FA535,#6A0DAD}. Slack constraints: max width 360px, PNG/JPG only, include alt text. Advisory only, never fail or block lessons.'
  };
  return prompts[agentName] || prompts.general_assistant;
}

function agentTutor(payload) {
  if (!isLessonTriggerActive()) return sendAutomatedMessageOnce(payload.user_id, 'lessons_paused', 'Lessons are currently paused.', null, '/help');
  const learner = getLearnerRecord(payload.user_id);
  if (!learner) {
    const workflowLink = PROPS.getProperty('WORKFLOW_ENROLL_LINK') || '';
    if (workflowLink) {
      return postDM(payload.user_id, "You're not enrolled yet. Click Enrol to get started.", [
        { type: 'section', text: { type: 'mrkdwn', text: "You're not enrolled yet. Click *Enrol* to get started." } },
        { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Enrol' }, url: workflowLink }] }
      ]);
    }
    return sendAutomatedMessageOnce(payload.user_id, "not_enrolled", "You're not enrolled yet.", null, "/help");
  }

  const lessonId = getCurrentLessonId(learner);
  if (!lessonId) return postDM(payload.user_id, 'You are up to date. No pending lesson in your current module.');

  const thread = getSlackThread(lessonId);
  if (!thread) return postDM(payload.user_id, 'No lesson found for ' + lessonId + '. Contact your administrator.');

  const blocks = buildLessonBlocks(thread['Slack Thread Text'], lessonId, payload.user_id, learner._rowIndex);
  return postDM(payload.user_id, 'Here is your next lesson.', blocks);
}

function agentQuizMaster(payload) {
  if (!isLessonTriggerActive()) return sendAutomatedMessageOnce(payload.user_id, 'lessons_paused', 'Lessons are currently paused.', null, '/help');
  const learner = getLearnerRecord(payload.user_id);
  if (!learner) {
    const workflowLink = PROPS.getProperty('WORKFLOW_ENROLL_LINK') || '';
    if (workflowLink) {
      return postDM(payload.user_id, "You're not enrolled yet. Click Enrol to get started.", [
        { type: 'section', text: { type: 'mrkdwn', text: "You're not enrolled yet. Click *Enrol* to get started." } },
        { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Enrol' }, url: workflowLink }] }
      ]);
    }
    return sendAutomatedMessageOnce(payload.user_id, "not_enrolled", "You're not enrolled yet.", null, "/help");
  }

  const txt = (payload.text || '').trim();
  const parts = txt.split(/\s+/);
  if (parts.length < 2) {
    return postDM(payload.user_id, 'Usage: /submit {lessonId} {your verification evidence}');
  }

  const lessonId = parts.shift();
  const evidence = parts.join(' ');
  const prompt = getSystemPrompt('quiz_master').replace('{lessonId}', lessonId);

  const aiText = callAI('quiz_master', prompt, 'Submission evidence:\n' + evidence, 300);
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

  const resultText = '*Lesson:* ' + lessonId + '\n*Score:* ' + score + '\n*Status:* ' + (passed ? 'Passed [done]' : 'Needs improvement');
  return postDM(payload.user_id, resultText + '\n\n' + feedback);
}

function agentProgress(payload) {
  if (!isLessonTriggerActive()) return sendAutomatedMessageOnce(payload.user_id, 'lessons_paused', 'Lessons are currently paused.', null, '/help');
  const learner = getLearnerRecord(payload.user_id);
  if (!learner) {
    const workflowLink = PROPS.getProperty('WORKFLOW_ENROLL_LINK') || '';
    if (workflowLink) {
      return postDM(payload.user_id, "You're not enrolled yet. Click Enrol to get started.", [
        { type: 'section', text: { type: 'mrkdwn', text: "You're not enrolled yet. Click *Enrol* to get started." } },
        { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Enrol' }, url: workflowLink }] }
      ]);
    }
    return sendAutomatedMessageOnce(payload.user_id, "not_enrolled", "You're not enrolled yet.", null, "/help");
  }

  const submissions = getLearnerSubmissions(payload.user_id);
  const moduleRow = getModuleRow(learner['Current Module']);
  const nextLessonId = getCurrentLessonId(learner) || '';
  const progressPayload = {
    name: learner['Name'] || learner['UserID'],
    current_module: learner['Current Module'] || '',
    lessons_completed: submissions.length,
    completion_percentage: Number(learner['Progress (%)'] || 0),
    next_lesson_id: nextLessonId
  };

  const aiText = callAI('progress_assistant', getSystemPrompt('progress_assistant'), JSON.stringify(progressPayload), 220);
  const blocks = buildProgressBlocks(learner, submissions, moduleRow);
  return postDM(payload.user_id, aiText, blocks);
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
  return postDM(payload.user_id, 'Enrolled <@' + userId + '> in ' + courseId + '.\n\nNext command: /learn');
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
  var rawTarget = String((payload.text || '').trim() || payload.user_id);
  var targetUser = resolveSlackUserId(rawTarget) || rawTarget;
  if (!/^U[A-Z0-9]+$/i.test(targetUser)) {
    return postDM(payload.user_id, 'Could not resolve user. Use /onboard @username or /onboard UXXXXXXXX.');
  }

  var info = getUserInfo(targetUser);
  if (!info) return postDM(payload.user_id, 'Unable to fetch Slack user profile.');

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var data = getAllRows(SHEET_LEARNERS);
    var idxUser = data.headers.indexOf('UserID');
    var idxName = data.headers.indexOf('Name');
    var idxEmail = data.headers.indexOf('Email');
    var idxCourse = data.headers.indexOf('Enrolled Course');
    var idxModule = data.headers.indexOf('Current Module');
    var idxProgress = data.headers.indexOf('Progress (%)');
    var idxStatus = data.headers.indexOf('Status');
    var idxJoined = data.headers.indexOf('Joined Date');
    var idxSubs = data.headers.indexOf('Lesson Submissions');

    var foundRow = -1;
    for (var i = 0; i < data.rows.length; i++) {
      if (String(data.rows[i][idxUser]) === String(targetUser)) {
        foundRow = i + 2;
        break;
      }
    }

    if (foundRow > 0) {
      data.sheet.getRange(foundRow, idxName + 1).setValue(info.name || '');
      data.sheet.getRange(foundRow, idxEmail + 1).setValue(info.email || '');
      data.sheet.getRange(foundRow, idxCourse + 1).setValue('COURSE_12M');
      data.sheet.getRange(foundRow, idxModule + 1).setValue('M0');
      data.sheet.getRange(foundRow, idxStatus + 1).setValue('Active');
    } else {
      var row = [];
      row[idxUser] = targetUser;
      row[idxName] = info.name || '';
      row[idxEmail] = info.email || '';
      row[idxCourse] = 'COURSE_12M';
      row[idxModule] = 'M0';
      row[idxProgress] = 0;
      row[idxStatus] = 'Active';
      row[idxJoined] = new Date();
      row[idxSubs] = '';
      var normalized = data.headers.map(function(_, idx) { return row[idx] == null ? '' : row[idx]; });
      data.sheet.appendRow(normalized);
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  var learner = getLearnerRecord(targetUser);
  var firstLesson = getFirstLessonIdForModule('M0') || getFirstReadyLessonIdForCourse('COURSE_12M');
  var orientationText = '*Welcome to RWR LMS Orientation (M0)*\nYou are now onboarded and enrolled in COURSE_12M.';
  postDM(targetUser, orientationText);

  if (firstLesson) {
    var thread = getSlackThread(firstLesson);
    if (thread) {
      var blocks = buildLessonBlocks(thread['Slack Thread Text'], firstLesson, targetUser, learner ? learner._rowIndex : 0);
      postDM(targetUser, 'Your first lesson is ready.', blocks);
    } else {
      postDM(targetUser, 'You are onboarded. First lesson ID: ' + firstLesson + '.');
    }
  }

  return postDM(payload.user_id, 'Onboard complete for <@' + targetUser + '> with M0 orientation and first lesson sent.\n\nNext command: /progress');
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

  const reportPayload = {
    learners: learners.map(function(l) {
      return {
        name: l['Name'] || l['UserID'],
        module: l['Current Module'] || '',
        lessons_completed: submissions.filter(function(s) { return String(s['Learner']) === String(l['UserID']); }).length,
        completion_percentage: Number(l['Progress (%)'] || 0)
      };
    })
  };

  const aiText = callAI('report_generator', getSystemPrompt('report_generator'), JSON.stringify(reportPayload), 500);
  return postDM(payload.user_id, aiText, buildReportBlocks(learners, submissions, modules));
}

function agentHelp(payload) {
  const admin = isAdmin(payload.user_id);
  const learnerCmds = [
    '/learn — Get your next lesson.',
    '/submit <lessonId> <evidence> — Submit proof of completion.',
    '/progress — View your completion progress.',
    '/courses — List available courses and your enrollment.',
    '/help — Show command help.'
  ];
  const adminCmds = [
    '/enrol <userId> — Enroll a learner (AU/NZ spelling).',
    '/unenrol <userId> — Remove enrollment (AU/NZ spelling).',
    '/onboard <userId> — Auto-enroll and send starter lesson.',
    '/offboard <userId> — Archive a learner.',
    '/report — Generate a cohort report.',
    '/gaps — Show learners who are behind.',
    '/backup — Create a backup of LMS sheets.',
    '/mix [topic] — Generate a learning mix.',
    '/media <lessonId> — Review media needs for a lesson.',
    '/cert — Check certification eligibility.',
    '/startlesson — Enable learner lesson commands.',
    '/stoplesson — Pause learner lesson commands.'
  ];
  let text = '*Available commands*\n' + learnerCmds.join('\n');
  if (admin) text += '\n\n*Admin commands*\n' + adminCmds.join('\n');
  return postDM(payload.user_id, text);
}

function agentCourses(payload) {
  if (!isLessonTriggerActive()) return sendAutomatedMessageOnce(payload.user_id, 'lessons_paused', 'Lessons are currently paused.', null, '/help');
  const learner = getLearnerRecord(payload.user_id);
  const data = getAllRows(SHEET_COURSES);
  const courses = data.rows.map(function(r) { return rowToObj(data.headers, r); });

  const payloadObj = {
    learner: learner ? { user_id: learner['UserID'], enrolled_course: learner['Enrolled Course'] } : null,
    courses: courses.map(function(c) {
      return {
        course_id: c['CourseID'],
        title: c['Course Title'],
        enrolled: learner && String(learner['Enrolled Course']) === String(c['CourseID'])
      };
    })
  };

  const aiText = callAI('courses_lister', getSystemPrompt('courses_lister'), JSON.stringify(payloadObj), 220);
  return postDM(payload.user_id, aiText);
}

function agentCert(payload) {
  if (!isLessonTriggerActive()) return sendAutomatedMessageOnce(payload.user_id, 'lessons_paused', 'Lessons are currently paused.', null, '/help');
  const learner = getLearnerRecord(payload.user_id);
  if (!learner) {
    const workflowLink = PROPS.getProperty('WORKFLOW_ENROLL_LINK') || '';
    if (workflowLink) {
      return postDM(payload.user_id, "You're not enrolled yet. Click Enrol to get started.", [
        { type: 'section', text: { type: 'mrkdwn', text: "You're not enrolled yet. Click *Enrol* to get started." } },
        { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Enrol' }, url: workflowLink }] }
      ]);
    }
    return sendAutomatedMessageOnce(payload.user_id, "not_enrolled", "You're not enrolled yet.", null, "/help");
  }

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

  const subs = getLearnerSubmissions(payload.user_id);
  const passedSet = {};
  subs.forEach(function(s) {
    if (Number(s['Score']) >= 60) {
      passedSet[String(s['Lesson'])] = true;
    }
  });

  const missing = required.filter(function(id) { return !passedSet[id]; });
  const certPayload = {
    name: learner['Name'] || learner['UserID'],
    current_module: moduleId,
    required_lessons: required.length,
    passed_lessons: required.length - missing.length,
    missing_lessons: missing,
    criteria: 'All lessons in the module at Ready status must be submitted with Score >= 60'
  };

  const aiText = callAI('cert_checker', getSystemPrompt('cert_checker'), JSON.stringify(certPayload), 180);
  return postDM(payload.user_id, aiText);
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

  const gapPayload = {
    median_completion: median,
    learners: learners.map(function(l) {
      const completed = countByLearner[l['UserID']] || 0;
      return {
        name: l['Name'] || l['UserID'],
        completion_count: completed,
        lessons_behind: Math.max(0, median - completed)
      };
    })
  };

  const aiText = callAI('gaps_analyser', getSystemPrompt('gaps_analyser'), JSON.stringify(gapPayload), 300);
  return postDM(payload.user_id, aiText);
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
    if (!query || hay.indexOf(query) !== -1) picks.push({ lesson_id: r[idxLesson], title: r[idxTitle], topic: r[idxTopic] });
    if (picks.length >= 12) break;
  }

  const aiText = callAI('mix_generator', getSystemPrompt('mix_generator'), JSON.stringify({ query: query, lessons: picks }), 240);
  return postDM(payload.user_id, aiText);
}


function agentMedia(payload) {
  try {
    const lessonId = String((payload.text || '').trim()).split(/\s+/)[0] || '';
    if (!lessonId) return postDM(payload.user_id, 'Usage: /media <lessonId>');

    const lesson = getLessonRow(lessonId);
    if (!lesson) return postDM(payload.user_id, 'Lesson not found: ' + lessonId);

    const mediaInput = {
      lesson_id: lessonId,
      title: lesson['Title'] || '',
      module: lesson['Module'] || '',
      objective: lesson['Objective'] || '',
      core_content: lesson['Core Content'] || '',
      mission_description: lesson['Mission Description'] || '',
      mission_format: lesson['Mission Format'] || '',
      verification_question: lesson['Verification Question'] || ''
    };

    const aiText = callAI('media_agent', getSystemPrompt('media_agent'), JSON.stringify(mediaInput), 700);

    let mediaRequired = false;
    let rationale = 'Media review complete.';
    let mediaBrief = null;
    let status = 'MEDIA_COMPLETE';

    try {
      const parsed = JSON.parse(aiText);
      mediaRequired = !!parsed.media_required;
      rationale = parsed.rationale || rationale;
      mediaBrief = parsed.media_brief || null;
      status = parsed.status || (mediaRequired ? 'MEDIA_BRIEF_READY' : 'MEDIA_COMPLETE');
    } catch (errParse) {
      Logger.log('agentMedia parse fallback: ' + errParse + ' | raw=' + aiText);
      rationale = 'Media agent output was not valid JSON; no sheet changes made.';
      return sendAutomatedMessageOnce(payload.user_id, 'media_parse_fallback', rationale + '\nRaw output:\n' + aiText, null, '/media <lessonId>');
    }

    const briefText = mediaRequired ? JSON.stringify(mediaBrief || {}, null, 2) : '';
    const updated = updateLessonMediaColumns(lessonId, mediaRequired, briefText);
    if (!updated) return postDM(payload.user_id, 'Unable to update lesson media columns for ' + lessonId);

    const summary = [
      '*Media Review:* ' + lessonId,
      '*Media Required:* ' + (mediaRequired ? 'TRUE' : 'FALSE'),
      '*Status:* ' + status,
      '*Rationale:* ' + rationale
    ].join('\n');

    return postDM(payload.user_id, summary + (mediaRequired ? ('\n\n*Media Brief*\n```' + briefText + '```') : ''));
  } catch (err) {
    Logger.log('agentMedia error: ' + err);
    return sendAutomatedMessageOnce(payload.user_id, 'media_failed', 'Media review failed. Please try again.', null, '/media <lessonId>');
  }
}


function upsertLearnerEnrollment(userId, courseId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const learners = getAllRows(SHEET_LEARNERS);
    const idxUser = learners.headers.indexOf('UserID');
    const idxName = learners.headers.indexOf('Name');
    const idxEmail = learners.headers.indexOf('Email');
    const idxCourse = learners.headers.indexOf('Enrolled Course');
    const idxCurrentModule = learners.headers.indexOf('Current Module');
    const idxProgress = learners.headers.indexOf('Progress (%)');
    const idxStatus = learners.headers.indexOf('Status');
    const idxJoined = learners.headers.indexOf('Joined Date');
    const idxSubmissions = learners.headers.indexOf('Lesson Submissions');

    for (let i = 0; i < learners.rows.length; i++) {
      if (String(learners.rows[i][idxUser]) === String(userId)) {
        const rowIndex = i + 2;
        learners.sheet.getRange(rowIndex, idxCourse + 1).setValue(courseId || 'COURSE_12M');
        learners.sheet.getRange(rowIndex, idxCurrentModule + 1).setValue(learners.rows[i][idxCurrentModule] || 'M01');
        learners.sheet.getRange(rowIndex, idxStatus + 1).setValue('Active');
        SpreadsheetApp.flush();
        return { created: false };
      }
    }

    const info = getUserInfo(userId) || { name: '', email: '' };
    const row = [];
    row[idxUser] = userId;
    row[idxName] = info.name || '';
    row[idxEmail] = info.email || '';
    row[idxCourse] = courseId || 'COURSE_12M';
    row[idxCurrentModule] = 'M01';
    row[idxProgress] = 0;
    row[idxStatus] = 'Active';
    row[idxJoined] = new Date();
    row[idxSubmissions] = '';

    const normalized = learners.headers.map(function(_, i) { return row[i] == null ? '' : row[i]; });
    learners.sheet.appendRow(normalized);
    SpreadsheetApp.flush();
    return { created: true };
  } catch (err) {
    Logger.log('upsertLearnerEnrollment error: ' + err);
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function handleWorkflowEnroll(payload) {
  try {
    const userId = payload && payload.user_id ? payload.user_id : '';
    const courseId = payload && payload.course_id ? payload.course_id : 'COURSE_12M';
    if (!userId) return;

    const result = upsertLearnerEnrollment(userId, courseId);
    const msg = result.created
      ? 'You are now enrolled in ' + courseId + '. Welcome to RWR LMS - use /learn to start.'
      : 'Your enrolment is active for ' + courseId + '. Use /learn to continue.';
    sendAutomatedMessageOnce(userId, 'workflow_enroll_' + courseId, msg, null, '/learn');
  } catch (err) {
    Logger.log('handleWorkflowEnroll error: ' + err);
  }
}


function agentStartLesson(payload) {
  setLessonTriggerActive(true);
  return postDM(payload.user_id, 'Lesson trigger is now ACTIVE. Users can access /learn and submit progress.');
}

function agentStopLesson(payload) {
  setLessonTriggerActive(false);
  return postDM(payload.user_id, 'Lesson trigger is now PAUSED. Learner lesson commands are temporarily disabled.');
}

function handleMention(event) {
  if (!event || event.bot_id || event.subtype === 'bot_message') return;
  const text = event.text || '';
  var reply = callAI('general_assistant', getSystemPrompt('general_assistant'), text, 250);
  if (reply && reply.indexOf('AI integrations are disabled') !== -1) {
    reply += '\n\nNext command: /help';
  }
  return postMessage(event.channel, reply, null);
}

function handleDirectMessage(event) {
  if (!event || event.bot_id || event.subtype === 'bot_message') return;
  const text = event.text || '';
  var reply = callAI('general_assistant', getSystemPrompt('general_assistant'), text, 250);
  if (reply && reply.indexOf('AI integrations are disabled') !== -1) {
    return sendAutomatedMessageOnce(event.user, 'ai_disabled_dm', reply, null, '/help');
  }
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
    return postDM(event.user, 'Recorded completion for ' + lessonId + ' [done]');
  } catch (err) {
    Logger.log('handleReaction error: ' + err);
  }
}
