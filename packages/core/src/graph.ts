// The dependency graph (§2.10, design §7.3): issue level for one milestone or
// project, milestone level for the whole workspace. Risk flags follow open
// blockers through the whole workspace, not just the drawn nodes, so a chain
// that leaves the scope still counts.

import { compareIssues, compareMilestones } from './ordering';
import { isOpenState, issueStateType } from './snapshot';
import type {
  DependencyGraph,
  EvalContext,
  GraphEdge,
  GraphNode,
  GraphScope,
  Issue,
  Milestone,
  MilestoneAssessment,
  Snapshot,
} from './types';

/**
 * Tarjan's strongly connected components over nodes `0..count-1`, written
 * iteratively so long blocker chains cannot overflow the call stack. Each
 * component lists its node indexes; components come out in Tarjan's
 * completion order.
 */
export function stronglyConnectedComponents(
  count: number,
  successors: readonly (readonly number[])[]
): number[][] {
  const index = new Int32Array(count).fill(-1);
  const low = new Int32Array(count);
  const onStack = new Uint8Array(count);
  const stack: number[] = [];
  const components: number[][] = [];
  // Explicit call stack: the node being visited and its next successor slot.
  const callNodes: number[] = [];
  const callNext: number[] = [];
  let counter = 0;

  const visit = (v: number): void => {
    index[v] = counter;
    low[v] = counter;
    counter += 1;
    stack.push(v);
    onStack[v] = 1;
    callNodes.push(v);
    callNext.push(0);
  };

  for (let start = 0; start < count; start++) {
    if (index[start] !== -1) continue;
    visit(start);
    while (callNodes.length > 0) {
      const top = callNodes.length - 1;
      const v = callNodes[top] ?? 0;
      const next = successors[v] ?? [];
      const slot = callNext[top] ?? 0;
      if (slot < next.length) {
        callNext[top] = slot + 1;
        const w = next[slot] ?? 0;
        if (index[w] === -1) visit(w);
        else if (onStack[w] === 1)
          low[v] = Math.min(low[v] ?? 0, index[w] ?? 0);
        continue;
      }
      callNodes.pop();
      callNext.pop();
      const parent = callNodes[callNodes.length - 1];
      if (parent !== undefined) {
        low[parent] = Math.min(low[parent] ?? 0, low[v] ?? 0);
      }
      if (low[v] === index[v]) {
        const component: number[] = [];
        let w: number | undefined;
        do {
          w = stack.pop();
          if (w === undefined) break;
          onStack[w] = 0;
          component.push(w);
        } while (w !== v);
        components.push(component);
      }
    }
  }
  return components;
}

/**
 * Cycles among `count` nodes: components with more than one node, or a
 * single node with an edge to itself. Each cycle is returned in walk order,
 * starting from its lowest index and following edges inside the component
 * (lowest unvisited successor first); members the walk misses are appended
 * in index order. Cycles are sorted by their first node.
 */
export function findCycles(
  count: number,
  successors: readonly (readonly number[])[]
): number[][] {
  const cycles: number[][] = [];
  for (const component of stronglyConnectedComponents(count, successors)) {
    const first = component[0];
    if (first === undefined) continue;
    const selfLoop =
      component.length === 1 && (successors[first] ?? []).includes(first);
    if (component.length < 2 && !selfLoop) continue;
    const members = new Set(component);
    const ordered = [...component].sort((a, b) => a - b);
    const walk: number[] = [];
    const seen = new Set<number>();
    let current: number | undefined = ordered[0];
    while (current !== undefined && !seen.has(current)) {
      walk.push(current);
      seen.add(current);
      let nextNode: number | undefined;
      for (const w of successors[current] ?? []) {
        if (
          members.has(w) &&
          !seen.has(w) &&
          (nextNode === undefined || w < nextNode)
        ) {
          nextNode = w;
        }
      }
      current = nextNode;
    }
    for (const node of ordered) if (!seen.has(node)) walk.push(node);
    cycles.push(walk);
  }
  return cycles.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
}

/**
 * Every open issue that transitively waits on an issue matching `isBase`,
 * following only `blocks` edges whose blocker is open (a closed blocker no
 * longer holds anything up). A forward walk from the base issues: O(issues
 * + relations). Base issues themselves are included only when they wait on
 * another base issue (or on themselves through a cycle).
 */
