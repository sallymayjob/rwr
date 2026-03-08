const PROPS = PropertiesService.getScriptProperties();
const SS = SpreadsheetApp.openById(PROPS.getProperty('SHEETS_ID'));

const SHEET_LESSONS = 'Lessons';
const SHEET_MODULES = 'Modules';
const SHEET_COURSES = 'Courses';
const SHEET_LEARNERS = 'Learners';
const SHEET_SUBMISSIONS = 'Lesson_Submissions';
const SHEET_QA = 'Lesson_QA_Records';
const SHEET_METRICS = 'Lesson_Metrics';
const SHEET_THREADS = 'Slack_Threads';
const SHEET_QUEUE = 'Queue';

const SLACK_API_BASE = 'https://slack.com/api/';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const AGENT_PROVIDER = {
  // Claude — pedagogical and coaching agents
  quiz_master: 'claude',
  content_validator: 'claude',
  ped_coach: 'claude',
  mission_feedback: 'claude',

  // Gemini — reporting, summarisation, operational agents
  progress_assistant: 'gemini',
  report_generator: 'gemini',
  gaps_analyser: 'gemini',
  general_assistant: 'gemini',
  cert_checker: 'gemini',
  courses_lister: 'gemini',
  mix_generator: 'gemini',
  media_agent: 'claude'
};

function getProvider(agentName) {
  return AGENT_PROVIDER[agentName] || 'claude';
}

function isAdmin(userId) {
  if (!userId) return false;
  const raw = PROPS.getProperty('ADMIN_USER_IDS') || '';
  const admins = raw
    .split(',')
    .map(function(v) { return v.trim(); })
    .filter(function(v) { return !!v; });
  return admins.indexOf(userId) !== -1;
}

function adminOnly(payload, fn) {
  if (isAdmin(payload.user_id)) return fn();
  return { text: "You don't have permission to use this command." };
}
