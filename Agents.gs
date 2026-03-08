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
    'input_tokens≈' + inputTokens + ' | output_tokens≈' + outputTokens + ' | ' +
    'cost≈$' + cost.toFixed(6)
  );
}

function callClaude(systemPrompt, userMessage, maxTokens, agentName) {
  const inputWords = approxWords(systemPrompt) + approxWords(userMessage);
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
    if (!data.content || !data.content.length) {
      return 'I encountered an issue. Please try again in a moment.';
    }

    const output = data.content[0].text || 'I encountered an issue. Please try again in a moment.';
    logAIUsage('claude', agentName || 'unknown', inputWords, approxWords(output));
    return output;
  } catch (err) {
    Logger.log('callClaude error: ' + err);
    return 'I encountered an issue. Please try again in a moment.';
  }
}

function callGemini(systemPrompt, userMessage, maxTokens, agentName) {
  const inputWords = approxWords(systemPrompt) + approxWords(userMessage);
  try {
    const key = PROPS.getProperty('GEMINI_API_KEY');
    if (!key) {
      Logger.log('Gemini: missing GEMINI_API_KEY');
      return 'Service temporarily unavailable. Please try again shortly.';
    }

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(key);
    const payload = {
      system_instruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: userMessage }]
        }
      ],
      generationConfig: {
        maxOutputTokens: maxTokens || 1000,
        temperature: 0.4
      }
    };

    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    let response = UrlFetchApp.fetch(url, options);
    let responseCode = response.getResponseCode();

    if (responseCode === 429) {
      Logger.log('Gemini: rate limited. Waiting 2s and retrying once.');
      Utilities.sleep(2000);
      response = UrlFetchApp.fetch(url, options);
      responseCode = response.getResponseCode();
    }

    if (responseCode === 500 || responseCode === 503) {
      Logger.log('Gemini: transient server error ' + responseCode + '. Waiting 2s and retrying once.');
      Utilities.sleep(2000);
      response = UrlFetchApp.fetch(url, options);
      responseCode = response.getResponseCode();
    }

    if (responseCode !== 200) {
      const body = response.getContentText();
      Logger.log('Gemini HTTP ' + responseCode + ': ' + body);

      if (responseCode === 403) {
        return 'Service temporarily unavailable. Please try again shortly.';
      }
      if (responseCode === 400) {
        return 'I was unable to generate a response. Please try again.';
      }
      return 'I was unable to generate a response. Please try again.';
    }

    const data = JSON.parse(response.getContentText());
    if (!data.candidates || data.candidates.length === 0) {
      Logger.log('Gemini: no candidates returned. Finish reason: ' + JSON.stringify(data.promptFeedback));
      return 'I was unable to generate a response. Please try again.';
    }

    const finishReason = data.candidates[0].finishReason;
    if (finishReason === 'SAFETY') {
      Logger.log('Gemini: response blocked by safety filter');
      return 'I was unable to generate a response for that request.';
    }

    const output = (
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text
    ) || 'I was unable to generate a response. Please try again.';

    if (data.usageMetadata) {
      Logger.log('Gemini model=gemini-2.0-flash usage=' + JSON.stringify(data.usageMetadata));
    } else {
      Logger.log('Gemini model=gemini-2.0-flash usage=unavailable');
    }

    logAIUsage('gemini', agentName || 'unknown', inputWords, approxWords(output));
    return output;
  } catch (err) {
    Logger.log('callGemini error: ' + err);
    return 'I was unable to generate a response. Please try again.';
  }
}

