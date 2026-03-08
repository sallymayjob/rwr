# Deployment Guide — RWR Group Agentic LMS

This guide describes how to deploy the Apps Script LMS and connect it to Slack.

## 1) Prerequisites

- Google account with Apps Script and Drive access
- Slack workspace admin access (for slash commands/events)
- Spreadsheet prepared with required tabs
- API access:
  - Anthropic API key
  - Google Gemini API key (AI Studio)

## 2) Prepare Google Sheet

Create a Google Spreadsheet and include these exact tab names:

1. `Lessons`
2. `Modules`
3. `Courses`
4. `Learners`
5. `Lesson_Submissions`
6. `Lesson_QA_Records`
7. `Lesson_Metrics`
8. `Slack_Threads`
9. `Queue`

Ensure header rows match your production schema.

## 3) Create Apps Script Project

1. Open Apps Script.
2. Create a new project.
3. Add/replace files with:
   - `Config.gs`
   - `Auth.gs`
   - `Sheets.gs`
   - `Slack.gs`
   - `Agents.gs`
   - `Code.gs`
4. Save all files.

## 4) Set Script Properties

In Apps Script:

- **Project Settings** → **Script Properties** → add:

- `SLACK_BOT_TOKEN` = `xoxb-...`
- `SLACK_SIGNING_SECRET` = `...`
- `ANTHROPIC_API_KEY` = `sk-ant-...`
- `GEMINI_API_KEY` = `AIza...`
- `SHEETS_ID` = `<Google Spreadsheet ID>`
- `DRIVE_ROOT_ID` = `<Drive folder ID>`
- `ADMIN_USER_IDS` = `U123...,U456...`

## 5) Deploy Web App

1. Click **Deploy** → **New deployment**.
2. Type: **Web app**.
3. Execute as: **Me**.
4. Access: **Anyone** (or workspace policy equivalent needed by Slack).
5. Deploy and copy the Web App URL.

## 6) Configure Slack App

In your Slack App settings:

### Slash Commands

Create commands pointing to the Web App URL:

- `/learn`, `/submit`, `/progress`, `/courses`, `/help`, `/cert`
- `/enroll`, `/unenroll`, `/onboard`, `/offboard`, `/report`, `/gaps`, `/backup`, `/mix`, `/media`

### Event Subscriptions

- Enable events and set Request URL to the same Web App URL.
- Subscribe to bot events:
  - `app_mention`
  - `message.im`
  - `reaction_added`

### OAuth Scopes (typical)

Ensure bot token has scopes required by your implemented Slack APIs, such as:

- `chat:write`
- `commands`
- `im:write`
- `im:history`
- `users:read`
- `users:read.email`
- `reactions:read`
- `channels:history` (if needed by your workflow)

Install/reinstall app to workspace after scope changes.

## 7) Create Queue Trigger

In Apps Script editor, run once:

- `setupTrigger()`

This installs a time-based trigger to execute `processQueuedPipeline()` every minute.

## 8) Verify End-to-End

1. Run `/help` in Slack and confirm DM response.
2. Run `/learn` as enrolled learner and verify lesson delivery.
3. Submit `/submit <lessonId> <evidence>` and verify submission/progress update.
4. Trigger an admin command (e.g., `/report`) with an admin user.
5. Confirm `Queue` status transitions and logs in Apps Script execution history.

## 9) Troubleshooting


### Trigger setup checklist

If queue jobs are not processing, verify trigger setup exactly:

1. Open Apps Script -> Triggers (clock icon).
2. Confirm there is a trigger for function `processQueuedPipeline`.
3. Event source: **Time-driven**.
4. Type: **Minutes timer**.
5. Interval: **Every 1 minute**.
6. If missing, run `setupTrigger()` once from the editor and re-check Triggers.

### Invalid signature

- Verify `SLACK_SIGNING_SECRET` exactly matches Slack app setting.
- Confirm Slack requests hit the same deployment URL.

### TypeError: Cannot read properties of undefined (reading "postData")

- This happens if `doPost` is run directly from the Apps Script editor.
- `doPost` must be invoked by an actual HTTP POST request from Slack.
- Test by using Slack command/event calls, not the editor Run button.

### processQueuedPipeline error: Sheet not found: Queue

- Ensure your spreadsheet has a tab named exactly `Queue` (case-sensitive), or let runtime auto-create it when queue writes occur.
- Confirm `SHEETS_ID` points to the correct spreadsheet in Script Properties.
- After fixing, run one slash command to enqueue and verify `PENDING` rows appear.

### Signing secret appears invalid even when correct

- Redeploy a **new version** of the Web App after property/code changes.
- Confirm Slack is calling that exact deployed URL.
- In Apps Script logs, if headers are unavailable in runtime, configure `SLACK_VERIFICATION_TOKEN` as fallback.

### No DM or Slack API errors

- Validate bot scopes and app installation.
- Confirm `SLACK_BOT_TOKEN` is valid and not revoked.

### AI unavailable

- Validate `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`.
- Check provider-specific rate limits/quota.
- Review execution logs for fallback messages and HTTP codes.

### Queue stuck in ERROR

- Inspect `Payload_Json` row and execution logs.
- Correct data/permissions issue and requeue by setting status to `PENDING` (if desired).

## 10) Post-Deployment Operations

- Monitor execution logs for:
  - AI provider failures / rate limits
  - queue processing duration
  - recurring handler errors
- Periodically back up Sheets content.
- Rotate API keys/tokens per security policy.
