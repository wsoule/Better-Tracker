// The fake Linear's request log (GET /__requests), as types, guards and
// readers a Playwright spec can load at runtime (no workspace packages:
// see fake-linear-data.ts). Records never hold a credential: a key's
// GraphQL call says which test key it was, a bearer call which org,
// person and actor its token acts as, and an OAuth call what it asked
// for and how it ended.

import type { FakeOrgKey } from './fake-linear-data';
import type {
  FakeGrantSummary,
  FakeOAuthRequestRecord,
} from './fake-linear-oauth';
import type { E2EKeyLabel } from './leak-needles';

export type { FakeOAuthRequestRecord } from './fake-linear-oauth';

/** A GraphQL call with a test API key (raw), or with no credential. */
export interface FakeKeyRequestRecord {
  operation: string;
  auth: 'raw' | 'none';
  who: E2EKeyLabel | 'unknown' | 'none';
  keyInBodyOrUrl: boolean;
}

/** A GraphQL call with a bearer (OAuth) token. */
export interface FakeBearerRequestRecord {
  operation: string;
  auth: 'bearer';
  /** The person's handle ('ana', 'gia'), 'app', or 'unknown'. */
  who: string;
  /** The organization whose data answered (or would have), null if unknown. */
  org: FakeOrgKey | null;
  actor: 'user' | 'app' | null;
  status: number;
  /** Why the token was refused (401), or null when it worked. */
  refused: 'unknown' | 'revoked' | 'expired' | null;
  keyInBodyOrUrl: boolean;
  /** Whether an OAuth token or code was in the body or URL (never should be). */
  tokenInBodyOrUrl: boolean;
}

/** Every record /__requests lists, oldest first. */
export type FakeRequestRecord =
  | FakeKeyRequestRecord
  | FakeBearerRequestRecord
  | FakeOAuthRequestRecord;

export function isBearerRecord(
  record: FakeRequestRecord
): record is FakeBearerRequestRecord {
  return record.auth === 'bearer';
}

export function isOAuthRecord(
  record: FakeRequestRecord
): record is FakeOAuthRequestRecord {
  return record.auth === 'oauth';
}

/**
 * The GraphQL operations that reached `org` with a bearer token and were
 * answered, e.g. `graphqlOperations(log, 'acme').includes('IssueUpdate')`.
 */
export function graphqlOperations(
  records: readonly FakeRequestRecord[],
  org: FakeOrgKey
): string[] {
  return records
    .filter(isBearerRecord)
    .filter((record) => record.org === org && record.status === 200)
    .map((record) => record.operation);
}

async function getJson<T>(fakeBaseUrl: string, path: string): Promise<T> {
  const response = await fetch(new URL(path, fakeBaseUrl));
  if (!response.ok) {
    throw new Error(`fake Linear ${path} answered ${response.status}`);
  }
  return (await response.json()) as T;
}

/** GET /__requests on the fake Linear at `fakeBaseUrl` (its origin). */
export function readFakeRequests(
  fakeBaseUrl: string
): Promise<FakeRequestRecord[]> {
  return getJson(fakeBaseUrl, '/__requests');
}

/** GET /__oauth/grants: every grant, revoked or not (no tokens). */
export function readFakeGrants(
  fakeBaseUrl: string
): Promise<FakeGrantSummary[]> {
  return getJson(fakeBaseUrl, '/__oauth/grants');
}
