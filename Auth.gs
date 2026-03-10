function validateSlackRequest(e) {
  try {
    if (!e || !e.postData) return false;
    const rawBody = e.postData.contents || e.postData.getDataAsString() || '';
    const signingSecret = String(PROPS.getProperty('SLACK_SIGNING_SECRET') || '').trim();

    const timestamp = getHeaderValue(e, ['X-Slack-Request-Timestamp', 'x-slack-request-timestamp']);
    const slackSignature = getHeaderValue(e, ['X-Slack-Signature', 'x-slack-signature']);

    // Primary path: Slack signing-secret HMAC validation.
    if (timestamp && slackSignature && signingSecret) {
      const tsNum = Number(String(timestamp || '').trim());
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
      const actual = String(slackSignature || '').trim().toLowerCase();
      const valid = constantTimeEqual(expected, actual);
      if (valid) return true;
      Logger.log('validateSlackRequest HMAC mismatch; checking legacy token fallback (if enabled).');
    } else {
      Logger.log('validateSlackRequest missing signature headers/secret; checking legacy token fallback (if enabled).');
    }

    // Emergency path: deprecated legacy token fallback, explicitly gated by property.
    if (isSlackTokenFallbackEnabled_() && validateLegacySlackToken_(e, rawBody)) {
      Logger.log('validateSlackRequest accepted via deprecated SLACK_VERIFICATION_TOKEN fallback.');
      return true;
    }

    return false;
  } catch (err) {
    Logger.log('validateSlackRequest error: ' + err);
    return false;
  }
}

