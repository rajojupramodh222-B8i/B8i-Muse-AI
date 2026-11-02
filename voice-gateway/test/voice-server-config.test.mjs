// Pins server-level contract strings that cannot be imported without booting:
// the exact voice greeting and the B8I_VOICE_ENABLED=false default.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverSrc = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js'),
  'utf8'
);

test('voice greeting matches the required exact opening', () => {
  const expected =
    'Hi, welcome to B8i! META MUSE AI. Are you calling as an influencer or a business owner? ' +
    'I can help with registration, campaigns, membership information, and general account support.';
  assert.ok(serverSrc.includes(expected), 'exact greeting default missing from src/server.js');
});

test('voice integration stays off by default', () => {
  assert.match(serverSrc, /b8iVoiceEnabled: bool\('B8I_VOICE_ENABLED', false\)/);
});

test('greeting is queued exactly once per call', () => {
  const occurrences = serverSrc.split("queue.unshift({ kind: 'say', text: CFG.greeting").length - 1;
  assert.equal(occurrences, 1);
});
