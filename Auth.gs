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

    if (!isSlackDevAuthBypassEnabled_()) {
      Logger.log('validateSlackRequest rejected: missing signature headers or signing secret.');
      return false;
    }

    const configuredToken = PROPS.getProperty('SLACK_VERIFICATION_TOKEN') || '';
    let body = {};
    try { body = JSON.parse(rawBody || '{}'); } catch (ignore) { body = {}; }
    const requestToken =
      (body && body.token) ||
      (e.parameter && e.parameter.token) ||
      (e.parameters && e.parameters.token && e.parameters.token[0]) ||
      '';

    if (configuredToken && requestToken) {
      const ok = constantTimeEqual(String(configuredToken), String(requestToken));
      if (ok) {
        Logger.log('WARNING: validateSlackRequest accepted request using development token fallback.');
      }
      return ok;
    }

    Logger.log('validateSlackRequest rejected: development fallback enabled but token invalid.');
    return false;
  } catch (err) {
    Logger.log('validateSlackRequest error: ' + err);
    return false;
  }
}

function isSlackDevAuthBypassEnabled_() {
  return String(PROPS.getProperty('SLACK_AUTH_DEV_MODE') || 'false').toLowerCase() === 'true';
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
