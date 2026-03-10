# Slack Platform Production Review

## 1. Executive Slack Review Summary
The Slack integration has a good foundational shape (signature validation, fast HTTP acknowledgment for slash commands/events, queued async processing, and command/event routing). However, it is **not production-safe yet** for Slack platform behavior because interactivity handlers are stubs, Slack retry/idempotency handling is incomplete, and request verification still allows legacy token fallback by default.

## 2. Critical Slack Integration Risks
1. **Interactivity is effectively broken:** button clicks and modal submissions are acknowledged, but handler functions are placeholders/no-ops.
2. **No event-level idempotency:** duplicate `event_callback` deliveries from Slack retries can produce duplicate learner actions/messages.
3. **No explicit handling of Slack retry headers:** no `X-Slack-Retry-Num` / `X-Slack-Retry-Reason` logic in webhook path.
4. **Security posture too permissive by default:** request verification token fallback is enabled by default, reducing trust boundary quality if signatures are unavailable.
5. **Mixed Slack API wrappers and uneven error strategy:** one wrapper returns `{ok:false}`, another throws; behavior differs by code path.

## 3. Slack API / Interaction Handling Findings
- **Slash commands**: acknowledged quickly and queued, which is correct for 3-second SLA.
- **Event API**: acknowledged quickly and queued, good for timing, but lacks event de-duplication (`event_id`/`event_ts` tracking).
- **Interactivity**: parsed and acknowledged, but `handleSlackInteraction` currently returns static `{ok:true}` without business processing.
- **Shortcuts**: no global/message shortcuts are configured in the manifest.
- **`response_url`** is captured but never used; follow-up UX relies on bot DMs instead of command-response updates.
- **Queue dedupe only covers slash commands**; events/interactions are not deduped.

## 4. Security Findings for Slack Requests
- **Strong points**: HMAC signature verification and 5-minute timestamp freshness checks exist; comparison is constant-time.
- **Risk**: fallback verification token mode is enabled by default (`SLACK_AUTH_TOKEN_FALLBACK=true`), so strict signed-request-only mode is not default-safe.
- **Replay protection gap**: no nonce/event-id store to reject repeated validly signed payloads within time window.
- **Header extraction assumptions**: relies on header values arriving through `e.parameter/e.parameters`, which is fragile in Apps Script deployment variations.

## 5. Delivery and Messaging Risks
- **DM flow**: DM open + post is correct, but repeated user events can still duplicate sends due to missing event idempotency.
- **Onboarding UX**: modal/button flows are exposed in code paths but not implemented, creating broken interaction journeys.
- **Error handling inconsistency**: `Slack.gs` returns soft failures; `LessonDelivery.gs` throws hard errors. This causes different retry/failure behavior depending on caller.
- **Manifest drift**: long description omits new `/health` command even though command exists, causing operator confusion.

## 6. Recommended Slack Fixes
1. Implement a real `handleSlackInteraction` router for:
   - `block_actions` (button handling)
   - `view_submission` (modal extraction/validation)
   - optional `shortcut` payloads
2. Add robust Slack idempotency:
   - store `event_id` (Events API)
   - store interaction `payload.trigger_id`/`container.message_ts` keys
   - ignore duplicates for a TTL window.
3. Add explicit Slack retry handling:
   - read `X-Slack-Retry-Num` / `X-Slack-Retry-Reason`
   - short-circuit duplicates with 200 OK.
4. Harden security defaults:
   - set `SLACK_AUTH_TOKEN_FALLBACK=false` by default in docs and deployment guidance
   - keep fallback only for controlled migration scenarios.
5. Unify Slack transport layer (single wrapper with normalized retries/backoff/error classification).
6. Use `response_url` for slash-command follow-ups where appropriate, reducing DM-only coupling.
7. Add manifest/documentation parity checks as part of release checklist.

## 7. Final Slack Readiness Verdict
**Verdict: Not Slack-production-ready yet.**

The core webhook and command/event architecture is promising, but missing idempotency and nonfunctional interaction handlers are hard blockers for reliable Slack production operation. After fixing interactivity routing, retry/idempotency controls, and tightening auth defaults, this can become a solid Slack-native LMS integration.
