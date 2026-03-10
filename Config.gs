const PROPS = PropertiesService.getScriptProperties();
const SS = SpreadsheetApp.openById(PROPS.getProperty('SHEETS_ID'));

// Canonical LMS sheet names
const SHEET_COURSES = 'Courses';
const SHEET_MODULES = 'Modules';
const SHEET_COURSE_MODULE_MAP = 'Course_Module_Map';
const SHEET_LESSONS = 'Lessons';
const SHEET_MISSIONS = 'Missions';
const SHEET_METRICS = 'Lesson_Metrics';
const SHEET_QA = 'Lesson_QA_Details';
const SHEET_SLACK_DELIVERY = 'Slack_Delivery';
const SHEET_THREADS = SHEET_SLACK_DELIVERY;

// Operational sheets
const SHEET_LEARNERS = 'Learners';
const SHEET_SUBMISSIONS = 'Lesson_Submissions';
const SHEET_QUEUE = 'Queue';
const SHEET_ONBOARDING = 'onboarding_workflow_filled_slack_messages';

const SLACK_API_BASE = 'https://slack.com/api/';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const AGENT_PROVIDER = {
  quiz_master: 'claude',
  content_validator: 'claude',
  ped_coach: 'claude',
  mission_feedback: 'claude',
  progress_assistant: 'gemini',
  report_generator: 'gemini',
  gaps_analyser: 'gemini',
  general_assistant: 'gemini',
  cert_checker: 'gemini',
  courses_lister: 'gemini',
  mix_generator: 'gemini',
  media_agent: 'claude'
};

function getProvider(agentName) { return AGENT_PROVIDER[agentName] || 'claude'; }

function isAdmin(userId) {
  if (!userId) return false;
  const raw = PROPS.getProperty('ADMIN_USER_IDS') || '';
  const admins = raw.split(',').map(function(v) { return v.trim(); }).filter(function(v) { return !!v; });
  return admins.indexOf(userId) !== -1;
}

function adminOnly(payload, fn) {
  var actor = payload && payload.user_id ? payload.user_id : '';
  var command = payload && payload.command ? payload.command : '';
  var target = payload && payload.text ? String(payload.text || '').trim().split(/\s+/)[0] : '';

  if (!isAdmin(actor)) {
    appendAdminAction(actor, command, target, 'DENIED', 'User is not in ADMIN_USER_IDS');
    return postDM(actor, "You don't have permission to use this command.");
  }

  try {
    var result = fn();
    appendAdminAction(actor, command, target, 'SUCCESS', '');
    return result;
  } catch (err) {
    appendAdminAction(actor, command, target, 'ERROR', String(err));
    appendErrorLog('adminOnly', 'ADMIN_COMMAND_ERROR', String(err), { command: command, actor: actor, target: target }, false);
    return postDM(actor, 'Admin command failed. Please check logs and /health.');
  }
}

function isLessonTriggerActive() {
  return (PROPS.getProperty('LESSON_TRIGGER_ACTIVE') || 'false').toLowerCase() === 'true';
}

function setLessonTriggerActive(active) {
  PROPS.setProperty('LESSON_TRIGGER_ACTIVE', active ? 'true' : 'false');
}

function isFeatureEnabled(flagName, defaultValue) {
  var key = String(flagName || '').trim();
  if (!key) return !!defaultValue;

  var raw = PROPS.getProperty(key);
  if (raw == null || raw === '') return !!defaultValue;

  raw = String(raw).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
