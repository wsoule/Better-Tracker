import { requireApiActor } from '../../../lib/http';
import { patchSettings } from '../../../lib/workspace-routes';

/**
 * PATCH /api/settings (anyone signed in): any subset of watcherUserIds,
 * allocationMode, warningsMode, timezone and tuning. Validated here with
 * zod and again by the engine (watchers in the mirror, a real IANA
 * timezone); every save is audited. Same-origin JSON only.
 * 200 { settings }.
 */
export function PATCH(request: Request): Promise<Response> {
  return patchSettings(request, requireApiActor);
}
