// The domain model every package shares. Linear stays the source of truth:
// the "mirrored" types below are normalized copies of Linear entities; the
// "tool-owned" types are data only this tool stores (weights, "done means…",
// settings). Everything here is plain data so it can cross the server/client
// boundary and be stored as JSON.

/** A calendar date, `YYYY-MM-DD` (Linear's TimelessDate). */
export type IsoDate = string;
/** An instant, ISO-8601 with timezone (e.g. `2026-10-21T15:00:00.000Z`). */
export type IsoDateTime = string;

/**
 * Linear priority: 0 = no priority, 1 = urgent, 2 = high, 3 = medium
 * (shown as "normal" in some Linear UIs), 4 = low.
 */
export type Priority = 0 | 1 | 2 | 3 | 4;

/**
 * Linear workflow state categories. Linear's API also reports "duplicate";
 * the gateway maps it to "canceled" (closed) and keeps the state's name.
 */
export type WorkflowStateType =
  | 'triage'
  | 'backlog'
  | 'unstarted'
  | 'started'
  | 'completed'
  | 'canceled';

/** Linear project status categories (ProjectStatus.type). */
export type ProjectStatusType =
  | 'backlog'
  | 'planned'
  | 'started'
  | 'paused'
  | 'completed'
  | 'canceled';

// ---------------------------------------------------------------------------
// Mirrored Linear entities
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  name: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  /** False once the user is deactivated (suspended) in Linear. */
  active: boolean;
  /** An app user (e.g. this tool's own actor=app identity), never a person. */
  app: boolean;
}

export interface Team {
  id: string;
  key: string;
  name: string;
}

export interface WorkflowState {
  id: string;
  teamId: string;
  name: string;
  type: WorkflowStateType;
  /** Linear's ordering of states within a team; lower comes first. */
  position: number;
}

export interface Initiative {
  id: string;
  name: string;
  /** Linear's manual ordering; lower comes first. */
  sortOrder: number;
  /** Initiative priority when Linear exposes one, else 0 (none). */
  priority: Priority;
  targetDate: IsoDate | null;
}

export interface Project {
  id: string;
  name: string;
  url: string;
  /** The project lead: the "project owner" for allocation and warnings. */
  leadId: string | null;
  priority: Priority;
  /** Linear's manual ordering of projects; lower comes first. */
  sortOrder: number;
  statusType: ProjectStatusType;
  statusName: string;
  initiativeIds: string[];
  teamIds: string[];
  startDate: IsoDate | null;
  targetDate: IsoDate | null;
}

export interface Milestone {
  id: string;
  projectId: string;
  name: string;
  /** Linear's milestone description (markdown), if any. */
  description: string | null;
  targetDate: IsoDate | null;
  /** Linear's manual ordering within the project; lower comes first. */
  sortOrder: number;
}

export interface Issue {
  id: string;
  /** Human key such as `ENG-123`. */
  identifier: string;
  title: string;
  url: string;
  teamId: string;
  projectId: string | null;
  milestoneId: string | null;
  assigneeId: string | null;
  stateId: string;
  priority: Priority;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  startedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  canceledAt: IsoDateTime | null;
  /**
   * When this issue last entered its current workflow state. Derived by the
   * sync from issue history when it was fetched, otherwise the latest of
   * createdAt/startedAt/completedAt/canceledAt. Drives "stalled" risk.
   */
  lastStateChangeAt: IsoDateTime;
}

/** Only Linear "blocks" relations are kept: blocker blocks blocked. */
export interface BlockingRelation {
  id: string;
  blockerId: string;
  blockedId: string;
}

/** Everything the tool mirrors from one Linear workspace. */
export interface WorkspaceData {
  workspaceId: string;
  users: User[];
  teams: Team[];
  states: WorkflowState[];
  initiatives: Initiative[];
  projects: Project[];
  milestones: Milestone[];
  issues: Issue[];
  relations: BlockingRelation[];
}

/**
 * WorkspaceData indexed for evaluation (built once per load by
 * indexWorkspace). Server-only: contains Maps.
 */
export interface Snapshot {
  data: WorkspaceData;
  users: ReadonlyMap<string, User>;
  teams: ReadonlyMap<string, Team>;
  states: ReadonlyMap<string, WorkflowState>;
  initiatives: ReadonlyMap<string, Initiative>;
  projects: ReadonlyMap<string, Project>;
  milestones: ReadonlyMap<string, Milestone>;
  issues: ReadonlyMap<string, Issue>;
  /** Per project: by targetDate ascending (undated last), then sortOrder. */
  milestonesByProject: ReadonlyMap<string, readonly Milestone[]>;
  issuesByMilestone: ReadonlyMap<string, readonly Issue[]>;
  issuesByProject: ReadonlyMap<string, readonly Issue[]>;
  issuesByAssignee: ReadonlyMap<string, readonly Issue[]>;
  /** Blocked issue id -> ids of the issues blocking it. */
  blockersOf: ReadonlyMap<string, readonly string[]>;
  /** Blocker issue id -> ids of the issues it blocks. */
  blocking: ReadonlyMap<string, readonly string[]>;
}

