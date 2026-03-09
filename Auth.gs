function validateSlackRequest(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return false;
    const rawBody = e.postData.contents;
    const signingSecret = PROPS.getProperty('SLACK_SIGNING_SECRET') || '';

    let body = {};
    try { body = JSON.parse(rawBody || '{}'); } catch (ignore) { body = {}; }
    if (body.type === 'url_verification') return true;

    const timestamp = getHeaderValue(e, ['X-Slack-Request-Timestamp', 'x-slack-request-timestamp']);
    const slackSignature = getHeaderValue(e, ['X-Slack-Signature', 'x-slack-signature']);

    if (timestamp && slackSignature && signingSecret) {
      const tsNum = Number(timestamp);
      if (!tsNum || Math.abs(Math.floor(Date.now() / 1000) - tsNum) > 300) return false;
      const baseString = 'v0:' + timestamp + ':' + rawBody;
      const bytes = Utilities.computeHmacSha256Signature(baseString, signingSecret);
      const hex = bytes.map(function(b) {
        const v = (b < 0 ? b + 256 : b).toString(16);
        return v.length === 1 ? '0' + v : v;
      }).join('');
      return constantTimeEqual('v0=' + hex, slackSignature);
    }

    const configuredToken = PROPS.getProperty('SLACK_VERIFICATION_TOKEN') || '';
    const requestToken =
      (body && body.token) ||
      (e.parameter && e.parameter.token) ||
      (e.parameters && e.parameters.token && e.parameters.token[0]) ||
      '';

    if (configuredToken && requestToken) {
      return constantTimeEqual(String(configuredToken), String(requestToken));
    }

    Logger.log('validateSlackRequest failed: missing/invalid signature and no valid verification token fallback.');
    return false;
  } catch (err) {
    Logger.log('validateSlackRequest error: ' + err);
    return false;
  }
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
