'use client';

import {
  AlertStrip,
  AppShell,
  BlockBar,
  CommandPaletteProvider,
  Kbd,
  KbdKeys,
  Link,
  type PaletteItem,
  PropertyList,
  SkeletonBlock,
  SkeletonRows,
  SkeletonText,
  SlideOver,
  StatusMark,
  ToastProvider,
  UiLinkProvider,
  type UiLinkProps,
  useCommandPalette,
  useToast,
} from '@better-tracker/ui';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';

import {
  crumbs,
  type FixtureMilestone,
  icons,
  jumpItems,
  milestoneFacts,
  milestones,
  nav,
  navigationItems,
  sections,
  SIDEBAR_STORAGE_KEY,
  tabs,
} from './fixtures';
import styles from './page.module.css';

/* Gallery links never leave the page: they say where they would have gone.
   Hash links, gallery routes and external URLs behave normally. */
function GalleryLink({ href, children, onClick, ...rest }: UiLinkProps) {
  const { toast } = useToast();
  const stays =
    href.startsWith('#') ||
    href.startsWith('/ui-gallery') ||
    /^https?:\/\//.test(href);
  return (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || stays) return;
        event.preventDefault();
        toast({ kind: 'info', label: 'Link', message: `Would open ${href}.` });
      }}
    >
      {children}
    </a>
  );
}

/** Flips html[data-theme] like ThemeToggle does (palette "Switch theme"). */
function switchTheme(storageKey: string): void {
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try {
    localStorage.setItem(storageKey, next);
  } catch {
    /* private mode: the choice does not persist */
  }
}

function MilestoneRow({
  milestone,
  onOpen,
}: {
  milestone: FixtureMilestone;
  onOpen: () => void;
}) {
  const pct =
    milestone.scope === 0 ? 0 : (milestone.completed / milestone.scope) * 100;
  return (
    <li className={styles.row}>
      <StatusMark status={milestone.status} label={milestone.statusLabel} />
      <span className={styles.name}>{milestone.name}</span>
      <span className={styles.mono}>{milestone.due}</span>
      <span
        className={
          milestone.status === 'overdue' ? styles.monoAccent : styles.mono
        }
      >
        {milestone.daysLabel}
      </span>
      <span className={styles.progress}>
        <span className={styles.bar} aria-hidden="true">
          <span className={styles.fill} style={{ width: `${pct}%` }} />
        </span>
        <span className={styles.mono}>
          {milestone.completed}/{milestone.scope}
        </span>
      </span>
      <button type="button" className={styles.open} onClick={onOpen}>
        Details
      </button>
    </li>
  );
}

