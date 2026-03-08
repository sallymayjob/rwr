function slackFetch(endpoint, payload) {
  try {
    const token = PROPS.getProperty('SLACK_BOT_TOKEN');
    const res = UrlFetchApp.fetch(SLACK_API_BASE + endpoint, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true
    });

    if (res.getResponseCode() !== 200) {
      Logger.log('Slack HTTP error ' + endpoint + ': ' + res.getContentText());
      return { ok: false, error: 'http_' + res.getResponseCode() };
    }
    const data = JSON.parse(res.getContentText());
    if (!data.ok) Logger.log('Slack API error ' + endpoint + ': ' + res.getContentText());
    return data;
  } catch (err) {
    Logger.log('slackFetch exception ' + endpoint + ': ' + err);
    return { ok: false, error: String(err) };
  }
}

function postMessage(channelId, text, blocks) {
  return slackFetch('chat.postMessage', {
    channel: channelId,
    text: text || '',
    blocks: blocks || undefined
  });
}

function updateMessage(channelId, ts, text, blocks) {
  return slackFetch('chat.update', {
    channel: channelId,
    ts: ts,
    text: text || '',
    blocks: blocks || undefined
  });
}

function openDM(userId) {
  const data = slackFetch('conversations.open', { users: userId });
  if (!data.ok || !data.channel || !data.channel.id) return null;
  return data.channel.id;
}

function postDM(userId, text, blocks) {
  const dm = openDM(userId);
  if (!dm) return { ok: false, error: 'could_not_open_dm' };
  return postMessage(dm, text, blocks);
}

function getUserInfo(userId) {
  const data = slackFetch('users.info', { user: userId });
  if (!data.ok || !data.user) return null;
  return {
    name: data.user.real_name || data.user.name || '',
    email: (data.user.profile && data.user.profile.email) || ''
  };
}

function buildLessonBlocks(slackThreadText, lessonId, userId, rowIndex) {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: slackThreadText || ('Lesson ' + lessonId) }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Mark Complete' },
          style: 'primary',
          action_id: 'lesson_complete',
          value: JSON.stringify({
            lesson_id: lessonId,
            user_id: userId,
            row_index: rowIndex
          })
        }
      ]
    }
  ];
}

function buildProgressBlocks(learner, submissions, moduleRow) {
  const completed = submissions.length;
  const progress = learner['Progress (%)'] || 0;
  const nextLesson = getCurrentLessonId(learner) || 'All lessons complete in this module';

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Your Progress' }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Learner:*\n' + (learner['Name'] || learner['UserID']) },
        { type: 'mrkdwn', text: '*Course:*\n' + (learner['Enrolled Course'] || 'Not enrolled') },
        { type: 'mrkdwn', text: '*Current Module:*\n' + (learner['Current Module'] || '-') },
        { type: 'mrkdwn', text: '*Submissions:*\n' + completed },
        { type: 'mrkdwn', text: '*Progress:*\n' + progress + '%' },
        { type: 'mrkdwn', text: '*Next Lesson:*\n' + nextLesson }
      ]
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: moduleRow ? ('Module status: *' + (moduleRow['Status'] || '-') + '*') : 'No module row found.' }
      ]
    }
  ];
}

function buildReportBlocks(learnerRows, submissionRows, moduleRows) {
  const activeLearners = learnerRows.filter(function(l) { return String(l['Status']) === 'Active'; }).length;
  const submissionsCount = submissionRows.length;
  let avgProgress = 0;

  if (learnerRows.length) {
    const sum = learnerRows.reduce(function(acc, l) { return acc + Number(l['Progress (%)'] || 0); }, 0);
    avgProgress = Math.round(sum / learnerRows.length);
  }

  const moduleSummary = moduleRows.map(function(m) {
    return '• ' + m['ModuleID'] + ' — ' + (m['Published Lessons'] || 0) + '/' + (m['Total Lessons'] || 0) + ' published';
  }).slice(0, 20).join('\n');

  return [
    { type: 'header', text: { type: 'plain_text', text: 'Cohort Report' } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Active Learners:*\n' + activeLearners },
        { type: 'mrkdwn', text: '*Total Submissions:*\n' + submissionsCount },
        { type: 'mrkdwn', text: '*Avg Progress:*\n' + avgProgress + '%' },
        { type: 'mrkdwn', text: '*Modules:*\n' + moduleRows.length }
      ]
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Module Breakdown*\n' + (moduleSummary || 'No modules found.') }
    }
  ];
}
