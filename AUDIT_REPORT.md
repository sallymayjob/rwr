# Slack LMS Repository Audit Report

## Section 1 — Repository Overview

### Purpose
This repository is a Google Apps Script project that implements a Slack-integrated LMS plus onboarding automation. The documented architecture is Google Sheets → Apps Script → Slack API/Interactivity → Sheets updates.

### Main components
- **HTTP entrypoint / orchestration:** `Code.gs` (`doPost`, queue scheduler/processor, command and event routing).
- **Slack API wrapper + block builders:** `Slack.gs`.
- **Data access + rollups:** `Sheets.gs`.
- **Learner/admin command agents:** `Agents.gs`.
- **Lesson/onboarding posting + modal flow:** `LessonDelivery.gs`.
- **Security validation:** `Auth.gs`.
- **Constants/configuration:** `Config.gs`.
- **Operational docs and Slack app manifest:** `README.md`, `DEPLOYMENT.md`, `slack-manifest.json`.

### How the current system works (actual implementation)
1. Slack sends slash commands/events/interactivity to `doPost`.
2. `doPost` validates signatures, enqueues most jobs to `Queue`, and returns immediate acknowledgment.
3. A one-shot trigger runs `processQueuedPipeline`, dispatching each job to command/event/workflow handlers.
4. Slash commands map to agent functions (`/learn`, `/submit`, `/progress`, etc.).
5. Lesson delivery is either:
   - **User-specific DM flow** (`/learn` → `postNextLessonForUser`) using `Lessons` + `Slack_Threads` + `Lesson_Submissions` + `Learners`, or
   - **Sequential sheet posting flow** (`postNextLesson`, menu-driven) using `lesson_slack_threads_filled_from_lessons` tracking columns.
6. Onboarding is a separate sequential workflow with Slack buttons + modal submission persisted back to onboarding sheet.

---

## Section 2 — Architecture Diagram

```text
[CSV imports/manual sheet maintenance]
            ↓
      [Google Sheets tabs]
  Lessons, Modules, Courses, Learners,
  Lesson_Submissions, Lesson_QA_Records,
  Lesson_Metrics, Slack_Threads, Queue
            ↓
   [Apps Script runtime]
   - doPost (webhook)
   - queue processor
   - agent handlers
   - lesson/onboarding delivery
            ↓
      [Slack APIs]
  chat.postMessage / chat.update
  conversations.open / users.info
  views.open (onboarding modal)
            ↓
       [Learner/Admin]
  slash commands, reactions, modals
            ↓
   [Sheets write-backs]
  submissions, progress %, posted flags,
  onboarding modal status, queue status
```

---

## Section 3 — Schema Mapping (Expected vs Implemented)

### Expected LMS CSV schemas provided by design
1. Courses.csv
2. Modules.csv
3. Course_Module_Map.csv
4. Lessons.csv
5. Missions.csv
6. Lesson_Metrics.csv
7. Lesson_QA_Details.csv
8. Slack_Delivery.csv

### Actual sheet constants and usage in code
- `Lessons`, `Modules`, `Courses`, `Learners`, `Lesson_Submissions`, `Lesson_QA_Records`, `Lesson_Metrics`, `Slack_Threads`, `Queue`.

### Mapping table

| Expected schema | Implemented? | Actual sheet(s)/code | Notes |
|---|---|---|---|
| Courses.csv | **Partial** | `Courses` used by `agentCourses`, `syncCourseRollup` | Core course table exists, but no `Course_Module_Map`-driven traversal. |
| Modules.csv | **Partial** | `Modules` used by `getModuleRow`, `syncModuleRollup` | Module rollup exists; lesson sequencing is not map-based. |
| Course_Module_Map.csv | **No** | Not found | No constant/sheet/function references. |
| Lessons.csv | **Partial** | `Lessons` plus alternate lesson thread sheet in `LessonDelivery.gs` | Field names deviate (`Course`/`Module` etc.); sequential posting sorts by regex-parsed LessonID only. |
| Missions.csv | **No** | Not found | Submit flow does not resolve mission table. |
| Lesson_Metrics.csv | **Minimal** | Included in backup only | No analytics update logic writes lesson metrics. |
| Lesson_QA_Details.csv | **No (name mismatch + partial behavior)** | Uses `Lesson_QA_Records` for module/course rollups only | Not used as a pre-delivery gate for lesson posting. |
| Slack_Delivery.csv | **No (replaced)** | Uses `Slack_Threads` and posting-tracking columns in lesson/onboarding sheets | No dedicated Slack_Delivery schema implementation. |

### Per-database read/write/function details

#### Courses
- **Read:** `agentCourses`, `syncCourseRollup`.
- **Write:** `syncCourseRollup` writes aggregates and status.

#### Modules
- **Read:** `getModuleRow`, `syncCourseRollup`.
- **Write:** `syncModuleRollup` writes module rollup metrics/status.

#### Course_Module_Map
- **Read/Write:** none.

#### Lessons
- **Read:** `getLessonRow`, `getCurrentLessonId`, `postNextLessonForUser`, `syncModuleRollup`, `agentCert`, `agentMix`, `agentMedia`.
- **Write:** `updateLessonMediaColumns`; posting tracker writes in `LessonDelivery.gs` target lesson sheet.