function GalleryBody({ themeStorageKey }: { themeStorageKey: string }) {
  const palette = useCommandPalette();
  const { toast } = useToast();
  const [detailId, setDetailId] = useState('atlas-3');
  const [detailOpen, setDetailOpen] = useState(false);
  const dueRef = useRef<HTMLInputElement>(null);
  const detail = milestones.find((m) => m.id === detailId) ?? milestones[1];

  const openDetail = useCallback((id: string) => {
    setDetailId(id);
    setDetailOpen(true);
  }, []);
  const closeDetail = useCallback(() => setDetailOpen(false), []);

  const facts = useMemo(() => {
    const values: Record<string, ReactNode> = {
      status: (
        <StatusMark
          status={detail.status}
          label={detail.statusLabel}
          showLabel
        />
      ),
      due: (
        <input
          ref={dueRef}
          type="date"
          className="input"
          aria-label="Due date"
          defaultValue="2026-10-18"
        />
      ),
      lead: 'Pat Lee',
      progress: (
        <span className={styles.progress}>
          <span className={styles.bar} aria-hidden="true">
            <span
              className={styles.fill}
              style={{ width: `${(detail.completed / detail.scope) * 100}%` }}
            />
          </span>
          <span className={styles.mono}>
            {detail.completed}/{detail.scope}
          </span>
        </span>
      ),
      weight: <span className={styles.mono}>↑2 · override</span>,
      next: 'M4 Backfill · Nov 08',
      done: 'Every write path reads from the new ledger and the old tables are read-only.',
    };
    return milestoneFacts.map((fact) => ({
      ...fact,
      value: values[fact.id ?? ''] ?? '—',
    }));
  }, [detail]);

  return (
    <AppShell
      appName="Milestone Planner"
      workspaceName="Northwind"
      brandHref="/week"
      nav={nav}
      sections={sections}
      settings={{ href: '/settings' }}
      user={{ name: 'Pat Lee', badge: 'DEMO', href: '/week?user=pat' }}
      signOut={{ action: '/api/auth/logout', method: 'post' }}
      themeStorageKey={themeStorageKey}
      crumbs={crumbs}
      tabs={tabs}
      storageKey={SIDEBAR_STORAGE_KEY}
      banner={
        <p className="notice">
          <span className="key">DEMO</span>
          <span>
            Demo data, not connected to Linear. Every name, date and issue on
            this screen is fictional.
          </span>
        </p>
      }
    >
      <div className="page">
        <header className={styles.head}>
          <h1 className={styles.title}>Atlas migration</h1>
          <p className={styles.receipts}>
            Lead Pat Lee · 4 milestones · next: M3 Cutover, 3 days overdue ·
            synced 09:41
          </p>
        </header>

        <section className="block" aria-label="Milestones">
          <BlockBar index="01" title="Milestones" meta="13/26 issues done" />
          <ul className={styles.rows}>
            {milestones.map((m) => (
              <MilestoneRow
                key={m.id}
                milestone={m}
                onOpen={() => openDetail(m.id)}
              />
            ))}
          </ul>
        </section>

        <section className="block" aria-label="Shell controls">
          <BlockBar index="02" title="Shell controls" meta="overlays" />
          <div className={styles.controls}>
            <button
              type="button"
              className="buttonPrimary"
              onClick={palette.open}
            >
              Open palette <KbdKeys keys={['Ctrl', 'K']} />
            </button>
            <button
              type="button"
              className="button"
              onClick={palette.openShortcuts}
            >
              Shortcuts <Kbd>?</Kbd>
            </button>
            <button
              type="button"
              className="button"
              onClick={() =>
                toast({
                  kind: 'info',
                  label: 'Saved',
                  message: 'Target date moved to Oct 24.',
                  action: {
                    label: 'Undo',
                    onClick: () =>
                      toast({
                        kind: 'info',
                        label: 'Undone',
                        message: 'Target date is Oct 18 again.',
                      }),
                  },
                })
              }
            >
              Info toast
            </button>
            <button
              type="button"
              className="button"
              onClick={() =>
                toast({
                  kind: 'error',
                  message:
                    'Linear rejected the change: the milestone is archived.',
                  action: {
                    label: 'Retry',
                    onClick: () =>
                      toast({
                        kind: 'info',
                        label: 'Retried',
                        message: 'Sent the date again.',
                      }),
                  },
                })
              }
            >
              Error toast
            </button>
            <button
              type="button"
              className="button"
              onClick={() => openDetail('atlas-3')}
            >
              Open slide-over
            </button>
            <Link href="/ui-gallery/shell/signed-out" className="accentLink">
              Signed-out frame
            </Link>
          </div>
          <p className={styles.note}>
            Ctrl/⌘ K palette · ? shortcuts · [ collapse the sidebar · G then W,
            T, P, G, R or S to navigate · Esc closes
          </p>
        </section>

        <section className="block" aria-label="Loading states">
          <BlockBar
            index="03"
            title="Loading states"
            meta="hatched skeletons"
          />
          <div className={styles.split}>
            <div className={styles.cell}>
              <SkeletonRows rows={4} label="Loading milestones" />
            </div>
            <div className={`${styles.cell} ${styles.cellPad}`}>
              <SkeletonText lines={3} label="Loading summary" />
              <SkeletonBlock height={84} label="Loading chart" />
            </div>
          </div>
        </section>

        <section className="block" aria-label="Alert strip and key caps">
          <BlockBar index="04" title="Alert strip · key caps" />
          <div className={styles.split}>
            <div className={`${styles.cell} ${styles.cellPad}`}>
              <AlertStrip
                label="Overdue"
                tone="danger"
                action={{
                  label: 'Reschedule',
                  onClick: () => openDetail('atlas-3'),
                }}
              >
                Overdue by 3 days.
              </AlertStrip>
            </div>
            <div className={`${styles.cell} ${styles.cellPad} ${styles.caps}`}>
              <KbdKeys keys={['Ctrl', 'K']} />
              <KbdKeys keys={['G', 'W']} />
              <Kbd>?</Kbd>
              <Kbd>[</Kbd>
              <Kbd>Esc</Kbd>
              <KbdKeys keys={['↑', '↓']} />
              <Kbd>↵</Kbd>
            </div>
          </div>
        </section>
      </div>

      <SlideOver
        open={detailOpen}
        onClose={closeDetail}
        title={detail.name}
        breadcrumb={`Atlas migration / ${detail.name}`}
        actions={
          <>
            <Link
              href="https://linear.app/"
              className={styles.headerAction}
              target="_blank"
              rel="noreferrer"
            >
              Linear ↗
            </Link>
            <button
              type="button"
              className={styles.headerAction}
              onClick={() =>
                toast({
                  kind: 'info',
                  label: 'Copied',
                  message: 'Milestone link copied to the clipboard.',
                })
              }
            >
              Copy link
            </button>
          </>
        }
      >
        {detail.status === 'overdue' ? (
          <div className={styles.alert}>
            <AlertStrip
              label="Overdue"
              tone="danger"
              action={{
                label: 'Reschedule',
                onClick: () => dueRef.current?.focus(),
              }}
            >
              Overdue by 3 days.
            </AlertStrip>
          </div>
        ) : null}
        <PropertyList label="Milestone details" items={facts} />
        <h3 className={styles.subhead}>Rubric</h3>
        <ul className={styles.rubric}>
          {[
            'Target date set',
            'Done means… written',
            'Project has a lead',
            'Has issues (7)',
          ].map((label) => (
            <li key={label}>
              <StatusMark status="done" label="Met" />
              <span>{label}</span>
            </li>
          ))}
        </ul>
        <h3 className={styles.subhead}>Risk</h3>
        <p className={styles.para}>
          2 open issues are unassigned and nothing has moved for 6 days.
        </p>
      </SlideOver>
    </AppShell>
  );
}

/** The whole shell family with fixture props: AppShell around a project
    page, the palette (static + lazily loaded items), toasts and a
    slide-over with the property list and alert strip. */
export default function ShellGallery({
  themeStorageKey,
}: {
  themeStorageKey: string;
}) {
  const staticItems = useMemo<PaletteItem[]>(
    () => [
      {
        id: 's-dry',
        label: 'Preview allocation (dry run)',
        hint: 'Assigns nothing',
        section: 'Suggestions',
        icon: icons.dryRun,
        onSelect: () => undefined,
      },
      {
        id: 's-sync',
        label: 'Resync from Linear',
        hint: 'Full sync',
        section: 'Suggestions',
        icon: icons.resync,
        onSelect: () => undefined,
      },
      {
        id: 's-theme',
        label: 'Switch theme',
        section: 'Suggestions',
        icon: icons.theme,
        onSelect: () => switchTheme(themeStorageKey),
      },
      ...navigationItems,
    ],
    [themeStorageKey]
  );

  // Stands in for GET /api/palette: resolves after a beat so the
  // skeleton row is visible on first open.
  const loadItems = useCallback(
    () =>
      new Promise<PaletteItem[]>((resolve) => {
        setTimeout(() => resolve(jumpItems), 900);
      }),
    []
  );

  return (
    <ToastProvider>
      <UiLinkProvider link={GalleryLink}>
        <PaletteWithToasts items={staticItems} loadItems={loadItems}>
          <GalleryBody themeStorageKey={themeStorageKey} />
        </PaletteWithToasts>
      </UiLinkProvider>
    </ToastProvider>
  );
}

/* The provider's navigate() and the suggestions report through toasts
   here, since the gallery has no other pages to go to. */
function PaletteWithToasts({
  items,
  loadItems,
  children,
}: {
  items: PaletteItem[];
  loadItems: () => Promise<PaletteItem[]>;
  children: ReactNode;
}) {
  const { toast } = useToast();
  const withToasts = useMemo(
    () =>
      items.map((item) =>
        item.id === 's-dry' || item.id === 's-sync'
          ? {
              ...item,
              onSelect: () =>
                toast({
                  kind: 'info',
                  label: item.id === 's-dry' ? 'Dry run' : 'Sync',
                  message:
                    item.id === 's-dry'
                      ? 'Would assign 6 issues across 3 projects.'
                      : 'Resync started; 214 issues to check.',
                }),
            }
          : item
      ),
    [items, toast]
  );
  return (
    <CommandPaletteProvider
      items={withToasts}
      loadItems={loadItems}
      sectionOrder={['Suggestions', 'Jump to', 'Navigation']}
      navigate={(href) =>
        toast({
          kind: 'info',
          label: 'Navigate',
          message: `Would open ${href}.`,
        })
      }
    >
      {children}
    </CommandPaletteProvider>
  );
}
