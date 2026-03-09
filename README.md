# Slack LMS Sequential Lesson Delivery (Google Apps Script)

This project delivers lessons from a CSV-imported Google Sheet to Slack sequentially using **Google Apps Script only**.

## Architecture

Google Sheets → Apps Script → Slack Bot API (`chat.postMessage`) → Slack DM/Channel.

Slash command `/learn` routes into this delivery flow and posts the next sequential lesson to the requesting learner's DM.

## Source Data

Import `lesson_slack_threads_filled_from_lessons.csv` into a sheet.

Required columns:

- `LessonID`
- `Slack Thread Text`
- `Submit Code`
- `Topic`

Optional source columns are supported and left unchanged.

The script auto-adds tracking columns if missing:

- `Posted Status`
- `Posted At`
- `Slack TS`
- `Slack Channel`
- `Lesson Order`
- `Error Log`

## Script Properties

Set these in **Project Settings → Script Properties**:

- `SLACK_BOT_TOKEN` (required)
- `DEFAULT_CHANNEL` (required unless row `Slack Channel` is populated)
- `SHEET_NAME` (default: `lesson_slack_threads_filled_from_lessons`)
- `DRY_RUN` (`true`/`false`, default `false`)
- `BATCH_LIMIT` (default `25`)
- `SHEETS_ID` (required, target spreadsheet id)

## Core Functions

Implemented in `LessonDelivery.gs`:

- `getConfig()`
- `getLessonSheet()`
- `ensureTrackingColumns()`
- `getLessons()`
- `getNextLesson()`
- `postLessonToSlack(lesson)`
- `markLessonPosted(rowIndex, slackResponse)`
- `markLessonError(rowIndex, errorMessage)`
- `postNextLesson()`
- `postAllLessons()`
- `postLessonById(lessonId)`

## Menu

When the sheet opens, a custom **Slack LMS** menu is added:

- Post Next Lesson
- Post All Lessons
- Post Lesson by ID
- Reset Post Status
- Test Slack Connection

## Delivery Rules

- Lessons are ordered by parsed `LessonID` (`M##-W##-L##`).
- A lesson is posted only when:
  - `Posted Status != TRUE`, and
  - `Slack TS` is empty.
- Message text is sent **exactly** from `Slack Thread Text`.
- Errors are logged to `Error Log` and `Logger`.

## Notes

- Uses Slack Web API endpoint `chat.postMessage`.
- Stores `ts` and `channel` from Slack response.
- Duplicate posting is blocked by status/timestamp checks.
