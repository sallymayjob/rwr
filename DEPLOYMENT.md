# Deployment (Beginner-Friendly)

This guide is written for people with little or no technical background.

Follow the steps in order.

---

## Step 1: Prepare your Google Sheet

Create one Google Sheet file that will store bot data.

Create these tabs (sheet names):

- `Courses`
- `Modules`
- `Course_Module_Map`
- `Lessons`
- `Missions`
- `Lesson_Metrics`
- `Lesson_QA_Details`
- `Slack_Delivery`
- `Learners`
- `Lesson_Submissions`
- `Queue`

If your project includes menu helpers, run `menuEnsureTrackingColumns()` once.

---

## Step 2: Set Apps Script properties

In Google Apps Script:

1. Open **Project Settings**.
2. Find **Script properties**.
3. Add these required keys:

- `SHEETS_ID` = your Google Sheet ID
- `SLACK_BOT_TOKEN` = bot token from Slack
- `SLACK_SIGNING_SECRET` = signing secret from Slack app Basic Info

Recommended keys:

- `ADMIN_USER_IDS`
- `SLACK_AUTH_TOKEN_FALLBACK` = `false`
- `DEFAULT_LESSON_CHANNEL`
- `DEFAULT_ONBOARDING_CHANNEL`

---

## Step 3: Deploy Apps Script as Web App

1. Click **Deploy** → **New deployment** (or Manage deployments).
2. Choose **Web app**.
3. Set access as needed for your organization.
4. Deploy and copy the Web App URL.

You will paste this URL into Slack in the next step.

---

## Step 4: Configure your Slack app

In Slack app settings:

1. **Event Subscriptions** → Enable.
2. Paste the Web App URL as Request URL.
3. **Interactivity & Shortcuts** → Enable and paste the same URL.
4. **Slash Commands** → each command should use the same URL.

Required bot scopes usually include:

- `chat:write`
- `commands`
- `users:read`
- `users:read.email`
- `im:read`
- `im:write`
- `reactions:read`
- `channels:history`
- `app_mentions:read`

Subscribe to needed bot events:

- `message.channels`
- `message.im`
- optional: `app_mention`, `reaction_added`

---

## Step 5: Verify Slack URL

If Slack shows “URL isn’t verified”:

1. Confirm `SLACK_SIGNING_SECRET` is correct (not client secret, not verification token).
2. Confirm the URL in Slack exactly matches your latest deployed Web App URL.
3. Confirm you deployed a **new version** after latest code updates.
4. Try verification again.

---

## Step 6: Test in Slack

Try these commands:

- `/help`
- `/learn`
- `/submit <submit_code> <evidence>`
- `/progress`

Admin tests:

- `/onboard <userId>`
- `/report`

---

## Step 7: Every time you change code

Do this every time, even for small edits:

1. Save code.
2. Deploy → Manage deployments.
3. Edit deployment.
4. Select **New version**.
5. Deploy.

If you skip this, Slack keeps calling old code.

---

## Quick troubleshooting

### Error: `{"error":"Invalid signature"}`

- Re-check `SLACK_SIGNING_SECRET`.
- Make sure Slack is calling the correct URL.
- Redeploy as a new version.
- Retry.

### Error: Slack says request URL not verified

- Same checks as above.
- Also make sure Event Subscriptions is enabled.

### Bot not responding to commands

- Ensure slash command URL matches your current Web App URL.
- Confirm bot token and scopes are set.
- Reinstall app to workspace if you changed scopes.
