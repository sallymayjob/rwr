function doPost(e) {
  if (!e || !e.postData) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'Missing postData. Trigger doPost via HTTP POST, not editor Run.' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const rawBody = e.postData.contents || '';

  // Step 1 - attempt JSON parse (events and block_actions arrive as JSON)
  let body = {};
  try {
    body = JSON.parse(rawBody);
  } catch (err) {
    // Not JSON - likely a slash command (application/x-www-form-urlencoded)
    // body stays as {} and will be populated from e.parameter below
  }

  // Step 2 - URL verification challenge MUST come before signature validation
  // Slack sends this with no valid signature on first contact - this is intentional
  if (body.type === 'url_verification') {
    return ContentService
      .createTextOutput(body.challenge)
      .setMimeType(ContentService.MimeType.TEXT);
  }

  // Step 3 - validate Slack signature for all other request types
  if (!validateSlackRequest(e)) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'Invalid signature' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Step 4 - for slash commands, body is form-encoded - read from e.parameter
  const command = e.parameter && e.parameter.command;
  if (command) {
    const payload = {
      command: command,
      text: e.parameter.text || '',
      user_id: e.parameter.user_id,
      user_name: e.parameter.user_name,
      channel_id: e.parameter.channel_id,
      team_id: e.parameter.team_id,
      response_url: e.parameter.response_url
    };
    appendToQueue(payload.user_id, JSON.stringify({ kind: 'command', payload: payload }));
    scheduleQueuedPipeline_();
    return ContentService
      .createTextOutput(JSON.stringify({ response_type: 'ephemeral', text: '⏳ Queued. I will process this command shortly.' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Step 5 - Slack interactivity payloads (form-encoded payload JSON)
  var interactionPayload = null;
  if (e.parameter && e.parameter.payload) {
    try {
      interactionPayload = JSON.parse(e.parameter.payload);
    } catch (ignore) {
      interactionPayload = null;
    }
  }

  if (interactionPayload) {
    handleSlackInteraction(interactionPayload);
    return ContentService
      .createTextOutput(JSON.stringify({ response_action: 'clear' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Step 5b - block_actions arriving as JSON
  if (body.type === 'block_actions' || body.type === 'view_submission') {
    handleSlackInteraction(body);
    return ContentService
      .createTextOutput('')
      .setMimeType(ContentService.MimeType.TEXT);
  }

  // Step 6a - workflow builder enrollment webhook trigger
  const workflowPayload = extractWorkflowEnrollPayload(body, e.parameter || {});
  if (workflowPayload) {
    appendToQueue(workflowPayload.user_id, JSON.stringify({ kind: 'workflow_enroll', payload: workflowPayload }));
    scheduleQueuedPipeline_();
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, message: 'Enrollment queued' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Step 6 - event_callback (app_mention, message.im, reaction_added)
  if (body.type === 'event_callback') {
    const event = body.event;
    const userId = event && (event.user || event.item_user);
    if (event) {
      appendToQueue(userId || '', JSON.stringify({ kind: 'event', payload: event }));
      scheduleQueuedPipeline_();
    }
    return ContentService
      .createTextOutput('')
      .setMimeType(ContentService.MimeType.TEXT);
  }

  // Fallback - unknown request type
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}


function scheduleQueuedPipeline_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return;
  try {
    // Debounce trigger creation to avoid burst duplicate scheduling from concurrent webhooks.
    var now = Date.now();
    var notBefore = Number(PROPS.getProperty('QUEUE_TRIGGER_NOT_BEFORE_MS') || 0);
    if (notBefore && now < notBefore) return;

    // Always remove existing queue triggers first (including legacy recurring triggers),
    // then create exactly one one-shot trigger.
    clearQueuedPipelineTriggers_();

    ScriptApp.newTrigger('processQueuedPipeline')
      .timeBased()
      .after(15 * 1000)
      .create();

    PROPS.setProperty('QUEUE_TRIGGER_NOT_BEFORE_MS', String(now + 12000));
    Logger.log('Scheduled one-shot processQueuedPipeline trigger (~15s).');
  } catch (err) {
    Logger.log('scheduleQueuedPipeline_ error: ' + err);
  } finally {
    lock.releaseLock();
  }
}


function clearQueuedPipelineTriggers_() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) {
    if (t.getHandlerFunction && t.getHandlerFunction() === 'processQueuedPipeline') {
      ScriptApp.deleteTrigger(t);
    }
  });
}


function stopQueuedPipelineLoop() {
  clearQueuedPipelineTriggers_();
  PROPS.deleteProperty('QUEUE_TRIGGER_NOT_BEFORE_MS');
  Logger.log('All processQueuedPipeline triggers removed and debounce reset.');
}

function normalizeCommandText_(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function shouldSkipDuplicateCommand_(payload) {
  try {
    var cmd = String(payload && payload.command || '').trim();
    var user = String(payload && payload.user_id || '').trim();
    var text = normalizeCommandText_(payload && payload.text || '');
    if (!cmd || !user) return false;

    var key = 'CMD_DEDUPE_' + Utilities.base64EncodeWebSafe(cmd + '|' + user + '|' + text).replace(/=+$/,'');
    var now = Date.now();
    var ttlMs = Number(PROPS.getProperty('COMMAND_DEDUPE_TTL_MS') || 120000);
    var last = Number(PROPS.getProperty(key) || 0);

    if (last && (now - last) < ttlMs) {
      Logger.log('Skipping duplicate command ' + cmd + ' for user ' + user + ' within dedupe window.');
      return true;
    }

    PROPS.setProperty(key, String(now));
    return false;
  } catch (err) {
    Logger.log('shouldSkipDuplicateCommand_ error: ' + err);
    return false;
  }
}


function hasPendingQueueJobs_() {
  try {
    ensureQueueSheet();
    const data = getAllRows(SHEET_QUEUE);
    const idxStatus = data.headers.indexOf('Status');
    if (idxStatus === -1) return false;
    for (let i = 0; i < data.rows.length; i++) {
      const status = String(data.rows[i][idxStatus] || '').trim();
      if (status === 'PENDING' || status === 'RUNNING') return true;
    }
    return false;
  } catch (err) {
    Logger.log('hasPendingQueueJobs_ error: ' + err);
    return false;
  }
}

function processQueuedPipeline() {
  const start = Date.now();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    scheduleQueuedPipeline_();
    return;
  }

  const batchLimit = Number(PROPS.getProperty('QUEUE_BATCH_LIMIT') || 15);
  const maxRuntimeMs = Number(PROPS.getProperty('QUEUE_MAX_RUNTIME_MS') || 240000);

  try {
    ensureQueueSheet();
    const data = getAllRows(SHEET_QUEUE);
    const headers = data.headers;
    const rows = data.rows;
    const idxPayload = headers.indexOf('Payload_Json');
    const idxStatus = headers.indexOf('Status');

    if (idxPayload === -1 || idxStatus === -1) {
      throw new Error('Queue sheet headers are invalid. Expected Payload_Json and Status.');
    }

    const candidates = [];
    for (let i = 0; i < rows.length; i++) {
      const status = String(rows[i][idxStatus] || '').trim();
      if (status === 'PENDING') {
        candidates.push(i);
      }
      if (candidates.length >= batchLimit) break;
    }

    let processed = 0;
    for (let j = 0; j < candidates.length; j++) {
      if (Date.now() - start >= maxRuntimeMs) {
        Logger.log('processQueuedPipeline time budget reached; stopping early. processed=' + processed);
        break;
      }

      const rowIdx = candidates[j];
      const sheetRow = rowIdx + 2;

      // Mark RUNNING per row before work so stale work can be retried on next run.
      data.sheet.getRange(sheetRow, idxStatus + 1).setValue('RUNNING');

      try {
        const payloadJson = rows[rowIdx][idxPayload];
        const job = JSON.parse(payloadJson || '{}');

        if (job.kind === 'command') {
          if (shouldSkipDuplicateCommand_(job.payload)) {
            // Intentionally skip duplicate command to prevent repeated onboarding/posts.
          } else {
            routeCommand(job.payload);
          }
        } else if (job.kind === 'event') {
          routeEvent(job.payload);
        } else if (job.kind === 'workflow_enroll') {
          handleWorkflowEnroll(job.payload);
        } else if (job.kind === 'block_action') {
          const action = job.payload && job.payload.actions && job.payload.actions[0];
          if (action && action.value) {
            try {
              const value = JSON.parse(action.value);
              if (value.lesson_id && value.user_id) {
                writeSubmission(value.lesson_id, value.user_id, null, 'slash_command');
                updateLearnerProgress(value.user_id, value.lesson_id);
              }
            } catch (parseErr) {
              Logger.log('block_action parse error: ' + parseErr);
            }
          }
        } else {
          Logger.log('Unknown queue kind at row ' + sheetRow);
        }

        data.sheet.getRange(sheetRow, idxStatus + 1).setValue('DONE');
      } catch (errJob) {
        Logger.log('Queue row error ' + sheetRow + ': ' + errJob);
        data.sheet.getRange(sheetRow, idxStatus + 1).setValue('ERROR');
      }

      processed++;
    }

    SpreadsheetApp.flush();
    Logger.log('processQueuedPipeline completed in ' + (Date.now() - start) + 'ms, processed=' + processed + ', candidates=' + candidates.length);
  } catch (err) {
    Logger.log('processQueuedPipeline error: ' + err);
  } finally {
    try {
      if (hasPendingQueueJobs_()) {
        scheduleQueuedPipeline_();
      } else {
        clearQueuedPipelineTriggers_();
      }
    } catch (cleanupErr) {
      Logger.log('processQueuedPipeline cleanup error: ' + cleanupErr);
    }
    lock.releaseLock();
  }
}
function routeCommand(payload) {
  switch (payload.command) {
    case '/learn': return agentTutor(payload);
    case '/submit': return agentQuizMaster(payload);
    case '/progress': return agentProgress(payload);
    case '/enroll': return adminOnly(payload, function() { return agentEnroll(payload); });
    case '/enrol': return adminOnly(payload, function() { return agentEnroll(payload); });
    case '/unenroll': return adminOnly(payload, function() { return agentUnenroll(payload); });
    case '/unenrol': return adminOnly(payload, function() { return agentUnenroll(payload); });
    case '/onboard': return adminOnly(payload, function() { return agentOnboard(payload); });
    case '/offboard': return adminOnly(payload, function() { return agentOffboard(payload); });
    case '/report': return adminOnly(payload, function() { return agentReport(payload); });
    case '/gaps': return adminOnly(payload, function() { return agentGaps(payload); });
    case '/backup': return adminOnly(payload, function() { return agentBackup(payload); });
    case '/cert': return adminOnly(payload, function() { return agentCert(payload); });
    case '/courses': return agentCourses(payload);
    case '/help': return agentHelp(payload);
    case '/mix': return adminOnly(payload, function() { return agentMix(payload); });
    case '/media': return adminOnly(payload, function() { return agentMedia(payload); });
    case '/startlesson': return adminOnly(payload, function() { return agentStartLesson(payload); });
    case '/stoplesson': return adminOnly(payload, function() { return agentStopLesson(payload); });
    default: return postDM(payload.user_id, 'Unknown command.');
  }
}

function routeEvent(event) {
  if (!event) return;

  // Prevent bot/self-message loops from message.im subscriptions.
  if (event.bot_id || event.subtype === 'bot_message' || event.subtype === 'message_changed') {
    return;
  }

  switch (event.type) {
    case 'app_mention':
      return handleMention(event);
    case 'message':
      if (event.channel_type === 'im') return handleDirectMessage(event);
      return;
    case 'reaction_added':
      if (event.reaction === 'white_check_mark') return handleReaction(event);
      return;
    default:
      return;
  }
}

function startLessonTrigger() {
  setLessonTriggerActive(true);
  Logger.log('Lesson trigger started (manual mode).');
}

function stopLessonTrigger() {
  setLessonTriggerActive(false);
  Logger.log('Lesson trigger stopped (manual mode).');
}

function parseIncomingBody(raw, type) {
  let body = {};
  try {
    const txt = String(raw || '').trim();

    // Prefer JSON parsing when body looks like JSON, regardless of content type.
    if (txt && (txt[0] === '{' || txt[0] === '[')) {
      body = JSON.parse(txt);
      return body || {};
    }

    if (String(type || '').indexOf('application/json') !== -1) {
      body = JSON.parse(raw || '{}');
    } else {
      const parsed = parseFormEncoded(raw);
      if (parsed.payload) {
        try {
          body = JSON.parse(parsed.payload);
        } catch (err) {
          body = parsed;
        }
      } else {
        body = parsed;
      }
    }
  } catch (errOuter) {
    Logger.log('parseIncomingBody error: ' + errOuter);
    body = {};
  }
  return body || {};
}

function parseFormEncoded(raw) {
  const out = {};
  if (!raw) return out;
  raw.split('&').forEach(function(part) {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const key = decodeURIComponent(part.substring(0, idx).replace(/\+/g, ' '));
    const val = decodeURIComponent(part.substring(idx + 1).replace(/\+/g, ' '));
    out[key] = val;
  });
  return out;
}


function extractWorkflowEnrollPayload(body, params) {
  const b = body || {};
  const p = params || {};

  const userId =
    b.user_id ||
    (b.user && b.user.id) ||
    b.slack_user_id ||
    (b.trigger && b.trigger.user_id) ||
    p.user_id ||
    p.slack_user_id ||
    '';

  const action = String(b.workflow_trigger || b.action || p.workflow_trigger || p.action || '').toLowerCase();
  const source = String(b.source || p.source || '').toLowerCase();

  const looksLikeWorkflow = action === 'enroll' || source === 'workflow_builder' || !!b.workflow || !!p.workflow;
  if (!userId || !looksLikeWorkflow) return null;

  return {
    user_id: userId,
    course_id: b.course_id || p.course_id || 'COURSE_12M',
    source: 'workflow_builder'
  };
}
