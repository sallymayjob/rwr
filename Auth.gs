function validateSlackRequest(e) {
  try {
    if (!e || !e.postData || typeof e.postData.contents !== 'string') return false;
    const rawBody = e.postData.contents;
    const signingSecret = PROPS.getProperty('SLACK_SIGNING_SECRET') || '';

    const timestamp = getHeaderValue(e, ['X-Slack-Request-Timestamp', 'x-slack-request-timestamp']);
    const slackSignature = getHeaderValue(e, ['X-Slack-Signature', 'x-slack-signature']);

    if (timestamp && slackSignature && signingSecret) {
      const tsNum = Number(timestamp);
      const now = Math.floor(Date.now() / 1000);
      if (!tsNum || Math.abs(now - tsNum) > 300) {
        Logger.log('validateSlackRequest rejected: stale or invalid timestamp.');
        return false;
      }

      const baseString = 'v0:' + timestamp + ':' + rawBody;
      const bytes = Utilities.computeHmacSha256Signature(baseString, signingSecret);
      const hex = bytes.map(function(b) {
        const v = (b < 0 ? b + 256 : b).toString(16);
        return v.length === 1 ? '0' + v : v;
      }).join('');
      const expected = 'v0=' + hex;
      const valid = constantTimeEqual(expected, String(slackSignature || '').trim());
      if (!valid) Logger.log('validateSlackRequest rejected: signature mismatch.');
      return valid;
    }

    if (!isSlackTokenFallbackEnabled_()) {
      Logger.log('validateSlackRequest rejected: missing signature headers or signing secret, and token fallback is disabled.');
      return false;
    }

    const configuredToken = String(PROPS.getProperty('SLACK_VERIFICATION_TOKEN') || '').trim();
    const requestToken = extractSlackVerificationToken_(rawBody, e);

    if (configuredToken && requestToken) {
      const ok = constantTimeEqual(String(configuredToken), String(requestToken));
      if (ok) {
        Logger.log('WARNING: validateSlackRequest accepted request using verification token fallback.');
      }
      return ok;
    }

    Logger.log('validateSlackRequest rejected: token fallback enabled but token missing or invalid.');
    return false;
  } catch (err) {
    Logger.log('validateSlackRequest error: ' + err);
    return false;
  }
}

function isSlackTokenFallbackEnabled_() {
  return String(PROPS.getProperty('SLACK_AUTH_TOKEN_FALLBACK') || 'false').toLowerCase() === 'true';
}

function markSlackRequestSeen_(key, ttlSeconds) {
  try {
    var cache = CacheService.getScriptCache();
    if (cache.get(key)) return true;
    cache.put(key, '1', Number(ttlSeconds || 600));
    return false;
  } catch (err) {
    Logger.log('markSlackRequestSeen_ error: ' + err);
    return false;
  }
}

function isDuplicateSlackRequest_(rawBody, e) {
  var ts = getHeaderValue(e, ['X-Slack-Request-Timestamp', 'x-slack-request-timestamp']) || '';
  var sig = getHeaderValue(e, ['X-Slack-Signature', 'x-slack-signature']) || '';
  var key = 'slack:req:' + Utilities.base64EncodeWebSafe(ts + '|' + sig + '|' + String(rawBody || '')).replace(/=+$/,'');
  return markSlackRequestSeen_(key, 600);
}

function isDuplicateSlackEventId_(eventId) {
  var id = String(eventId || '').trim();
  if (!id) return false;
  return markSlackRequestSeen_('slack:event:' + id, 7200);
}

function extractSlackVerificationToken_(rawBody, e) {
  let body = {};
  try { body = JSON.parse(rawBody || '{}'); } catch (ignore) { body = {}; }

  let token =
    (body && body.token) ||
    (e.parameter && e.parameter.token) ||
    (e.parameters && e.parameters.token && e.parameters.token[0]) ||
    '';

  if (token) return String(token).trim();

  const payloadParam =
    (e.parameter && e.parameter.payload) ||
    (e.parameters && e.parameters.payload && e.parameters.payload[0]) ||
    '';

  if (!payloadParam && rawBody.indexOf('payload=') !== -1) {
    const parts = rawBody.split('&');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].indexOf('payload=') === 0) {
        try {
          const decoded = decodeURIComponent(parts[i].slice(8).replace(/\+/g, ' '));
          const payload = JSON.parse(decoded);
          token = payload && payload.token;
        } catch (ignore) {}
      }
    }
  } else if (payloadParam) {
    try {
      const payload = JSON.parse(payloadParam);
      token = payload && payload.token;
    } catch (ignore) {}
  }

  return String(token || '').trim();
}

function getHeaderValue(e, keys) {
  const variants = [];
  keys.forEach(function(k) {
    variants.push(k, k.toLowerCase(), k.toUpperCase(), 'HTTP_' + k.toUpperCase().replace(/-/g, '_'));
  });
  for (let i = 0; i < variants.length; i++) {
    const key = variants[i];
    if (e.parameter && e.parameter[key]) return e.parameter[key];
    if (e.parameters && e.parameters[key] && e.parameters[key][0]) return e.parameters[key][0];
  }
  return '';
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let mismatch = a.length === b.length ? 0 : 1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    mismatch |= (ca ^ cb);
  }
  return mismatch === 0;
}
