'use client';

import {
  AlertStrip,
  BlockBar,
  Button,
  Chip,
  type ChipTone,
  DependencyChart,
  EmptyState,
  type GraphNodeData,
  MermaidSource,
  NavTabs,
  type NodePaths,
  nodePaths,
  Notice,
  type PathContext,
  pathContext,
  PropertyList,
  Register,
  RegisterCell,
  RegisterRow,
  SlideOver,
  StatusMark,
  TaskCrumbs,
  useToast,
} from '@better-tracker/ui';
import { ExternalLink } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import type {
  GraphNodeDetail,
  GraphPageModel,
  GraphTooLarge,
} from '../../../lib/adapters/graph';
import {
  type IssueDrawerParts,
  type IssueDrawerServer,
  useIssueDrawerParts,
  useIssueDrawerState,
} from '../components/issue-drawer';
import css from './page.module.css';

/** The words for one box and many at each level, for the chart's copy. */
function unitOf(model: GraphPageModel): readonly [string, string] {
  return model.pathWords.unit ?? ['box', 'boxes'];
}

/* The graph's client island, in Gr8r's look (§8.4 Graph): the page
   header (trail, h1, receipts, notices), the section title over the
   chart, then Vadim Sevriuk's dependency chart (ui DependencyChart, ported
   from the Dispatch desktop) laid out by elkjs in the browser: the level
   tabs at the start of its toolbar, then Find, the highlights (Critical
   path, Ready, In progress, At risk) and its display toggles, remembered
   per scope. A click on a box traces what it waits on (amber) and what it
   holds up (teal) and fills the chart's inspector; a double-click drills
   into a container's own graph (model drillHref) or opens an issue, and
   the inspector offers both (Open issue or Details, Open graph). An issue
   opens its slide-over (§8.5, ?issue=<key>, rendered by the server); an
   initiative, project or milestone opens its details panel: what it is,
   its links, where it stands, what it waits on and what it holds up. The
   too-large state stands where the chart would, and Copy Mermaid follows
   it. The page remounts this island per scope and ?node= (model.pageKey),
   so the arrival selection is just the initial state. */
