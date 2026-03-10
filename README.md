# RWR Slack LMS (Apps Script + Google Sheets + Slack)

This implementation keeps Google Sheets as the LMS datastore and Apps Script as the automation runtime.

## Canonical LMS sheets

Canonical sheet contracts are centralized in `getSchemaDefinitionMap()` (`Sheets.gs`). `/health` and `/schema` run `validateSchema()` against this map and report missing or mismatched headers before writes proceed.

## Overview

This codebase implements a supervisor-style routing architecture where all incoming Slack traffic goes through one entrypoint (`doPost` in `Code.gs`) and is deferred into a queue for processing.

Core design goals:

- Fast Slack acknowledgement (`doPost` returns quickly)
- Signed request validation (Slack HMAC verification)
- Deterministic sheet operations using batch reads
- Agent-style handlers for learner/admin workflows
- Provider-routed AI calls (`callAI`) for Claude/Gemini split

## Repository Structure

- `Config.gs` — constants, sheet names, properties, provider routing, admin helpers
- `Auth.gs` — Slack signature validation and constant-time compare
- `Sheets.gs` — batched read/write helpers, progress/submission updates, rollups, queue writes
- `Slack.gs` — Slack API wrappers and Block Kit builders
- `Agents.gs` — agent handlers and AI integration (`callClaude`, `callGemini`, `callAI`)
- `Code.gs` — `doPost`, queue worker (`processQueuedPipeline`), event/command routing

## Supported Commands

### Learner

- `/learn` — Deliver your next lesson.
- `/submit <submit_code> <evidence>` — Submit lesson verification.
- `/progress` — Show your current completion progress.
- `/courses` — List available courses and enrollment status.
- `/help` — Show command help and usage.

### Admin (guarded by `ADMIN_USER_IDS`)

- `/enrol <userId>` — Enroll a learner.
- `/unenrol <userId>` — Unenroll a learner.
- `/cert` — Check certification eligibility.
- `/onboard <userId>` — Auto-enroll and send orientation + first lesson.
- `/offboard <userId>` — Archive a learner record.
- `/report` — Generate a cohort report.
- `/gaps` — Identify learners behind target pace.
- `/backup` — Back up LMS sheets.
- `/mix [topic]` — Generate a suggested learning mix.
- `/media <lessonId>` — Assess media needs and create a brief.
- `/startlesson` — Enable learner lesson commands.
- `/stoplesson` — Pause learner lesson commands.
- `/deadletter [report|inspect <job_id>|requeue <job_id>]` — Review or requeue dead-letter queue jobs.
- `/schema` — Run explicit schema validation for tabs/headers.

## Slack Events

- `app_mention`
- DM messages (`message` with `channel_type=im`)
- `reaction_added` for `white_check_mark` (`✅`)


## Slack security + subscriptions checklist

- Enable **Event Subscriptions** and set Request URL to the Apps Script web app URL.
- Subscribe bot events: `message.channels` and `message.im` (plus other events you use, such as `app_mention` and `reaction_added`).
- Enable **Interactivity** and set its Request URL to the same web app URL for onboarding/LMS action callbacks.
- Configure Script Properties with `SLACK_SIGNING_SECRET` and `SLACK_AUTH_TOKEN_FALLBACK=false`.
- The webhook entrypoint now enforces signed requests only (`X-Slack-Signature` + `X-Slack-Request-Timestamp` + raw body), rejects stale timestamps (>5 minutes), and uses constant-time signature comparison.

## Data Model (Sheets)

Canonical tab/column contracts (required headers):

