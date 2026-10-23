import {
  BlockBar,
  Chip,
  EmptyState,
  NavTabs,
  Register,
  RegisterCell,
  RegisterRow,
} from '@better-tracker/ui';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import {
  foldAuditEntries,
  modesReadOnlyRows,
  notificationRows,
  parseSettingsSection,
  scheduleForm,
  scheduleReadOnlyRows,
  sectionTabs,
  type SettingsSectionId,
  statusRows,
  watcherRows,
  watchersHint,
} from '../../../lib/adapters/settings';
import { currentHref } from '../../../lib/issue-load';
import {
  type InstalledContext,
  orSetup,
  requireInstalledActor,
} from '../../../lib/load';
import { PageCrumb } from '../components/page-crumb';
import ReadOnlyNotice from '../components/read-only-notice';
import ModesForm from './modes-form';
import css from './page.module.css';
import { ReadOnlySettings, ReadOnlyWatchers } from './read-only-sections';
import ScheduleForm from './schedule-form';
import StatusActions from './status-actions';
import WatchersForm from './watchers-form';

export const metadata: Metadata = { title: 'Settings' };

/** How many notification and audit rows a section lists. */
const LIST_LIMIT = 50;

/** Audit entries read to fill LIST_LIMIT rows once a bulk issue edit (one
    entry per issue and field) is folded into one row per field. */
const AUDIT_READ_LIMIT = 500;

type Loaded = Awaited<ReturnType<InstalledContext['engine']['load']>>;

/* /settings (architecture §8.4 "Settings", Gr8r's settings layout): a
   section sub-nav beside the section's registers, ?section= choosing
   Modes (default), Watchers (the old ?section=people still opens it),
   Schedule, Status, Notifications or Audit. Every section is editable by
   everyone signed in (owner decision 2026-10-22: no roles), each form
   saving only its own fields through PATCH /api/settings, which (with the
   engine) validates them again and writes an audit entry. A Linear guest
   reads every section but changes none (owner decision 2026-10-22,
   "Guests limited to read only"): plain values, no Save, no Resync or
   Preview, and one read-only notice above the section. */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Request data first: the page is per-request, never prerendered.
  const params = await searchParams;
  const context = await requireInstalledActor(currentHref('/settings', params));
  const { engine, actor, workspaceId } = context;
  const section = parseSettingsSection(params);
  const loaded = await orSetup(engine.load(workspaceId, actor));
  const readOnly = actor.readOnly;

  return (
    <>
      <header className={css.head}>
        <h1 className={css.title}>Settings</h1>
        <p className={css.receipts}>
          {readOnly
            ? 'How this workspace allocates and warns, and who changed what.'
            : 'How this workspace allocates and warns. Each section saves on its own, and every change is in the audit log.'}
        </p>
      </header>
      <div className={css.layout}>
        <NavTabs
          label="Settings sections"
          orientation="vertical"
          items={sectionTabs(section.id)}
          className={css.subnav}
        />
        <div className={css.content}>
          <section className={css.collapse} aria-label={section.label}>
            <BlockBar
              index={sectionIndex(section.id)}
              title={section.label}
              meta={
                readOnly
                  ? READ_ONLY_SECTION_META[section.id]
                  : SECTION_META[section.id]
              }
            />
            <p className={css.sectionText}>{section.description}</p>
            {readOnly && EDITABLE_SECTIONS.has(section.id) ? (
              <div className={css.readOnlyNotice}>
                <ReadOnlyNotice />
              </div>
            ) : null}
            {await renderSection(section.id, context, loaded)}
          </section>
        </div>
      </div>
      <PageCrumb label={section.label} />
    </>
  );
}

/* The block bar's meta: what a section's saves do, or what it lists.
   Every section is editable by everyone signed in; none names a role. */
const SECTION_META: Record<SettingsSectionId, string> = {
  modes: 'Audited',
  watchers: 'Audited',
  schedule: 'Audited',
  status: 'Sync · preview',
  notifications: `Newest ${LIST_LIMIT}`,
  audit: `Newest ${LIST_LIMIT}`,
};

/* The meta for a Linear guest: nothing here saves for them. */
const READ_ONLY_SECTION_META: Record<SettingsSectionId, string> = {
  ...SECTION_META,
  modes: 'Read only',
  watchers: 'Read only',
  schedule: 'Read only',
  status: 'Read only',
};

/* Sections that offer a change (a save, a resync, a preview) to everyone
   else: a guest sees the read-only notice there. */
const EDITABLE_SECTIONS: ReadonlySet<SettingsSectionId> = new Set([
  'modes',
  'watchers',
  'schedule',
  'status',
]);

function sectionIndex(id: SettingsSectionId): string {
  const order: SettingsSectionId[] = [
    'modes',
    'watchers',
    'schedule',
    'status',
    'notifications',
    'audit',
  ];
  return String(order.indexOf(id) + 1).padStart(2, '0');
}

