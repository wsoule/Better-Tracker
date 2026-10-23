'use client';

import type { GraphHighlight } from '@better-tracker/core';
import {
  AlertStrip,
  BlockBar,
  Button,
  chainPhrase,
  Chip,
  type ChipTone,
  DependencyGraph,
  EmptyState,
  type GraphNodeData,
  GraphLegend,
  longestChain,
  MermaidSource,
  NavTabs,
  type NodePaths,
  nodePaths,
  Notice,
  type PathContext,
  pathContext,
  pathNodeName,
  PropertyList,
  Register,
  RegisterCell,
  RegisterRow,
  SegmentedControl,
  type SegmentedOption,
  SLIDE_OVER_WIDTH,
  SlideOver,
  StatusMark,
  TaskCrumbs,
  useToast,
} from '@better-tracker/ui';
import { ExternalLink } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  addressHref,
  carryHighlight,
  carryLock,
  GRAPH_HIGHLIGHT_LABEL,
  GRAPH_HIGHLIGHTS,
  type GraphNodeDetail,
  type GraphPageModel,
  type GraphTooLarge,
  highlightCookie,
  highlightFromCookies,
  LOCK_PARAM,
  lockedNodeId,
  lockParam,
  parseHighlight,
  parseLockParam,
  scopeQuery,
} from '../../../lib/adapters/graph';
import {
  type IssueDrawerParts,
  type IssueDrawerServer,
  useIssueDrawerParts,
  useIssueDrawerState,
} from '../components/issue-drawer';
import css from './page.module.css';

/** The highlight switch's options, in switch order. */
const HIGHLIGHT_OPTIONS: SegmentedOption[] = GRAPH_HIGHLIGHTS.map((id) => ({
  id,
  label: GRAPH_HIGHLIGHT_LABEL[id],
}));

/**
 * The highlight last picked on the switch in this tab (null until one is),
 * kept for the life of the page so a later graph opened without a reload
 * knows it even where the cookie cannot be read (initialBare).
 */
let pickedInThisTab: GraphHighlight | null = null;

/**
 * What a /graph URL with no ?highlight= shows on this device, as the
 * island first renders: the graph-highlight cookie read on the client,
 * else the mode last picked in this tab, else the server's read of the
 * cookie (`server`). The client read comes first because a remount from
 * the router cache (Back, Forward) carries a stale server prop. It can
 * come back empty when the cookie is there: browsers decide which cookies
 * a page's script sees by the path the page was loaded at, so a page
 * loaded at /issues or /timeline never sees the Path=/graph cookie, even
 * after a link moves it to /graph. The server's read, made for this very
 * navigation, is right then, unless this tab picked a mode since it was
 * made.
 */
function initialBare(server: GraphHighlight): GraphHighlight {
  if (typeof document === 'undefined') return server;
  return highlightFromCookies(document.cookie) ?? pickedInThisTab ?? server;
}

/* The graph's client island, in Gr8r's look (§8.4 Graph): the page
   header (trail, h1, receipts, notices), the section title right over the
   graph panel, level tabs (route links) and the highlight switch (Status
   / Risk / Critical path) in the panel's toolbar, or the tabs alone in the
   section title row when nothing is drawn, the pan/zoom DependencyGraph
   laid out by the server (every item of the scope, in labelled frames by
   parent; a chain's issue ringed as its focus) with its readout row, the
   highlight's legend key rows under it, Copy Mermaid in the highlight,
   the too-large state, and the slide-over for the selected node. Blocks
   stand 12px apart. A click (tap, Enter) on a box locks it, keeping its
   paths lit while the reader pans or switches the highlight; the lock
   lives in ?lock= (written in place like ?highlight=, read back on Back
   and Forward, carried on the graph links it draws and dropped when the
   box is not drawn), and a second click on the locked box, or its
   strip's Open, opens it. A double-click drills into the box's own graph
   (model drillHref, carrying the highlight). An initiative, project or
   milestone node shows what it is, its drill-down links, where it stands,
   what it waits on and what it holds up (the same paths the graph
   lights); an issue node opens the issue itself (§8.5, ?issue=<key>,
   rendered by the server), in the same panel, and stays the canvas's
   selection while it is open. The page remounts this island per scope and
   ?node= (model.pageKey), so the arrival selection is just the initial
   state. The highlight is client state, read from the history entry's
   URL (?highlight=) and this device's graph-highlight cookie (initialBare:
   never a cached server prop, so Back and Forward show what each entry
   says, but the server's fresh read on a link from another page):
   switching never asks the server or moves a box; it writes the cookie
   and ?highlight= in place (every other parameter kept, and never while a
   navigation is on its way, which a history write would cancel), and the
   graph links it draws carry the mode to the next graph. */
