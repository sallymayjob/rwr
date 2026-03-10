var SLACK_CLIENT_CONTEXT_ = { source: '', correlationId: '' };

function setSlackCallContext(source, correlationId) {
  SLACK_CLIENT_CONTEXT_ = {
    source: String(source || '').trim(),
    correlationId: String(correlationId || '').trim()
  };
}

function clearSlackCallContext() {
  SLACK_CLIENT_CONTEXT_ = { source: '', correlationId: '' };
}

function getSlackCallContext_() {
  return {
    source: String(SLACK_CLIENT_CONTEXT_.source || '').trim(),
    correlationId: String(SLACK_CLIENT_CONTEXT_.correlationId || '').trim()
  };
}

function slackApiCall(endpoint, payload, options) {
  var opts = options || {};
  var token = String(opts.token || PROPS.getProperty('SLACK_BOT_TOKEN') || '').trim();
  if (!token) {
    return { ok: false, error: 'missing_slack_bot_token', status: 0, retriable: false, data: {} };
  }

  var maxRetries = Math.max(0, Number(opts.maxRetries == null ? 3 : opts.maxRetries));
  var baseBackoffMs = Math.max(100, Number(opts.baseBackoffMs || 500));
  var method = String(opts.httpMethod || 'post').toLowerCase();
  var context = getSlackCallContext_();
  var correlationId = String(opts.correlationId || context.correlationId || '').trim();
  var source = String(opts.source || context.source || '').trim();

  var url = SLACK_API_BASE + endpoint;
  if (method === 'get' && payload && Object.keys(payload).length) {
    var query = Object.keys(payload).map(function(key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(String(payload[key]));
    }).join('&');
    if (query) url += '?' + query;
  }

  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    var started = Date.now();
    var status = 0;
    var body = {};
    var errorText = '';
    var retriable = false;

    try {
      var fetchOptions = {
        method: method,
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true
      };
      if (method !== 'get') {
        fetchOptions.contentType = 'application/json; charset=utf-8';
        fetchOptions.payload = JSON.stringify(payload || {});
      }

      var response = UrlFetchApp.fetch(url, fetchOptions);
      status = Number(response.getResponseCode() || 0);

      try {
        body = JSON.parse(response.getContentText() || '{}');
      } catch (parseErr) {
        body = {};
      }

      errorText = String((body && body.error) || (status >= 400 ? ('http_' + status) : '') || '');
      retriable = slackCallRetriable_(status, errorText);

      var ok = status >= 200 && status < 300 && body && body.ok === true;
      logSlackCall_(endpoint, {
        ok: ok,
        status: status,
        error: errorText,
        retriable: retriable,
        attempt: attempt + 1,
        elapsedMs: Date.now() - started,
        correlationId: correlationId,
        source: source
      });

      if (ok) return { ok: true, status: status, error: '', retriable: false, data: body };
      if (!retriable || attempt >= maxRetries) {
        return { ok: false, status: status, error: errorText || 'slack_api_failed', retriable: retriable, data: body };
      }

      var headers = response.getAllHeaders ? response.getAllHeaders() : {};
      var retryAfter = Number(headers['Retry-After'] || headers['retry-after'] || 0);
      var waitMs = retryAfter > 0 ? retryAfter * 1000 : (baseBackoffMs * Math.pow(2, attempt));
      Utilities.sleep(waitMs + Math.floor(Math.random() * 250));
    } catch (err) {
      errorText = String(err || 'slack_api_exception');
      retriable = true;

      logSlackCall_(endpoint, {
        ok: false,
        status: status,
        error: errorText,
        retriable: true,
        attempt: attempt + 1,
        elapsedMs: Date.now() - started,
        correlationId: correlationId,
        source: source
      });

      if (attempt >= maxRetries) {
        return { ok: false, status: status, error: errorText, retriable: true, data: body };
      }
      Utilities.sleep(baseBackoffMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250));
    }
  }

  return { ok: false, status: 0, error: 'slack_client_unreachable', retriable: false, data: {} };
}

function slackCallRetriable_(status, error) {
  if (status === 429 || status >= 500) return true;
  var retriableErrors = {
    ratelimited: true,
    internal_error: true,
    request_timeout: true,
    service_unavailable: true,
    temporarily_unavailable: true
  };
  return !!retriableErrors[String(error || '').toLowerCase()];
}

function logSlackCall_(endpoint, details) {
  Logger.log('[SlackApi] ' + JSON.stringify({
    endpoint: endpoint,
    ok: !!details.ok,
    status: Number(details.status || 0),
    error: String(details.error || ''),
    retriable: !!details.retriable,
    attempt: Number(details.attempt || 1),
    elapsed_ms: Number(details.elapsedMs || 0),
    correlation_id: String(details.correlationId || ''),
    source: String(details.source || '')
  }));
}