async function renderSection(
  id: SettingsSectionId,
  context: InstalledContext,
  loaded: Loaded
): Promise<ReactNode> {
  const { engine, workspaceId, installation } = context;
  const { settings, snapshot } = loaded;
  const timeZone = settings.timezone;
  const readOnly = context.actor.readOnly;
  switch (id) {
    case 'modes':
      if (readOnly) {
        return (
          <ReadOnlySettings label="Modes" rows={modesReadOnlyRows(settings)} />
        );
      }
      return (
        <ModesForm
          initial={{
            allocationMode: settings.allocationMode,
            warningsMode: settings.warningsMode,
          }}
        />
      );
    case 'watchers':
      if (readOnly) {
        return (
          <ReadOnlyWatchers
            rows={watcherRows(snapshot.data.users, settings)}
            watcherUserIds={settings.watcherUserIds}
            hint={watchersHint(settings.watcherUserIds.length)}
          />
        );
      }
      return (
        <WatchersForm
          rows={watcherRows(snapshot.data.users, settings)}
          watcherUserIds={settings.watcherUserIds}
        />
      );
    case 'schedule':
      if (readOnly) {
        return (
          <ReadOnlySettings
            label="Schedule"
            rows={scheduleReadOnlyRows(settings)}
          />
        );
      }
      return <ScheduleForm initial={scheduleForm(settings)} />;
    case 'status': {
      const rows = statusRows({
        installation,
        syncState: loaded.syncState,
        users: snapshot.users,
        timeZone,
        demo: engine.mode === 'fixture',
      });
      return (
        <>
          <Register
            label="Status"
            columns="200px minmax(0, 1fr)"
            stackWithin={700}
            stackedColumns="minmax(0, 1fr)"
          >
            {rows.map((row) => (
              <RegisterRow key={row.id}>
                <RegisterCell variant="mono" tone="muted">
                  {row.label}
                </RegisterCell>
                <RegisterCell tone={row.tone} sub={row.sub}>
                  {row.value}
                </RegisterCell>
              </RegisterRow>
            ))}
          </Register>
          {/* Resync and the digest preview are for members only. */}
          {readOnly ? null : <StatusActions />}
        </>
      );
    }
    case 'notifications': {
      const records = await orSetup(
        engine.listNotifications(workspaceId, LIST_LIMIT)
      );
      const rows = notificationRows(records, snapshot.users);
      if (rows.length === 0) {
        return (
          <EmptyState label="No digests">
            No digests recorded yet. The daily run records at most one per
            person per day; Status → Preview today’s digests shows what it would
            send now.
          </EmptyState>
        );
      }
      return (
        // The recipient leads (with the channel under it): it is the
        // card's title once the register stacks, and six columns left the
        // name and the error about 70px each in a 700px register.
        <Register
          label="Recent digests, newest first"
          columns="minmax(0, 1fr) 96px 128px 72px minmax(0, 1.3fr)"
          stackWithin={700}
          header={[
            { id: 'to', label: 'Recipient' },
            { id: 'day', label: 'Day' },
            { id: 'status', label: 'Status' },
            { id: 'items', label: 'Items', align: 'end' },
            { id: 'error', label: 'Error' },
          ]}
          stackedColumns="repeat(2, minmax(0, 1fr))"
        >
          {rows.map((row) => (
            <RegisterRow key={row.id} tone={row.rowTone}>
              <RegisterCell label="Recipient" variant="name" sub={row.channel}>
                {row.recipient}
              </RegisterCell>
              <RegisterCell label="Day" variant="mono">
                {row.day}
              </RegisterCell>
              <RegisterCell label="Status">
                <Chip tone={row.statusTone}>{row.statusLabel}</Chip>
              </RegisterCell>
              <RegisterCell label="Items" variant="mono" align="end">
                {row.items}
              </RegisterCell>
              <RegisterCell
                label="Error"
                tone={row.error === null ? 'muted' : 'accent'}
              >
                <span className={css.breakAnywhere}>{row.error ?? '—'}</span>
              </RegisterCell>
            </RegisterRow>
          ))}
        </Register>
      );
    }
    case 'audit': {
      const entries = await orSetup(
        engine.listAudit(workspaceId, AUDIT_READ_LIMIT, context.actor)
      );
      const rows = foldAuditEntries(entries, snapshot, timeZone, LIST_LIMIT);
      if (rows.length === 0) {
        return (
          <EmptyState label="No edits">
            No edits yet. Re-dated milestones, leads, weights, “done means…”,
            issue edits and settings changes appear here, with who made them.
          </EmptyState>
        );
      }
      return (
        <Register
          label="Recent edits made in the planner, newest first"
          columns="152px minmax(0, 0.8fr) minmax(0, 1fr) minmax(0, 1.6fr)"
          stackWithin={700}
          header={[
            { id: 'when', label: 'When' },
            { id: 'who', label: 'Who' },
            { id: 'what', label: 'What' },
            { id: 'change', label: 'Before → after' },
          ]}
          stackedColumns="minmax(0, 1fr)"
        >
          {rows.map((row) => (
            <RegisterRow key={row.id}>
              <RegisterCell label="When" variant="mono">
                {row.when}
              </RegisterCell>
              <RegisterCell label="Who" variant="name">
                {row.who}
              </RegisterCell>
              <RegisterCell label="What">{row.what}</RegisterCell>
              <RegisterCell label="Before → after">
                <span className={css.changes}>
                  {row.changes.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </span>
              </RegisterCell>
            </RegisterRow>
          ))}
        </Register>
      );
    }
  }
}