export function waitingIssues(
  snapshot: Snapshot,
  isBase: (issue: Issue) => boolean
): Set<string> {
  const waiting = new Set<string>();
  const queue: string[] = [];
  for (const issue of snapshot.issues.values()) {
    if (isOpenState(issueStateType(snapshot, issue)) && isBase(issue)) {
      queue.push(issue.id);
    }
  }
  const expanded = new Set<string>();
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head] ?? '';
    if (expanded.has(id)) continue;
    expanded.add(id);
    for (const blockedId of snapshot.blocking.get(id) ?? []) {
      if (waiting.has(blockedId)) continue;
      const blocked = snapshot.issues.get(blockedId);
      if (blocked === undefined) continue;
      if (!isOpenState(issueStateType(snapshot, blocked))) continue;
      waiting.add(blockedId);
      queue.push(blockedId);
    }
  }
  return waiting;
}

// Per-issue risk facts shared by both zoom levels.
interface IssueRisk {
  isOpen: (issue: Issue) => boolean;
  isUnassigned: (issue: Issue) => boolean;
  isOverdue: (issue: Issue) => boolean;
  waitsOnUnassigned: Set<string>;
  waitsOnOverdue: Set<string>;
}

// Computes the issue-level risk predicates and the two transitive waits
// sets once per graph build.
function issueRisk(
  snapshot: Snapshot,
  assessments: ReadonlyMap<string, MilestoneAssessment>
): IssueRisk {
  const isOpen = (issue: Issue): boolean =>
    isOpenState(issueStateType(snapshot, issue));
  const isUnassigned = (issue: Issue): boolean =>
    isOpen(issue) && issue.assigneeId === null;
  const isOverdue = (issue: Issue): boolean =>
    isOpen(issue) &&
    issue.milestoneId !== null &&
    assessments.get(issue.milestoneId)?.status === 'overdue';
  return {
    isOpen,
    isUnassigned,
    isOverdue,
    waitsOnUnassigned: waitingIssues(snapshot, isUnassigned),
    waitsOnOverdue: waitingIssues(snapshot, isOverdue),
  };
}

// Marks nodes and edges that sit on a cycle and fills `graph.cycles`. Only
// edges whose blocker is still open take part: a resolved edge cannot
// deadlock anything.
function markCycles(nodes: GraphNode[], edges: GraphEdge[]): string[][] {
  const indexOf = new Map<string, number>();
  nodes.forEach((node, i) => indexOf.set(node.id, i));
  const successors: number[][] = nodes.map(() => []);
  for (const edge of edges) {
    if (edge.resolved) continue;
    const from = indexOf.get(edge.from);
    const to = indexOf.get(edge.to);
    if (from !== undefined && to !== undefined) successors[from]?.push(to);
  }
  const cycles = findCycles(nodes.length, successors);
  const cycleOf = new Map<string, number>();
  cycles.forEach((cycle, c) => {
    for (const i of cycle) {
      const node = nodes[i];
      if (node === undefined) continue;
      node.inCycle = true;
      cycleOf.set(node.id, c);
    }
  });
  for (const edge of edges) {
    const c = cycleOf.get(edge.from);
    edge.inCycle =
      !edge.resolved && c !== undefined && cycleOf.get(edge.to) === c;
  }
  return cycles.map((cycle) =>
    cycle.flatMap((i) => {
      const node = nodes[i];
      return node === undefined ? [] : [node.id];
    })
  );
}

// True when the edge's blocker is itself a risk or waits on one.
function blockerIsRisky(node: GraphNode | undefined): boolean {
  return (
    node !== undefined &&
    (node.unassigned ||
      node.overdue ||
      node.waitsOnUnassigned ||
      node.waitsOnOverdue)
  );
}

// Orders edges by their endpoints' node order so output is stable.
function sortEdges(nodes: readonly GraphNode[], edges: GraphEdge[]): void {
  const indexOf = new Map<string, number>();
  nodes.forEach((node, i) => indexOf.set(node.id, i));
  edges.sort((a, b) => {
    const byFrom = (indexOf.get(a.from) ?? 0) - (indexOf.get(b.from) ?? 0);
    if (byFrom !== 0) return byFrom;
    return (indexOf.get(a.to) ?? 0) - (indexOf.get(b.to) ?? 0);
  });
}

