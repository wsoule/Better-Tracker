// Typed store errors, so callers branch on a class (or its name, across
// bundle copies) instead of matching message text.

/** Which kind of row a StoreNotFoundError is about. */
export type StoreNotFoundKind = 'session' | 'installation';

/**
 * Thrown by withSessionLock / withInstallationLock when the row to lock
 * does not exist (signed out or cleaned up elsewhere; never installed).
 * The message keeps the wording older callers matched on.
 */
export class StoreNotFoundError extends Error {
  readonly kind: StoreNotFoundKind;
  /** The session id or the workspace id that was looked up. */
  readonly id: string;

  constructor(kind: StoreNotFoundKind, id: string) {
    super(
      kind === 'session'
        ? `No session ${id}`
        : `No installation for workspace ${id}`
    );
    this.name = 'StoreNotFoundError';
    this.kind = kind;
    this.id = id;
  }
}

/**
 * True for a StoreNotFoundError (of `kind`, when given), including one
 * thrown by another bundled copy of @better-tracker/store, where
 * instanceof fails: then the error's name and `kind` identify it.
 */
export function isStoreNotFoundError(
  error: unknown,
  kind?: StoreNotFoundKind
): error is StoreNotFoundError {
  const found =
    error instanceof StoreNotFoundError ||
    (error instanceof Error &&
      error.name === 'StoreNotFoundError' &&
      typeof (error as { kind?: unknown }).kind === 'string');
  return (
    found && (kind === undefined || (error as StoreNotFoundError).kind === kind)
  );
}
