# RWR Slack LMS (Apps Script + Google Sheets + Slack)

This implementation keeps Google Sheets as the LMS datastore and Apps Script as the automation runtime.

## Canonical LMS sheets

- `Courses`
- `Modules`
- `Course_Module_Map`
- `Lessons`
- `Missions`
- `Lesson_Metrics`
- `Lesson_QA_Details`
- `Slack_Delivery`

Operational sheets:

- `Learners`
- `Lesson_Submissions`
- `Queue`
- `onboarding_workflow_filled_slack_messages` (onboarding only)

Governance/operations sheets (created and validated by setup):

- `Users`, `Cohorts`, `Tracks`, `Enrollments`, `Lesson_Content`
- `Reminders`, `Approvals`, `Settings`, `Workflow_Rules`
- `Audit_Log`, `Error_Log`, `Admin_Actions`
- `Content_Pipeline`, `Prompt_Configs`, `Gem_Roles`, `Publish_Queue`, `Generated_Drafts`

## Key behavior

- `Slack_Delivery` is the canonical lesson message source.
- `Missions` is the canonical submit-code lookup source.
- `Lesson_QA_Details` is a hard delivery gate before posting lessons.
- Learner progress is calculated from recorded mission submissions.
- Reaction completion maps by `Slack Channel + Slack TS` from `Slack_Delivery` (not timestamp parsing).
- Onboarding is isolated from LMS lesson sequencing.

## Slash commands

- `/learn` — send next eligible lesson
- `/submit <submit_code> <evidence>` — mission submission
- `/progress` — learner progress summary
- admin: `/onboard`, `/offboard`, `/enroll`, `/unenroll`, `/report`, `/gaps`, `/backup`, `/health`, `/startlesson`, `/stoplesson`

## Setup

Set Script Properties:

- `SHEETS_ID`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `ADMIN_USER_IDS`
- optional: `SLACK_VERIFICATION_TOKEN`, `SLACK_AUTH_TOKEN_FALLBACK` (default `false`), `DEFAULT_LESSON_CHANNEL`, `DEFAULT_ONBOARDING_CHANNEL`, `ONBOARDING_SHEET_NAME`, `BATCH_LIMIT`, `DRY_RUN`, `QUEUE_MAX_RETRIES`, `QUEUE_RETENTION_DAYS`, `QUEUE_MAX_ROWS`, `QUEUE_PRUNE_INTERVAL_MS`, `AI_DISABLED`
- AI: `GEMINI_API_KEY`, optional `GEMINI_MODEL` (default `gemini-1.5-flash`), optional per-agent Gem instruction properties like `GEMINI_GEM_PROGRESS_ASSISTANT`

Then run `menuEnsureTrackingColumns()` once to align headers.
