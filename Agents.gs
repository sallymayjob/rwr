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
  const response = 'Claude integration is not configured in this deployment. Falling back to command-driven LMS functions.';
  logAIUsage('claude', agentName || 'disabled', approxWords(systemPrompt) + approxWords(userMessage), approxWords(response));
  return response;
}

function callGemini(systemPrompt, userMessage, maxTokens, agentName, options) {
  const model = String(PROPS.getProperty('GEMINI_MODEL') || 'gemini-1.5-flash').trim();
  const apiKey = String(PROPS.getProperty('GEMINI_API_KEY') || '').trim();
  const disabled = String(PROPS.getProperty('AI_DISABLED') || 'false').toLowerCase() === 'true';
  const effectiveMax = Math.max(64, Number(maxTokens || 300));

  if (disabled || !apiKey) {
    const fallback = 'Gemini is not configured. Please use command-driven LMS functions.';
    logAIUsage('gemini', agentName || 'disabled', approxWords(systemPrompt) + approxWords(userMessage), approxWords(fallback));
    return fallback;
  }

  const gemKey = 'GEMINI_GEM_' + String(agentName || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const gemInstruction = String(PROPS.getProperty(gemKey) || '').trim();
  const finalSystemPrompt = gemInstruction ? (systemPrompt + '\n\nGem instruction:\n' + gemInstruction) : systemPrompt;

  try {
    const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
    const payload = {
      systemInstruction: { parts: [{ text: String(finalSystemPrompt || '') }] },
      contents: [
        {
          role: 'user',
          parts: [{ text: String(userMessage || '') }]
        }
      ],
      generationConfig: {
        maxOutputTokens: effectiveMax,
        temperature: 0.3
      }
    };

    if (options && options.responseMimeType) payload.generationConfig.responseMimeType = options.responseMimeType;
    if (options && options.responseSchema) payload.generationConfig.responseSchema = options.responseSchema;

    const res = UrlFetchApp.fetch(endpoint, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const status = res.getResponseCode();
    const txt = res.getContentText() || '{}';
    const data = JSON.parse(txt);
    if (status >= 300 || data.error) {
      throw new Error('Gemini API failed status=' + status + ' error=' + JSON.stringify(data.error || txt));
    }

    const out = (((data || {}).candidates || [])[0] || {}).content || {};
    const parts = out.parts || [];
    const response = parts.map(function(p) { return String((p && p.text) || ''); }).join('\n').trim();
    const finalText = response || 'No response generated.';
    logAIUsage('gemini', agentName || 'gemini', approxWords(finalSystemPrompt) + approxWords(userMessage), approxWords(finalText));
    return finalText;
  } catch (err) {
    Logger.log('callGemini error: ' + err);
    const fallback = 'I could not reach Gemini right now. Please retry shortly or continue with command-driven LMS functions.';
    logAIUsage('gemini', agentName || 'gemini_error', approxWords(finalSystemPrompt) + approxWords(userMessage), approxWords(fallback));
    return fallback;
  }
}

function callAI(agentName, systemPrompt, userMessage, maxTokens, options) {
  const provider = getProvider(agentName);
  if (provider === 'gemini') return callGemini(systemPrompt, userMessage, maxTokens, agentName, options);
  if (provider === 'claude') return callClaude(systemPrompt, userMessage, maxTokens, agentName);
  return callGemini(systemPrompt, userMessage, maxTokens, agentName, options);
}




function getMediaAgentResponseSchema_() {
  return {
    type: 'OBJECT',
    required: ['lesson_id', 'edited_content', 'change_log', 'compliance_flags'],
    properties: {
      lesson_id: { type: 'STRING' },
      edited_content: { type: 'STRING' },
      change_log: { type: 'ARRAY', items: { type: 'STRING' } },
      rationale: { type: 'STRING' },
      status: { type: 'STRING' },
      compliance_flags: {
        type: 'OBJECT',
        required: ['media_required', 'visual_clarity', 'framework_alignment', 'slack_ready', 'people_first_voice'],
        properties: {
          media_required: { type: 'BOOLEAN' },
          visual_clarity: { type: 'BOOLEAN' },
          framework_alignment: { type: 'BOOLEAN' },
          slack_ready: { type: 'BOOLEAN' },
          people_first_voice: { type: 'BOOLEAN' }
        }
      },
      media_brief: {
        type: 'OBJECT',
        nullable: true,
        properties: {
          asset_type: { type: 'STRING' },
          purpose: { type: 'STRING' },
          content: { type: 'STRING' },
          palette: { type: 'ARRAY', items: { type: 'STRING' } },
          design_notes: { type: 'STRING' },
          slack_constraints: { type: 'STRING' }
        }
      }
    }
  };
}

function validateMediaAgentResponse_(parsed, expectedLessonId) {
  const errors = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) errors.push('payload_not_object');
  if (!parsed || String(parsed.lesson_id || '').trim() === '') errors.push('missing_lesson_id');
  if (String(parsed.lesson_id || '') !== String(expectedLessonId || '')) errors.push('lesson_id_mismatch');
  if (!parsed || typeof parsed.edited_content !== 'string') errors.push('missing_edited_content');
  if (!parsed || !Array.isArray(parsed.change_log)) errors.push('missing_change_log_array');

  const flags = parsed && parsed.compliance_flags;
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) {
    errors.push('missing_compliance_flags');
  } else {
    ['media_required', 'visual_clarity', 'framework_alignment', 'slack_ready', 'people_first_voice'].forEach(function(key) {
      if (typeof flags[key] !== 'boolean') errors.push('invalid_flag_' + key);
    });
  }

  return { ok: errors.length === 0, errors: errors };
}