function isSlackTokenFallbackEnabled_() {
  var raw = String(PROPS.getProperty('SLACK_AUTH_TOKEN_FALLBACK') || '').toLowerCase().trim();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

function validateLegacySlackToken_(e, rawBody) {
  var configured = String(PROPS.getProperty('SLACK_VERIFICATION_TOKEN') || '').trim();
  if (!configured) return false;

  var incoming = extractLegacySlackTokenFromRequest_(e, rawBody);
  if (!incoming) return false;

  return constantTimeEqual(String(configured), String(incoming));
}

function extractLegacySlackTokenFromRequest_(e, rawBody) {
  try {
    if (e && e.parameter && e.parameter.token) {
      return String(e.parameter.token).trim();
    }

    if (e && e.parameter && e.parameter.payload) {
      try {
        var payload = JSON.parse(e.parameter.payload);
        if (payload && payload.token) return String(payload.token).trim();
      } catch (ignore) {}
    }

    var text = String(rawBody || '').trim();
    if (!text) return '';

    if (text[0] === '{') {
      try {
        var body = JSON.parse(text);
        if (body && body.token) return String(body.token).trim();
      } catch (ignoreJson) {}
      return '';
    }

    var parts = text.split('&');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      if (decodeURIComponent(String(kv[0] || '')) === 'token') {
        return decodeURIComponent(String(kv.slice(1).join('=') || '').replace(/\+/g, '%20')).trim();
      }
    }
  } catch (err) {
    Logger.log('extractLegacySlackTokenFromRequest_ error: ' + err);
  }
  return '';
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

function getSlackDedupeTtlSeconds_() {
  var ttl = Number(PROPS.getProperty('SLACK_DEDUPE_TTL_SECONDS') || 1200);
  if (!ttl || ttl < 60) ttl = 600;
  if (ttl > 1800) ttl = 1800;
  return ttl;
}

function cleanupExpiredSlackDedupeKeys_() {
  try {
    var now = Date.now();
    var lastCleanup = Number(PROPS.getProperty('SLACK_DEDUPE_LAST_CLEANUP_MS') || 0);
    if (lastCleanup && (now - lastCleanup) < 5 * 60 * 1000) return;

    var all = PROPS.getProperties();
    var toDelete = [];
    Object.keys(all).forEach(function(k) {
      if (k.indexOf('SLACK_DEDUPE_') !== 0) return;
      var raw = all[k];
      try {
        var parsed = JSON.parse(raw || '{}');
        if (!parsed.expiresAtMs || Number(parsed.expiresAtMs) <= now) {
          toDelete.push(k);
        }
      } catch (parseErr) {
        toDelete.push(k);
      }
    });

    if (toDelete.length) PROPS.deleteAllProperties(toDelete);
    PROPS.setProperty('SLACK_DEDUPE_LAST_CLEANUP_MS', String(now));
  } catch (err) {
    Logger.log('cleanupExpiredSlackDedupeKeys_ error: ' + err);
  }
}

function checkAndStoreDedupeKey_(dedupeKey, ttlSeconds, metadata) {
  var normalized = String(dedupeKey || '').trim();
  if (!normalized) return { duplicate: false, key: '' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1500)) {
    Logger.log('checkAndStoreDedupeKey_: lock busy, continuing without dedupe enforcement.');
    return { duplicate: false, key: normalized, lockBusy: true };
  }

  try {
    cleanupExpiredSlackDedupeKeys_();
    var now = Date.now();
    var ttlMs = Number(ttlSeconds || getSlackDedupeTtlSeconds_()) * 1000;
    var propKey = 'SLACK_DEDUPE_' + Utilities.base64EncodeWebSafe(normalized).replace(/=+$/,'');
    var existing = PROPS.getProperty(propKey);

    if (existing) {
      try {
        var parsed = JSON.parse(existing);
        if (Number(parsed.expiresAtMs || 0) > now) {
          return { duplicate: true, key: normalized, expiresAtMs: Number(parsed.expiresAtMs) };
        }
      } catch (ignore) {
        // Overwrite malformed values below.
      }
    }

    PROPS.setProperty(propKey, JSON.stringify({
      createdAtMs: now,
      expiresAtMs: now + ttlMs,
      meta: metadata || {}
    }));
    return { duplicate: false, key: normalized, expiresAtMs: now + ttlMs };
  } catch (err) {
    Logger.log('checkAndStoreDedupeKey_ error: ' + err);
    return { duplicate: false, key: normalized, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}

function getSlackRetryMetadata_(e) {
  var retryNum = getHeaderValue(e, ['X-Slack-Retry-Num', 'x-slack-retry-num']);
  var retryReason = getHeaderValue(e, ['X-Slack-Retry-Reason', 'x-slack-retry-reason']);
  return {
    retry_num: retryNum === '' ? '' : String(retryNum),
    retry_reason: String(retryReason || ''),
    is_retry: retryNum !== '' || String(retryReason || '') !== ''
  };
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

function getHeaderValue(e, keys) {
  const variants = [];

  function addVariant(value) {
    const key = String(value || '').trim();
    if (!key) return;
    if (variants.indexOf(key) === -1) variants.push(key);
  }

  function addKeyVariants(baseKey) {
    const original = String(baseKey || '').trim();
    if (!original) return;

    const hyphen = original.replace(/_/g, '-');
    const underscore = original.replace(/-/g, '_');

    [original, hyphen, underscore].forEach(function(k) {
      addVariant(k);
      addVariant(k.toLowerCase());
      addVariant(k.toUpperCase());
    });

    addVariant('HTTP_' + hyphen.toUpperCase().replace(/-/g, '_'));
    addVariant('http_' + hyphen.toLowerCase().replace(/-/g, '_'));
  }

  function coerceHeaderValue(value) {
    if (Array.isArray(value)) return value[0] || '';
    return value || '';
  }

  keys.forEach(addKeyVariants);

  // Web Apps can expose headers under e.headers with provider-specific naming/casing.
  if (e.headers) {
    for (let i = 0; i < variants.length; i++) {
      const key = variants[i];
      if (Object.prototype.hasOwnProperty.call(e.headers, key)) {
        const value = coerceHeaderValue(e.headers[key]);
        if (value) return String(value).trim();
      }
    }

    // Final fallback: case-insensitive lookup across all generated variants.
    const normalized = {};
    Object.keys(e.headers).forEach(function(k) {
      normalized[String(k || '').toLowerCase()] = e.headers[k];
    });

    for (let i = 0; i < variants.length; i++) {
      const value = coerceHeaderValue(normalized[String(variants[i]).toLowerCase()]);
      if (value) return String(value).trim();
    }
  }

  for (let i = 0; i < variants.length; i++) {
    const key = variants[i];
    if (e.parameter && e.parameter[key]) return String(e.parameter[key]).trim();
    if (e.parameters && e.parameters[key] && e.parameters[key][0]) return String(e.parameters[key][0]).trim();
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