// Issue-level graph: the scope's issues (open and closed), plus one hop of
// external blockers and blocked issues.
function issueGraph(
  snapshot: Snapshot,
  risk: IssueRisk,
  scope: Extract<GraphScope, { level: 'issue' }>
): DependencyGraph {
  const scopeIssues =
    'milestoneId' in scope
      ? (snapshot.issuesByMilestone.get(scope.milestoneId) ?? [])
      : (snapshot.issuesByProject.get(scope.projectId) ?? []);
  const inScope = new Set(scopeIssues.map((issue) => issue.id));

  const pairs = new Set<string>();
  const relationPairs: { blocker: Issue; blocked: Issue }[] = [];
  const externals = new Map<string, Issue>();
  // Records one blocks relation touching the scope, and its outside end.
  const addRelation = (blockerId: string, blockedId: string): void => {
    const pair = `${blockerId}\u0000${blockedId}`;
    if (pairs.has(pair)) return;
    const blocker = snapshot.issues.get(blockerId);
    const blocked = snapshot.issues.get(blockedId);
    if (blocker === undefined || blocked === undefined) return;
    pairs.add(pair);
    relationPairs.push({ blocker, blocked });
    for (const end of [blocker, blocked]) {
      if (!inScope.has(end.id)) externals.set(end.id, end);
    }
  };
  for (const issue of scopeIssues) {
    for (const blockerId of snapshot.blockersOf.get(issue.id) ?? []) {
      addRelation(blockerId, issue.id);
    }
    for (const blockedId of snapshot.blocking.get(issue.id) ?? []) {
      addRelation(issue.id, blockedId);
    }
  }

  const toNode = (issue: Issue, external: boolean): GraphNode => {
    const assignee =
      issue.assigneeId === null
        ? undefined
        : snapshot.users.get(issue.assigneeId);
    const who =
      issue.assigneeId === null
        ? 'Unassigned'
        : (assignee?.name ?? 'Unknown user');
    return {
      id: issue.id,
      kind: 'issue',
      label: issue.title,
      sublabel: `${issue.identifier} · ${who}`,
      url: issue.url,
      projectId: issue.projectId,
      milestoneId: issue.milestoneId,
      ownerId: issue.assigneeId,
      external,
      open: risk.isOpen(issue),
      unassigned: risk.isUnassigned(issue),
      overdue: risk.isOverdue(issue),
      inCycle: false,
      waitsOnUnassigned: risk.waitsOnUnassigned.has(issue.id),
      waitsOnOverdue: risk.waitsOnOverdue.has(issue.id),
      status: issueStateType(snapshot, issue),
    };
  };
  const nodes: GraphNode[] = [
    ...[...scopeIssues]
      .sort(compareIssues)
      .map((issue) => toNode(issue, false)),
    ...[...externals.values()]
      .sort(compareIssues)
      .map((issue) => toNode(issue, true)),
  ];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const edges: GraphEdge[] = relationPairs.map(({ blocker, blocked }) => ({
    from: blocker.id,
    to: blocked.id,
    resolved: !risk.isOpen(blocker),
    crossProject: blocker.projectId !== blocked.projectId,
    crossOwner:
      blocker.assigneeId !== null &&
      blocked.assigneeId !== null &&
      blocker.assigneeId !== blocked.assigneeId,
    inCycle: false,
    onRiskChain: blockerIsRisky(nodeById.get(blocker.id)),
    weight: 1,
  }));
  sortEdges(nodes, edges);
  const cycles = markCycles(nodes, edges);
  return { scope, nodes, edges, cycles };
}