function computeComplianceScore(flags) {
  const table = {
    media_required: 20,
    visual_clarity: 20,
    framework_alignment: 20,
    slack_ready: 20,
    people_first_voice: 20
  };
  let score = 0;
  Object.keys(table).forEach(function(key) {
    if (flags && flags[key] === true) score += table[key];
  });
  return score;
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
      'Media Agent - RWR Slack LMS. Role: language analysis and compliance extraction coordinator. Analyze lesson text for media suitability and compliance flags only. Do not do arithmetic or score deductions in your response. Return strict JSON with required fields: lesson_id, edited_content, change_log, and compliance_flags (media_required, visual_clarity, framework_alignment, slack_ready, people_first_voice). If media is needed, include media_brief (asset_type, purpose, content, palette, design_notes, slack_constraints) and set status=MEDIA_BRIEF_READY. If not needed set media_required=false, media_brief=null, status=MEDIA_COMPLETE. Keep rationale concise and grounded in lesson language. Use RWR design language: rounded shapes, dot motif, minimal style, Poppins, people-first imagery, and palette {#000000,#FFFFFF,#0054FF,#F58220,#E63976,#3FA535,#6A0DAD}. Slack constraints: max width 360px, PNG/JPG only, include alt text. Advisory only, never fail or block lessons.'
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

  const result = postNextLessonForUser(payload.user_id);
  if (result && result.posted) return result;
  if (result && result.blocked) return postDM(payload.user_id, 'Next lesson is not available yet: ' + (result.reason || 'QA gate blocked delivery.'));
  return postDM(payload.user_id, 'You are up to date. No pending lesson.');
}