export default function GraphScreen({
  model,
  bareHighlight,
  issueDrawer,
}: {
  model: GraphPageModel;
  /** What a /graph URL with no ?highlight= shows here, as the server read
      the cookie (highlightFromCookies, else the default). */
  bareHighlight: GraphHighlight;
  issueDrawer: IssueDrawerServer;
}) {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  // Whether the URL is still this island's page: its scope parameters as
  // they were when it mounted. Back and Forward render the page being left
  // with the arriving entry's URL while the traversal is on its way; that
  // island must neither adopt that entry's lock (it does not draw that
  // box) nor write the address bar (it would wipe the entry's ?lock= and
  // ?highlight= before the arriving page reads them).
  const [ownScope] = useState(() => scopeQuery(query));
  const current = scopeQuery(query) === ownScope;
  // What a bare URL shows on this device (initialBare).
  const [bare, setBare] = useState<GraphHighlight>(() =>
    initialBare(bareHighlight)
  );
  // What this history entry shows: its ?highlight=, else the cookie's.
  const entryMode = parseHighlight(searchParams.get('highlight')) ?? bare;
  const [highlight, setHighlight] = useState<GraphHighlight>(entryMode);
  // Back, Forward or a link that names another mode is adopted during
  // render; a switch updates both at once, so it is never undone.
  const [seenEntry, setSeenEntry] = useState(entryMode);
  if (entryMode !== seenEntry) {
    setSeenEntry(entryMode);
    setHighlight(entryMode);
  }
  // The locked box: this history entry's ?lock= (a box that is not drawn
  // locks nothing), adopted during render on Back and Forward like the
  // highlight; a lock, a move and an unlock update it at once and the
  // address bar follows below.
  const lockInUrl = parseLockParam(searchParams.get(LOCK_PARAM));
  const entryLock = useMemo(
    () => lockedNodeId(model.nodes, lockInUrl),
    [model.nodes, lockInUrl]
  );
  const [lockId, setLockId] = useState<string | null>(entryLock);
  const [seenLock, setSeenLock] = useState(entryLock);
  if (current && entryLock !== seenLock) {
    setSeenLock(entryLock);
    setLockId(entryLock);
  }
  const lock = lockParam(model.nodes, lockId);
  const issue = useIssueDrawerState(issueDrawer);
  // A link click starts a navigation the address-bar write below would
  // cancel (Next turns a history write into a restore that discards it):
  // it waits until the URL moves on, or a few seconds if it never does.
  const [leaving, setLeaving] = useState<string | null>(null);
  if (leaving !== null && leaving !== query) setLeaving(null);
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);
  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
      if (event.shiftKey || event.altKey) return;
      const anchor =
        event.target instanceof Element
          ? event.target.closest('a[href]')
          : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target !== '' && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;
      if (anchor.origin !== window.location.origin) return;
      setLeaving(queryRef.current);
    }
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
  useEffect(() => {
    if (leaving === null) return undefined;
    const timer = window.setTimeout(() => setLeaving(null), 8000);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  const navigating = issue.navigating || leaving !== null;
  // The address bar says what is shown: on arrival (the cookie may have
  // picked the mode), after every switch, lock and unlock and after each
  // navigation lands, ?highlight= and ?lock= are written in place
  // (addressHref), every other parameter kept; never while a navigation is
  // on its way. In place, so a lock leaves no history entry of its own:
  // Back from a drill-down returns to the box that was locked.
  useEffect(() => {
    if (navigating || !current) return;
    const { pathname, search, hash } = window.location;
    const here = `${pathname}${search}${hash}`;
    const wanted = addressHref(here, highlight, bare, lock);
    if (wanted !== here) window.history.replaceState(null, '', wanted);
  }, [highlight, bare, navigating, current, query, lock]);
  const choose = (id: string) => {
    const mode = parseHighlight(id);
    if (mode === null) return;
    setHighlight(mode);
    setBare(mode);
    pickedInThisTab = mode;
    // Remembered on this device for the next graph (Path=/graph).
    document.cookie = highlightCookie(
      mode,
      window.location.protocol === 'https:'
    );
  };
  /** A graph link this screen draws, carrying the mode on screen and the
      locked box (the next graph keeps it if it draws that box). */
  const carry = (href: string) =>
    carryHighlight(carryLock(href, lock), highlight, bare);
  /** A drill-down link: the mode on screen, not the lock (the box drilled
      into is the next page's subject). */
  const carryDrill = (href: string) => carryHighlight(href, highlight, bare);
  /** A double-click's drill-down: a client navigation, held clear of the
      address-bar write like a link click. */
  const drill = (href: string) => {
    setLeaving(queryRef.current);
    router.push(href);
  };
  const [selectedId, setSelectedId] = useState<string | null>(
    model.initialSelectedId
  );
  const issueParts = useIssueDrawerParts(issue);
  // The panel the page opened on arrival (?node=, or ?issue=) covers the
  // canvas's right: until it first closes the graph keeps room beside it,
  // so the box the visit is about is not hidden under its own panel.
  const [arrivalPanel, setArrivalPanel] = useState(
    () => model.initialSelectedId !== null || issue.requested !== null
  );
  if (arrivalPanel && selectedId === null && issue.requested === null) {
    setArrivalPanel(false);
  }
  const issueNodeId = useMemo(() => {
    const wanted = issue.requested?.toUpperCase();
    if (wanted === undefined) return null;
    return (
      Object.values(model.details).find(
        (detail) =>
          detail.issueKey?.toUpperCase() === wanted ||
          detail.id.toUpperCase() === wanted
      )?.id ?? null
    );
  }, [issue.requested, model.details]);
  const drawn = model.nodes.length > 0;
  const tabs =
    model.tabs.length > 0 ? (
      <NavTabs
        label="Graph level"
        size="sm"
        items={model.tabs.map((tab) =>
          tab.href === undefined ? tab : { ...tab, href: carry(tab.href) }
        )}
        className={drawn ? css.toolbarTabs : undefined}
      />
    ) : null;
  // Only a drawing has something to highlight: the switch is left out of
  // the empty and too-large states.
  const switcher = (
    <div className={css.highlightSwitch}>
      <SegmentedControl
        label="Highlight"
        size="sm"
        options={HIGHLIGHT_OPTIONS}
        value={highlight}
        onChange={choose}
      />
    </div>
  );
  const mermaid =
    model.mermaid === null
      ? null
      : `${model.mermaid.body}${model.mermaid.styles[highlight]}`;

  /** Opens a box from the canvas (a second click, tap or Enter on the
      locked box, or Open on its strip or in the readout): an issue's
      slide-over, else the box's panel. Idempotent, never a toggle: a box
      already open stays open (the timeline's link that arrives with its
      panel open, Open pressed twice); the panel's × and Escape close it. */
  const open = (id: string) => {
    const detail = model.details[id];
    if (detail?.kind === 'issue' && detail.issueKey !== null) {
      setSelectedId(null);
      if (issueNodeId !== id) issue.open(detail.issueKey);
      return;
    }
    if (issue.requested !== null) issue.close();
    setSelectedId(id);
  };
  // The panel's own rows ("Waits on", "Holds up") select a box, and a
  // second press on the row shown closes it again. Issue nodes open the
  // issue's slide-over; the other kinds the panel.
  const select = (id: string) => {
    const detail = model.details[id];
    if (detail?.kind === 'issue' && detail.issueKey !== null) {
      setSelectedId(null);
      if (issueNodeId === id) issue.close();
      else issue.open(detail.issueKey);
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
              breadcrumb={model.trail.map((crumb) =>
                crumb.href === undefined
                  ? crumb
                  : { ...crumb, href: carry(crumb.href) }
              )}
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
          {/* DependencyGraph renders only its empty state without nodes
            (no toolbar), so the level tabs move to the section title row
            then: they are the way to another level exactly when this one
            shows nothing. The title sits right over its panel. */}
          <div>
            <BlockBar title={model.blockTitle} meta={model.meta}>
              {drawn ? null : tabs}
            </BlockBar>
            {model.tooLarge !== null ? (
              <TooLargeBlock tooLarge={model.tooLarge} carry={carry} />
            ) : (
              <DependencyGraph
                nodes={model.nodes}
                edges={model.edges}
                clusters={model.clusters}
                layout={model.layout ?? undefined}
                selectedId={issue.requested === null ? selectedId : issueNodeId}
                lockedId={lockId}
                onLockChange={setLockId}
                onDrill={drill}
                drillHrefFor={carryDrill}
                focusId={model.focusId}
                focusLabel="the issue this chain is about"
                coveredRight={arrivalPanel ? SLIDE_OVER_WIDTH : undefined}
                onSelect={open}
                ariaSummary={model.ariaSummary}
                emptyMessage={model.emptyMessage}
                toolbar={
                  drawn ? (
                    <>
                      {tabs}
                      {switcher}
                    </>
                  ) : null
                }
                highlight={highlight}
                readout={model.readouts[highlight]}
                pathWords={model.pathWords}
              />
            )}
          </div>
          {drawn ? (
            // The key under the drawing, as under a figure, so the first
            // screen is the drawing, on a phone too (2026-10-23 review: above
            // it, the legend pushed the canvas below the fold). Every
            // highlight's legend in one grid cell, the others hidden (and
            // inert), so the cell is always as tall as the tallest and
            // switching never moves what follows it.
            <div className={css.legends}>
              {GRAPH_HIGHLIGHTS.map((mode) => (
                <div
                  key={mode}
                  className={css.legendSlot}
                  data-shown={mode === highlight ? '' : undefined}
                  aria-hidden={mode === highlight ? undefined : true}
                  inert={mode !== highlight}
                >
                  <GraphLegend
                    items={model.legends[mode]}
                    label={`Graph legend: ${GRAPH_HIGHLIGHT_LABEL[mode]}`}
                  />
                </div>
              ))}
            </div>
          ) : null}
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
          highlight={highlight}
          selectedId={selectedId}
          onSelect={select}
          onClose={() => setSelectedId(null)}
          issue={issue.requested === null ? null : issueParts}
          onCloseIssue={issue.close}
          carry={carry}
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
function TooLargeBlock({
  tooLarge,
  carry,
}: {
  tooLarge: GraphTooLarge;
  carry: (href: string) => string;
}) {
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
                href={carry(row.href)}
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
  /** The row's tone (data only: Gr8r's rows carry no rule), in the
      highlight's own tone for the box. */
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

/** The node's tone on the canvas in this highlight, for a row's tone: a
    quiet (muted) box and a ready (green edge) one stay plain rows. */
function shownRowTone(
  node: GraphNodeData,
  highlight: GraphHighlight
): GraphNodeData['tone'] {
  const tone =
    highlight === 'status'
      ? (node.readiness?.tone ?? node.tone)
      : highlight === 'risk'
        ? node.tone
        : 'default';
  return tone === 'muted' || tone === 'success' ? 'default' : tone;
}

/**
 * The selected box's slide-over: its properties (the server's Readiness
 * and Open issues rows among them; under Critical path also its step on
 * the longest chain through it), its links, a summary line, then what it
 * waits on and what it holds up, both transitive over the drawn box
 * arrows (the paths the canvas lights), each row with its readiness chip
 * in its Status tone: the heads where work can start read "Start here",
 * the boxes finishing it alone would clear "Clear next". What the graph
 * counts but does not draw gets a note, and the box-arrow caveat is said
 * once.
 */
function PanelBody({
  model,
  highlight,
  detail,
  paths,
  ctx,
  onSelect,
  carry,
}: {
  model: GraphPageModel;
  highlight: GraphHighlight;
  detail: GraphNodeDetail;
  paths: NodePaths | null;
  ctx: PathContext<GraphNodeData>;
  onSelect: (id: string) => void;
  carry: (href: string) => string;
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
  const nameOf = (id: string) => {
    const node = ctx.nodes.get(id);
    return node === undefined ? id : pathNodeName(node);
  };
  const criticalRow = (() => {
    if (highlight !== 'critical') return null;
    const chain = longestChain(ctx.chains, detail.id);
    const step = chain?.steps.get(detail.id);
    if (chain === null || step === undefined) return 'Not on an open chain';
    const names = chainPhrase(chain.groups.map((group) => group.map(nameOf)));
    return `Step ${step} of ${chain.stepCount} (${names})`;
  })();
  const summary = [
    `Waits on ${waitsOn.length}`,
    `Holds up ${holdsUp.length}`,
    clears > 0 ? `Finishing it would clear ${clears}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
  const toneOf = (node: GraphNodeData) => shownRowTone(node, highlight);
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
          ...(criticalRow === null
            ? []
            : [{ label: 'Critical path', value: criticalRow }]),
        ]}
      />
      <div className={css.links}>
        {detail.links.map((link) => (
          <Button
            key={link.href}
            href={link.external ? link.href : carry(link.href)}
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
  highlight,
  selectedId,
  onSelect,
  onClose,
  issue,
  onCloseIssue,
  carry,
}: {
  model: GraphPageModel;
  highlight: GraphHighlight;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** An issue's slide-over, drawn in this same panel. */
  issue: IssueDrawerParts | null;
  onCloseIssue: () => void;
  carry: (href: string) => string;
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
          highlight={highlight}
          detail={detail}
          paths={paths}
          ctx={ctx}
          onSelect={onSelect}
          carry={carry}
        />
      )}
    </SlideOver>
  );
}
