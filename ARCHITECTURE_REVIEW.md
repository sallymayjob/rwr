# Production Readiness Architecture Review

## 1. Executive Architecture Summary
The codebase is largely aligned to the intended stack: Slack is the external interface, Apps Script is the orchestration runtime, and Google Sheets is the primary system of record for LMS data and operations. The webhook path is sensibly split into fast ACK + queued processing, which is appropriate for Slack SLAs and Apps Script limits.

However, this is not yet production-ready as an end-to-end **Slack LMS + onboarding + lesson delivery + content factory** implementation because the AI/content layer is effectively disabled (`callAI` always returns a static disabled response), onboarding interactivity handlers are stubs, and there are schema/flow inconsistencies that will cause drift in live operations.

## 2. What Matches the Target Architecture
- **Stack alignment exists at runtime boundaries:**
  - Slack app manifest defines slash commands, events, and interactivity endpoints.
  - Apps Script `doPost` validates, queues, and routes requests.
  - Sheets constants and helpers define canonical LMS tabs (`Courses`, `Modules`, `Course_Module_Map`, `Lessons`, `Missions`, `Lesson_QA_Details`, `Slack_Delivery`, etc.).
- **Sheets as system of record:** lesson, mission, QA, delivery, learner, submission, and queue state are read/written in sheet-backed functions.
- **Apps Script orchestration pattern is sound for small teams:** queue sheet + scheduled trigger + lock usage + dedupe window reduce Slack timeout risk.
- **Slack is correctly the learner/admin interface:** slash-command driven learner journey and admin operations exist (/learn, /submit, /progress, /onboard, /report, /gaps, /backup, etc.).
- **Core LMS flow wiring is present:**
  - `/submit` resolves `Missions` by submit code.
  - delivery checks QA gate before posting.
  - reactions map completion by `Slack Channel + Slack TS` to `Slack_Delivery`.

## 3. Architecture Mismatches
- **AI architecture drift vs requested Gemini/Gems placement:**
  - Provider mapping references Gemini/Claude, but `callAI` is globally disabled and does not call Gemini APIs or Gems.
  - This means the “content factory” and AI-assisted reporting/feedback are not truly implemented, only scaffolded.
- **Onboarding orchestration is incomplete:** key interactivity functions (`handleSlackInteraction`, onboarding modal update handlers, reopen/reset helpers) are placeholders/no-ops, so workflow completion cannot be considered production-capable.
- **Schema contract drift in at least one module path:** `agentCert` reads `Lessons` using `Module` column, while canonical schema uses `ModuleID`; this creates inconsistent behavior depending on sheet headers.
- **Manifest/documentation mismatch:** manifest long description still describes `/submit <lessonId> <evidence>` while command implementation and README now use `<submit_code> <evidence>`.

## 4. Missing Production Components
- **Real Gemini/Gems integration layer:**
  - No authenticated Gemini API execution path.
  - No Gem selection/routing strategy, prompt/version governance, retry policy, or safety/error policy for AI operations.
- **Operational observability and reliability controls:**
  - No dead-letter/retry-count semantics in queue rows.
  - No structured audit/event log sheet for command execution outcomes.
  - Limited health/admin diagnostics (no `/health` or schema-integrity report).
- **Security hardening:** token fallback mode is enabled by default and can bypass signed-request-only posture unless explicitly disabled.
- **Change-safe schema governance:** there is column auto-ensure, but no startup integrity audit that blocks command processing when critical columns are inconsistent.

## 5. Coupling / Maintainability Risks
- **Cross-file responsibility overlap:** Slack API wrappers exist in both `Slack.gs` and `LessonDelivery.gs` (`slackFetch` vs `callSlackApi`), increasing divergence risk.
- **Business logic tightly coupled to raw sheet scans:** repeated full-sheet scans in command paths will degrade with scale and are hard to reason about under concurrent updates.
- **Hard-coded defaults reduce operability:** enrollment and workflow defaults to `COURSE_12M` and module `M01`, making multi-course expansion fragile.
- **Mixed maturity in module boundaries:** clean file separation exists, but many orchestration endpoints depend on partially implemented functions, so boundaries are present structurally but not behaviorally complete.

## 6. Recommended Architecture Refactor Plan
1. **Complete AI layer to match target stack (highest priority):**
   - Implement a single `AiService` abstraction with provider adapters.
   - Wire Gemini API calls for enabled agents, add Gem routing map (agent -> gem id/version), and centralize retries/timeouts/fallback copy.
2. **Finish onboarding module as a first-class workflow:**
   - Implement `handleSlackInteraction` routing and modal persistence.
   - Remove placeholder methods or mark feature-flagged and hidden from admin commands until complete.
3. **Normalize schema contracts and enforce at runtime:**
   - Fix `agentCert` to `ModuleID` and add a strict `validateSchema()` check run at startup/admin command.
   - Fail fast with admin-facing actionable errors when required tabs/columns are missing.
4. **Unify Slack transport adapter:**
   - Consolidate all Slack API calls under one wrapper (auth, retries, error normalization) used by every module.
5. **Harden operations for production:**
   - Add queue retry count + dead-letter status.
   - Add audit log sheet (event, actor, target, outcome, latency).
   - Add `/health` command for tokens/scopes/sheet-schema checks.
6. **Keep stack, but simplify for team scale:**
   - Maintain Sheets as source of truth, but introduce lightweight cached lookup helpers for hot paths (lesson/mission/user lookups).

## 7. Final Architecture Verdict
**Verdict: Partially aligned, not production-ready yet.**

The foundation and stack choices are appropriate for a small team (Slack + Apps Script + Sheets), and the LMS delivery/progression model is directionally correct. But the system currently falls short of the requested production architecture because Gemini/Gems are not actually operating, onboarding interactivity is incomplete, and several operational hardening pieces are missing. With the refactor plan above, this can become a realistic, maintainable production system without changing the core stack.
