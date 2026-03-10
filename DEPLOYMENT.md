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
- `SLACK_VERIFICATION_TOKEN` (for environments where Slack signature headers are stripped)
- `SLACK_AUTH_TOKEN_FALLBACK` (`false` by default; set `true` only if signature headers are unavailable in your environment)
- `DEFAULT_LESSON_CHANNEL`
- `DEFAULT_ONBOARDING_CHANNEL`
- `ONBOARDING_SHEET_NAME`
- `QUEUE_MAX_RETRIES` (default `3`)
- `QUEUE_RETENTION_DAYS` (default `7`)
- `QUEUE_MAX_ROWS` (default `5000`)
- `QUEUE_PRUNE_INTERVAL_MS` (default `3600000`)

## 3) Slack app

- Request URLs (events/interactivity/commands) -> Web app URL
- Bot scopes: `chat:write`, `commands`, `users:read`, `users:read.email`, `im:read`, `im:write`, `reactions:read`
- Events: `app_mention`, `message.im`, `reaction_added`

## 4) Verification

- `/submit` format is now: `/submit <submit_code> <evidence>`
- Lessons are sent from `Slack_Delivery`
- Lesson delivery requires QA pass+ready row in `Lesson_QA_Details`
- Reaction completion resolves lesson via `Slack_Delivery` by `Slack Channel` + `Slack TS`