function agentQuizMaster(payload) {
  if (!isLessonTriggerActive()) return sendAutomatedMessageOnce(payload.user_id, 'lessons_paused', 'Lessons are currently paused.', null, '/help');
  const learner = getLearnerRecord(payload.user_id);
  if (!learner) return sendAutomatedMessageOnce(payload.user_id, 'not_enrolled', "You're not enrolled yet.", null, '/help');

  const txt = String(payload.text || '').trim();
  const parts = txt.split(/\s+/);
  if (parts.length < 2) return postDM(payload.user_id, 'Usage: /submit <submit_code> <evidence>');

  const submitCode = parts.shift();
  const evidence = parts.join(' ');
  const mission = getMissionBySubmitCode(submitCode);
  if (!mission) return postDM(payload.user_id, 'Submit Code not found in Missions: ' + submitCode);

  const lessonId = String(mission['LessonID'] || '').trim();
  const missionId = String(mission['MissionID'] || '').trim();
  if (!lessonId || !missionId) return postDM(payload.user_id, 'Mission mapping is incomplete for Submit Code: ' + submitCode);

  const prompt = getSystemPrompt('quiz_master').replace('{lessonId}', lessonId);
  const aiText = callAI('quiz_master', prompt, 'Mission: ' + missionId + '\nEvidence:\n' + evidence, 300);

  let score = evidence.length > 40 ? 70 : 45;
  let feedback = aiText;
  let passed = score >= 60;
  try {
    const parsed = JSON.parse(aiText);
    score = Number(parsed.score || score);
    feedback = parsed.feedback || aiText;
    passed = parsed.passed == null ? (score >= 60) : !!parsed.passed;
  } catch (err) {
    Logger.log('Quiz parse fallback: ' + err);
  }

  writeSubmission(lessonId, payload.user_id, score, 'slash_command', missionId, submitCode, evidence);
  updateLearnerProgress(payload.user_id, lessonId, missionId);

  const next = getNextLessonForLearner(payload.user_id);
  const nextLine = next ? ('\n*Next Lesson:* ' + next + ' (use /learn)') : '\n*Next Lesson:* You are up to date.';
  const resultText = '*Mission:* ' + missionId + '\n*Lesson:* ' + lessonId + '\n*Score:* ' + score + '\n*Status:* ' + (passed ? 'Passed [done]' : 'Needs improvement');
  return postDM(payload.user_id, resultText + nextLine + '\n\n' + feedback);
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
  const nextLessonId = getNextLessonForLearner(payload.user_id) || '';
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


function ensureLearnerColumnsForOnboarding_() {
  var sheet = SS.getSheetByName(SHEET_LEARNERS);
  if (!sheet) throw new Error('Missing sheet: ' + SHEET_LEARNERS);

  var required = ['UserID', 'Name', 'Email', 'Enrolled Course', 'Current Module', 'Progress (%)', 'Status', 'Joined Date', 'Lesson Submissions'];
  var lastCol = Math.max(1, sheet.getLastColumn());
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h || '').trim(); });
  var changed = false;

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

function resolveOnboardTargetUser_(rawTarget, fallbackUserId) {
  var input = String(rawTarget || '').trim();
  if (!input) return String(fallbackUserId || '').trim();

  var firstToken = input.split(/\s+/)[0] || input;
  var mentionMatch = firstToken.match(/^<@([UW][A-Z0-9]+)(?:\|[^>]+)?>$/i);
  if (mentionMatch) return mentionMatch[1];
  if (/^[UW][A-Z0-9]+$/i.test(firstToken)) return firstToken;

  var resolved = resolveSlackUserId(firstToken) || resolveSlackUserId(input);
  if (resolved) return resolved;

  return String(fallbackUserId || '').trim();
}