// ---------------------------------------------------------------------------
// Tool-owned data
// ---------------------------------------------------------------------------

/** Per-milestone data Linear has no field for. */
export interface MilestoneMeta {
  milestoneId: string;
  /**
   * Display-only sort override: higher sorts earlier within its group. It
   * never changes which milestone is "next" for allocation or warnings.
   */
  weight: number | null;
  /** One-line "done means…" outcome (rubric item b). */
  doneMeans: string | null;
  updatedAt: IsoDateTime;
  updatedBy: string | null;
}

export type AllocationMode = 'dry_run' | 'live';

/**
 * preview: digests are built and recorded in the app's outbox only.
 * live: digests are also delivered (Slack DM).
 */
export type WarningsMode = 'preview' | 'live';

/** Tunable thresholds; defaults in DEFAULT_TUNING. */
export interface Tuning {
  /** Warn this many days ahead of a milestone's due date. */
  warnLeadDays: number;
  /** "Time remaining" denominator for the behind-pace check. */
  paceWindowDays: number;
  /** No state change among a milestone's issues for this long = stalled. */
  stallDays: number;
  /** Repeat an overdue warning every N days while it stays overdue. */
  overdueRepeatDays: number;
  /** How long an auto-allocated issue keeps its "new" mark in My week. */
  newBadgeDays: number;
  /** Project statuses that receive allocation and warnings. */
  activeProjectStatuses: ProjectStatusType[];
  /** Timeline window, relative to today. */
  timelineDaysBack: number;
  timelineDaysAhead: number;
}