function callAI(agentName, systemPrompt, userMessage, maxTokens) {
  const provider = getProvider(agentName);
  Logger.log('callAI: ' + agentName + ' → ' + provider);
  if (provider === 'gemini') {
    return callGemini(systemPrompt, userMessage, maxTokens, agentName);
  }
  return callClaude(systemPrompt, userMessage, maxTokens, agentName);
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
      'You are the RWR Group LMS progress assistant. You receive a JSON object containing a learner\'s name, current module, lessons completed, completion percentage, and next lesson ID. Generate a brief, friendly progress update message (under 120 words) formatted for Slack. Use bold for key stats. No emoji unless contextually appropriate. Tone: collegial peer, not corporate system. Brand voice: confident, people-first. Do not use the words: leverage, synergy, transformative, staff, human resources.',

    report_generator:
      'You are the RWR Group LMS admin reporting assistant. You receive JSON containing cohort data: learner names, modules enrolled, lessons completed, and completion percentages. Generate a structured Slack-formatted cohort summary. Lead with the headline stat (overall cohort completion %). Then list each learner\'s status in a compact format. Flag anyone below 50% completion. Keep the full report under 400 words. No markdown headers — use Slack bold (*text*) and separators (———) only. Do not use the words: leverage, synergy, transformative, staff, human resources.',

    gaps_analyser:
      'You are the RWR Group LMS gaps analyst. You receive JSON containing learner progress data and the module median completion rate. Identify learners who are more than 3 lessons behind the cohort median. For each, state their name, their completion count, how many lessons behind they are, and a one-line suggested action. Format for Slack. Keep each learner entry to 2 lines maximum. If no learners are behind, confirm the cohort is on track. Do not use the words: leverage, synergy, transformative, staff, human resources.',

    general_assistant:
      'You are the Agentic LMS assistant for RWR Group, a specialist recruitment training organisation operating across New Zealand and Australia. Your brands are RWR Health, Hospoworld, Retailworld, RWR Construction, and RWR Executive Search. Answer questions about the LMS, training programme, or recruitment practice concisely and practically. Keep responses under 200 words unless the question clearly requires more. Slack formatting only — no markdown headers. Brand voice: confident, people-first, forward-looking. Core positioning: "We don\'t recruit — we empower those who do." Do not use: leverage, synergy, transformative, staff, human resources.',

    cert_checker:
      'You are the RWR Group LMS certification checker. You receive JSON containing a learner\'s name, their current module completion data, and the certification criteria (all lessons in the module at Ready status must be submitted with Score ≥ 60). Evaluate eligibility and return a clear, brief Slack message (under 100 words) stating whether they are eligible, and if not, exactly what is outstanding. Be direct. No padding. Brand voice: confident, people-first. Do not use: leverage, synergy, transformative, staff, human resources.',

    courses_lister:
      'You are the RWR Group LMS course listing assistant. You receive JSON with available courses and enrolment status. Return a concise Slack-formatted summary showing each course and whether the learner is enrolled. Keep it practical, clear, and under 120 words. Brand voice: confident, people-first. Do not use: leverage, synergy, transformative, staff, human resources.',

    mix_generator:
      'You are the RWR Group LMS mix generator assistant. You receive JSON with optional topic query and candidate ready lessons. Produce a concise Slack-formatted learning mix recommendation and short rationale under 160 words. Brand voice: confident, people-first. Do not use: leverage, synergy, transformative, staff, human resources.'
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

  const resultText = '*Lesson:* ' + lessonId + '\n*Score:* ' + score + '\n*Status:* ' + (passed ? 'Passed ✅' : 'Needs improvement');
  return postDM(payload.user_id, resultText + '\n\n' + feedback);
}

function agentProgress(payload) {
  const learner = getLearnerRecord(payload.user_id);
  if (!learner) return postDM(payload.user_id, "You're not enrolled yet. Use /enroll to get started.");

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

function handleMention(event) {
  const text = event.text || '';
  const reply = callAI('general_assistant', getSystemPrompt('general_assistant'), text, 250);
  return postMessage(event.channel, reply, null);
}

function handleDirectMessage(event) {
  const text = event.text || '';
  const reply = callAI('general_assistant', getSystemPrompt('general_assistant'), text, 250);
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