#### Missions
- **Read/Write:** none.

#### Lesson_Metrics
- **Read/Write:** no processing logic; only included in backup export list.

#### Lesson_QA_Details
- **Read/Write:** not referenced; nearest is `Lesson_QA_Records` read in `syncModuleRollup`.

#### Slack_Delivery
- **Read/Write:** not referenced; nearest is `Slack_Threads` read via `getSlackThread` and lesson posting columns in lesson sheet.

---

## Section 4 — Code Quality Assessment

### Architecture/modularity
- Positives:
  - Logical separation by concern (`Code`, `Agents`, `Sheets`, `Slack`, `LessonDelivery`, `Auth`).
  - Queue-based async handling improves Slack response-time compliance.
- Weaknesses:
  - Two overlapping delivery models (user DM via `Slack_Threads` and sequential posting via alternate lesson sheet) create conceptual drift.
  - Schema names/columns are inconsistent across files, increasing operational risk.

### Scalability
- Queue design supports throttled batch processing and dedupe.
- Uses script locks for concurrent writes.
- But Apps Script + sheet scans are full-table loops without indexing/caching; growth may degrade performance.

### Security
- HMAC validation implemented.
- **High risk:** fallback path allows requests when headers/tokens unavailable (`validateSlackRequest` returns true with warning), weakening trust boundary.

### Maintainability
- Many magic strings for column names and status values.
- Limited automated validation around schema compatibility.
- Strong operational docs, but documentation has drift vs runtime behavior in some places.

---

## Section 5 — System Gaps

1. **No Course_Module_Map implementation** (missing resolver for course → modules sequence).
2. **No Missions table implementation** (submit code to mission lookup absent).
3. **No Slack_Delivery table implementation** (delivery metadata handled in ad-hoc fields / `Slack_Threads`).
4. **No Lesson_QA_Details gating before posting** (QA used only for rollups).
5. **No Lesson_Metrics update pipeline** (metrics not calculated or persisted during operations).
6. **Submit Code flow not implemented per design** (`/submit` accepts lessonId + evidence, not submit code).
7. **Reaction completion parsing likely nonfunctional** (extracts LessonID from timestamp string rather than message metadata/thread content).
8. **Onboarding flow dominates docs and functionality relative to LMS schema expectations.**

---

## Section 6 — Critical Bugs / High-Risk Defects

1. **`profileWarning` undefined in `agentOnboard` return path**, which can throw and fail admin confirmation DM.
2. **Reaction-based completion mapping is brittle/incorrect**: tries to regex LessonID from `event.item.ts`; Slack timestamp is numeric, so lookup usually fails.
3. **Security fallback can accept unsigned requests** when header extraction fails and no verification token is present.
4. **Documentation drift:** `DEPLOYMENT.md` says queue runs inline/no scheduler, but code schedules time-based one-shot trigger.

---

## Section 7 — Recommended Improvements (Refactoring Plan)

### A. Align data model with required 8-CSV architecture
1. Add constants and accessors for:
   - `Course_Module_Map`
   - `Missions`
   - `Lesson_QA_Details`
   - `Slack_Delivery`
2. Create dedicated services (new files suggested):
   - `CourseModuleMapService.gs`
   - `MissionService.gs`
   - `QaGateService.gs`
   - `SlackDeliveryService.gs`
   - `MetricsService.gs`

### B. Implement required workflow contract
1. **Course selection** resolves module order from `Course_Module_Map`.
2. **Lesson retrieval** from `Lessons` by module sequence + lesson order.
3. **QA gate** blocks non-passing lessons using `Lesson_QA_Details` status/verdict.
4. **Delivery** reads canonical message payload from `Slack_Delivery` and writes delivery status/TS/channel.
5. **Submission** accepts submit code, resolves `Missions` by submit code → mission → lesson.
6. **Progress** records mission completion per learner and unlocks next lesson deterministically.
7. **Metrics** updates `Lesson_Metrics` on delivery/submission/engagement.

### C. Fix defects and harden operations
1. Define/remove `profileWarning` in `agentOnboard`.
2. Replace reaction lesson detection with stable metadata mapping (e.g., store lesson id in button value, block_id, or message metadata keyed by `channel+ts`).
3. Enforce strict signature validation in production mode (do not allow unsigned requests).
4. Reconcile docs with actual queue trigger behavior.
5. Add schema validation startup check and fail-fast admin alert for missing required tabs/columns.

### D. Improve observability
- Add structured audit log sheet (event type, user, lesson, mission, outcome).
- Add queue retry count + dead-letter handling for repeated failures.
- Add health command `/health` for sheet/schema/token checks.

---

## Compliance Verdict

**Result: The repository does not fully implement the target Slack LMS architecture and required 8-CSV schema.**

It implements a functional Slack+Sheets LMS variant with onboarding and learner command workflows, but key contract elements (Course_Module_Map resolution, Missions/Submit Code path, Slack_Delivery table, Lesson_QA_Details gate, metrics pipeline) are missing or materially different.
