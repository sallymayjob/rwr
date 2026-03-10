# RWR Slack Learning Bot (Simple Guide)

This project is a Slack bot that helps people learn through short lessons.

If you are not technical, use this page as your plain-language guide.

---

## What this bot does

- Sends lessons in Slack.
- Accepts learner submissions.
- Tracks progress in Google Sheets.
- Lets admins run commands like enroll, report, and backup.

---

## What you need

1. A Google account.
2. A Google Sheet (the bot stores learner data here).
3. A Slack workspace where you can create/manage a Slack app.
4. A Google Apps Script project connected to this code.

---

## Basic flow (non-technical)

1. You set up Google Sheets tabs.
2. You add secret keys in Apps Script settings.
3. You deploy Apps Script as a Web App.
4. You paste that Web App URL into Slack app settings.
5. Slack sends requests to your script.
6. Learners use slash commands in Slack.

---

## Common commands learners use

- `/learn` → get next lesson
- `/submit <submit_code> <evidence>` → submit work
- `/progress` → see progress
- `/courses` → list courses
- `/help` → command help

## Common commands admins use

- `/enrol <userId>` and `/unenrol <userId>`
- `/onboard <userId>` and `/offboard <userId>`
- `/report`, `/gaps`, `/backup`
- `/schema` (checks sheet structure)
- `/startlesson` and `/stoplesson`

---

## If Slack says “URL isn’t verified”

Do these checks in order:

1. Confirm Slack Request URL exactly matches your deployed Web App URL.
2. Confirm you deployed a **new version** after making code changes.
3. Confirm Apps Script property `SLACK_SIGNING_SECRET` is set to your Slack app **Signing Secret**.
4. Confirm Slack events/interactivity/commands all point to the same current Web App URL.
5. Retry verification in Slack.

---

## Important: after every code change

In Google Apps Script, pressing Save is **not enough**.

You must:

1. Go to **Deploy** → **Manage deployments**.
2. Edit your active deployment.
3. Select **New version**.
4. Deploy.

Then test again in Slack.

---

## Where settings live

In Apps Script, go to Script Properties and set:

Required:
- `SHEETS_ID`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`

Optional emergency fallback (deprecated by Slack):
- `SLACK_VERIFICATION_TOKEN` = verification token from Slack app Basic Info

Recommended:
- `ADMIN_USER_IDS`
- `DEFAULT_LESSON_CHANNEL`
- `DEFAULT_ONBOARDING_CHANNEL`

---

## Need step-by-step setup?

Use `DEPLOYMENT.md` for a full beginner walkthrough.
