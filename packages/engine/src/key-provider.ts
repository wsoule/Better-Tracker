// The Linear provider of api_key mode (architecture §7 "API-key mode",
// "Which key each Linear call uses"). Every gateway reads its key from the
// vault through a getter, so nothing here holds a key either.
//
// - forSession: the person's own key, for everything they do (edits,
//   comments, their issue page's live read, a run they start). It needs a
//   live vault entry of that very person (security S3).
// - forApp: the "reader" key, a connected workspace member's (the binder's
//   first, then the earliest connected), used only to refresh the shared
//   mirror. Its gateway refuses all seven writes without calling Linear,
//   so one person's key never writes for anyone.
//
// Each gateway is guarded: a key Linear stops accepting is forgotten
// (vault.remove), and a write Linear refuses as out of the key's scope
// marks the person read-only (`read_only_key`, isKeyPermissionRefusal).
// The reader is checked against what it reads: a full read in which
// Linear lists the reader as a guest (or deactivated) is thrown away, that
// person stops reading, and the next member reads instead, so the mirror
// never shrinks to a guest's teams.

import type { WorkspaceData } from '@better-tracker/core';
import {
  LinearGraphqlErrors,
  type LinearGateway,
} from '@better-tracker/linear';
import type { Logger } from '@better-tracker/logger';
import type { Installation, Session } from '@better-tracker/store';

import type { KeyVault, VaultSession } from './key-vault';
import { isLinearApiError } from './linear-errors';
import { READ_ONLY_MESSAGES } from './permissions';
import { NOT_INSTALLED_MESSAGE } from './runtime';
import { EngineAuthError, type LinearProvider } from './types';

/** Told to a person whose key the vault no longer holds. */
export const KEY_FORGOTTEN_MESSAGE =
  'The planner forgot your Linear key (you signed out, were idle, reached the time limit, or the planner restarted). Paste it again.';
/** Told to a person whose key Linear stopped accepting. */
export const KEY_REJECTED_MESSAGE =
  'Linear no longer accepts your API key (revoked?). Paste a new one.';
/** No workspace member is connected, so nothing can read Linear. */
export const NO_READER_MESSAGE =
  'No workspace member has a Linear key connected right now, so the planner cannot read Linear. It shows its last copy.';
/** The reader's key went away while a sync used it. */
export const READER_GONE_MESSAGE =
  "The key the planner was reading Linear with was disconnected; the next sync uses another connected member's key.";
/** A write tried through the reader gateway (never happens on purpose). */
export const READER_WRITE_MESSAGE =
  'The planner never writes with the key it reads Linear with.';
/** Most readers one full read tries before giving up (each try pages all of Linear). */
export const MAX_READER_TRIES = 3;

// Why a reader may not read for the mirror, from the workspace it just
// read: Linear lists them as a guest, deactivated or an app user. A reader
// Linear did not list is let through (its users read includes everyone).
function readerProblem(
  data: WorkspaceData,
  userId: string
): 'guest' | 'inactive' | null {
  const user = data.users.find((candidate) => candidate.id === userId);
  if (user === undefined) return null;
  if (!user.active || user.app) return 'inactive';
  return user.guest === true ? 'guest' : null;
}

/** Every LinearGateway method; the guard wraps each one. */
const GATEWAY_METHODS = [
  'whoAmI',
  'fetchWorkspace',
  'fetchLastStateChanges',
  'fetchIssue',
  'fetchIssueRelations',
  'fetchProject',
  'fetchMilestone',
  'fetchUser',
  'fetchInitiative',
  'updateIssue',
  'createComment',
  'updateMilestoneTargetDate',
  'updateProjectLead',
  'fetchIssueDetail',
  'listIssueLabels',
  'updateIssueFields',
  'createBlockingRelation',
  'deleteRelation',
] as const satisfies readonly (keyof LinearGateway)[];

type GatewayMethod = (typeof GATEWAY_METHODS)[number];
// Fails to compile when LinearGateway gains a method the list lacks.
const COMPLETE: [Exclude<keyof LinearGateway, GatewayMethod>] extends [never]
  ? true
  : false = true;
void COMPLETE;

