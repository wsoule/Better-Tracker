'use client';

import type { ReactNode } from 'react';

import StatusMark from '../components/status-mark';
import { Kbd } from '../shell/kbd';
import { Button } from '../tasks/button';
import { Chip } from '../tasks/chip';
import { TraceSwatch } from './chart-canvas';
import { type ChartModel, isOpenState, traceChart } from './chart-model';
import { stateWord } from './chart-node';
import styles from './dependency-chart.module.css';

// How many rows a list shows before folding the rest into "+N more".
const LIST_LIMIT = 8;

/** "1 issue", "3 issues" in the host's words. */
export function countOf(
  n: number,
  unit: readonly [string, string] = ['box', 'boxes']
): string {
  return `${n} ${n === 1 ? unit[0] : unit[1]}`;
}

/** The inspector's frame: a kicker, a title, then sections. */
function Frame({
  kicker,
  title,
  meta,
  children,
  actions,
}: {
  kicker: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={styles.inspectorFrame}>
      <div className={styles.inspectorHead}>
        <p className={styles.kicker}>{kicker}</p>
        <h2 className={styles.inspectorTitle}>{title}</h2>
        {meta !== undefined ? (
          <div className={styles.inspectorMeta}>{meta}</div>
        ) : null}
      </div>
      {actions !== undefined ? (
        <div className={styles.inspectorActions}>{actions}</div>
      ) : null}
      {children}
    </div>
  );
}

