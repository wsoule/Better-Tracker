import {
  BlockBar,
  Chip,
  EmptyState,
  NavTabs,
  Notice,
  Register,
  RegisterCell,
  RegisterRow,
} from '@better-tracker/ui';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import {
  auditRows,
  notificationRows,
  parseSettingsSection,
  peopleRows,
  readOnlyNote,
  scheduleForm,
  sectionTabs,
  type SettingsSectionId,
  statusRows,
} from '../../../lib/adapters/settings';
import {
  type InstalledContext,
  orSetup,
  requireInstalledActor,
} from '../../../lib/load';
import { PageCrumb } from '../components/page-crumb';
import ModesForm from './modes-form';
import css from './page.module.css';
import PeopleForm from './people-form';
import ScheduleForm from './schedule-form';
import StatusActions from './status-actions';

export const metadata: Metadata = { title: 'Settings' };

/** How many notification and audit rows a section lists. */
const LIST_LIMIT = 50;

type Loaded = Awaited<ReturnType<InstalledContext['engine']['load']>>;

/* /settings (architecture §8.4 "Settings", Gr8r's settings layout): a
   section sub-nav beside the section's registers, ?section= choosing
   Modes (default), People, Schedule, Status, Notifications or Audit.
   Everyone can read; PMs get the forms, each saving only its own fields
   through PATCH /api/settings, which (with the engine) enforces the same
   rules again. */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Request data first: the page is per-request, never prerendered.
  const params = await searchParams;
  const context = await requireInstalledActor();
  const { engine, actor, workspaceId } = context;
  const section = parseSettingsSection(params);
  const loaded = await orSetup(engine.load(workspaceId));
  const canEdit = actor.isPm;

  return (
    <>
      <header className={css.head}>
        <h1 className={css.title}>Settings</h1>
        <p className={css.receipts}>
          {canEdit
            ? 'How this workspace allocates and warns. Each section saves on its own.'
            : 'How this workspace allocates and warns. Read only: PMs change these.'}
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
          {!canEdit ? (
            <Notice label="Read only" tone="default">
              {readOnlyNote(loaded.settings, loaded.snapshot.users)}
            </Notice>
          ) : null}
          <section className={css.collapse} aria-label={section.label}>
            <BlockBar
              index={sectionIndex(section.id)}
              title={section.label}
              meta={canEdit ? 'PM' : 'Read only'}
            />
            <p className={css.sectionText}>{section.description}</p>
            {await renderSection(section.id, context, loaded, canEdit)}
          </section>
        </div>
      </div>
      <PageCrumb label={section.label} />
    </>
  );
}

function sectionIndex(id: SettingsSectionId): string {
  const order: SettingsSectionId[] = [
    'modes',
    'people',
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
  loaded: Loaded,
  canEdit: boolean
): Promise<ReactNode> {
  const { engine, workspaceId, installation } = context;
  const { settings, snapshot } = loaded;
  const timeZone = settings.timezone;
  switch (id) {
    case 'modes':
      return (
        <ModesForm
          initial={{
            allocationMode: settings.allocationMode,
            warningsMode: settings.warningsMode,
          }}
          canEdit={canEdit}
        />
      );
    case 'people':
      return (
        <PeopleForm
          rows={peopleRows(snapshot.data.users, settings)}
          pmUserIds={settings.pmUserIds}
          watcherUserIds={settings.watcherUserIds}
          canEdit={canEdit}
        />
      );
    case 'schedule':
      return (
        <ScheduleForm initial={scheduleForm(settings)} canEdit={canEdit} />
      );
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
          {canEdit ? <StatusActions /> : null}
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
          <EmptyState>
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
      const entries = await orSetup(engine.listAudit(workspaceId, LIST_LIMIT));
      const rows = auditRows(entries, snapshot, timeZone);
      if (rows.length === 0) {
        return (
          <EmptyState>
            No PM edits yet. Re-dated milestones, leads, weights, “done means…”
            and settings changes appear here.
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
