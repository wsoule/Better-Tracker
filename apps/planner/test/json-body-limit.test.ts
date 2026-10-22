import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { readLimitedText } from '../lib/body';
import { MAX_JSON_BYTES, readJson } from '../lib/http';

// Every authenticated JSON route reads its body through readJson, which
// stops reading past MAX_JSON_BYTES (413) instead of buffering and
// parsing a body of any size before zod's per-field limits apply.

const schema = z.strictObject({ body: z.string() });

/** A POST whose body streams in chunks and declares no Content-Length. */
function streamed(text: string, chunk = 64 * 1024): Request {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
  const request = new Request('http://localhost:3300/api/sync', {
    method: 'POST',
    body: stream,
    // @ts-expect-error -- Node/Bun need duplex for a streamed request body.
    duplex: 'half',
  });
  Object.defineProperty(request, 'pulledChunks', { get: () => pulled });
  return request;
}

describe('readJson body limit', () => {
  test('a body past the limit is 413 without reading it all', async () => {
    const huge = JSON.stringify({ body: 'x'.repeat(20 * 1024 * 1024) });
    const request = streamed(huge);
    const result = await readJson(request, schema);
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(413);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code
    ).toBe('too_large');
    // Stopped right after the limit, not after 20 MiB.
    const pulled = (request as unknown as { pulledChunks: number })
      .pulledChunks;
    expect(pulled).toBeLessThanOrEqual(MAX_JSON_BYTES / (64 * 1024) + 2);
  });

  test('a declared Content-Length past the limit is refused unread', async () => {
    const request = new Request('http://localhost:3300/api/sync', {
      method: 'POST',
      headers: { 'content-length': String(MAX_JSON_BYTES + 1) },
      body: '{}',
    });
    expect(await readLimitedText(request, MAX_JSON_BYTES)).toBeNull();
  });

  test('a body under the limit is parsed and validated as before', async () => {
    const description = 'é'.repeat(100_000);
    const ok = await readJson(
      streamed(JSON.stringify({ body: description })),
      schema
    );
    expect(ok).toEqual({ body: description });
    const bad = await readJson(streamed('{"body":'), schema);
    expect((bad as Response).status).toBe(400);
  });
});
