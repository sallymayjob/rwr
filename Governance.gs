function ensureSheetExists_(sheetName) {
  var sheet = SS.getSheetByName(sheetName);
  if (!sheet) sheet = SS.insertSheet(sheetName);
  return sheet;
}

function ensureGovernanceSheetsAndColumns() {
  var specs = [
    { name: 'Users', cols: ['UserID', 'SlackUserID', 'Email', 'DisplayName', 'Status', 'Created_At', 'Updated_At'] },
    { name: 'Cohorts', cols: ['CohortID', 'Name', 'TrackID', 'Start_Date', 'End_Date', 'Status'] },
    { name: 'Tracks', cols: ['TrackID', 'Track_Name', 'Description', 'Status'] },
    { name: 'Lesson_Content', cols: ['ContentID', 'LessonID', 'Content_Type', 'Body', 'Version', 'Status', 'Created_At'] },
    { name: 'Enrollments', cols: ['EnrollmentID', 'UserID', 'CourseID', 'CohortID', 'TrackID', 'Status', 'Enrolled_At', 'Updated_At'] },
    { name: 'Progress', cols: ['ProgressID', 'UserID', 'LessonID', 'MissionID', 'Status', 'Score', 'Completed_At'] },
    { name: 'Deliveries', cols: ['DeliveryID', 'UserID', 'LessonID', 'Channel', 'SlackTS', 'Delivery_Status', 'Delivered_At', 'Retry_Count'] },
    { name: 'Reminders', cols: ['ReminderID', 'UserID', 'LessonID', 'Reminder_Type', 'Scheduled_At', 'Sent_At', 'Status'] },
    { name: 'Approvals', cols: ['ApprovalID', 'Entity_Type', 'Entity_ID', 'Requested_By', 'Approver', 'Decision', 'Decision_At', 'Notes'] },
    { name: 'Settings', cols: ['Setting_Key', 'Setting_Value', 'Updated_At', 'Updated_By'] },
    { name: 'Workflow_Rules', cols: ['RuleID', 'Rule_Name', 'Entity_Type', 'From_Status', 'To_Status', 'Guard_Condition', 'Is_Active'] },
    { name: 'Audit_Log', cols: ['Timestamp', 'Action', 'Actor_UserID', 'Entity_Type', 'Entity_ID', 'Outcome', 'Details_JSON'] },
    { name: 'Error_Log', cols: ['Timestamp', 'Source', 'Error_Class', 'Message', 'Context_JSON', 'Retryable', 'Resolved_Status'] },
    { name: 'Admin_Actions', cols: ['Timestamp', 'Admin_UserID', 'Command', 'Target_UserID', 'Outcome', 'Notes'] },
    { name: 'Content_Pipeline', cols: ['PipelineID', 'LessonID', 'Stage', 'Status', 'Owner', 'Started_At', 'Completed_At', 'Details_JSON'] },
    { name: 'Prompt_Configs', cols: ['PromptID', 'Agent_Name', 'Version', 'Provider', 'Gem_Key', 'Prompt_Text', 'Is_Active', 'Updated_At'] },
    { name: 'Gem_Roles', cols: ['GemRoleID', 'Agent_Name', 'Gem_Key', 'Model', 'Status', 'Updated_At'] },
    { name: 'QA_Results', cols: ['QAResultID', 'LessonID', 'PipelineID', 'QA_Type', 'QA_Score', 'Verdict', 'Run_At', 'Details_JSON'] },
    { name: 'Publish_Queue', cols: ['PublishID', 'LessonID', 'Status', 'Requested_By', 'Requested_At', 'Published_At', 'Error'] },
    { name: 'Generated_Drafts', cols: ['DraftID', 'LessonID', 'PromptID', 'GemRoleID', 'Version', 'Draft_Text', 'Status', 'Created_At'] }
  ];

  specs.forEach(function(spec) {
    ensureSheetExists_(spec.name);
    ensureSheetColumnsByName_(spec.name, spec.cols);
  });
}

function appendAuditLog(action, actorUserId, entityType, entityId, outcome, detailsObj) {
  try {
    ensureSheetExists_('Audit_Log');
    ensureSheetColumnsByName_('Audit_Log', ['Timestamp', 'Action', 'Actor_UserID', 'Entity_Type', 'Entity_ID', 'Outcome', 'Details_JSON']);
    var sheet = SS.getSheetByName('Audit_Log');
    sheet.appendRow([
      new Date(),
      String(action || ''),
      String(actorUserId || ''),
      String(entityType || ''),
      String(entityId || ''),
      String(outcome || ''),
      JSON.stringify(detailsObj || {})
    ]);
  } catch (err) {
    Logger.log('appendAuditLog error: ' + err);
  }
}

function appendErrorLog(source, errorClass, message, contextObj, retryable) {
  try {
    ensureSheetExists_('Error_Log');
    ensureSheetColumnsByName_('Error_Log', ['Timestamp', 'Source', 'Error_Class', 'Message', 'Context_JSON', 'Retryable', 'Resolved_Status']);
    var sheet = SS.getSheetByName('Error_Log');
    sheet.appendRow([
      new Date(),
      String(source || ''),
      String(errorClass || ''),
      String(message || ''),
      JSON.stringify(contextObj || {}),
      retryable ? 'TRUE' : 'FALSE',
      'OPEN'
    ]);
  } catch (err) {
    Logger.log('appendErrorLog error: ' + err);
  }
}

function appendAdminAction(adminUserId, command, targetUserId, outcome, notes) {
  try {
    ensureSheetExists_('Admin_Actions');
    ensureSheetColumnsByName_('Admin_Actions', ['Timestamp', 'Admin_UserID', 'Command', 'Target_UserID', 'Outcome', 'Notes']);
    var sheet = SS.getSheetByName('Admin_Actions');
    sheet.appendRow([new Date(), String(adminUserId || ''), String(command || ''), String(targetUserId || ''), String(outcome || ''), String(notes || '')]);
  } catch (err) {
    Logger.log('appendAdminAction error: ' + err);
  }
}
