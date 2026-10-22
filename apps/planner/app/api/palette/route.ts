import { buildPaletteIndex } from '../../../lib/adapters/shell';
import { errorResponse, requireApiActor } from '../../../lib/http';

/**
 * GET /api/palette: the command palette's "Jump to" index for the
 * signed-in person — every project and milestone on the timeline and their
 * own open issues (architecture §8.1). Fetched once, when the palette first
 * opens; private to the person and never cached.
 */
export async function GET(request: Request): Promise<Response> {
  const context = await requireApiActor(request);
  if (context instanceof Response) return context;
  const { engine, actor } = context;
  const workspaceId = actor.session.workspaceId;
  try {
    const [timeline, week] = await Promise.all([
      engine.getTimelineView(workspaceId, actor),
      engine.getWeekView(workspaceId, actor.session.userId, actor),
    ]);
    return Response.json(buildPaletteIndex({ timeline, week }), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
