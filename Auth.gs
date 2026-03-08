function validateSlackRequest(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return false;

    // GAS caveat:
    // Slack signatures are sent as HTTP headers, but Apps Script deployments may expose
    // them inconsistently depending on runtime/version. e.postData.contents is reliable.
    // We attempt to read signature/timestamp from e.parameter/e.parameters fallbacks.
    const rawBody = e.postData.contents;
    const signingSecret = PROPS.getProperty('SLACK_SIGNING_SECRET');
    if (!signingSecret) return false;

    const timestamp =
      (e.parameter && (e.parameter['X-Slack-Request-Timestamp'] || e.parameter['x-slack-request-timestamp'])) ||
      (e.parameters && (e.parameters['X-Slack-Request-Timestamp'] && e.parameters['X-Slack-Request-Timestamp'][0])) ||
      '';

    const slackSignature =
      (e.parameter && (e.parameter['X-Slack-Signature'] || e.parameter['x-slack-signature'])) ||
      (e.parameters && (e.parameters['X-Slack-Signature'] && e.parameters['X-Slack-Signature'][0])) ||
      '';

    if (!timestamp || !slackSignature) {
      Logger.log('Missing Slack signature headers in Apps Script event object.');
      return false;
    }

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
  } catch (err) {
    Logger.log('validateSlackRequest error: ' + err);
    return false;
  }
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
