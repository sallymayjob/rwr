# Deployment

## 1) Google Sheets

Create/verify sheets:

`Courses`, `Modules`, `Course_Module_Map`, `Lessons`, `Missions`, `Lesson_Metrics`, `Lesson_QA_Details`, `Slack_Delivery`, `Learners`, `Lesson_Submissions`, `Queue`.

Run `menuEnsureTrackingColumns()` from Apps Script once.

## 2) Apps Script properties

Required:

- `SHEETS_ID`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`

Recommended:

- `ADMIN_USER_IDS`
- `SLACK_AUTH_TOKEN_FALLBACK` (**must be** `false`; verification-token fallback is disabled)
- `DEFAULT_LESSON_CHANNEL`
- `DEFAULT_ONBOARDING_CHANNEL`
- `ONBOARDING_SHEET_NAME`
- `QUEUE_MAX_RETRIES` (default `3`)
- `QUEUE_RETENTION_DAYS` (default `7`)
- `QUEUE_MAX_ROWS` (default `5000`)
- `QUEUE_PRUNE_INTERVAL_MS` (default `3600000`)

## 3) Slack app

- Request URLs (events/interactivity/commands) -> Web app URL
- Bot scopes: `chat:write`, `commands`, `users:read`, `users:read.email`, `im:read`, `im:write`, `reactions:read`, `channels:history`, `app_mentions:read`
- Event Subscriptions: enable and set request URL to the web app URL
- Events: `message.channels`, `message.im` (plus `app_mention`, `reaction_added` if used)
- Interactivity: enable and set request URL to the web app URL for onboarding/LMS callbacks

## 4) Verification

- `/submit` format is now: `/submit <submit_code> <evidence>`
- Lessons are sent from `Slack_Delivery`
- Lesson delivery requires QA pass+ready row in `Lesson_QA_Details`
- Reaction completion resolves lesson via `Slack_Delivery` by `Slack Channel` + `Slack TS`


## 5) Slack request signing requirements

All inbound Slack requests are validated with HMAC signing using:

- `X-Slack-Signature`
- `X-Slack-Request-Timestamp`
- raw request body

Replay protection rejects timestamps outside a 5-minute window before signature comparison. Ensure `SLACK_SIGNING_SECRET` is configured and keep `SLACK_AUTH_TOKEN_FALLBACK=false`.