function agentOnboard(payload) {
  var rawTarget = String((payload.text || '').trim());
  var targetUser = resolveOnboardTargetUser_(rawTarget, payload.user_id);
  if (!/^[UW][A-Z0-9]+$/i.test(targetUser)) {
    return postDM(payload.user_id, 'Could not resolve user. Use /onboard @username or /onboard UXXXXXXXX.');
  }

  var info = getUserInfo(targetUser) || { name: '', email: '', lookup_error: 'users_info_failed' };
  if (info.lookup_error) {
    Logger.log('agentOnboard warning: users.info failed for ' + targetUser + ' with error=' + info.lookup_error);
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    ensureLearnerColumnsForOnboarding_();
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
      if (idxName >= 0) data.sheet.getRange(foundRow, idxName + 1).setValue(info.name || '');
      if (idxEmail >= 0) data.sheet.getRange(foundRow, idxEmail + 1).setValue(info.email || '');
      if (idxCourse >= 0) data.sheet.getRange(foundRow, idxCourse + 1).setValue('COURSE_12M');
      if (idxModule >= 0) data.sheet.getRange(foundRow, idxModule + 1).setValue('M0');
      if (idxStatus >= 0) data.sheet.getRange(foundRow, idxStatus + 1).setValue('Active');
    } else {
      var row = [];
      if (idxUser >= 0) row[idxUser] = targetUser;
      if (idxName >= 0) row[idxName] = info.name || '';
      if (idxEmail >= 0) row[idxEmail] = info.email || '';
      if (idxCourse >= 0) row[idxCourse] = 'COURSE_12M';
      if (idxModule >= 0) row[idxModule] = 'M0';
      if (idxProgress >= 0) row[idxProgress] = 0;
      if (idxStatus >= 0) row[idxStatus] = 'Active';
      if (idxJoined >= 0) row[idxJoined] = new Date();
      if (idxSubs >= 0) row[idxSubs] = '';
      var normalized = data.headers.map(function(_, idx) { return row[idx] == null ? '' : row[idx]; });
      data.sheet.appendRow(normalized);
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  var profileWarning = info.lookup_error ? '\n(Warning: profile lookup failed: ' + info.lookup_error + ')' : '';
  return postDM(payload.user_id, 'Onboard complete for <@' + targetUser + '>.' + profileWarning + '\n\nNext command: /learn');
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

function getSlackScopeDiagnostics_() {
  const requiredScopes = [
    'app_mentions:read',
    'channels:history',
    'chat:write',
    'commands',
    'im:history',
    'im:read',
    'im:write',
    'reactions:read',
    'users:read',
    'users:read.email'
  ];

  const token = String(PROPS.getProperty('SLACK_BOT_TOKEN') || '').trim();
  if (!token) {
    return {
      ok: false,
      requiredScopes: requiredScopes,
      configuredScopes: [],
      missingScopes: requiredScopes.slice(),
      detail: 'Missing SLACK_BOT_TOKEN.'
    };
  }

  try {
    const response = UrlFetchApp.fetch('https://slack.com/api/auth.test', {
      method: 'post',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) {
      return {
        ok: false,
        requiredScopes: requiredScopes,
        configuredScopes: [],
        missingScopes: requiredScopes.slice(),
        detail: 'auth.test HTTP ' + response.getResponseCode()
      };
    }

    const data = JSON.parse(response.getContentText() || '{}');
    if (!data.ok) {
      return {
        ok: false,
        requiredScopes: requiredScopes,
        configuredScopes: [],
        missingScopes: requiredScopes.slice(),
        detail: 'auth.test error: ' + String(data.error || 'unknown_error')
      };
    }

    const configuredScopes = String(data && data.response_metadata && data.response_metadata.scopes || '')
      .split(',')
      .map(function(s) { return String(s || '').trim(); })
      .filter(function(s) { return !!s; });

    if (!configuredScopes.length) {
      return {
        ok: false,
        requiredScopes: requiredScopes,
        configuredScopes: [],
        missingScopes: requiredScopes.slice(),
        detail: 'Unable to read token scopes from auth.test response.'
      };
    }

    const missingScopes = requiredScopes.filter(function(scope) { return configuredScopes.indexOf(scope) === -1; });
    return {
      ok: missingScopes.length === 0,
      requiredScopes: requiredScopes,
      configuredScopes: configuredScopes,
      missingScopes: missingScopes,
      detail: missingScopes.length ? ('Missing: ' + missingScopes.join(', ')) : 'Required scopes present.'
    };
  } catch (err) {
    return {
      ok: false,
      requiredScopes: requiredScopes,
      configuredScopes: [],
      missingScopes: requiredScopes.slice(),
      detail: 'Scope diagnostics error: ' + err
    };
  }
}

function agentHealth(payload) {
  const schema = validateRequiredSchema();
  const checks = [];
  const scopeDiag = getSlackScopeDiagnostics_();

  checks.push('*Schema:* ' + (schema.ok ? 'OK' : 'FAIL'));
  if (!schema.ok) {
    if (schema.missingSheets.length) checks.push('Missing sheets: ' + schema.missingSheets.join(', '));
    if (schema.missingColumns.length) checks.push('Missing columns: ' + schema.missingColumns.slice(0, 12).join(', ') + (schema.missingColumns.length > 12 ? ' ...' : ''));
  }

  checks.push('*Slack token:* ' + (PROPS.getProperty('SLACK_BOT_TOKEN') ? 'SET' : 'MISSING'));
  checks.push('*Signing secret:* ' + (PROPS.getProperty('SLACK_SIGNING_SECRET') ? 'SET' : 'MISSING'));
  checks.push('*Required scopes:* ' + (scopeDiag.ok ? 'OK' : 'MISSING/UNKNOWN'));
  checks.push('*Scopes detail:* ' + scopeDiag.detail);
  checks.push('*Sheets ID:* ' + (PROPS.getProperty('SHEETS_ID') ? 'SET' : 'MISSING'));
  checks.push('*Lesson trigger:* ' + (isLessonTriggerActive() ? 'ACTIVE' : 'PAUSED'));
  checks.push('*Token fallback auth:* DISABLED (enforced)');
  checks.push('*AI disabled:* ' + (String(PROPS.getProperty('AI_DISABLED') || 'false').toLowerCase() === 'true' ? 'YES' : 'NO'));

  const summary = '*LMS Health Check*\n' + checks.join('\n');
  return postDM(payload.user_id, summary);
}

function buildDeadLetterReport_() {
  const data = getAllRows(SHEET_QUEUE);
  const h = data.headers;
  const idxJobId = h.indexOf('job_id');
  const idxStatus = h.indexOf('status');
  const idxKind = h.indexOf('kind');
  const idxAttempt = h.indexOf('attempt_count');
  const idxMax = h.indexOf('max_attempts');
  const idxUser = h.indexOf('user_id');
  const idxErr = h.indexOf('last_error');
  const idxErrClass = h.indexOf('last_error_class');
  const idxCode = h.indexOf('last_provider_response_code');
  const idxFinished = h.indexOf('finished_at');
  const idxSnapshot = h.indexOf('dead_letter_error_json');

  const dead = [];
  for (let i = 0; i < data.rows.length; i++) {
    if (String(data.rows[i][idxStatus] || '').toUpperCase() !== 'DEAD') continue;
    dead.push({
      job_id: String(data.rows[i][idxJobId] || ''),
      kind: String(data.rows[i][idxKind] || ''),
      user_id: String(data.rows[i][idxUser] || ''),
      attempts: Number(data.rows[i][idxAttempt] || 0),
      max_attempts: Number(data.rows[i][idxMax] || 0),
      error_class: String(data.rows[i][idxErrClass] || 'UNKNOWN'),
      provider_response_code: idxCode >= 0 ? String(data.rows[i][idxCode] || '') : '',
      error: String(data.rows[i][idxErr] || ''),
      finished_at: String(data.rows[i][idxFinished] || ''),
      error_snapshot: idxSnapshot >= 0 ? String(data.rows[i][idxSnapshot] || '') : ''
    });
  }

  dead.sort(function(a, b) {
    return new Date(b.finished_at || 0).getTime() - new Date(a.finished_at || 0).getTime();
  });
  return dead;
}

function requeueDeadLetterJob_(jobId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const data = getAllRows(SHEET_QUEUE);
    const h = data.headers;
    const idxJobId = h.indexOf('job_id');
    const idxStatus = h.indexOf('status');
    const idxAttempt = h.indexOf('attempt_count');
    const idxNext = h.indexOf('next_attempt_at');
    const idxErr = h.indexOf('last_error');
    const idxErrClass = h.indexOf('last_error_class');
    const idxCode = h.indexOf('last_provider_response_code');
    const idxSnapshot = h.indexOf('dead_letter_error_json');

    for (let i = 0; i < data.rows.length; i++) {
      if (String(data.rows[i][idxJobId] || '') !== String(jobId || '')) continue;
      if (String(data.rows[i][idxStatus] || '').toUpperCase() !== 'DEAD') return { ok: false, message: 'Job is not in DEAD state.' };
      const row = i + 2;
      data.sheet.getRange(row, idxStatus + 1).setValue('PENDING');
      data.sheet.getRange(row, idxAttempt + 1).setValue(0);
      data.sheet.getRange(row, idxNext + 1).setValue(new Date());
      data.sheet.getRange(row, idxErr + 1).setValue('');
      if (idxErrClass >= 0) data.sheet.getRange(row, idxErrClass + 1).setValue('');
      if (idxCode >= 0) data.sheet.getRange(row, idxCode + 1).setValue('');
      if (idxSnapshot >= 0) data.sheet.getRange(row, idxSnapshot + 1).setValue('');
      appendAuditLog('QUEUE_DEADLETTER_REQUEUE', '', 'Queue', String(jobId), 'REQUEUED', {});
      return { ok: true, message: 'Job requeued.' };
    }
    return { ok: false, message: 'Job not found.' };
  } finally {
    lock.releaseLock();
  }
}

function agentDeadletter(payload) {
  const text = String(payload && payload.text || '').trim();
  const parts = text ? text.split(/\s+/) : [];
  const action = (parts[0] || 'report').toLowerCase();

  if (action === 'requeue') {
    const jobId = parts[1] || '';
    if (!jobId) return postDM(payload.user_id, 'Usage: /deadletter requeue <job_id>');
    const res = requeueDeadLetterJob_(jobId);
    if (res.ok) scheduleQueuedPipeline_();
    return postDM(payload.user_id, (res.ok ? '✅ ' : '❌ ') + res.message);
  }

  if (action === 'inspect') {
    const jobId = parts[1] || '';
    if (!jobId) return postDM(payload.user_id, 'Usage: /deadletter inspect <job_id>');
    const dead = buildDeadLetterReport_();
    const match = dead.filter(function(d) { return d.job_id === jobId; })[0];
    if (!match) return postDM(payload.user_id, 'Job not found in dead-letter queue: `' + jobId + '`.');
    return postDM(payload.user_id,
      '*Dead-letter inspect*\n' +
      'job_id: `' + match.job_id + '`\n' +
      'kind: ' + (match.kind || '-') + '\n' +
      'user: <@' + (match.user_id || '') + '>\n' +
      'attempts: ' + match.attempts + '/' + (match.max_attempts || '?') + '\n' +
      'error_class: ' + match.error_class + '\n' +
      'provider_response_code: ' + (match.provider_response_code || '-') + '\n' +
      'error: ' + (match.error || '-') + '\n' +
      'snapshot: ```' + (match.error_snapshot || '{}') + '```');
  }

  const dead = buildDeadLetterReport_();
  if (!dead.length) return postDM(payload.user_id, '*Dead-letter queue:* 0 jobs.');

  const lines = dead.slice(0, 20).map(function(d) {
    const code = d.provider_response_code ? (' code=' + d.provider_response_code) : '';
    return '• `' + d.job_id + '` kind=' + (d.kind || '?') + ' attempts=' + d.attempts + '/' + (d.max_attempts || '?') + ' class=' + d.error_class + code;
  });

  return postDM(payload.user_id,
    '*Dead-letter queue:* ' + dead.length + ' jobs\n' +
    lines.join('\n') +
    '\n\nUse `/deadletter inspect <job_id>` to view error snapshot or `/deadletter requeue <job_id>` to retry.');
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
    '/stoplesson — Pause learner lesson commands.',
    '/health — Show signing + scope diagnostics.',
    '/deadletter [report|inspect <job_id>|requeue <job_id>] — Review/requeue dead-letter jobs.'
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
  const lIdxModule = lessons.headers.indexOf('ModuleID');
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

    const aiText = callAI('media_agent', getSystemPrompt('media_agent'), JSON.stringify(mediaInput), 700, {
      responseMimeType: 'application/json',
      responseSchema: getMediaAgentResponseSchema_()
    });

    let parsed;
    try {
      parsed = JSON.parse(aiText);
    } catch (errParse) {
      Logger.log('agentMedia parse failure: ' + errParse + ' | raw=' + aiText);
      appendErrorLog('agentMedia', 'MEDIA_SCHEMA_PARSE_FAILED', String(errParse), { lesson_id: lessonId }, true);
      throw new Error('MEDIA_SCHEMA_PARSE_FAILED');
    }

    const validation = validateMediaAgentResponse_(parsed, lessonId);
    if (!validation.ok) {
      appendErrorLog('agentMedia', 'MEDIA_SCHEMA_INVALID', validation.errors.join(','), { lesson_id: lessonId, response: parsed }, true);
      throw new Error('MEDIA_SCHEMA_INVALID: ' + validation.errors.join(','));
    }

    const flags = parsed.compliance_flags;
    const mediaRequired = !!flags.media_required;
    const rationale = parsed.rationale || 'Media review complete.';
    const mediaBrief = parsed.media_brief || null;
    const status = parsed.status || (mediaRequired ? 'MEDIA_BRIEF_READY' : 'MEDIA_COMPLETE');

    const briefText = mediaRequired ? JSON.stringify(mediaBrief || {}, null, 2) : '';
    const updated = updateLessonMediaColumns(lessonId, mediaRequired, briefText);
    if (!updated) return postDM(payload.user_id, 'Unable to update lesson media columns for ' + lessonId);

    const complianceScore = computeComplianceScore(flags);
    upsertLessonMetricCompliance(lessonId, complianceScore, flags, payload.user_id || 'media_agent');

    const summary = [
      '*Media Review:* ' + lessonId,
      '*Media Required:* ' + (mediaRequired ? 'TRUE' : 'FALSE'),
      '*Compliance Score:* ' + complianceScore,
      '*Status:* ' + status,
      '*Rationale:* ' + rationale
    ].join('\n');

    return postDM(payload.user_id, summary + (mediaRequired ? ('\n\n*Media Brief*\n```' + briefText + '```') : ''));
  } catch (err) {
    Logger.log('agentMedia error: ' + err);
    appendErrorLog('agentMedia', 'MEDIA_REVIEW_FAILED', String(err), { user_id: payload.user_id || '' }, true);
    throw err;
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
    const channel = event.item && event.item.channel ? String(event.item.channel) : '';
    const ts = event.item && event.item.ts ? String(event.item.ts) : '';
    const delivery = findLessonDeliveryBySlackMessage(channel, ts);
    if (!delivery) return;

    const lessonId = String(delivery['LessonID'] || '');
    const submitCode = String(delivery['Submit Code'] || '');
    const mission = getMissionBySubmitCode(submitCode);
    const missionId = mission ? String(mission['MissionID'] || '') : '';

    writeSubmission(lessonId, event.user, '', 'reaction', missionId, submitCode, 'reaction:white_check_mark');
    updateLearnerProgress(event.user, lessonId, missionId);
    return postDM(event.user, 'Recorded completion for ' + lessonId + ' [done]');
  } catch (err) {
    Logger.log('handleReaction error: ' + err);
  }
}
