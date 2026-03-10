function doPost(e) {
  if (!e || !e.postData) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'Missing postData. Trigger doPost via HTTP POST, not editor Run.' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const rawBody = e.postData.contents || '';
  const retryMeta = getSlackRetryMetadata_(e);

  // Step 1 - attempt JSON parse (events and block_actions arrive as JSON)
  let body = {};
  try {
    body = JSON.parse(rawBody);
  } catch (err) {
    // Not JSON - likely a slash command (application/x-www-form-urlencoded)
    // body stays as {} and will be populated from e.parameter below
  }

  // Step 2 - validate Slack signature for all request types.
  if (!validateSlackRequest(e)) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'Invalid signature' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Step 3 - URL verification challenge after signature validation
  if (body.type === 'url_verification') {
    return ContentService
      .createTextOutput(body.challenge)
      .setMimeType(ContentService.MimeType.TEXT);
  }

  // Step 3b - coarse request-level idempotency for Slack retries/replays.
  if (isDuplicateSlackRequest_(rawBody, e)) {
    logSlackDedupeAudit_('request', 'HIT', { dedupe_key: 'request_signature', retry: retryMeta });
    return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
  }
  logSlackDedupeAudit_('request', 'MISS', { dedupe_key: 'request_signature', retry: retryMeta });
  if (retryMeta.is_retry) {
    Logger.log('Slack retry metadata observed: ' + JSON.stringify(retryMeta));
  }

  // Step 4 - for slash commands, body is form-encoded - read from e.parameter
  const command = e.parameter && e.parameter.command;
  if (command) {
    try {
      const payload = {
        command: command,
        text: e.parameter.text || '',
        user_id: e.parameter.user_id,
        user_name: e.parameter.user_name,
        channel_id: e.parameter.channel_id,
        team_id: e.parameter.team_id,
        response_url: e.parameter.response_url
      };
      appendToQueue(payload.user_id, JSON.stringify({ kind: 'command', payload: payload }), {
        kind: 'command',
        source_event_id: retryMeta.signature || '',
        response_url: payload.response_url || ''
      });
      scheduleQueuedPipeline_();
      return ContentService
        .createTextOutput(JSON.stringify({ response_type: 'ephemeral', text: '⏳ Queued. I will process this command shortly.' }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (cmdErr) {
      Logger.log('doPost slash command queue error: ' + cmdErr);
      return ContentService
        .createTextOutput(JSON.stringify({ response_type: 'ephemeral', text: '⚠️ Command received but queue write failed. Please retry once.' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
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
    if (shouldShortCircuitSlackDedupe_({ body: body, interactionPayload: interactionPayload, retryMeta: retryMeta })) {
      return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
    }

    var interactionResult = handleSlackInteraction(interactionPayload) || {};
    if (interactionPayload.type === 'view_submission') {
      if (interactionResult.response_action === 'errors') {
        return ContentService
          .createTextOutput(JSON.stringify({ response_action: 'errors', errors: interactionResult.errors || {} }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      return ContentService
        .createTextOutput(JSON.stringify({ response_action: 'clear' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService
      .createTextOutput('')
      .setMimeType(ContentService.MimeType.TEXT);
  }

  // Step 5b - block_actions arriving as JSON
  if (body.type === 'block_actions' || body.type === 'view_submission' || body.type === 'shortcut' || body.type === 'message_action') {
    if (shouldShortCircuitSlackDedupe_({ body: body, interactionPayload: body, retryMeta: retryMeta })) {
      return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
    }

    var bodyResult = handleSlackInteraction(body) || {};
    if (body.type === 'view_submission') {
      if (bodyResult.response_action === 'errors') {
        return ContentService
          .createTextOutput(JSON.stringify({ response_action: 'errors', errors: bodyResult.errors || {} }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      return ContentService
        .createTextOutput(JSON.stringify({ response_action: 'clear' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService
      .createTextOutput('')
      .setMimeType(ContentService.MimeType.TEXT);
  }

  // Step 6a - workflow builder enrollment webhook trigger
  const workflowPayload = extractWorkflowEnrollPayload(body, e.parameter || {});
  if (workflowPayload) {
    if (shouldShortCircuitSlackDedupe_({ body: body, workflowPayload: workflowPayload, retryMeta: retryMeta })) {
      return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
    }

    appendToQueue(workflowPayload.user_id, JSON.stringify({ kind: 'workflow_enroll', payload: workflowPayload }), {
      kind: 'workflow_enroll',
      source_event_id: workflowPayload.trigger_id || retryMeta.signature || ''
    });
    scheduleQueuedPipeline_();
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, message: 'Enrollment queued' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Step 6 - event_callback (app_mention, message.im, reaction_added)
  if (body.type === 'event_callback') {
    if (shouldShortCircuitSlackDedupe_({ body: body, retryMeta: retryMeta })) {
      return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
    }

    const event = body.event;
    const userId = event && (event.user || event.item_user);
    if (event) {
      appendToQueue(userId || '', JSON.stringify({ kind: 'event', payload: event }), {
        kind: 'event',
        source_event_id: body.event_id || retryMeta.signature || ''
      });
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



function buildSlackDedupeKeyCandidates_(opts) {
  opts = opts || {};
  var body = opts.body || {};
  var interactionPayload = opts.interactionPayload || null;
  var workflowPayload = opts.workflowPayload || null;
  var keys = [];

  if (body && body.event_id) keys.push('event_id:' + String(body.event_id));

  var interaction = interactionPayload || body;
  if (interaction && typeof interaction === 'object') {
    if (interaction.trigger_id) keys.push('trigger_id:' + String(interaction.trigger_id));
    var containerTs = interaction.container && interaction.container.message_ts;
    if (containerTs) {
      var channel = (interaction.channel && interaction.channel.id) || (interaction.container && interaction.container.channel_id) || '';
      keys.push('interaction_msg:' + String(channel) + '|' + String(containerTs));
    }
  }

  if (workflowPayload && workflowPayload.user_id && workflowPayload.trigger_type) {
    keys.push('workflow:' + String(workflowPayload.trigger_type) + '|' + String(workflowPayload.user_id));
  }

  return keys.filter(function(k, idx, arr) { return k && arr.indexOf(k) === idx; });
}

function logSlackDedupeAudit_(entityId, outcome, details) {
  appendAuditLog('SLACK_DEDUPE', '', 'SlackWebhook', String(entityId || ''), String(outcome || ''), details || {});
}

function shouldShortCircuitSlackDedupe_(opts) {
  var keys = buildSlackDedupeKeyCandidates_(opts || {});
  var retryMeta = opts && opts.retryMeta || {};
  if (!keys.length) return false;

  var ttlSeconds = getSlackDedupeTtlSeconds_();
  for (var i = 0; i < keys.length; i++) {
    var dedupe = checkAndStoreDedupeKey_(keys[i], ttlSeconds, { retry: retryMeta });
    logSlackDedupeAudit_(keys[i], dedupe.duplicate ? 'HIT' : 'MISS', {
      dedupe_key: keys[i],
      ttl_seconds: ttlSeconds,
      retry_num: retryMeta.retry_num || '',
      retry_reason: retryMeta.retry_reason || '',
      is_retry: retryMeta.is_retry ? 'TRUE' : 'FALSE',
      lock_busy: dedupe.lockBusy ? 'TRUE' : 'FALSE'
    });

    if (dedupe.duplicate) {
      Logger.log('Slack dedupe hit key=' + keys[i] + ' retry=' + JSON.stringify(retryMeta));
      return true;
    }
  }

  if (retryMeta.is_retry) {
    Logger.log('Slack retry metadata observed (no dedupe hit): ' + JSON.stringify(retryMeta));
  }
  return false;
}


function scheduleQueuedPipeline_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(150)) return;
  try {
    // Keep slash-command ack path fast: do not wait on locks in webhook request path.
    var now = Date.now();
    var notBefore = Number(PROPS.getProperty('QUEUE_TRIGGER_NOT_BEFORE_MS') || 0);
    if (notBefore && now < notBefore) return;

    const triggers = ScriptApp.getProjectTriggers();
    const exists = triggers.some(function(t) {
      return t.getHandlerFunction && t.getHandlerFunction() === 'processQueuedPipeline';
    });

    if (!exists) {
      ScriptApp.newTrigger('processQueuedPipeline')
        .timeBased()
        .after(10 * 1000)
        .create();
      Logger.log('Scheduled one-shot processQueuedPipeline trigger (~10s).');
    }

    PROPS.setProperty('QUEUE_TRIGGER_NOT_BEFORE_MS', String(now + 8000));
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
    const idxStatus = data.headers.indexOf('status');
    const idxNextAttempt = data.headers.indexOf('next_attempt_at');
    if (idxStatus === -1 || idxNextAttempt === -1) return false;

    const now = Date.now();
    for (let i = 0; i < data.rows.length; i++) {
      const status = String(data.rows[i][idxStatus] || '').trim().toUpperCase();
      const nextAttemptAt = new Date(data.rows[i][idxNextAttempt] || 0).getTime() || 0;
      if (status === 'PENDING' && nextAttemptAt <= now) return true;
    }
    return false;
  } catch (err) {
    Logger.log('hasPendingQueueJobs_ error: ' + err);
    return false;
  }
}

function claimQueueJobs_(batchLimit) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return [];
  try {
    ensureQueueSheet();
    const data = getAllRows(SHEET_QUEUE);
    const headers = data.headers;
    const idxJobId = headers.indexOf('job_id');
    const idxStatus = headers.indexOf('status');
    const idxNextAttempt = headers.indexOf('next_attempt_at');
    const idxStarted = headers.indexOf('started_at');
    const idxPayload = headers.indexOf('payload_json');
    const idxAttempt = headers.indexOf('attempt_count');
    const idxUser = headers.indexOf('user_id');
    if (idxJobId === -1 || idxStatus === -1 || idxNextAttempt === -1 || idxStarted === -1 || idxPayload === -1) {
      throw new Error('Queue sheet headers invalid for claimQueueJobs_.');
    }

    const claimed = [];
    const now = Date.now();
    for (let i = 0; i < data.rows.length && claimed.length < batchLimit; i++) {
      const status = String(data.rows[i][idxStatus] || '').trim().toUpperCase();
      const nextAttemptAt = new Date(data.rows[i][idxNextAttempt] || 0).getTime() || 0;
      if (status !== 'PENDING' || nextAttemptAt > now) continue;

      const sheetRow = i + 2;
      data.sheet.getRange(sheetRow, idxStatus + 1).setValue('RUNNING');
      data.sheet.getRange(sheetRow, idxStarted + 1).setValue(new Date());
      claimed.push({
        row: sheetRow,
        job_id: String(data.rows[i][idxJobId] || ''),
        payload_json: String(data.rows[i][idxPayload] || '{}'),
        attempt_count: Number(data.rows[i][idxAttempt] || 0),
        user_id: idxUser >= 0 ? String(data.rows[i][idxUser] || '') : ''
      });
    }

    SpreadsheetApp.flush();
    return claimed;
  } finally {
    lock.releaseLock();
  }
}

function markQueueJobCompleted_(jobId, latencyMs, resultMeta) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return;
  try {
    const data = getAllRows(SHEET_QUEUE);
    const h = data.headers;
    const idxJobId = h.indexOf('job_id');
    const idxStatus = h.indexOf('status');
    const idxFinished = h.indexOf('finished_at');
    const idxLatency = h.indexOf('processing_latency_ms');
    const idxError = h.indexOf('last_error');
    const idxUser = h.indexOf('user_id');
    const idxKind = h.indexOf('kind');
    for (let i = 0; i < data.rows.length; i++) {
      if (String(data.rows[i][idxJobId] || '') !== String(jobId)) continue;
      const row = i + 2;
      data.sheet.getRange(row, idxStatus + 1).setValue('DONE');
      data.sheet.getRange(row, idxFinished + 1).setValue(new Date());
      data.sheet.getRange(row, idxLatency + 1).setValue(Number(latencyMs || 0));
      data.sheet.getRange(row, idxError + 1).setValue('');
      appendAuditLog('QUEUE_JOB_DONE', String(data.rows[i][idxUser] || ''), 'Queue', String(jobId), 'DONE', {
        kind: String(data.rows[i][idxKind] || ''),
        processing_latency_ms: Number(latencyMs || 0),
        meta: resultMeta || {}
      });
      break;
    }
  } finally {
    lock.releaseLock();
  }
}

function parseProviderResponseCode_(errText) {
  var msg = String(errText || '');
  var m = msg.match(/(?:status=|HTTP\s+|code=)(\d{3})/i);
  return m ? Number(m[1]) : '';
}

function classifyQueueError_(errText) {
  var message = String(errText || '').toLowerCase();
  var responseCode = parseProviderResponseCode_(errText);

  var isSchemaViolation = (
    message.indexOf('schema') !== -1 ||
    message.indexOf('missing sheet') !== -1 ||
    message.indexOf('missing column') !== -1 ||
    message.indexOf('sheet not found') !== -1 ||
    message.indexOf('invalid payload') !== -1 ||
    message.indexOf('json') !== -1 && message.indexOf('parse') !== -1
  );

  if (isSchemaViolation) {
    return { error_class: 'PERMANENT_SCHEMA', retryable: false, response_code: responseCode };
  }

  if (responseCode === 429 || (responseCode >= 500 && responseCode < 600)) {
    return { error_class: 'TRANSIENT_PROVIDER', retryable: true, response_code: responseCode };
  }

  if (message.indexOf('timeout') !== -1 || message.indexOf('timed out') !== -1 || message.indexOf('rate limit') !== -1) {
    return { error_class: 'TRANSIENT_NETWORK', retryable: true, response_code: responseCode };
  }

  if (responseCode >= 400 && responseCode < 500) {
    return { error_class: 'PERMANENT_CLIENT', retryable: false, response_code: responseCode };
  }

  return { error_class: 'UNKNOWN', retryable: true, response_code: responseCode };
}

function computeRetryBackoffMs_(attemptCount) {
  var baseMs = Number(PROPS.getProperty('QUEUE_BACKOFF_BASE_MS') || 1000);
  var maxMs = Number(PROPS.getProperty('QUEUE_BACKOFF_MAX_MS') || (10 * 60 * 1000));
  var jitterMs = Number(PROPS.getProperty('QUEUE_BACKOFF_JITTER_MS') || 750);
  var expMs = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, Number(attemptCount || 0) - 1)));
  var jitter = Math.floor(Math.random() * Math.max(1, jitterMs));
  return expMs + jitter;
}

function logQueueAttempt_(job, attemptNo, errText, classification) {
  var payload = {};
  try {
    payload = JSON.parse(String(job && job.payload_json || '{}'));
  } catch (ignore) {
    payload = {};
  }

  appendAuditLog('QUEUE_JOB_ATTEMPT', String(job && job.user_id || ''), 'Queue', String(job && job.job_id || ''), classification.retryable ? 'RETRY' : 'FAILED', {
    attempt: Number(attemptNo || 0),
    timestamp: new Date().toISOString(),
    kind: String(payload.kind || ''),
    error_class: String(classification.error_class || 'UNKNOWN'),
    provider_response_code: classification.response_code === '' ? '' : Number(classification.response_code),
    error: String(errText || '')
  });
}

function markQueueJobFailed_(job, errText, maxAttempts, startedAtMs, classification) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return;
  try {
    const data = getAllRows(SHEET_QUEUE);
    const h = data.headers;
    const idxJobId = h.indexOf('job_id');
    const idxStatus = h.indexOf('status');
    const idxAttempt = h.indexOf('attempt_count');
    const idxMaxAttempts = h.indexOf('max_attempts');
    const idxError = h.indexOf('last_error');
    const idxErrorClass = h.indexOf('last_error_class');
    const idxResponseCode = h.indexOf('last_provider_response_code');
    const idxNext = h.indexOf('next_attempt_at');
    const idxFinished = h.indexOf('finished_at');
    const idxLatency = h.indexOf('processing_latency_ms');
    const idxSnapshot = h.indexOf('dead_letter_error_json');
    const idxLastAttempt = h.indexOf('last_attempt_at');

    for (let i = 0; i < data.rows.length; i++) {
      if (String(data.rows[i][idxJobId] || '') !== String(job.job_id)) continue;
      const row = i + 2;
      const nextAttempt = Number(data.rows[i][idxAttempt] || 0) + 1;
      const rowMaxAttempts = Number(data.rows[i][idxMaxAttempts] || maxAttempts || 3) || 3;
      const retryable = classification && classification.retryable !== false;
      const isDead = !retryable || nextAttempt >= rowMaxAttempts;
      const backoffMs = computeRetryBackoffMs_(nextAttempt);

      data.sheet.getRange(row, idxAttempt + 1).setValue(nextAttempt);
      if (idxLastAttempt >= 0) data.sheet.getRange(row, idxLastAttempt + 1).setValue(new Date());
      data.sheet.getRange(row, idxError + 1).setValue(String(errText || 'Unknown queue job error'));
      if (idxErrorClass >= 0) data.sheet.getRange(row, idxErrorClass + 1).setValue(String(classification && classification.error_class || 'UNKNOWN'));
      if (idxResponseCode >= 0) data.sheet.getRange(row, idxResponseCode + 1).setValue(classification && classification.response_code !== '' ? Number(classification.response_code) : '');
      data.sheet.getRange(row, idxStatus + 1).setValue(isDead ? 'DEAD' : 'PENDING');
      data.sheet.getRange(row, idxNext + 1).setValue(new Date(Date.now() + backoffMs));
      data.sheet.getRange(row, idxFinished + 1).setValue(new Date());
      data.sheet.getRange(row, idxLatency + 1).setValue(Math.max(0, Date.now() - Number(startedAtMs || Date.now())));
      if (isDead && idxSnapshot >= 0) {
        data.sheet.getRange(row, idxSnapshot + 1).setValue(JSON.stringify({
          failed_at: new Date().toISOString(),
          job_id: String(job.job_id || ''),
          attempts: nextAttempt,
          max_attempts: rowMaxAttempts,
          error_class: String(classification && classification.error_class || 'UNKNOWN'),
          provider_response_code: classification && classification.response_code !== '' ? Number(classification.response_code) : null,
          error: String(errText || ''),
          payload_json: String(job.payload_json || '{}')
        }));
      }

      appendErrorLog('processQueuedPipeline', String(classification && classification.error_class || 'QUEUE_JOB_ERROR'), String(errText), {
        job_id: String(job.job_id || ''),
        attempt: nextAttempt,
        max_attempts: rowMaxAttempts,
        provider_response_code: classification && classification.response_code !== '' ? Number(classification.response_code) : '',
        next_attempt_at: new Date(Date.now() + backoffMs),
        status: isDead ? 'DEAD' : 'PENDING'
      }, !isDead);
      break;
    }
  } finally {
    lock.releaseLock();
  }
}

function notifyQueueJobResult_(job, ok, message) {
  try {
    const payload = JSON.parse(String(job.payload_json || '{}'));
    const body = payload.payload || {};
    const responseUrl = String((body && body.response_url) || '').trim();
    if (!responseUrl) return;

    const text = ok ? ('✅ ' + (body.command || 'Request') + ' processed.') : ('❌ ' + (body.command || 'Request') + ' failed: ' + String(message || 'Unknown error'));
    postToResponseUrl(responseUrl, { response_type: 'ephemeral', text: text });
  } catch (err) {
    Logger.log('notifyQueueJobResult_ error: ' + err);
  }
}

function processQueuedPipeline() {
  const start = Date.now();
  const batchLimit = Number(PROPS.getProperty('QUEUE_BATCH_LIMIT') || 15);
  const maxRuntimeMs = Number(PROPS.getProperty('QUEUE_MAX_RUNTIME_MS') || 240000);
  const maxAttempts = Number(PROPS.getProperty('QUEUE_MAX_ATTEMPTS') || PROPS.getProperty('QUEUE_MAX_RETRIES') || 3);

  try {
    const claimed = claimQueueJobs_(batchLimit);
    let processed = 0;

    for (let j = 0; j < claimed.length; j++) {
      if (Date.now() - start >= maxRuntimeMs) {
        Logger.log('processQueuedPipeline time budget reached; stopping early. processed=' + processed);
        break;
      }

      const job = claimed[j];
      const jobStart = Date.now();
      const attemptNo = Number(job.attempt_count || 0) + 1;
      try {
        const envelope = JSON.parse(job.payload_json || '{}');
        appendAuditLog('QUEUE_JOB_ATTEMPT', String(job.user_id || ''), 'Queue', String(job.job_id || ''), 'START', {
          attempt: attemptNo,
          timestamp: new Date().toISOString(),
          kind: String(envelope.kind || ''),
          error_class: 'NONE',
          provider_response_code: ''
        });

        if (envelope.kind === 'command') {
          if (!shouldSkipDuplicateCommand_(envelope.payload)) routeCommand(envelope.payload);
        } else if (envelope.kind === 'event') {
          routeEvent(envelope.payload);
        } else if (envelope.kind === 'workflow_enroll') {
          handleWorkflowEnroll(envelope.payload);
        } else if (envelope.kind === 'block_action') {
          const action = envelope.payload && envelope.payload.actions && envelope.payload.actions[0];
          if (action && action.value) {
            const value = JSON.parse(action.value);
            if (value.lesson_id && value.user_id) {
              var delivery = getLessonDeliveryRow(value.lesson_id);
              var submitCode = delivery ? String(delivery['Submit Code'] || '') : '';
              var mission = getMissionBySubmitCode(submitCode);
              var missionId = mission ? String(mission['MissionID'] || '') : '';
              writeSubmission(value.lesson_id, value.user_id, '', 'block_action', missionId, submitCode, 'button_mark_complete');
              updateLearnerProgress(value.user_id, value.lesson_id, missionId);
            }
          }
        } else {
          Logger.log('Unknown queue kind for job ' + job.job_id);
        }

        const latencyMs = Date.now() - jobStart;
        markQueueJobCompleted_(job.job_id, latencyMs, { kind: envelope.kind || '' });
        appendAuditLog('QUEUE_JOB_ATTEMPT', String(job.user_id || ''), 'Queue', String(job.job_id || ''), 'SUCCESS', {
          attempt: attemptNo,
          timestamp: new Date().toISOString(),
          kind: String(envelope.kind || ''),
          error_class: 'NONE',
          provider_response_code: ''
        });
        if (envelope.kind === 'command') notifyQueueJobResult_(job, true, '');
      } catch (errJob) {
        Logger.log('Queue job error ' + job.job_id + ': ' + errJob);
        const errText = String(errJob);
        const classification = classifyQueueError_(errText);
        logQueueAttempt_(job, attemptNo, errText, classification);
        markQueueJobFailed_(job, errText, maxAttempts, jobStart, classification);
        notifyQueueJobResult_(job, false, errJob);
      }
      processed++;
    }

    Logger.log('processQueuedPipeline completed in ' + (Date.now() - start) + 'ms, processed=' + processed + ', claimed=' + claimed.length);
  } catch (err) {
    Logger.log('processQueuedPipeline error: ' + err);
  } finally {
    try {
      if (hasPendingQueueJobs_()) {
        scheduleQueuedPipeline_();
      } else {
        clearQueuedPipelineTriggers_();
        PROPS.deleteProperty('QUEUE_TRIGGER_NOT_BEFORE_MS');
      }

      var lastPruneMs = Number(PROPS.getProperty('QUEUE_LAST_PRUNE_MS') || 0);
      var pruneIntervalMs = Number(PROPS.getProperty('QUEUE_PRUNE_INTERVAL_MS') || (60 * 60 * 1000));
      if ((Date.now() - lastPruneMs) >= pruneIntervalMs) {
        pruneQueueRows_();
        PROPS.setProperty('QUEUE_LAST_PRUNE_MS', String(Date.now()));
      }
    } catch (cleanupErr) {
      Logger.log('processQueuedPipeline cleanup error: ' + cleanupErr);
    }
  }
}


function commandRequiresSchemaWriteGuard_(command, text) {
  const cmd = String(command || '').toLowerCase();
  if (cmd === '/submit' || cmd === '/enroll' || cmd === '/enrol' || cmd === '/unenroll' || cmd === '/unenrol' || cmd === '/onboard' || cmd === '/offboard') return true;
  if (cmd === '/deadletter') {
    const action = String(text || '').trim().split(/\s+/)[0].toLowerCase();
    return action === 'requeue';
  }
  return false;
}

function routeCommand(payload) {
  var commandName = String(payload && payload.command || '').trim();
  var commandCorr = String((payload && payload.trigger_id) || (payload && payload.response_url) || (payload && payload.user_id) || '').trim();
  setSlackCallContext('command:' + commandName, commandCorr);
  try {
    if (commandRequiresSchemaWriteGuard_(payload.command, payload.text)) {
      assertSchemaValidForWrite_('command ' + payload.command);
    }
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
    case '/health': return adminOnly(payload, function() { return agentHealth(payload); });
    case '/schema': return adminOnly(payload, function() { return agentSchema(payload); });
    case '/deadletter': return adminOnly(payload, function() { return agentDeadletter(payload); });
    case '/cert': return adminOnly(payload, function() { return agentCert(payload); });
    case '/courses': return agentCourses(payload);
    case '/help': return agentHelp(payload);
    case '/mix': return adminOnly(payload, function() { return agentMix(payload); });
    case '/media': return adminOnly(payload, function() { return agentMedia(payload); });
    case '/startlesson': return adminOnly(payload, function() { return agentStartLesson(payload); });
    case '/stoplesson': return adminOnly(payload, function() { return agentStopLesson(payload); });
    default: return postDM(payload.user_id, 'Unknown command.');
    }
  } finally {
    clearSlackCallContext();
  }
}

function routeEvent(event) {
  if (!event) return;

  var eventType = String(event.type || '').trim();
  var eventCorr = String(event.event_ts || event.client_msg_id || event.ts || '').trim();
  setSlackCallContext('event:' + eventType, eventCorr);
  try {
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
  } finally {
    clearSlackCallContext();
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
