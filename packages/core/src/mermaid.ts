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

/** Risk nodes and risk-chain edges: the amber status hue (`--amber`). */
const MERMAID_RISK = '#c27d0a';
/** Cycle nodes: the red status hue (`--red`). */
const MERMAID_CYCLE = '#d92d20';

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
 * Renders the graph as `flowchart LR`. Node ids are positional (`n0`, `n1`,
 * …) so they never depend on Linear ids; labels are quoted and escaped;
 * open edges use `-->`, resolved ones `-.->`, and edges summarising more
 * than one relation carry the count. Risk, cycle and external nodes get
 * classes (risk in the amber status hue, cycles in the red one), and
 * risk-chain edges an amber link style. A chain also marks
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
  // The light theme's status MARK hexes (ui tokens.css --amber, --red;
  // architecture §8.2), never the purple accent, which is not a status.
  lines.push(
    `  classDef risk stroke:${MERMAID_RISK},stroke-width:2px`,
    `  classDef cycle stroke:${MERMAID_CYCLE},stroke-dasharray:5 3`,
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
    lines.push(`  linkStyle ${riskEdges.join(',')} stroke:${MERMAID_RISK}`);
  }
  return `${lines.join('\n')}\n`;
}