- `Courses`: `CourseID`, `Course Title`, `Course Description`, `Entry Module`, `Module IDs`, `Module Names`, `Total Modules`, `Total Lessons`, `Audience`, `Difficulty Range`, `Delivery Mode`, `Status`
- `Modules`: `ModuleID`, `Module Number`, `Module Name`, `Module Description`, `CourseID`, `Difficulty Tier`, `Audience`, `Total Lessons`, `Week Range`, `Focus Areas`, `Delivery Mode`, `Estimated Duration`
- `Course_Module_Map`: `CourseID`, `ModuleID`, `Sequence`, `Is Entry Module`, `Total Lessons in Module`
- `Lessons`: `LessonID`, `CourseID`, `ModuleID`, `Month`, `Week`, `Lesson Title`, `Type`, `Hook`, `Core Content`, `Insight`, `Takeaway`, `Objective`, `Intent`, `Mission`, `Verification`, `Submit Code`, `Difficulty`, `Focus Area`, `Tone`, `Status`, `Lesson Order`
- `Missions`: `MissionID`, `LessonID`, `Activity`, `Instructions`, `Submit Code`, `Activity Type`, `Response Format`
- `Lesson_Metrics`: `Lesson`, `Word Count Total`, `Word Count Core`, `Word Count Insight`, `Word Count Takeaway`, `Brand Compliance Score`, `PED Flags`, `Last Reviewed`, `Reviewer`
- `Lesson_QA_Details`: `Lesson`, `QA Score`, `QA Verdict`, `QA Detail`, `QA Run Date`, `Revision Count`, `SOP-5 Validated`, `Spot Check`, `Priority`, `Status`, `Golden Example`
- `Slack_Delivery`: `LessonID`, `Slack Thread Text`, `Submit Code`, `Mapped Focus`, `Mapped Action`, `Mapped Channel Name`, `Template Source Message`, `Delivery Status`, `Slack TS`, `Slack Channel`, `Send Order`
- `Learners`: `UserID`, `Name`, `Email`, `Enrolled Course`, `Current Module`, `Progress (%)`, `Status`, `Joined Date`, `Completed Missions`, `Completed Lessons`, `Last LessonID`, `Last MissionID`
- `Lesson_Submissions`: `Timestamp`, `Learner`, `Lesson`, `MissionID`, `Submit Code`, `Evidence`, `Method`, `Score`
- `Queue`: `job_id`, `source_event_id`, `status`, `attempt_count`, `max_attempts`, `next_attempt_at`, `payload_ref`, `last_error_class`, `last_provider_response_code`, `dead_letter_error_json`, `last_attempt_at`
- `Audit_Log`: `Timestamp`, `Action`, `Actor_UserID`, `Entity_Type`, `Entity_ID`, `Outcome`, `Execution_Type`, `Latency_MS`, `Failure_Reason`, `Details_JSON`
- Governance tabs: `Error_Log`, `Admin_Actions`, `Content_Pipeline`, `Prompt_Configs`, `Gem_Roles`, `Publish_Queue`, `Generated_Drafts` (see `Sheets.gs` schema map for exact required columns).

When headers are missing/mismatched (for example `Module` instead of `ModuleID`), write operations are blocked with an actionable admin error until fixed.

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
- admin: `/onboard`, `/offboard`, `/enroll`, `/unenroll`, `/report`, `/gaps`, `/backup`, `/health`, `/schema`, `/deadletter`, `/startlesson`, `/stoplesson`


## Release checklist (pre-deploy)

- [ ] Manifest slash commands/events match implemented handlers in `Code.gs` (`routeCommand` and `routeEvent`).
- [ ] Command examples in docs match current syntax, especially `/submit <submit_code> <evidence>`.
- [ ] Queue lifecycle milestones are observable in `Audit_Log` (`RECEIVED`, `QUEUED`, `STARTED`, `COMPLETED`, `FAILED`, `DEAD_LETTER`) with actor, latency, and failure reason fields.
- [ ] Run parity verification script: `python scripts/verify_manifest_docs_parity.py`.

## Setup

Set Script Properties:

- `SHEETS_ID`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `ADMIN_USER_IDS`
- required: `SLACK_AUTH_TOKEN_FALLBACK=false` (verification token fallback is disabled; signing-secret HMAC is mandatory)
- optional: `DEFAULT_LESSON_CHANNEL`, `DEFAULT_ONBOARDING_CHANNEL`, `ONBOARDING_SHEET_NAME`, `BATCH_LIMIT`, `DRY_RUN`, `QUEUE_MAX_ATTEMPTS` (fallback `QUEUE_MAX_RETRIES`), `QUEUE_BACKOFF_BASE_MS`, `QUEUE_BACKOFF_MAX_MS`, `QUEUE_BACKOFF_JITTER_MS`, `QUEUE_RETENTION_DAYS`, `QUEUE_MAX_ROWS`, `QUEUE_PRUNE_INTERVAL_MS`, `AI_DISABLED`

## Queue retry + dead-letter behavior

- Transient errors (retryable): provider HTTP `429` and `5xx`, plus timeout/rate-limit network failures.
- Permanent errors (non-retryable): schema/data violations (missing sheets/columns, invalid payload/schema, JSON parse issues) and provider `4xx` client failures.
- Retries use exponential backoff with jitter and stop at `max_attempts`.
- On `max_attempts` exceeded (or permanent error), the job status is set to `DEAD` and a JSON snapshot of the failure is stored in `dead_letter_error_json`.
- Each failed attempt is audit-logged with timestamp, error class, and provider response code.
- Queue lifecycle milestones are audit-logged as `RECEIVED`, `QUEUED`, `STARTED`, `COMPLETED`, `FAILED`, and `DEAD_LETTER` with actor, latency, and failure reason fields.
- AI: `GEMINI_API_KEY`, optional `GEMINI_MODEL` (default `gemini-1.5-flash`), optional per-agent Gem instruction properties like `GEMINI_GEM_PROGRESS_ASSISTANT`

Then run `menuEnsureTrackingColumns()` once to align headers.