function Section({
  label,
  count,
  dir,
  children,
}: {
  label: string;
  count?: number;
  dir?: 'up' | 'down';
  children: ReactNode;
}) {
  return (
    <section className={styles.section} aria-label={label}>
      <h3 className={styles.sectionLabel}>
        <span>
          {label}
          {count !== undefined ? (
            <span className={styles.sectionCount}> · {count}</span>
          ) : null}
        </span>
        {dir !== undefined ? <TraceSwatch dir={dir} /> : null}
      </h3>
      {children}
    </section>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className={styles.hint}>{children}</p>;
}

/** A box as an inspector row: status mark, key, name and a quiet note. A
    click hands the id back, which traces it on the chart. */
function NodeRow({
  model,
  id,
  note,
  onPick,
}: {
  model: ChartModel;
  id: string;
  note?: string;
  onPick: (id: string) => void;
}) {
  const node = model.nodes.get(id);
  if (node === undefined) return null;
  const { data } = node;
  return (
    <li>
      <button
        type="button"
        className={styles.row}
        title={data.label}
        onClick={() => onPick(id)}
        data-chart-row={id}
      >
        {data.status !== undefined ? (
          <StatusMark status={data.status} label={data.statusLabel ?? ''} />
        ) : (
          <span aria-hidden className={styles.rowMarkGap} />
        )}
        {data.key !== undefined ? (
          <span className={styles.mono}>{data.key}</span>
        ) : null}
        <span
          className={styles.rowName}
          data-quiet={isOpenState(node.state) ? undefined : ''}
        >
          {data.label}
        </span>
        {note !== undefined ? (
          <span className={styles.rowNote}>{note}</span>
        ) : null}
      </button>
    </li>
  );
}

function NodeList({
  ids,
  model,
  onPick,
  empty,
  limit = LIST_LIMIT,
  note,
}: {
  ids: readonly string[];
  model: ChartModel;
  onPick: (id: string) => void;
  empty?: string;
  limit?: number;
  note?: (id: string, index: number) => string | undefined;
}) {
  if (ids.length === 0) {
    return empty === undefined ? null : <Hint>{empty}</Hint>;
  }
  const shown = ids.slice(0, limit);
  return (
    <>
      <ul className={styles.rows}>
        {shown.map((id, i) => (
          <NodeRow
            key={id}
            id={id}
            model={model}
            note={note?.(id, i)}
            onPick={onPick}
          />
        ))}
      </ul>
      {ids.length > shown.length ? (
        <Hint>+{ids.length - shown.length} more</Hint>
      ) : null}
    </>
  );
}

/** What the inspector shows with nothing selected: how to read the
    chart, the headline numbers, and the lists worth starting from. */
export function InspectorOverview({
  model,
  unit,
  hiddenUnlinked,
  onPick,
  onShowUnlinked,
}: {
  model: ChartModel;
  unit: readonly [string, string];
  /** Boxes left off because nothing links them (Show unlinked is off). */
  hiddenUnlinked: number;
  onPick: (id: string) => void;
  onShowUnlinked: () => void;
}) {
  let open = 0;
  for (const node of model.nodes.values()) {
    if (isOpenState(node.state)) open += 1;
  }
  const facts: [string, number][] = [
    ['Open', open],
    ['Ready', model.readyNow.length],
    ['In progress', model.inProgress.length],
    ['At risk', model.atRisk.length],
    ['Edges', model.edges.length],
    ['Critical path', model.longestChain.length],
  ];
  return (
    <div data-chart-overview="" className={styles.inspectorFrame}>
      <div className={styles.howTo}>
        <p>
          Click a{unit[0].match(/^[aeiou]/i) === null ? '' : 'n'} {unit[0]} to
          trace it. Lines turn <span className={styles.wordUp}>amber</span> back
          through everything it waits on and{' '}
          <span className={styles.wordDown}>teal</span> forward through
          everything it holds up. Double-click to open it.
        </p>
        <p className={styles.keys}>
          Drag to pan · scroll to zoom · <Kbd>/</Kbd> find · <Kbd>Esc</Kbd>{' '}
          clear · <Kbd>0</Kbd> fit · <Kbd>+</Kbd> <Kbd>−</Kbd> zoom
        </p>
      </div>
      <dl className={styles.facts}>
        {facts.map(([label, n]) => (
          <div key={label} className={styles.fact}>
            <dt>{label}</dt>
            <dd>{n}</dd>
          </div>
        ))}
      </dl>
      <Section label="Critical path" count={model.longestChain.length}>
        <NodeList
          ids={model.longestChain}
          model={model}
          onPick={onPick}
          empty={`No open ${unit[0]} waits on another.`}
          limit={12}
          note={(_id, i) => `${i + 1}`}
        />
      </Section>
      <Section label="Ready to start" count={model.readyNow.length}>
        <NodeList
          ids={model.readyNow}
          model={model}
          onPick={onPick}
          empty={`Nothing is ready: every open ${unit[0]} waits on something or is on no relation.`}
        />
      </Section>
      {model.atRisk.length > 0 ? (
        <Section label="At risk" count={model.atRisk.length}>
          <NodeList ids={model.atRisk} model={model} onPick={onPick} />
        </Section>
      ) : null}
      {hiddenUnlinked > 0 ? (
        <Section label="Not on the chart" count={hiddenUnlinked}>
          <Hint>
            {countOf(hiddenUnlinked, unit)} with no blocking relation either way{' '}
            {hiddenUnlinked === 1 ? 'is' : 'are'} left off so the chains stay
            readable.
          </Hint>
          <div>
            <Button size="sm" variant="secondary" onClick={onShowUnlinked}>
              Show unlinked
            </Button>
          </div>
        </Section>
      ) : null}
    </div>
  );
}

/**
 * A selected box: where it sits, its state, what it waits on and what it
 * holds up (direct edges listed, the transitive reach counted), and the
 * ways on: open it, open its own graph, fit its chain, clear.
 */
export function NodeInspector({
  model,
  id,
  unit,
  openLabel,
  drillHref,
  onPick,
  onFitChain,
  onOpen,
  onClear,
}: {
  model: ChartModel;
  id: string;
  unit: readonly [string, string];
  /** The primary button's words ("Open issue", "Details"), or null for
      none. */
  openLabel: string | null;
  /** Its own graph one level down, already carried by the host. */
  drillHref: string | null;
  onPick: (id: string) => void;
  onFitChain: (ids: ReadonlySet<string>) => void;
  onOpen: (id: string) => void;
  onClear: () => void;
}) {
  const node = model.nodes.get(id);
  if (node === undefined) return null;
  const { data } = node;
  const up = traceChart(model, id, 'up');
  const down = traceChart(model, id, 'down');
  const blockers = model.blockersOf.get(id) ?? [];
  const dependents = model.dependentsOf.get(id) ?? [];
  const hidden = model.hiddenBlockers.get(id) ?? 0;
  const openUp = [...up].filter((x) => {
    const state = model.nodes.get(x)?.state;
    return state !== undefined && isOpenState(state);
  }).length;
  const word = stateWord(node);
  const kicker = node.frames.length > 0 ? node.frames.join(' / ') : unit[0];
  return (
    <Frame
      kicker={kicker}
      title={
        <>
          {data.key !== undefined ? (
            <span className={styles.mono}>{data.key} </span>
          ) : null}
          {data.label}
        </>
      }
      meta={
        <>
          {data.status !== undefined ? (
            <Chip
              status={data.status}
              statusLabel={data.statusLabel ?? ''}
              tone="default"
            >
              {data.statusLabel ?? ''}
            </Chip>
          ) : null}
          {word.label !== '' && word.label !== data.statusLabel ? (
            <Chip tone={word.tone}>{word.label}</Chip>
          ) : null}
          {(data.tags ?? []).map((tag) => (
            <Chip
              key={tag}
              tone={
                tag === 'Overdue' || tag.includes('ycle')
                  ? 'danger'
                  : tag === 'Unassigned' || tag === 'No lead'
                    ? 'warning'
                    : 'default'
              }
            >
              {tag}
            </Chip>
          ))}
        </>
      }
      actions={
        <>
          {openLabel !== null ? (
            <Button size="sm" variant="primary" onClick={() => onOpen(id)}>
              {openLabel}
            </Button>
          ) : null}
          {drillHref !== null ? (
            <Button size="sm" variant="secondary" href={drillHref}>
              Open graph
            </Button>
          ) : null}
          {up.size + down.size > 0 ? (
            <Button
              size="sm"
              variant="quiet"
              onClick={() => onFitChain(new Set([...up, ...down, id]))}
            >
              Fit its chain
            </Button>
          ) : null}
          <Button size="sm" variant="quiet" onClick={onClear}>
            Clear
          </Button>
        </>
      }
    >
      <Section label="Waits on" count={blockers.length} dir="up">
        <NodeList
          ids={blockers}
          model={model}
          onPick={onPick}
          empty={
            hidden > 0
              ? undefined
              : isOpenState(node.state)
                ? 'Nothing here. It can start whenever someone picks it up.'
                : 'Nothing here.'
          }
        />
        {hidden > 0 ? (
          <Hint>
            {hidden === 1
              ? '1 more open blocker is outside this graph.'
              : `${hidden} more open blockers are outside this graph.`}
          </Hint>
        ) : null}
        {up.size > blockers.length ? (
          <Hint>
            {countOf(up.size, unit)} upstream in all, {openUp} still open.
          </Hint>
        ) : null}
      </Section>
      <Section label="Holds up" count={dependents.length} dir="down">
        <NodeList
          ids={dependents}
          model={model}
          onPick={onPick}
          empty="Nothing here waits on it."
        />
        {down.size > dependents.length ? (
          <Hint>{countOf(down.size, unit)} downstream in all.</Hint>
        ) : null}
      </Section>
    </Frame>
  );
}

/** A highlighted set (a toolbar highlight): what it is and its members. */
export function SetInspector({
  model,
  label,
  blurb,
  ids,
  numbered,
  onPick,
  onClear,
}: {
  model: ChartModel;
  label: string;
  blurb: string;
  ids: readonly string[];
  /** Number the rows (the critical path's steps). */
  numbered: boolean;
  onPick: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <Frame
      kicker="Highlighted"
      title={`${label} · ${ids.length}`}
      actions={
        <Button size="sm" variant="quiet" onClick={onClear}>
          Clear
        </Button>
      }
    >
      <Hint>{blurb}</Hint>
      <NodeList
        ids={ids}
        model={model}
        onPick={onPick}
        empty="Nothing right now."
        limit={40}
        note={numbered ? (_id, i) => `${i + 1}` : undefined}
      />
    </Frame>
  );
}
