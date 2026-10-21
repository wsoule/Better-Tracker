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

// A node is drawn as a risk when it is unassigned/overdue itself or waits
// on such an issue.
function isRiskNode(node: GraphNode): boolean {
  return (
    node.unassigned ||
    node.overdue ||
    node.waitsOnUnassigned ||
    node.waitsOnOverdue
  );
}

/**
 * Renders the graph as `flowchart LR`. Node ids are positional (`n0`, `n1`,
 * …) so they never depend on Linear ids; labels are quoted and escaped;
 * open edges use `-->`, resolved ones `-.->`, and milestone edges summarising
 * more than one relation carry the count. Risk, cycle and external nodes get
 * classes, and risk-chain edges an accent link style.
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

  lines.push(
    '  classDef risk stroke:#9747ff,stroke-width:2px',
    '  classDef cycle stroke:#9747ff,stroke-dasharray:5 3',
    '  classDef external stroke-dasharray:3 3,opacity:0.7'
  );
  const classes: [string, (node: GraphNode) => boolean][] = [
    ['risk', isRiskNode],
    ['cycle', (node) => node.inCycle],
    ['external', (node) => node.external],
  ];
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