export interface WorkspaceSettings {
  workspaceId: string;
  /** Users who may edit dates, weights, leads, "done means…" and settings. */
  pmUserIds: string[];
  /** Users told about every at-risk milestone (initially the PMs). */
  watcherUserIds: string[];
  allocationMode: AllocationMode;
  warningsMode: WarningsMode;
  /** IANA zone used to decide what "today" is, e.g. `America/Chicago`. */
  timezone: string;
  tuning: Tuning;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Inputs every pure evaluation function receives. */
export interface EvalContext {
  /** "Today" in the workspace timezone. */
  today: IsoDate;
  now: IsoDateTime;
  tuning: Tuning;
  /** Tool-owned milestone data keyed by milestone id. */
  meta: ReadonlyMap<string, MilestoneMeta>;
}

export type RubricGap =
  | 'no_target_date'
  | 'no_done_means'
  | 'no_project_lead'
  | 'no_issues';

export interface RubricResult {
  valid: boolean;
  /** In display order: date, done means, lead, issues. */
  gaps: RubricGap[];
}

export type DoneMeansSource = 'planner' | 'linear_description';

export interface DoneMeans {
  text: string | null;
  source: DoneMeansSource | null;
}

export interface Progress {
  /** Every issue in the milestone, including canceled. */
  total: number;
  completed: number;
  canceled: number;
  /** total - canceled: the denominator shown as "done/scope". */
  scope: number;
  open: number;
  openUnassigned: number;
  openTriage: number;
}

/**
 * - empty: no issues at all (fails the rubric).
 * - complete: has issues and none are open.
 * - unscheduled: open issues but no target date.
 * - overdue: past its date with open issues.
 * - at_risk: due within warnLeadDays and at least one risk reason holds.
 * - on_track: everything else.
 */
export type MilestoneStatus =
  | 'empty'
  | 'complete'
  | 'unscheduled'
  | 'overdue'
  | 'at_risk'
  | 'on_track';

export type RiskReason = 'unassigned_open' | 'stalled' | 'behind_pace';

export interface MilestoneAssessment {
  milestoneId: string;
  projectId: string;
  status: MilestoneStatus;
  /** targetDate - today in calendar days; negative when overdue. */
  daysLeft: number | null;
  /** Populated for at_risk and overdue milestones. */
  reasons: RiskReason[];
  progress: Progress;
  rubric: RubricResult;
  doneMeans: DoneMeans;
  /** True when this is its project's "next milestone" (§6.2). */
  isNext: boolean;
  /** Latest lastStateChangeAt among the milestone's issues. */
  lastStateChangeAt: IsoDateTime | null;
}

// ---------------------------------------------------------------------------
// Allocation (§7.4)
// ---------------------------------------------------------------------------

export type ProjectAllocationOutcome =
  /** Has unassigned issues in a valid next milestone. */
  | 'allocate'
  /** Valid next milestone, nothing unassigned. */
  | 'nothing_to_do'
  /** Missing input: reported loudly, nothing allocated. */
  | 'blocked'
  /** Every milestone is complete (or there are none). */
  | 'no_open_milestone'
  /** Project status is not in tuning.activeProjectStatuses. */
  | 'inactive';

export type AllocationBlockReason =
  | 'no_lead'
  | 'lead_inactive'
  | 'next_milestone_invalid';

export type IssueSkipReason = 'already_assigned' | 'triage';

export interface AllocationAction {
  issueId: string;
  identifier: string;
  title: string;
  projectId: string;
  milestoneId: string;
  assigneeId: string;
  fromStateId: string;
  /** The team's Todo state when moving out of Backlog; null keeps the state. */
  toStateId: string | null;
}

export interface AllocationSkip {
  issueId: string;
  identifier: string;
  reason: IssueSkipReason;
}

export interface ProjectAllocationPlan {
  projectId: string;
  outcome: ProjectAllocationOutcome;
  nextMilestoneId: string | null;
  blockReason: AllocationBlockReason | null;
  /** Rubric gaps of the next milestone when blockReason is next_milestone_invalid. */
  gaps: RubricGap[];
  actions: AllocationAction[];
  skipped: AllocationSkip[];
}

export interface AllocationPlan {
  today: IsoDate;
  projects: ProjectAllocationPlan[];
  totals: {
    actions: number;
    blockedProjects: number;
    skippedIssues: number;
  };
}

// ---------------------------------------------------------------------------
// Warnings (§7.5)
// ---------------------------------------------------------------------------

export type NoticeKind =
  | 'overdue'
  | 'at_risk'
  /** Dated within warnLeadDays but fails the rubric. */
  | 'invalid_due_soon'
  /** Allocation for the project is stopped by a missing input. */
  | 'allocation_blocked';

export interface Notice {
  kind: NoticeKind;
  subjectKind: 'milestone' | 'project';
  /** Milestone id, or project id for allocation_blocked. */
  subjectId: string;
  projectId: string;
  milestoneId: string | null;
  /** Dedupe key; a notice is sent when it differs from the remembered one. */
  key: string;
  targetDate: IsoDate | null;
  daysLeft: number | null;
  reasons: RiskReason[];
  gaps: RubricGap[];
  blockReason: AllocationBlockReason | null;
  openIssueIds: string[];
  unassignedIssueIds: string[];
  /** Deduplicated user ids: project lead (if any) + watchers. */
  recipientIds: string[];
  /** 1 on first notice for this key, then 2, 3… for overdue repeats. */
  occurrence: number;
}

/** What the warning job remembers about one subject between runs. */
export interface WarningMemory {
  subjectKind: 'milestone' | 'project';
  subjectId: string;
  /** Key of the last evaluated state, or null for "nothing to report". */
  lastKey: string | null;
  lastNotifiedOn: IsoDate | null;
  occurrence: number;
}

export interface WarningPlan {
  notices: Notice[];
  /** Memory rows to persist (one per evaluated subject). */
  memory: WarningMemory[];
}

export interface DigestItem {
  notice: Notice;
  projectName: string;
  milestoneName: string | null;
  leadName: string | null;
  openCount: number;
  unassignedCount: number;
  /** Short, plain-language lines explaining why ("2 open issues unassigned"). */
  lines: string[];
  /** Deep link into the timeline for this subject. */
  url: string;
}

/** One message per recipient per day (§6.8). */
export interface Digest {
  recipientId: string;
  recipientName: string;
  recipientEmail: string | null;
  day: IsoDate;
  items: DigestItem[];
}

// ---------------------------------------------------------------------------
// Dependency graph (§7.3)
// ---------------------------------------------------------------------------

export type GraphLevel = 'milestone' | 'issue';

export type GraphScope =
  | { level: 'milestone' }
  | { level: 'issue'; milestoneId: string }
  | { level: 'issue'; projectId: string };

export interface GraphNode {
  id: string;
  kind: GraphLevel;
  label: string;
  /** Issue: "ENG-12 · Ana"; milestone: project name. */
  sublabel: string;
  url: string | null;
  projectId: string | null;
  milestoneId: string | null;
  ownerId: string | null;
  /** Issue nodes outside the requested scope (one hop away). */
  external: boolean;
  open: boolean;
  unassigned: boolean;
  overdue: boolean;
  inCycle: boolean;
  /** Transitively waits on an open unassigned issue. */
  waitsOnUnassigned: boolean;
  /** Transitively waits on an issue in an overdue milestone. */
  waitsOnOverdue: boolean;
  status: MilestoneStatus | WorkflowStateType;
}

export interface GraphEdge {
  /** The blocker. */
  from: string;
  /** The node that waits. */
  to: string;
  /** Blocker is already completed/canceled (issue level only). */
  resolved: boolean;
  crossProject: boolean;
  crossOwner: boolean;
  inCycle: boolean;
  /** Part of a chain that ends in an unassigned or overdue issue. */
  onRiskChain: boolean;
  /** Milestone level: how many issue relations the edge summarises. */
  weight: number;
}

export interface DependencyGraph {
  scope: GraphScope;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Each cycle as node ids in order. */
  cycles: string[][];
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/** An allocation the tool made recently, for My week's "new" mark. */
export interface RecentAllocation {
  issueId: string;
  assigneeId: string;
  projectId: string;
  milestoneId: string;
  at: IsoDateTime;
}

export interface WeekIssueRow {
  issueId: string;
  identifier: string;
  title: string;
  url: string;
  priority: Priority;
  stateName: string;
  stateType: WorkflowStateType;
  /** "new — given to you because you lead <project>" when set. */
  newBecauseLeadOf: string | null;
}

export interface WeekSection {
  /** null for the final "No milestone" section. */
  milestoneId: string | null;
  milestoneName: string | null;
  projectId: string | null;
  projectName: string | null;
  projectUrl: string | null;
  targetDate: IsoDate | null;
  daysLeft: number | null;
  status: MilestoneStatus | null;
  progress: Progress | null;
  /** Overdue, or due on or before today + 6 days. */
  thisWeek: boolean;
  rows: WeekIssueRow[];
}

export interface WeekView {
  userId: string;
  userName: string;
  today: IsoDate;
  sections: WeekSection[];
  totals: { open: number; thisWeek: number; overdue: number; new: number };
}

export interface TimelineBar {
  milestoneId: string;
  name: string;
  projectId: string;
  /** Bar start: previous dated milestone's date, else project start, else windowStart. */
  start: IsoDate;
  /** The due date the bar ends at; null for undated milestones. */
  end: IsoDate | null;
  status: MilestoneStatus;
  reasons: RiskReason[];
  rubric: RubricResult;
  doneMeans: DoneMeans;
  progress: Progress;
  isNext: boolean;
  daysLeft: number | null;
  weight: number | null;
}

export interface TimelineLane {
  projectId: string;
  name: string;
  url: string;
  leadId: string | null;
  leadName: string | null;
  priority: Priority;
  statusType: ProjectStatusType;
  /** Allocation and warnings apply (status in activeProjectStatuses). */
  active: boolean;
  /** Dated milestones in date order. */
  bars: TimelineBar[];
  /** Milestones without a target date, in Linear's order. */
  undated: TimelineBar[];
  /** Open issues in the project with no milestone (§6.4 "unplanned"). */
  unplannedIssueIds: string[];
  allocation: ProjectAllocationPlan | null;
}

export interface TimelineGroup {
  initiativeId: string | null;
  name: string;
  lanes: TimelineLane[];
}

export interface TimelineView {
  today: IsoDate;
  windowStart: IsoDate;
  windowEnd: IsoDate;
  groups: TimelineGroup[];
  banners: {
    projectsWithoutLead: { projectId: string; name: string }[];
    milestonesWithoutDate: {
      milestoneId: string;
      name: string;
      projectId: string;
      projectName: string;
    }[];
    issuesWithoutMilestone: {
      count: number;
      byProject: { projectId: string; name: string; issueIds: string[] }[];
    };
    blockedProjects: {
      projectId: string;
      name: string;
      reason: AllocationBlockReason;
      gaps: RubricGap[];
    }[];
  };
}

export interface MilestoneIssueRow {
  issueId: string;
  identifier: string;
  title: string;
  url: string;
  priority: Priority;
  stateName: string;
  stateType: WorkflowStateType;
  assigneeId: string | null;
  assigneeName: string | null;
  blockedByIds: string[];
}

export interface MilestoneDetail {
  milestone: Milestone;
  project: Project;
  leadName: string | null;
  assessment: MilestoneAssessment;
  meta: MilestoneMeta | null;
  issues: MilestoneIssueRow[];
  /** Milestones this one waits on (milestone-level graph neighbours). */
  waitsOn: { milestoneId: string; name: string; projectName: string }[];
}
