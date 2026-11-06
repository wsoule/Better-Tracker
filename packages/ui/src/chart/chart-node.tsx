'use client';

import { memo } from 'react';

import StatusMark from '../components/status-mark';
import { cx } from '../tasks/class-names';
import type { UiTone } from '../types';
import type { ChartNode, ChartState } from './chart-model';
import styles from './dependency-chart.module.css';

/** The state word on a card and its tone (architecture §8.2: amber
    blocked, blue in progress, green ready, grey done and inactive). */
export function stateWord(node: ChartNode): { label: string; tone: UiTone } {
  const said = node.data.readiness?.label ?? '';
  const or = (fallback: string) => (said === '' ? fallback : said);
  switch (node.state) {
    case 'done':
      return { label: node.data.statusLabel ?? 'Done', tone: 'muted' };
    case 'empty':
      return { label: or('No issues'), tone: 'muted' };
    case 'blocked':
      return { label: or('Blocked'), tone: 'warning' };
    case 'progress':
      return { label: 'In progress', tone: 'info' };
    case 'ready':
      return { label: or('Ready'), tone: 'success' };
    default:
      return { label: said, tone: 'muted' };
  }
}

/** The state colours the legend lists, in its order. */
export const STATE_LEGEND: readonly { state: ChartState; label: string }[] = [
  { state: 'blocked', label: 'Blocked' },
  { state: 'progress', label: 'In progress' },
  { state: 'ready', label: 'Ready' },
  { state: 'open', label: 'No dependencies' },
  { state: 'done', label: 'Done' },
];

/** A legend swatch: a tiny card in the state's own edge. */
export function StateSwatch({
  state,
  risk,
}: {
  state?: ChartState;
  risk?: 'danger' | 'warning';
}) {
  return (
    <span
      aria-hidden
      className={styles.stateSwatch}
      data-state={state}
      data-risk={risk}
    />
  );
}

/** The sublabel with its leading key, if any, in Geist Mono. */
function Sublabel({ text, keyText }: { text: string; keyText?: string }) {
  if (keyText !== undefined && text.startsWith(keyText)) {
    return (
      <span className={styles.cardSub}>
        <span className={styles.mono}>{keyText}</span>
        {text.slice(keyText.length)}
      </span>
    );
  }
  return <span className={styles.cardSub}>{text}</span>;
}

/** What the card says to a screen reader: its name, state, tags and
    frames. */
export function nodeName(node: ChartNode): string {
  const { data } = node;
  const word = stateWord(node).label;
  const parts = [
    data.key !== undefined && !data.label.startsWith(data.key)
      ? `${data.key} ${data.label}`
      : data.label,
    data.statusLabel,
    word === data.statusLabel ? undefined : word,
    ...(data.tags ?? []),
    node.frames.length > 0 ? `in ${node.frames.join(', ')}` : undefined,
  ];
  return parts.filter((p) => p !== undefined && p !== '').join(', ');
}

/**
 * One box on the chart (Gr8r's card): its frames as a quiet line when the
 * chart does not box them, the status mark, sublabel and state word, then
 * the name over two lines. The name is the card's one control, stretched
 * over the whole card: a click selects (traces) the box, a double-click
 * opens it. Memoised, with handlers that take the id, so a selection only
 * re-renders the cards whose props change.
 */
export const ChartNodeCard = memo(function ChartNodeCard({
  node,
  showFrames,
  selected,
  focus,
  step,
  onSelect,
  onOpen,
}: {
  node: ChartNode;
  showFrames: boolean;
  selected: boolean;
  /** The box the graph is about (a chain's issue): an accent ring off it. */
  focus: boolean;
  /** Its step on the highlighted critical path, if it is on it. */
  step: number | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const { data } = node;
  const word = stateWord(node);
  const risk =
    data.tone === 'danger' || data.tone === 'warning' ? data.tone : undefined;
  return (
    <div
      className={cx(styles.card, showFrames && styles.cardWithFrames)}
      data-state={node.state}
      data-risk={risk}
      data-external={data.external === true ? '' : undefined}
      data-selected={selected ? '' : undefined}
      data-focus={focus ? '' : undefined}
    >
      {showFrames ? (
        <span className={styles.cardFrames}>
          {node.frames.length > 0 ? node.frames.join(' · ') : 'No parent'}
        </span>
      ) : null}
      <span className={styles.cardMeta}>
        {data.status !== undefined ? (
          <StatusMark status={data.status} label={data.statusLabel ?? ''} />
        ) : null}
        {data.sublabel !== undefined && data.sublabel !== '' ? (
          <Sublabel text={data.sublabel} keyText={data.key} />
        ) : (
          <span className={styles.cardSub} />
        )}
        {word.label !== '' ? (
          <span className={styles.cardWord} data-tone={word.tone}>
            {word.label}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        className={styles.cardName}
        aria-label={nodeName(node)}
        aria-pressed={selected}
        title={data.label}
        onClick={() => onSelect(node.id)}
        onDoubleClick={() => onOpen(node.id)}
      >
        <span className={styles.clamp}>{data.label}</span>
      </button>
      {step !== null ? (
        <span className={styles.step} aria-hidden>
          {step}
        </span>
      ) : null}
    </div>
  );
});
