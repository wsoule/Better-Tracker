// Schema migrations: an append-only, ordered list. Each migration is a list
// of single SQL statements (PGlite's extended protocol runs one statement
// per query), applied together in one transaction and recorded in
// schema_migrations. Never edit a shipped migration; add a new one.
import type { Sql, SqlLogger } from './db';

export interface Migration {
  /** Strictly increasing; recorded in schema_migrations once applied. */
  version: number;
  name: string;
  statements: readonly string[];
}

/**
 * Advisory lock id shared by every migrator ("mplan" in ASCII). Taken with
 * pg_advisory_xact_lock inside each migration's transaction, so concurrent
 * boots apply each migration exactly once and the lock can never leak past
 * a crashed process or a pooled connection.
 */
export const MIGRATION_LOCK_ID = 0x6d706c616e;

const CREATE_SCHEMA_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

const INITIAL_SCHEMA: readonly string[] = [
  // App-actor authorization per Linear workspace (§8). Access and refresh
  // tokens are AES-256-GCM ciphertext; expiry and scopes are not secret.
  `CREATE TABLE installations (
    workspace_id text PRIMARY KEY,
    workspace_name text NOT NULL,
    url_key text NOT NULL,
    app_user_id text NOT NULL,
    installed_by_user_id text NOT NULL,
    revoked_at timestamptz,
    access_token_enc text NOT NULL,
    refresh_token_enc text,
    token_expires_at timestamptz,
    token_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  // Signed-in users. token_hash is SHA-256 of the cookie token; the cookie
  // value itself is never stored.
  `CREATE TABLE sessions (
    id text PRIMARY KEY,
    token_hash text NOT NULL UNIQUE,
    workspace_id text NOT NULL,
    user_id text NOT NULL,
    user_name text NOT NULL,
    access_token_enc text NOT NULL,
    refresh_token_enc text,
    token_expires_at timestamptz,
    token_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL
  )`,
  `CREATE INDEX sessions_expires_at_idx ON sessions (expires_at)`,
  `CREATE TABLE settings (
    workspace_id text PRIMARY KEY,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE TABLE milestone_meta (
    workspace_id text NOT NULL,
    milestone_id text NOT NULL,
    weight double precision,
    done_means text,
    updated_at timestamptz NOT NULL,
    updated_by text,
    PRIMARY KEY (workspace_id, milestone_id)
  )`,
  // The Linear mirror: one row per entity. ord preserves the order the
  // entities arrived in, so loadMirror returns arrays in sync order.
  `CREATE TABLE mirror_entities (
    workspace_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('user', 'team', 'state', 'initiative', 'project', 'milestone', 'issue', 'relation')),
    id text NOT NULL,
    ord bigint NOT NULL,
    data jsonb NOT NULL,
    synced_at timestamptz NOT NULL,
    PRIMARY KEY (workspace_id, kind, id)
  )`,
  `CREATE INDEX mirror_entities_order_idx ON mirror_entities (workspace_id, ord)`,
  // version is bumped by every mirror write (same transaction), so readers
  // can cache an indexed snapshot until it changes. mirror_synced_at is the
  // syncedAt of the last replaceMirror; last_full_sync_* record attempts.
  `CREATE TABLE sync_state (
    workspace_id text PRIMARY KEY,
    version bigint NOT NULL DEFAULT 0,
    mirror_synced_at timestamptz,
    last_full_sync_at timestamptz,
    last_full_sync_status text CHECK (last_full_sync_status IN ('ok', 'failed')),
    last_full_sync_error text,
    last_webhook_at timestamptz
  )`,
  // Keyed by the Linear-Delivery header so a retried delivery is processed
  // at most once.
  `CREATE TABLE webhook_deliveries (
    delivery_id text PRIMARY KEY,
    workspace_id text NOT NULL,
    type text NOT NULL,
    action text NOT NULL,
    entity_id text,
    received_at timestamptz NOT NULL,
    processed_at timestamptz,
    error text
  )`,
  `CREATE TABLE allocation_runs (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    mode text NOT NULL CHECK (mode IN ('dry_run', 'live')),
    run_trigger text NOT NULL CHECK (run_trigger IN ('schedule', 'manual')),
    started_by_user_id text,
    status text NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
    started_at timestamptz NOT NULL,
    finished_at timestamptz,
    summary jsonb,
    error text
  )`,
  // At most one running allocation per workspace: a concurrent startRun
  // fails this index instead of racing.
  `CREATE UNIQUE INDEX allocation_runs_one_running_idx ON allocation_runs (workspace_id) WHERE status = 'running'`,
  `CREATE INDEX allocation_runs_workspace_started_idx ON allocation_runs (workspace_id, started_at DESC)`,
  `CREATE TABLE allocation_entries (
    run_id text NOT NULL REFERENCES allocation_runs (id) ON DELETE CASCADE,
    seq integer NOT NULL,
    workspace_id text NOT NULL,
    action text NOT NULL CHECK (action IN ('assign', 'skip', 'block')),
    outcome text NOT NULL CHECK (outcome IN ('planned', 'applied', 'failed', 'stale', 'noted')),
    project_id text NOT NULL,
    milestone_id text,
    issue_id text,
    issue_identifier text,
    assignee_id text,
    reason text,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    error text,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (run_id, seq)
  )`,
  // Serves listAppliedAssignments (My week's "new" mark) without scanning
  // skip/block/planned rows.
  `CREATE INDEX allocation_entries_applied_idx ON allocation_entries (workspace_id, created_at) WHERE action = 'assign' AND outcome = 'applied'`,
  `CREATE TABLE warning_memory (
    workspace_id text NOT NULL,
    subject_kind text NOT NULL CHECK (subject_kind IN ('milestone', 'project')),
    subject_id text NOT NULL,
    last_key text,
    last_notified_on date,
    occurrence integer NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, subject_kind, subject_id)
  )`,
  // One digest per person per day (§6.8), enforced by the unique key.
  `CREATE TABLE notifications (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    day date NOT NULL,
    recipient_id text NOT NULL,
    channel text NOT NULL CHECK (channel IN ('slack', 'outbox')),
    status text NOT NULL CHECK (status IN ('sent', 'preview', 'failed', 'undeliverable')),
    digest jsonb NOT NULL,
    error text,
    created_at timestamptz NOT NULL,
    CONSTRAINT notifications_one_per_day UNIQUE (workspace_id, day, recipient_id)
  )`,
  `CREATE INDEX notifications_workspace_created_idx ON notifications (workspace_id, created_at DESC)`,
  // Idempotent scheduled jobs: claiming (workspace, job, day) twice fails.
  `CREATE TABLE job_claims (
    workspace_id text NOT NULL,
    job text NOT NULL,
    day date NOT NULL,
    claimed_at timestamptz NOT NULL,
    PRIMARY KEY (workspace_id, job, day)
  )`,
  `CREATE TABLE audit_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id text NOT NULL,
    actor_user_id text NOT NULL,
    action text NOT NULL,
    subject_id text NOT NULL,
    before_value jsonb,
    after_value jsonb,
    occurred_at timestamptz NOT NULL
  )`,
  `CREATE INDEX audit_log_workspace_idx ON audit_log (workspace_id, occurred_at DESC, id DESC)`,
];

/** Every migration, oldest first. */
// Claim-first digests: a notification is inserted as 'pending' (the
// one-per-person-per-day claim), delivered, then updated to its outcome.
const NOTIFICATION_PENDING: readonly string[] = [
  'ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_status_check',
  `ALTER TABLE notifications ADD CONSTRAINT notifications_status_check
    CHECK (status IN ('pending', 'sent', 'preview', 'failed', 'undeliverable'))`,
  'CREATE INDEX IF NOT EXISTS webhook_deliveries_received_idx ON webhook_deliveries (received_at)',
];

// Job claims become leases: finished_at is set when the job completes, and
// an unfinished claim older than the caller's lease belongs to a process
// that died mid-run, so another claimer may take it over. Claims made
// before this migration kept their day taken for good, so they count as
// finished (never taken over).
const JOB_CLAIM_LEASE: readonly string[] = [
  'ALTER TABLE job_claims ADD COLUMN finished_at timestamptz',
  'UPDATE job_claims SET finished_at = claimed_at WHERE finished_at IS NULL',
];

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial_schema', statements: INITIAL_SCHEMA },
  {
    version: 2,
    name: 'notification_pending_status',
    statements: NOTIFICATION_PENDING,
  },
  { version: 3, name: 'job_claim_lease', statements: JOB_CLAIM_LEASE },
];

// Rejects lists that are not strictly increasing, which would otherwise
// apply in a surprising order or skip a migration silently.
function assertOrdered(migrations: readonly Migration[]): void {
  for (let i = 1; i < migrations.length; i++) {
    const previous = migrations[i - 1];
    const current = migrations[i];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.version <= previous.version
    ) {
      throw new Error(
        `Migrations must have strictly increasing versions (${previous.version} then ${current.version})`
      );
    }
  }
}

/**
 * Applies every migration not yet recorded in schema_migrations, oldest
 * first, each in its own transaction under the migration advisory lock.
 * Safe to run on every boot and from several processes at once: a migrator
 * that loses the race re-checks under the lock and skips. That re-check
 * sees the winner's commit because Sql transactions run at READ COMMITTED
 * (see openPgSql). Returns the versions this call applied.
 */
export async function runMigrations(
  sql: Sql,
  migrations: readonly Migration[] = MIGRATIONS,
  logger?: SqlLogger
): Promise<number[]> {
  assertOrdered(migrations);
  // CREATE TABLE IF NOT EXISTS is not race-free on its own (two creators
  // can collide on the catalog), so it also runs under the lock.
  await sql.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [
      MIGRATION_LOCK_ID,
    ]);
    await tx.query(CREATE_SCHEMA_MIGRATIONS);
  });

  // Unlocked read for the common "nothing to do" boot; every pending
  // migration is re-checked under the lock before it is applied.
  const appliedRows = await sql.query<{ version: number }>(
    'SELECT version FROM schema_migrations'
  );
  const applied = new Set(appliedRows.map((row) => Number(row.version)));

  const appliedNow: number[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }
    const didApply = await sql.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [
        MIGRATION_LOCK_ID,
      ]);
      const existing = await tx.query<{ version: number }>(
        'SELECT version FROM schema_migrations WHERE version = $1',
        [migration.version]
      );
      if (existing.length > 0) {
        return false;
      }
      for (const statement of migration.statements) {
        await tx.query(statement);
      }
      await tx.query(
        'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
        [migration.version, migration.name]
      );
      return true;
    });
    if (didApply) {
      appliedNow.push(migration.version);
      logger?.info('applied migration', {
        version: migration.version,
        name: migration.name,
      });
    }
  }
  return appliedNow;
}
