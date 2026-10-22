'use client';

import {
  AlertStrip,
  BlockBar,
  blockerIndex,
  Button,
  DependencyGraph,
  EmptyState,
  type GraphNodeData,
  GraphLegend,
  MermaidSource,
  NavTabs,
  PropertyList,
  Register,
  RegisterCell,
  RegisterRow,
  SlideOver,
  StatusMark,
  upstreamChain,
  useToast,
  waiterIndex,
} from '@better-tracker/ui';
import { ExternalLink } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import {
  type GraphNodeDetail,
  type GraphPageModel,
  type IsolatedList,
  levelTabs,
} from '../../../lib/adapters/graph';
import {
  type IssueDrawerParts,
  type IssueDrawerServer,
  useIssueDrawerParts,
  useIssueDrawerState,
} from '../components/issue-drawer';
import css from './page.module.css';

/* The graph's client island: level tabs (route links) in the graph's
   toolbar, the legend, the pan/zoom DependencyGraph, Copy Mermaid, and the
   slide-over for the selected node. A milestone node shows what it is,
   its links, what it waits on and what it holds up (the same upstream
   chain the graph lights); an issue node opens the issue itself (§8.5,
   ?issue=<key>, rendered by the server), in the same panel, and stays the
   canvas's selection while it is open. */
export default function GraphScreen({
  model,
  issueDrawer,
}: {
  model: GraphPageModel;
  issueDrawer: IssueDrawerServer;
}) {
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const issue = useIssueDrawerState(issueDrawer);
  const issueParts = useIssueDrawerParts(issue);
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
  const selected =
    selectedId === null ? null : (model.details[selectedId] ?? null);
  const tabs = levelTabs(model, selected);

  // Issue nodes open the issue's slide-over; milestone nodes the panel.
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
    <div className={css.body}>
      <section className={css.collapse} aria-label={model.heading}>
        <BlockBar
          index="01"
          title={model.level === 'milestone' ? 'Milestones' : 'Issues'}
          meta={model.meta}
        />
        {model.nodes.length > 0 ? <GraphLegend items={model.legend} /> : null}
        <DependencyGraph
          nodes={model.nodes}
          edges={model.edges}
          selectedId={issue.requested === null ? selectedId : issueNodeId}
          onSelect={select}
          ariaSummary={model.ariaSummary}
          emptyMessage={model.emptyMessage}
          toolbar={<NavTabs label="Graph level" size="sm" items={tabs} />}
        />
        {/* Keyed by scope: moving between levels keeps this island
            mounted, and a long list must start collapsed at each scope. */}
        {model.isolated !== null ? (
          <IsolatedRegister
            key={model.scopeHref}
            list={model.isolated}
            onOpenIssue={issue.open}
          />
        ) : null}
        {model.nodes.length > 0 ? (
          <MermaidSource
            source={model.mermaid}
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
  );
}

/* The nodes left off the canvas because they have no blocking relation:
   one line saying how many and why, then a small register (mark, name,
   project or assignee, due), each row opening the milestone on the
   timeline or the issue in its slide-over. A long list starts collapsed
   behind a Show button so the canvas stays the subject of the page. */
function IsolatedRegister({
  list,
  onOpenIssue,
}: {
  list: IsolatedList;
  onOpenIssue: (key: string) => void;
}) {
  const [open, setOpen] = useState(!list.collapsed);
  const listId = useId();
  const count = list.rows.length;
  return (
    <section className={css.isolated} aria-label={list.title}>
      <div className={css.isolatedBar}>
        <p className={css.isolatedText}>
          <span className={css.isolatedTitle}>{list.title}.</span>{' '}
          <span className={css.isolatedNote}>{list.note}</span>
        </p>
        {list.collapsed ? (
          <Button
            size="sm"
            variant="quiet"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((was) => !was)}
          >
            {open ? 'Hide' : `Show ${count}`}
          </Button>
        ) : null}
      </div>
      <div id={listId} hidden={!open}>
        <Register
          label={list.title}
          columns="minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 0.9fr)"
          header={[
            { id: 'name', label: list.nameLabel },
            { id: 'context', label: list.contextLabel },
            { id: 'due', label: 'Due' },
          ]}
          stackWithin={700}
        >
          {list.rows.map((row) => {
            const key = row.key;
            // An issue opens in place (scroll kept); a milestone navigates.
            const target =
              key === null
                ? {
                    href: row.href,
                    external: row.external,
                    rowLabel: row.rowLabel,
                  }
                : {
                    onActivate: () => onOpenIssue(key),
                    rowLabel: row.rowLabel,
                  };
            return (
              <RegisterRow key={row.id} {...target} tone={row.tone}>
                <RegisterCell label={list.nameLabel} variant="name">
                  <span className={css.neighbour}>
                    <StatusMark status={row.status} label={row.statusLabel} />
                    <span className={css.neighbourName}>
                      {row.key !== null ? (
                        <span className={css.isolatedKey}>{row.key}</span>
                      ) : null}
                      {row.name}
                    </span>
                  </span>
                </RegisterCell>
                <RegisterCell label={list.contextLabel} tone={row.contextTone}>
                  {row.context}
                </RegisterCell>
                <RegisterCell label="Due" variant="mono" tone={row.dueTone}>
                  {row.due}
                </RegisterCell>
              </RegisterRow>
            );
          })}
        </Register>
      </div>
    </section>
  );
}

