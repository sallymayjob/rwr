function doPost(e) {
  if (!validateSlackRequest(e)) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'Invalid signature' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const raw = e.postData && e.postData.contents ? e.postData.contents : '';
  const type = (e.postData && e.postData.type) ? e.postData.type : '';

  let body = {};
  if (type.indexOf('application/json') !== -1) {
    body = JSON.parse(raw || '{}');
  } else {
    const parsed = parseFormEncoded(raw);
    if (parsed.payload) {
      try { body = JSON.parse(parsed.payload); } catch (err) { body = parsed; }
    } else {
      body = parsed;
    }
  }

  if (body.type === 'url_verification') {
    return ContentService.createTextOutput(body.challenge || '');
  }

  let queuePayload = {};
  let userId = '';

  if (body.command) {
    queuePayload = { kind: 'command', payload: body };
    userId = body.user_id || '';
  } else if (body.event) {
    queuePayload = { kind: 'event', payload: body.event };
    userId = body.event.user || body.event.bot_id || '';
  } else {
    queuePayload = { kind: 'unknown', payload: body };
  }

  appendToQueue(userId, JSON.stringify(queuePayload));

  // Immediate worker run can reduce latency; time-based trigger remains the primary mechanism.
  try { processQueuedPipeline(); } catch (err) { Logger.log('Inline queue process skipped: ' + err); }

  if (body.command) {
    return ContentService
      .createTextOutput(JSON.stringify({ response_type: 'in_channel', text: '⏳ On it...' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
}

function processQueuedPipeline() {
  const start = Date.now();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;

  try {
    const data = getAllRows(SHEET_QUEUE);
    const headers = data.headers;
    const rows = data.rows;
    const idxPayload = headers.indexOf('Payload_Json');
    const idxStatus = headers.indexOf('Status');

    const writeback = [];
    const toRun = [];
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][idxStatus]) === 'PENDING') {
        rows[i][idxStatus] = 'RUNNING';
        toRun.push(i);
      }
    }

    for (let j = 0; j < toRun.length; j++) {
      const rowIdx = toRun[j];
      try {
        const payloadJson = rows[rowIdx][idxPayload];
        const job = JSON.parse(payloadJson || '{}');

        if (job.kind === 'command') {
          routeCommand(job.payload);
        } else if (job.kind === 'event') {
          routeEvent(job.payload);
        } else {
          Logger.log('Unknown queue kind at row ' + (rowIdx + 2));
        }

        rows[rowIdx][idxStatus] = 'DONE';
      } catch (errJob) {
        Logger.log('Queue row error ' + (rowIdx + 2) + ': ' + errJob);
        rows[rowIdx][idxStatus] = 'ERROR';
      }
    }

    if (rows.length) {
      data.sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    }

    SpreadsheetApp.flush();
    Logger.log('processQueuedPipeline completed in ' + (Date.now() - start) + 'ms, jobs=' + toRun.length);
  } catch (err) {
    Logger.log('processQueuedPipeline error: ' + err);
  } finally {
    lock.releaseLock();
  }
}

function routeCommand(payload) {
  switch (payload.command) {
    case '/learn': return agentTutor(payload);
    case '/submit': return agentQuizMaster(payload);
    case '/progress': return agentProgress(payload);
    case '/enroll': return adminOnly(payload, function() { return agentEnroll(payload); });
    case '/unenroll': return adminOnly(payload, function() { return agentUnenroll(payload); });
    case '/onboard': return adminOnly(payload, function() { return agentOnboard(payload); });
    case '/offboard': return adminOnly(payload, function() { return agentOffboard(payload); });
    case '/report': return adminOnly(payload, function() { return agentReport(payload); });
    case '/gaps': return adminOnly(payload, function() { return agentGaps(payload); });
    case '/backup': return adminOnly(payload, function() { return agentBackup(payload); });
    case '/cert': return agentCert(payload);
    case '/courses': return agentCourses(payload);
    case '/help': return agentHelp(payload);
    case '/mix': return adminOnly(payload, function() { return agentMix(payload); });
    default: return postDM(payload.user_id, 'Unknown command.');
  }
}

function routeEvent(event) {
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

function setupTrigger() {
  ScriptApp.newTrigger('processQueuedPipeline')
    .timeBased()
    .everyMinutes(1)
    .create();
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
