import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { sendWebResponse } from '../server/apiMiddleware';

test('API response bridge remains active until stream completion and cancels on disconnect', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { cancelled = true; },
  });
  const chunks: string[] = [];
  const destination = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  Object.assign(destination, { setHeader() {} });
  let finished = false;
  const sending = sendWebResponse(new Response(body), destination as unknown as ServerResponse).then(() => { finished = true; });
  controller.enqueue(new TextEncoder().encode('progress\n'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false, 'request cancellation must remain attached during streaming');
  assert.deepEqual(chunks, ['progress\n']);
  destination.destroy();
  await sending;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true, 'disconnect must cancel the web stream');
});
