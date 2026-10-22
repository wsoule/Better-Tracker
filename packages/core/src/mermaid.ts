// Mermaid text for a dependency graph (§2.10), for "Copy Mermaid" and docs.

import type { DependencyGraph, GraphNode } from './types';

// Characters that could end a quoted label, open markup, or be read as
// Mermaid syntax, replaced by Mermaid's `#<code>;` entity escapes.
const MERMAID_ESCAPES: Record<string, string> = {
  '"': '#34;',
  '#': '#35;',
  '%': '#37;',
  '&': '#38;',
  '(': '#40;',
  ')': '#41;',
  '<': '#60;',
  '>': '#62;',
  '[': '#91;',
  ']': '#93;',
  '`': '#96;',
  '{': '#123;',
  '|': '#124;',
  '}': '#125;',
};

/**
 * Makes text safe inside a quoted Mermaid label: one pass replaces each
 * special character with its entity (so `#` is never escaped twice) and
 * line breaks become spaces.
 */
export function escapeMermaidLabel(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/["#%&()<>[\]`{|}]/g, (ch) => MERMAID_ESCAPES[ch] ?? ch);
}

/**
 * Whether a node is drawn as a risk (the `risk` class). An issue or a
 * milestone: it is unassigned/overdue itself or waits on such an issue. A
 * project or an initiative: it is active and overdue, or its status is at
 * risk (a quiet, inactive project is never loud).
 */
export function isRiskNode(node: GraphNode): boolean {
  switch (node.kind) {
    case 'issue':
    case 'milestone':
      return (
        node.unassigned ||
        node.overdue ||
        node.waitsOnUnassigned ||
        node.waitsOnOverdue
      );
    case 'project':
    case 'initiative':
      return node.active && (node.overdue || node.status === 'at_risk');
    default: {
      const unreachable: never = node.kind;
      return unreachable;
    }
  }
}

/**
 * The chip word of a node's readiness (§2.10 "Readiness"): '' when done
 * (its state shows that); an issue 'Ready' or 'Blocked by N'; above the
 * issue level 'Clear', 'None ready' (clear, but every open issue in it
 * waits on another inside) or 'Waiting on N'.
 */
export function readinessLabel(node: GraphNode): string {
  if (node.readiness === 'done') return '';
  if (node.kind === 'issue') {
    return node.readiness === 'blocked'
      ? `Blocked by ${node.blockedBy}`
      : 'Ready';
  }
  if (node.readiness === 'blocked') return `Waiting on ${node.blockedBy}`;
  return node.readyIssues === 0 ? 'None ready' : 'Clear';
}

/**
 * The status highlight's class (§2.10 "Readiness"), shared by the
 * planner's tones and the Mermaid export: quiet (done, or inactive work:
 * §2.8, never loud), stuck (an issue on an open cycle; a box none of whose
 * open issues is ready, with a cycle inside, whether it waits or not),
 * blocked, ready. Mirror-wide: it never reads `inCycle`, which depends on
 * what is drawn, so a box reads the same in every graph that draws it.
 */
export function readinessClass(
  node: GraphNode
): 'ready' | 'blocked' | 'stuck' | 'quiet' {
  if (node.readiness === 'done' || !node.active) return 'quiet';
  const stuck =
    node.kind === 'issue'
      ? node.readiness === 'blocked' && node.holdsCycle
      : node.readyIssues === 0 && node.holdsCycle;
  if (stuck) return 'stuck';
  return node.readiness === 'blocked' ? 'blocked' : 'ready';
}

/**
 * Renders the graph as `flowchart LR`. Node ids are positional (`n0`, `n1`,
 * …) so they never depend on Linear ids; labels are quoted and escaped;
 * open edges use `-->`, resolved ones `-.->`, and edges summarising more
 * than one relation carry the count. Risk, cycle and external nodes get
 * classes, and risk-chain edges an accent link style. A chain also marks
 * its focus (the `focus` class) and, when the chain was cut, says how many
 * of its issues are shown in a comment.
 */
export function toMermaid(graph: DependencyGraph): string {
  const lines: string[] = ['flowchart LR'];
  const idOf = new Map<string, string>();
  graph.nodes.forEach((node, i) => idOf.set(node.id, `n${i}`));

  graph.nodes.forEach((node, i) => {
    const label = escapeMermaidLabel(node.label);
    const sublabel = escapeMermaidLabel(node.sublabel);
    const text = sublabel === '' ? label : `${label}<br/>${sublabel}`;
    lines.push(`  n${i}["${text}"]`);
  });

  const riskEdges: number[] = [];
  let edgeIndex = 0;
  for (const edge of graph.edges) {
    const from = idOf.get(edge.from);
    const to = idOf.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const arrow = edge.resolved ? '-.->' : '-->';
    const count = edge.weight > 1 ? `|${edge.weight}|` : '';
    lines.push(`  ${from} ${arrow}${count} ${to}`);
    if (edge.onRiskChain) riskEdges.push(edgeIndex);
    edgeIndex += 1;
  }

  const chain = graph.chain;
  if (chain !== null && chain.hidden > 0) {
    const kept = graph.nodes.length;
    lines.push(
      `  %% Showing the nearest ${kept} of ${kept + chain.hidden} issues on this chain`
    );
  }
  lines.push(
    '  classDef risk stroke:#9747ff,stroke-width:2px',
    '  classDef cycle stroke:#9747ff,stroke-dasharray:5 3',
    '  classDef external stroke-dasharray:3 3,opacity:0.7'
  );
  if (chain !== null) lines.push('  classDef focus stroke-width:3px');
  const classes: [string, (node: GraphNode) => boolean][] = [
    ['risk', isRiskNode],
    ['cycle', (node) => node.inCycle],
    ['external', (node) => node.external],
  ];
  if (chain !== null) {
    classes.push(['focus', (node) => node.id === chain.focusId]);
  }
  for (const [name, applies] of classes) {
    const ids = graph.nodes.flatMap((node, i) =>
      applies(node) ? [`n${i}`] : []
    );
    if (ids.length > 0) lines.push(`  class ${ids.join(',')} ${name}`);
  }
  if (riskEdges.length > 0) {
    lines.push(`  linkStyle ${riskEdges.join(',')} stroke:#9747ff`);
  }
  return `${lines.join('\n')}\n`;
}