export default function GraphScreen({
  model,
  issueDrawer,
}: {
  model: GraphPageModel;
  issueDrawer: IssueDrawerServer;
}) {
  const { toast } = useToast();
  const router = useRouter();
  const issue = useIssueDrawerState(issueDrawer);
  const issueParts = useIssueDrawerParts(issue);
  const [selectedId, setSelectedId] = useState<string | null>(
    model.initialSelectedId
  );
  // The box whose issue the page opened with ?issue=, traced on arrival.
  const [arrivalIssueNode] = useState(() => {
    const wanted = issue.requested?.toUpperCase();
    if (wanted === undefined) return null;
    return (
      Object.values(model.details).find(
        (detail) =>
          detail.issueKey?.toUpperCase() === wanted ||
          detail.id.toUpperCase() === wanted
      )?.id ?? null
    );
  });
  const drawn = model.nodes.length > 0;
  const unit = unitOf(model);
  const tabs =
    model.tabs.length > 0 ? (
      <NavTabs
        label="Graph level"
        size="sm"
        items={model.tabs}
        className={drawn ? css.toolbarTabs : undefined}
      />
    ) : null;
  const mermaid =
    model.mermaid === null
      ? null
      : `${model.mermaid.body}${model.mermaid.styles.status}`;
  const byId = useMemo(
    () => new Map(model.nodes.map((node) => [node.id, node])),
    [model.nodes]
  );

  /** Opens a box: an issue's slide-over, else the box's details panel.
      Idempotent, never a toggle; the panel's × and Escape close it. */
  const open = (id: string) => {
    const detail = model.details[id];
    if (detail?.kind === 'issue' && detail.issueKey !== null) {
      setSelectedId(null);
      issue.open(detail.issueKey);
      return;
    }
    if (issue.requested !== null) issue.close();
    setSelectedId(id);
  };
  /** A double-click: a container drills into its own graph, an issue (or
      a box with no graph of its own) opens. */
  const activate = (id: string) => {
    const node = byId.get(id);
    if (node?.drillHref !== undefined && model.details[id]?.kind !== 'issue') {
      router.push(node.drillHref);
      return;
    }
    open(id);
  };
  // The panel's own rows ("Waits on", "Holds up") select a box, and a
  // second press on the row shown closes it again.
  const select = (id: string) => {
    const detail = model.details[id];
    if (detail?.kind === 'issue' && detail.issueKey !== null) {
      setSelectedId(null);
      issue.open(detail.issueKey);
      return;
    }
    if (issue.requested !== null) issue.close();
    setSelectedId((current) => (current === id ? null : id));
  };

  return (
    <>
      <header className={css.head}>
        {model.trail.length > 0 ? (
          <div className={css.trail}>
            <TaskCrumbs
              label="Graph scope"
              breadcrumb={model.trail}
              taskKey=""
            />
          </div>
        ) : null}
        <h1 className={css.title}>{model.heading}</h1>
        <p className={css.receipts}>{model.receipts}</p>
        {model.notices.map((notice) => (
          <p key={notice.id} className={css.notice} data-notice={notice.id}>
            {notice.text}
          </p>
        ))}
      </header>
      <div className={css.body}>
        <section className={css.collapse} aria-label={model.heading}>
          {/* With nothing to draw (an empty scope, or too large) the level
            tabs move to the section title row: they are the way to another
            level exactly when this one shows nothing. */}
          <div>
            <BlockBar title={model.blockTitle} meta={model.meta}>
              {drawn ? null : tabs}
            </BlockBar>
            {model.tooLarge !== null ? (
              <TooLargeBlock tooLarge={model.tooLarge} />
            ) : (
              <DependencyChart
                nodes={model.nodes}
                edges={model.edges}
                clusters={model.clusters}
                prefsKey={model.scopeHref}
                defaultPrefs={
                  // Issues follow Vadim's Tasks chart (the chains, unlinked
                  // work behind a toggle); the container levels his
                  // milestone map (every box).
                  model.level === 'issue' && model.container.kind !== 'chain'
                    ? undefined
                    : { showUnlinked: true }
                }
                initialSelectedId={model.initialSelectedId ?? arrivalIssueNode}
                focusId={model.focusId}
                unit={unit}
                onOpen={open}
                openLabel={(node: GraphNodeData) =>
                  model.details[node.id]?.kind === 'issue'
                    ? 'Open issue'
                    : 'Details'
                }
                onActivate={activate}
                onDrill={(href) => router.push(href)}
                ariaLabel={model.ariaSummary}
                emptyMessage={model.emptyMessage}
                toolbar={drawn ? tabs : undefined}
              />
            )}
          </div>
          {drawn && mermaid !== null ? (
            <MermaidSource
              source={mermaid}
              onCopy={(ok) =>
                toast(
                  ok
                    ? {
                        kind: 'info',
                        label: 'Copied',
                        message: 'The Mermaid source is on your clipboard.',
                      }
                    : {
                        kind: 'error',
                        label: 'Copy failed',
                        message:
                          'The browser refused the clipboard; the source is selected below.',
                      }
                )
              }
            />
          ) : null}
        </section>
        <NodePanel
          model={model}
          selectedId={selectedId}
          onSelect={select}
          onClose={() => setSelectedId(null)}
          issue={issue.requested === null ? null : issueParts}
          onCloseIssue={issue.close}
        />
      </div>
    </>
  );
}

/* Past the draw limits: one neutral notice saying how many boxes and
   arrows the graph would need and that it draws at most 700 and 1,000 (a
   size limit, not a risk, so no status tone), then a heading row and the
   narrower graphs to open instead (a register panel, each row a route
   link), or, inside a milestone or a chain, the most connected issues,
   each opening its own chain. It stands where the canvas would. */
function TooLargeBlock({ tooLarge }: { tooLarge: GraphTooLarge }) {
  return (
    <section className={css.tooLarge} aria-label="Too many to draw">
      <Notice label="Too large" tone="default">
        {tooLarge.message}
      </Notice>
      {tooLarge.rows.length > 0 ? (
        <>
          <div className={css.tooLargeBar}>
            <p className={css.tooLargeText}>
              <span className={css.tooLargeTitle}>
                {tooLarge.title}
                {tooLarge.note !== null ? '.' : ''}
              </span>
              {tooLarge.note !== null ? (
                <>
                  {' '}
                  <span className={css.tooLargeNote}>{tooLarge.note}</span>
                </>
              ) : null}
            </p>
          </div>
          <Register
            label={tooLarge.title}
            columns="minmax(0, 1.6fr) minmax(0, 0.7fr) minmax(0, 0.5fr)"
            header={[
              { id: 'name', label: 'Name' },
              { id: 'kind', label: 'Kind' },
              { id: 'count', label: 'On edges' },
            ]}
            stackWithin={700}
          >
            {tooLarge.rows.map((row) => (
              <RegisterRow
                key={row.id}
                href={row.href}
                rowLabel={`${row.label}: ${row.count} on edges`}
              >
                <RegisterCell label="Name" variant="name">
                  {row.label}
                </RegisterCell>
                <RegisterCell label="Kind" variant="mono">
                  {row.kind}
                </RegisterCell>
                <RegisterCell label="On edges" variant="mono">
                  {row.count}
                </RegisterCell>
              </RegisterRow>
            ))}
          </Register>
        </>
      ) : null}
    </section>
  );
}