/** The seven methods that write to Linear. */
export const GATEWAY_WRITE_METHODS: ReadonlySet<string> =
  new Set<GatewayMethod>([
    'updateIssue',
    'createComment',
    'updateMilestoneTargetDate',
    'updateProjectLead',
    'updateIssueFields',
    'createBlockingRelation',
    'deleteRelation',
  ]);

const KEY_SCOPE_WORDING = /\b(scopes?|api[ -]?key|read[- ]only)\b/i;

// The first GraphQL error's texts found along an error's cause chain.
function graphqlTexts(error: unknown): string[] {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    const list = (current as { errors?: unknown }).errors;
    if (
      (current instanceof LinearGraphqlErrors ||
        current.name === 'LinearGraphqlErrors') &&
      Array.isArray(list)
    ) {
      const first: unknown = list[0];
      if (typeof first !== 'object' || first === null) return [];
      const info = first as {
        message?: unknown;
        userPresentableMessage?: unknown;
      };
      return [info.message, info.userPresentableMessage].filter(
        (text): text is string => typeof text === 'string'
      );
    }
    current = current.cause;
  }
  return [];
}

/**
 * True when a write's failure says the API key itself may not write (F7,
 * heuristic): a LinearApiError (by name and kind, also through its cause
 * chain) of kind `forbidden` whose first GraphQL error's message or
 * userPresentableMessage speaks of scopes, an API key or read-only.
 * Generic wording ("permission to perform") is deliberately not matched:
 * a per-issue refusal uses it, and matching it would turn a writable
 * person read-only for everything. The guard calls it for writes only.
 */
export function isKeyPermissionRefusal(error: unknown): boolean {
  let current: unknown = error;
  let forbidden = false;
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    if (isLinearApiError(current) && current.kind === 'forbidden') {
      forbidden = true;
      break;
    }
    current = current.cause;
  }
  if (!forbidden) return false;
  return graphqlTexts(error).some((text) => KEY_SCOPE_WORDING.test(text));
}

/** A gateway whose seven writes throw read_only without calling Linear. */
export function readOnlyGateway(gateway: LinearGateway): LinearGateway {
  const wrapped: Record<string, unknown> = {};
  for (const method of GATEWAY_METHODS) {
    wrapped[method] = GATEWAY_WRITE_METHODS.has(method)
      ? (): Promise<never> =>
          Promise.reject(new EngineAuthError('read_only', READER_WRITE_MESSAGE))
      : gateway[method].bind(gateway);
  }
  return wrapped as unknown as LinearGateway;
}

export interface ApiKeyLinearProviderOptions {
  vault: KeyVault;
  logger: Logger;
  appName: string;
  /** The workspace binding (key-auth.ts bindingFor). */
  binding: () => Promise<Installation | null>;
}

