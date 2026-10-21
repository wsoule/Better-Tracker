import { jsonError } from '../../../lib/origin';

/* Unknown /api paths answer a JSON 404 (the error shape client islands
   read), instead of falling through to the app's not-found page. Every
   real API route is more specific and wins. */
function missing(): Response {
  return jsonError(404, 'not_found', 'No such API route.');
}

export const GET = missing;
export const POST = missing;
export const PUT = missing;
export const PATCH = missing;
export const DELETE = missing;