/** A row's chip in the panel's lists: its readiness word in its Status
    tone, or what the selected box makes of it ("Start here", "Clear
    next"). */
interface RowChip {
  label: string;
  tone: ChipTone;
}

/** The row's own readiness chip (none when done: its mark says so). */
function readinessChip(node: GraphNodeData): RowChip | null {
  const readiness = node.readiness;
  if (readiness === undefined || readiness.label === '') return null;
  return { label: readiness.label, tone: readiness.tone };
}

/* One neighbour in the panel's "Waits on" / "Holds up" lists: a button
   row that selects that node, so the reader can walk the chain from here,
   with a chip saying where it stands. */
function NeighbourRows({
  label,
  nodes,
  empty,
  note,
  chipOf,
  toneOf,
  onSelect,
}: {
  label: string;
  nodes: GraphNodeData[];
  empty: string;
  /** A quiet line under the list: what the graph does not draw. */
  note: string | null;
  chipOf: (node: GraphNodeData) => RowChip | null;
  /** The row's tone (data only: Gr8r's rows carry no rule). */
  toneOf: (node: GraphNodeData) => GraphNodeData['tone'];
  onSelect: (id: string) => void;
}) {
  return (
    <section className={css.panelSection} aria-label={label}>
      <h3 className={css.panelKey}>
        {label}
        {nodes.length > 0 ? (
          <span className={css.panelCount}> · {nodes.length}</span>
        ) : null}
      </h3>
      {nodes.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <Register
          label={label}
          columns="minmax(0, 1fr) auto"
          stackedColumns="minmax(0, 1fr)"
        >
          {nodes.map((node) => {
            const chip = chipOf(node);
            return (
              <RegisterRow
                key={node.id}
                onActivate={() => onSelect(node.id)}
                rowLabel={`Show ${node.label}${chip === null ? '' : `, ${chip.label}`}`}
                tone={toneOf(node)}
              >
                <RegisterCell variant="name" sub={node.sublabel}>
                  <span className={css.neighbour}>
                    {node.status !== undefined ? (
                      <StatusMark
                        status={node.status}
                        label={node.statusLabel ?? ''}
                      />
                    ) : null}
                    <span className={css.neighbourName}>{node.label}</span>
                  </span>
                </RegisterCell>
                <RegisterCell align="end">
                  {chip !== null ? (
                    <Chip tone={chip.tone}>{chip.label}</Chip>
                  ) : null}
                </RegisterCell>
              </RegisterRow>
            );
          })}
        </Register>
      )}
      {note !== null ? <p className={css.panelNote}>{note}</p> : null}
    </section>
  );
}

const DETAILS_LABEL: Record<GraphNodeDetail['kind'], string> = {
  initiative: 'Initiative details',
  project: 'Project details',
  milestone: 'Milestone details',
  issue: 'Issue details',
};

/** "1 milestone", "2 milestones" in the level's words. */
function unitCount(model: GraphPageModel, n: number): string {
  const [one, other] = model.pathWords.unit ?? ['box', 'boxes'];
  return `${n} ${n === 1 ? one : other}`;
}

/** A row's tone in the panel: its readiness tone, with a quiet (muted)
    box and a ready (green edge) one kept as plain rows. */
function shownRowTone(node: GraphNodeData): GraphNodeData['tone'] {
  const tone = node.readiness?.tone ?? node.tone;
  return tone === 'muted' || tone === 'success' ? 'default' : tone;
}

/**
 * The selected box's slide-over: its properties (the server's Readiness
 * and Open issues rows among them), its links, a summary line, then what it
 * waits on and what it holds up, both transitive over the drawn box
 * arrows (the paths the canvas lights), each row with its readiness chip
 * in its Status tone: the heads where work can start read "Start here",
 * the boxes finishing it alone would clear "Clear next". What the graph
 * counts but does not draw gets a note, and the box-arrow caveat is said
 * once.
 */
