# Slack Training + Onboarding Automation (Google Apps Script)

This project runs entirely in:

Google Sheets → Google Apps Script → Slack Bot API

It supports **two workflows in one Apps Script project**:

1. **Lesson delivery workflow** from `lesson_slack_threads_filled_from_lessons`
2. **Onboarding workflow** from `onboarding_workflow_filled_slack_messages`

## Required Sheets

Set sheet names through Script Properties (defaults shown):

- `LESSONS_SHEET_NAME` (default: `lesson_slack_threads_filled_from_lessons`)
- `ONBOARDING_SHEET_NAME` (default: `onboarding_workflow_filled_slack_messages`)

## Required Source Columns

### Lessons sheet

- `LessonID`
- `Slack Thread Text`

(Other lesson columns like `Submit Code` and `Topic` are preserved and can still exist.)

### Onboarding sheet

- `Slack Message`

Optional routing fields supported when present:

- `Slack Channel`, `Channel`, `Channel ID`, `Responsible Channel`, `Team Channel`
- `Responsible`, `Responsibility`, `Owner`, `Assignee`, `Responsible Team`

## Auto-created Tracking Columns

The script auto-adds missing tracking columns.

### Lessons tracking

- `Posted Status`
- `Posted At`
- `Slack TS`
- `Slack Channel`
- `Error Log`

### Onboarding tracking

- `Posted Status`
- `Posted At`
- `Slack TS`
- `Slack Channel`
- `Completed Status`
- `Error Log`

## Script Properties

Configure in Apps Script → Project Settings → Script Properties:

- `SHEETS_ID` (Spreadsheet ID)
- `SLACK_BOT_TOKEN` (Bot token)
- `LESSONS_SHEET_NAME`
- `ONBOARDING_SHEET_NAME`
- `DEFAULT_LESSON_CHANNEL`
- `DEFAULT_ONBOARDING_CHANNEL`
- `DRY_RUN` (`true` or `false`)
- `BATCH_LIMIT` (default `25`)

Backward compatibility:

- `SHEET_NAME` is still read as a fallback for lessons.
- `DEFAULT_CHANNEL` is still read as a fallback for lesson channel.

## Slack Setup

- Install Slack app to workspace.
- Add `chat:write` scope.
- Use bot token in `SLACK_BOT_TOKEN`.
- If using incoming events/slash commands in other files, keep existing Slack Events setup.

## How to Run

Use the custom menu: **Slack Automation**

### Lesson flow

- Post Next Lesson
- Post All Lessons
- Post Lesson By ID

Behavior:

- Sorted by parsed `LessonID` (`M##-W##-L##`)
- Posts `Slack Thread Text` exactly as prepared
- Prevents duplicates if `Posted Status` is set or `Slack TS` exists

### Onboarding flow

- Post Next Onboarding Step
- Post All Onboarding Steps
- Post Onboarding Step By ID/Row

Behavior:

- Sequential by sheet row order
- Posts `Slack Message` exactly as prepared (with optional owner prefix)
- Prevents duplicates if `Posted Status` is set or `Slack TS` exists

### Utilities

- Ensure Tracking Columns
- Test Slack Connection
