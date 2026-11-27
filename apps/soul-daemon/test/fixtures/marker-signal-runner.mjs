/* global setImmediate, setTimeout */
/**
 * Test fixture: runs the real built daemon and defers SIGTERM until the test
 * creates a marker file. This keeps the existing SIGNAL_RUNNER intact while
 * allowing HTTP/WebSocket setup to finish before shutdown begins.
 *
 * The fixture only lives under test/fixtures; production has no marker hook.
 */

import { existsSync } from 'node:fs';
import { run } from '../../dist/main.js';

const marker = process.env.SOUL_TEST_SIGNAL_MARKER;
const signal = process.env.SOUL_TEST_SIGNAL ?? 'SIGTERM';
const markerTimeoutMs = 20_000;

if (marker === undefined || marker.length === 0) {
  throw new Error('SOUL_TEST_SIGNAL_MARKER is required');
}

let waiting = false;
let sent = false;
const originalWrite = process.stdout.write.bind(process.stdout);
let buffer = '';

function waitForMarker() {
  const deadline = Date.now() + markerTimeoutMs;
  const poll = () => {
    if (sent) {
      return;
    }
    if (existsSync(marker)) {
      sent = true;
      setImmediate(() => process.emit(signal));
      return;
    }
    if (Date.now() >= deadline) {
      process.stderr.write('marker-signal-runner: marker timeout\n');
      sent = true;
      setImmediate(() => process.emit(signal));
      return;
    }
    setTimeout(poll, 20);
  };
  poll();
}

process.stdout.write = (chunk, ...rest) => {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  const result = originalWrite(chunk, ...rest);
  buffer += text;
  if (!waiting && buffer.includes('"phase":"RUNNING"')) {
    waiting = true;
    waitForMarker();
  }
  return result;
};

const code = await run();
process.exitCode = code;