function PanelBody({
  model,
  detail,
  paths,
  ctx,
  onSelect,
}: {
  model: GraphPageModel;
  detail: GraphNodeDetail;
  paths: NodePaths | null;
  ctx: PathContext<GraphNodeData>;
  onSelect: (id: string) => void;
}) {
  const nodesOf = (ids: readonly string[]): GraphNodeData[] =>
    ids
      .map((id) => ctx.nodes.get(id))
      .filter((n): n is GraphNodeData => n !== undefined);
  const waitsOn = nodesOf(paths?.upstream.nodeIds ?? []);
  const holdsUp = nodesOf(paths?.downstream.nodeIds ?? []);
  const startHere = new Set(paths?.startWith ?? []);
  const clearNext = new Set(paths?.next ?? []);
  const clears = (paths?.next.length ?? 0) + (paths?.unblocksNotDrawn ?? 0);
  const outside = paths?.blockersNotDrawn ?? 0;
  const alsoClears = paths?.unblocksNotDrawn ?? 0;
  const summary = [
    `Waits on ${waitsOn.length}`,
    `Holds up ${holdsUp.length}`,
    clears > 0 ? `Finishing it would clear ${clears}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
  const toneOf = shownRowTone;
  return (
    <div className={css.panel}>
      {detail.alert !== null ? (
        <AlertStrip label="Overdue" tone="danger">
          {detail.alert}
        </AlertStrip>
      ) : null}
      <PropertyList
        label={DETAILS_LABEL[detail.kind]}
        items={[
          {
            label: 'Status',
            value: (
              <StatusMark
                status={detail.status}
                label={detail.statusLabel}
                showLabel
              />
            ),
          },
          ...detail.properties.map((property) => ({
            label: property.label,
            // A status tone colours the value's text through the data-tone
            // hook (--tone-ink); default stays --text.
            value:
              property.tone === undefined || property.tone === 'default' ? (
                property.value
              ) : (
                <span className={css.toneText} data-tone={property.tone}>
                  {property.value}
                </span>
              ),
          })),
        ]}
      />
      <div className={css.links}>
        {detail.links.map((link) => (
          <Button
            key={link.href}
            href={link.href}
            external={link.external}
            size="sm"
            iconAfter={
              link.external ? (
                <ExternalLink size={14} strokeWidth={1.8} />
              ) : undefined
            }
          >
            {link.label}
          </Button>
        ))}
      </div>
      <p className={css.panelSummary}>{summary}</p>
      <NeighbourRows
        label="Waits on"
        nodes={waitsOn}
        empty="Nothing upstream: it waits on nothing open here."
        note={
          outside === 0
            ? null
            : outside === 1
              ? '1 more blocker is outside this graph.'
              : `${outside} more blockers are outside this graph.`
        }
        chipOf={(node) =>
          startHere.has(node.id)
            ? { label: 'Start here', tone: 'success' }
            : readinessChip(node)
        }
        toneOf={toneOf}
        onSelect={onSelect}
      />
      <NeighbourRows
        label="Holds up"
        nodes={holdsUp}
        empty="Nothing here waits on it."
        note={
          alsoClears === 0
            ? null
            : `Finishing it would also clear ${unitCount(model, alsoClears)} outside this graph.`
        }
        chipOf={(node) =>
          clearNext.has(node.id)
            ? { label: model.pathWords.next ?? 'Ready next', tone: 'success' }
            : readinessChip(node)
        }
        toneOf={toneOf}
        onSelect={onSelect}
      />
      {waitsOn.length > 0 || holdsUp.length > 0 ? (
        <p className={css.panelCaveat}>
          Box paths follow the arrows between boxes: an arrow in and an arrow
          out may be different issues. The Issues level shows the exact chains.
        </p>
      ) : null}
    </div>
  );
}

function NodePanel({
  model,
  selectedId,
  onSelect,
  onClose,
  issue,
  onCloseIssue,
}: {
  model: GraphPageModel;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** An issue's slide-over, drawn in this same panel. */
  issue: IssueDrawerParts | null;
  onCloseIssue: () => void;
}) {
  // The drawn graph indexed once (ui pathContext, as the canvas does), so
  // the panel's lists are exactly the paths the canvas lights.
  const ctx = useMemo(
    () => pathContext(model.nodes, model.edges),
    [model.nodes, model.edges]
  );
  // Keep the last node while the panel slides out.
  const [shown, setShown] = useState<string | null>(selectedId);
  if (selectedId !== null && selectedId !== shown) setShown(selectedId);
  const detail = shown === null ? undefined : model.details[shown];
  const paths = useMemo(
    () => (detail === undefined ? null : nodePaths(detail.id, ctx)),
    [detail, ctx]
  );

  if (issue !== null) {
    return (
      <SlideOver
        open
        onClose={onCloseIssue}
        title={issue.title}
        breadcrumb={issue.breadcrumb}
        actions={issue.actions}
        closeLabel={issue.closeLabel}
        contentKey={issue.contentKey}
      >
        {issue.body}
      </SlideOver>
    );
  }
  return (
    <SlideOver
      open={selectedId !== null && detail !== undefined}
      onClose={onClose}
      contentKey={shown === null ? undefined : `node:${shown}`}
      title={detail?.title ?? ''}
      breadcrumb={detail?.breadcrumb}
    >
      {detail === undefined ? null : (
        <PanelBody
          model={model}
          detail={detail}
          paths={paths}
          ctx={ctx}
          onSelect={onSelect}
        />
      )}
    </SlideOver>
  );
}
