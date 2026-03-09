# Slack Onboarding + Lesson Automation (Google Apps Script)

This project runs fully in Google Apps Script and uses Google Sheets as the source of truth.

Architecture:

Google Sheets → Apps Script → Slack Bot API (`chat.postMessage`, `views.open`) → Slack Interactivity (`doPost`) → Google Sheets tracking updates.

## Onboarding source of truth

Use the sheet imported from:

- `onboarding_workflow_filled_slack_messages.csv`

The onboarding flow strictly follows sheet row order.

## Required onboarding columns

Minimum required:

- `Slack Message`

Common supported fields (if present):

- `Task / Checklist Step`
- `Task`
- `Checklist Step`
- `Responsible`
- `Responsibility`
- `Owner`
- `Assignee`
- `Responsible Team`
- `Slack Channel` / `Channel` / `Channel ID` / `Responsible Channel` / `Team Channel`

## Auto-created onboarding tracking columns

The script ensures these columns exist and writes status updates to them:

- `Step ID`
- `Posted Status`
- `Posted At`
- `Slack TS`
- `Slack Channel`
- `Modal Status`
- `Modal Opened At`
- `Submitted At`
- `Completed Status`
- `Completed By`
- `Notes / Response`
- `Error Log`

`Step ID` is generated automatically when missing.

## Script Properties

Set in Apps Script → Project Settings → Script Properties:

- `SHEETS_ID`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET` (recommended)
- `SLACK_VERIFICATION_TOKEN` (optional fallback)
- `ONBOARDING_SHEET_NAME` (default `onboarding_workflow_filled_slack_messages`)
- `DEFAULT_ONBOARDING_CHANNEL`
- `DRY_RUN` (`true`/`false`)
- `BATCH_LIMIT` (default `25`)
- `WEBAPP_URL` (optional placeholder for future links)

Existing lesson properties continue to work.

## Slack setup

1. Create/install Slack app.
2. Bot scopes:
   - `chat:write`
   - `commands` (if using slash commands)
   - `users:read` (optional)
3. Enable Interactivity and set Request URL to your Apps Script Web App URL.
4. Event subscriptions / slash commands can share the same web app endpoint.

## Deploy Apps Script Web App

1. Deploy → New deployment → type **Web app**.
2. Execute as: **Me**.
3. Who has access: **Anyone** (or org policy compatible with Slack callbacks).
4. Copy deployment URL and use it in Slack Interactivity Request URL.

## Onboarding runtime behavior

### 1) Post onboarding step

- `postNextOnboardingStep()` posts the next unposted and not-complete row in order.
- Message body uses the row `Slack Message` value directly.
- Message includes a Block Kit button (`Open Workflow`) and step metadata.

### 2) Open modal

- Button click sends Slack `block_actions` payload to `doPost(e)`.
- `handleSlackInteraction(payload)` routes onboarding actions.
- `openOnboardingModal(triggerId, row)` calls `views.open`.
- Modal metadata stores `Step ID`, row index, channel, and message ts.

### 3) Submit modal

- Slack `view_submission` is parsed in `doPost(e)`.
- `handleOnboardingModalSubmit(payload)` updates the correct row by metadata row index.
- Writes modal and completion fields (`Modal Status`, `Submitted At`, `Completed Status`, `Completed By`, `Notes / Response`).

### 4) Continue sequence

- Next step is still determined by sheet row order.
- Completed rows are skipped.
- Posted rows are not reposted unless reset.

## Custom menu

`Slack Automation` menu includes:

- Post Next Onboarding Step
- Post All Onboarding Steps
- Post Onboarding Step By ID/Row
- Generate Missing Step IDs
- Reopen Step Modal
- Reset Posted Status
- Ensure Tracking Columns
- Test Slack Connection

## Testing checklist

1. Import CSV into onboarding sheet.
2. Run **Ensure Tracking Columns**.
3. Run **Generate Missing Step IDs**.
4. Run **Post Next Onboarding Step**.
5. Click **Open Workflow** in Slack.
6. Submit modal with status and notes.
7. Verify tracking columns updated in the same row.