/* One neighbour in the panel's "Waits on" / "Blocks" lists: a button row
   that selects that node, so the reader can walk the chain from here. */
function NeighbourRows({
  label,
  nodes,
  empty,
  onSelect,
}: {
  label: string;
  nodes: GraphNodeData[];
  empty: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section className={css.panelSection} aria-label={label}>
      <h3 className={css.panelKey}>{label}</h3>
      {nodes.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <Register
          label={label}
          columns="minmax(0, 1fr)"
          stackedColumns="minmax(0, 1fr)"
        >
          {nodes.map((node) => (
            <RegisterRow
              key={node.id}
              onActivate={() => onSelect(node.id)}
              rowLabel={`Show ${node.label}`}
              tone={node.tone === 'accent' ? 'accent' : 'default'}
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
            </RegisterRow>
          ))}
        </Register>
      )}
    </section>
  );
}

function PanelBody({
  detail,
  waitsOn,
  holdsUp,
  onSelect,
}: {
  detail: GraphNodeDetail;
  waitsOn: GraphNodeData[];
  holdsUp: GraphNodeData[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className={css.panel}>
      {detail.alert !== null ? (
        <AlertStrip label="Overdue">{detail.alert}</AlertStrip>
      ) : null}
      <PropertyList
        label={
          detail.kind === 'milestone' ? 'Milestone details' : 'Issue details'
        }
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
            value:
              property.tone === 'accent' ? (
                <span className={css.accentText}>{property.value}</span>
              ) : (
                property.value
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
                <ExternalLink size={14} strokeWidth={1.5} />
              ) : undefined
            }
          >
            {link.label}
          </Button>
        ))}
      </div>
      <NeighbourRows
        label="Waits on"
        nodes={waitsOn}
        empty="Nothing upstream: it waits on no open blocker here."
        onSelect={onSelect}
      />
      <NeighbourRows
        label="Blocks"
        nodes={holdsUp}
        empty="Nothing here waits on it."
        onSelect={onSelect}
      />
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
  const byId = useMemo(
    () => new Map(model.nodes.map((node) => [node.id, node])),
    [model.nodes]
  );
  const blockers = useMemo(() => blockerIndex(model.edges), [model.edges]);
  const waiters = useMemo(() => waiterIndex(model.edges), [model.edges]);
  // Keep the last node while the panel slides out.
  const [shown, setShown] = useState<string | null>(selectedId);
  if (selectedId !== null && selectedId !== shown) setShown(selectedId);
  const detail = shown === null ? undefined : model.details[shown];

  const waitsOn =
    detail === undefined
      ? []
      : upstreamChain(detail.id, blockers)
          .nodeIds.map((id) => byId.get(id))
          .filter((n): n is GraphNodeData => n !== undefined);
  const holdsUp =
    detail === undefined
      ? []
      : (waiters.get(detail.id) ?? [])
          .map((edge) => byId.get(edge.to))
          .filter((n): n is GraphNodeData => n !== undefined);

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
          detail={detail}
          waitsOn={waitsOn}
          holdsUp={holdsUp}
          onSelect={onSelect}
        />
      )}
    </SlideOver>
  );
}
