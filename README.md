# RWR Group Agentic LMS (Google Apps Script)

A Slack-native learning management system for RWR Group, built on:

- **Slack Pro** (slash commands + events)
- **Google Apps Script Web App** (single webhook entrypoint)
- **AI providers**:
  - Anthropic Claude (`claude-sonnet-4-6`)
  - Google Gemini (`gemini-2.0-flash`)
- **Google Sheets** as the operational datastore

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
- `/submit <lessonId> <evidence>` — Submit lesson verification.
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

## Slack Events

- `app_mention`
- DM messages (`message` with `channel_type=im`)
- `reaction_added` for `white_check_mark` (`✅`)

## Data Model (Sheets)

Expected sheet tabs (case-sensitive):

- `Lessons`
- `Modules`
- `Courses`
- `Learners`
- `Lesson_Submissions`
- `Lesson_QA_Records`
- `Lesson_Metrics`
- `Slack_Threads`
- `Queue`

## AI Provider Routing

Agent routing is configured in `Config.gs` (`AGENT_PROVIDER`).

- Pedagogical scoring/coaching routes to **Claude**
- Reporting/operational/generic assistant routes to **Gemini**
- Unknown agent defaults to **Claude**

## Quick Start

1. Read `DEPLOYMENT.md`.
2. Create/populate the required Google Sheets tabs.
3. Set Script Properties (tokens, keys, IDs).
4. Deploy as a Web App.
5. Connect Slack slash commands and event subscriptions to the Web App URL.
6. Use `/startlesson` to enable lessons (manual mode, no scheduled trigger).

## Security Notes

- Keep all secrets in Script Properties only.
- Never hardcode API keys/tokens in source.
- Ensure Slack signature validation is enabled before routing.
- Restrict admin operations through `ADMIN_USER_IDS`.

## Operational Notes

- `doPost` only validates/parses/enqueues and returns fast.
- `processQueuedPipeline` processes queued jobs and sets status (`PENDING`/`RUNNING`/`DONE`/`ERROR`).
- Failed queue items remain visible for troubleshooting.

## Next Steps

- Add execution log alerting (queue errors, provider failures, rate limiting).
- Add periodic archival or cleanup strategy for historical queue/submission volume.
- Add automated Apps Script tests or external harness for regression checks.


## Media Agent

Use `/media <lessonId>` (admin only) to run a media-needs review for a lesson. The agent defaults to no media and only recommends visuals when they materially improve clarity. It writes `Media Required` (`TRUE`/`FALSE`) and `Media Brief` (JSON brief text when required) directly to the `Lessons` sheet.


## Workflow Builder Auto-Enrol

You can auto-enrol users via Slack Workflow Builder by sending a webhook payload containing user info and `workflow_trigger=enroll` (or `action=enroll`). The backend queues a `workflow_enroll` job and upserts the learner into `Learners`. Optionally set `WORKFLOW_ENROLL_LINK` in Script Properties so not-enrolled users receive an *Enrol* button in DM.


## AI Execution Mode

This deployment runs in **non-AI mode**. Claude and Gemini calls are disabled, and command-based LMS behavior is used for execution.


## Manual Lesson Trigger

Use `/startlesson` and `/stoplesson` (admin only) to control whether learner lesson commands are active. No automated time-based trigger is used.


Onboarding note: `/onboard @username` now auto-enrols into `COURSE_12M`, sets `Current Module` to `M0`, sends orientation DM, and delivers first available lesson automatically.