/** The api_key-mode provider (see the file comment). */
export function createApiKeyLinearProvider(
  options: ApiKeyLinearProviderOptions
): LinearProvider {
  const { vault } = options;

  // Wraps every method of `gateway` (acting with the key of `sessionId`)
  // with the guard described in the file comment.
  function guard(
    gateway: LinearGateway,
    sessionId: string,
    role: 'person' | 'reader'
  ): LinearGateway {
    const log = options.logger.child({ sessionId, role });
    const forgotten = (): EngineAuthError =>
      role === 'person'
        ? new EngineAuthError('not_signed_in', KEY_FORGOTTEN_MESSAGE)
        : new EngineAuthError('no_reader', READER_GONE_MESSAGE);
    const wrapped: Record<string, unknown> = {};
    for (const method of GATEWAY_METHODS) {
      const writes = GATEWAY_WRITE_METHODS.has(method);
      wrapped[method] = async (...args: unknown[]): Promise<unknown> => {
        if (
          role === 'person' &&
          writes &&
          vault.peek(sessionId)?.writeRefused === true
        ) {
          throw new EngineAuthError(
            'read_only',
            READ_ONLY_MESSAGES.read_only_key
          );
        }
        try {
          const call = gateway[method] as (...a: unknown[]) => Promise<unknown>;
          return await call.apply(gateway, args);
        } catch (error) {
          if (isLinearApiError(error) && error.kind === 'unauthorized') {
            // Forgotten while the call ran: the getter came back empty.
            if (vault.peek(sessionId) === null) throw forgotten();
            // Linear refused a key the vault still held: revoked.
            vault.remove(sessionId);
            log.warn('Linear refused a connected API key; forgot it', {
              sessionId,
              role,
            });
            throw role === 'person'
              ? new EngineAuthError('not_signed_in', KEY_REJECTED_MESSAGE)
              : new EngineAuthError('no_reader', READER_GONE_MESSAGE);
          }
          if (role === 'person' && writes && isKeyPermissionRefusal(error)) {
            vault.markWriteRefused(sessionId);
            log.warn("Linear refused a write as out of the key's scope", {
              sessionId,
              method,
            });
            throw new EngineAuthError(
              'read_only',
              READ_ONLY_MESSAGES.read_only_key
            );
          }
          throw error;
        }
      };
    }
    return wrapped as unknown as LinearGateway;
  }

  return {
    mode: 'linear',

    forSession(session: Session): Promise<LinearGateway> {
      return new Promise((resolve) => {
        const entry = vault.peek(session.id);
        if (
          entry === null ||
          entry.userId !== session.userId ||
          entry.workspaceId !== session.workspaceId
        ) {
          throw new EngineAuthError('not_signed_in', KEY_FORGOTTEN_MESSAGE);
        }
        const gateway = vault.gateway(session.id);
        if (gateway === null) {
          throw new EngineAuthError('not_signed_in', KEY_FORGOTTEN_MESSAGE);
        }
        resolve(guard(gateway, session.id, 'person'));
      });
    },

    async forApp(workspaceId: string): Promise<LinearGateway> {
      const binding = await options.binding();
      if (binding === null || binding.workspaceId !== workspaceId) {
        throw new EngineAuthError(
          'not_installed',
          NOT_INSTALLED_MESSAGE.unbound(options.appName)
        );
      }
      // The first reader (§7.6) whose key is still held, behind the
      // read-only guard.
      const pick = (): PickedReader | null => {
        for (const reader of vault.readers(workspaceId, {
          preferUserId: binding.installedByUserId,
        })) {
          const gateway = vault.gateway(reader.id);
          if (gateway !== null) {
            return {
              reader,
              gateway: readOnlyGateway(guard(gateway, reader.id, 'reader')),
            };
          }
        }
        return null;
      };
      const first = pick();
      if (first === null) {
        throw new EngineAuthError('no_reader', NO_READER_MESSAGE);
      }
      return readerGateway(first, pick, (reader, problem) => {
        // A guest's entries stay (read-only); a deactivated person's key
        // is forgotten, as authenticate does.
        if (problem === 'guest') vault.markGuest(workspaceId, reader.userId);
        else vault.remove(reader.id);
        options.logger.warn(
          'the reader is no longer a workspace member; another key reads',
          { workspaceId, userId: reader.userId, problem }
        );
      });
    },
  };
}

interface PickedReader {
  reader: VaultSession;
  gateway: LinearGateway;
}

// The reader gateway forApp hands out (see the file comment): every call
// goes to the current reader. A full read (fetchWorkspace) in which Linear
// lists the current reader as a guest or deactivated is thrown away:
// `demote` takes that person off the readers, and the read is retried with
// the next reader `pick` finds, at most MAX_READER_TRIES full reads in all;
// with none left it fails with no_reader and the mirror stays as it was.
function readerGateway(
  first: PickedReader,
  pick: () => PickedReader | null,
  demote: (reader: VaultSession, problem: 'guest' | 'inactive') => void
): LinearGateway {
  let current = first;
  const wrapped: Record<string, unknown> = {};
  for (const method of GATEWAY_METHODS) {
    wrapped[method] =
      method === 'fetchWorkspace'
        ? async (): Promise<WorkspaceData> => {
            for (let tries = 0; tries < MAX_READER_TRIES; tries++) {
              const data = await current.gateway.fetchWorkspace();
              const problem = readerProblem(data, current.reader.userId);
              if (problem === null) return data;
              demote(current.reader, problem);
              const next = pick();
              if (next === null) break;
              current = next;
            }
            throw new EngineAuthError('no_reader', NO_READER_MESSAGE);
          }
        : (...args: unknown[]): Promise<unknown> => {
            const gateway = current.gateway;
            const call = gateway[method] as (
              ...a: unknown[]
            ) => Promise<unknown>;
            return call.apply(gateway, args);
          };
  }
  return wrapped as unknown as LinearGateway;
}
