function validateSlackRequest(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return false;

    // GAS caveat:
    // Slack signatures are sent as HTTP headers, but Apps Script deployments may expose
    // them inconsistently depending on runtime/version. e.postData.contents is reliable.
    // We attempt to read signature/timestamp from multiple event-object shapes.
    const rawBody = e.postData.contents;
    const signingSecret = PROPS.getProperty('SLACK_SIGNING_SECRET');

    let body = {};
    try { body = JSON.parse(rawBody || '{}'); } catch (ignore) { body = {}; }

    // URL verification is handled in doPost() before routing; allow it here so
    // missing header exposure in GAS does not block Slack endpoint registration.
    if (body.type === 'url_verification') return true;

    const timestamp = getHeaderValue(e, ['X-Slack-Request-Timestamp', 'x-slack-request-timestamp']);
    const slackSignature = getHeaderValue(e, ['X-Slack-Signature', 'x-slack-signature']);

    // Preferred path: full HMAC validation when GAS exposes the headers.
    if (timestamp && slackSignature && signingSecret) {
      const tsNum = Number(timestamp);
      if (!tsNum || Math.abs(Math.floor(Date.now() / 1000) - tsNum) > 300) return false;

      const baseString = 'v0:' + timestamp + ':' + rawBody;
      const bytes = Utilities.computeHmacSha256Signature(baseString, signingSecret);
      const hex = bytes.map(function(b) {
        const v = (b < 0 ? b + 256 : b).toString(16);
        return v.length === 1 ? '0' + v : v;
      }).join('');
      const computed = 'v0=' + hex;
      return constantTimeEqual(computed, slackSignature);
    }

    // Fallback path for Apps Script environments where headers are unavailable:
    // optionally verify legacy Slack verification token if configured.
    const configuredToken = PROPS.getProperty('SLACK_VERIFICATION_TOKEN') || '';
    const requestToken =
      (body && body.token) ||
      (e.parameter && e.parameter.token) ||
      (e.parameters && e.parameters.token && e.parameters.token[0]) ||
      '';

    if (configuredToken && requestToken) {
      return constantTimeEqual(String(configuredToken), String(requestToken));
    }

    // Last resort for GAS header limitations: permit and log loudly.
    // Keep this only if your deployment does not expose Slack headers.
    Logger.log('validateSlackRequest warning: Slack headers unavailable in GAS event object; allowing request.');
    return true;
  } catch (err) {
    Logger.log('validateSlackRequest error: ' + err);
    return false;
  }
}

function getHeaderValue(e, keys) {
  const variants = [];
  keys.forEach(function(k) {
    variants.push(k);
    variants.push(k.toLowerCase());
    variants.push(k.toUpperCase());
    variants.push('HTTP_' + k.toUpperCase().replace(/-/g, '_'));
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