// Milestone-level graph: B → A when an open issue in A is blocked by an open
// issue in B (A ≠ B), weighted by how many relations do that. Nodes are the
// active projects' milestones with open issues, plus any milestone on an
// edge that touches an active project.
function milestoneGraph(
  snapshot: Snapshot,
  ctx: EvalContext,
  assessments: ReadonlyMap<string, MilestoneAssessment>,
  risk: IssueRisk,
  scope: GraphScope
): DependencyGraph {
  const activeStatuses = new Set(ctx.tuning.activeProjectStatuses);
  const isActive = (m: Milestone): boolean => {
    const project = snapshot.projects.get(m.projectId);
    return project !== undefined && activeStatuses.has(project.statusType);
  };

  const weights = new Map<
    string,
    { from: Milestone; to: Milestone; weight: number }
  >();
  const waitsOnUnassigned = new Set<string>();
  const waitsOnOverdue = new Set<string>();
  for (const issue of snapshot.issues.values()) {
    if (issue.milestoneId === null || !risk.isOpen(issue)) continue;
    const to = snapshot.milestones.get(issue.milestoneId);
    if (to === undefined) continue;
    if (risk.waitsOnUnassigned.has(issue.id)) waitsOnUnassigned.add(to.id);
    if (risk.waitsOnOverdue.has(issue.id)) waitsOnOverdue.add(to.id);
    for (const blockerId of snapshot.blockersOf.get(issue.id) ?? []) {
      const blocker = snapshot.issues.get(blockerId);
      if (blocker === undefined || blocker.milestoneId === null) continue;
      if (blocker.milestoneId === to.id || !risk.isOpen(blocker)) continue;
      const from = snapshot.milestones.get(blocker.milestoneId);
      if (from === undefined || (!isActive(from) && !isActive(to))) continue;
      const pair = `${from.id}\u0000${to.id}`;
      const entry = weights.get(pair);
      if (entry === undefined) weights.set(pair, { from, to, weight: 1 });
      else entry.weight += 1;
    }
  }

  const included = new Map<string, Milestone>();
  for (const milestone of snapshot.milestones.values()) {
    if (
      isActive(milestone) &&
      (assessments.get(milestone.id)?.progress.open ?? 0) > 0
    ) {
      included.set(milestone.id, milestone);
    }
  }
  for (const { from, to } of weights.values()) {
    included.set(from.id, from);
    included.set(to.id, to);
  }

  const leadOf = (m: Milestone): string | null =>
    snapshot.projects.get(m.projectId)?.leadId ?? null;
  const nodes: GraphNode[] = [...included.values()]
    .sort(compareMilestones(snapshot, ctx, assessments))
    .map((milestone) => {
      const assessment = assessments.get(milestone.id);
      const project = snapshot.projects.get(milestone.projectId);
      return {
        id: milestone.id,
        kind: 'milestone',
        label: milestone.name,
        sublabel: project?.name ?? '',
        url: null,
        projectId: milestone.projectId,
        milestoneId: milestone.id,
        ownerId: leadOf(milestone),
        external: false,
        open: (assessment?.progress.open ?? 0) > 0,
        unassigned: (assessment?.progress.openUnassigned ?? 0) > 0,
        overdue: assessment?.status === 'overdue',
        inCycle: false,
        waitsOnUnassigned: waitsOnUnassigned.has(milestone.id),
        waitsOnOverdue: waitsOnOverdue.has(milestone.id),
        status: assessment?.status ?? 'empty',
      };
    });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const edges: GraphEdge[] = [...weights.values()].map(
    ({ from, to, weight }) => {
      const fromLead = leadOf(from);
      const toLead = leadOf(to);
      return {
        from: from.id,
        to: to.id,
        resolved: false,
        crossProject: from.projectId !== to.projectId,
        crossOwner: fromLead !== null && toLead !== null && fromLead !== toLead,
        inCycle: false,
        onRiskChain: blockerIsRisky(nodeById.get(from.id)),
        weight,
      };
    }
  );
  sortEdges(nodes, edges);
  const cycles = markCycles(nodes, edges);
  return { scope, nodes, edges, cycles };
}

/**
 * Builds the dependency graph for a scope (§2.10). Issue level: the
 * milestone's or project's issues plus their direct outside blockers and
 * blocked issues as `external` nodes. Milestone level: one node per
 * milestone in an active project with open issues or with edges. Nodes come
 * in display order (issues, then externals; milestones in milestone order)
 * and edges in node order, so the output is stable.
 */
export function buildDependencyGraph(
  snapshot: Snapshot,
  ctx: EvalContext,
  assessments: ReadonlyMap<string, MilestoneAssessment>,
  scope: GraphScope
): DependencyGraph {
  const risk = issueRisk(snapshot, assessments);
  if (scope.level === 'milestone') {
    return milestoneGraph(snapshot, ctx, assessments, risk, scope);
  }
  return issueGraph(snapshot, risk, scope);
}
