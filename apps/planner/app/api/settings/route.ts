import { requireApiActor } from '../../../lib/http';
import { patchSettings } from '../../../lib/pm-routes';

/**
 * PATCH /api/settings (PMs): any subset of pmUserIds, watcherUserIds,
 * allocationMode, warningsMode, timezone and tuning. Validated here with
 * zod and again by the engine (people in the mirror, one active PM left,
 * a real IANA timezone). Same-origin JSON only. 200 { settings }.
 */
export function PATCH(request: Request): Promise<Response> {
  return patchSettings(request, requireApiActor);
}
