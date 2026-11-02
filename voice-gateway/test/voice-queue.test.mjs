// Drop-in tests for the gateway voice-queue client (claim/ack).
// COPY TO: <gateway>/test/voice-queue.test.mjs
// Network isolation: global fetch is stubbed in-process; no sockets opened,
// no external requests, no real credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  B8iWorkerError,
  ackVoiceQueue,
  claimVoiceQueue,
} from '../src/services/b8i-worker.js';

const BASE = 'https://worker.test';

const clientFor = (overrides = {}) => ({
  enabled: true,
  baseUrl: BASE,
  token: 'TEST_ONLY_voice_token',
  timeoutMs: 2000,
  ...overrides,
});

const asCode = code => err => {
  assert.ok(err instanceof B8iWorkerError, `expected B8iWorkerError, got ${err}`);
  assert.equal(err.code, code);
  return true;
};

function installFetchMock(handler) {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({
      url: String(url),
      method: init.method || 'GET',
      auth: init.headers?.authorization || null,
      body: init.body || null,
    });
    return handler(String(url), init);
  };
  return { seen, restore: () => { globalThis.fetch = orig; } };
}

const jsonRes = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const claimBody = (overrides = {}) => ({
  ok: true,
  linked: true,
  session_id: 'sess_123',
  items: [
    {
      id: 'item_1',
      text: 'B8i connects businesses with influencers.',
      at: '2026-10-31T00:00:00.000Z',
      expires_at: '2026-10-31T00:10:00.000Z',
      lease_expires_at: '2026-10-31T00:01:00.000Z',
    },
  ],
  context: {
    purpose: 'influencer',
    link_expires_at: '2026-10-31T04:00:00.000Z',
    summary: 'User: hello',
    summary_updated_at: '2026-10-31T00:00:00.000Z',
    recent: [{ src: 'ig_in', at: '2026-10-31T00:00:00.000Z', text: 'hello' }],
  },
  ...overrides,
});

test('claim validates input before any fetch', async () => {
  const mock = installFetchMock(() => jsonRes(200, claimBody()));
  try {
    await assert.rejects(claimVoiceQueue(clientFor(), ''), asCode('invalid_id'));
    await assert.rejects(claimVoiceQueue(clientFor(), 'x'.repeat(257)), asCode('invalid_id'));
    await assert.rejects(claimVoiceQueue(clientFor(), 'sess_123', 0), asCode('invalid_input'));
    await assert.rejects(claimVoiceQueue(clientFor(), 'sess_123', 11), asCode('invalid_input'));
    assert.equal(mock.seen.length, 0);
  } finally {
    mock.restore();
  }
});

test('claim posts bearer + session and returns items with context', async () => {
  const mock = installFetchMock(() => jsonRes(200, claimBody()));
  try {
    const res = await claimVoiceQueue(clientFor(), 'sess_123', 3);
    assert.equal(mock.seen.length, 1);
    assert.equal(mock.seen[0].method, 'POST');
    assert.equal(mock.seen[0].url, `${BASE}/api/voice/ig-queue/claim`);
    assert.equal(mock.seen[0].auth, 'Bearer TEST_ONLY_voice_token');
    assert.deepEqual(JSON.parse(mock.seen[0].body), { session_id: 'sess_123', max: 3 });
    assert.equal(res.linked, true);
    assert.equal(res.sessionId, 'sess_123');
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].id, 'item_1');
    assert.equal(res.context.purpose, 'influencer');
    assert.equal(res.context.recent.length, 1);
  } finally {
    mock.restore();
  }
});

test('claim linked:false yields empty items and null context', async () => {
  const mock = installFetchMock(() => jsonRes(200, claimBody({ linked: false, items: [], context: null })));
  try {
    const res = await claimVoiceQueue(clientFor(), 'sess_123');
    assert.equal(res.linked, false);
    assert.deepEqual(res.items, []);
    assert.equal(res.context, null);
  } finally {
    mock.restore();
  }
});

test('claim rejects malformed payloads', async () => {
  const cases = [
    claimBody({ items: [{ id: '', text: 'x' }] }),
    claimBody({ items: [{ id: 'a', text: '' }] }),
    claimBody({ items: 'nope' }),
    claimBody({ context: { recent: 'nope' } }),
    { ok: false },
  ];
  for (const body of cases) {
    const mock = installFetchMock(() => jsonRes(200, body));
    try {
      await assert.rejects(claimVoiceQueue(clientFor(), 'sess_123'), asCode('invalid_response'));
    } finally {
      mock.restore();
    }
  }
});

test('claim maps transport failures to error codes', async () => {
  let mock = installFetchMock(() => jsonRes(401, { error: 'unauthorized' }));
  try {
    await assert.rejects(claimVoiceQueue(clientFor(), 'sess_123'), asCode('unauthorized'));
  } finally {
    mock.restore();
  }
  mock = installFetchMock(() => jsonRes(503, { error: 'voice_disabled' }));
  try {
    await assert.rejects(claimVoiceQueue(clientFor(), 'sess_123'), asCode('http_503'));
  } finally {
    mock.restore();
  }
  const timeout = installFetchMock(() => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  });
  try {
    await assert.rejects(claimVoiceQueue(clientFor(), 'sess_123'), asCode('timeout'));
  } finally {
    timeout.restore();
  }
});

test('ack validates ids and returns acked count', async () => {
  const mock = installFetchMock(() => jsonRes(200, { ok: true, linked: true, session_id: 's', acked: 2 }));
  try {
    await assert.rejects(ackVoiceQueue(clientFor(), 'sess_123', []), asCode('invalid_input'));
    await assert.rejects(
      ackVoiceQueue(clientFor(), 'sess_123', Array.from({ length: 11 }, (_, i) => `id${i}`)),
      asCode('invalid_input'),
    );
    await assert.rejects(ackVoiceQueue(clientFor(), 'sess_123', ['not an id!']), asCode('invalid_input'));
    const res = await ackVoiceQueue(clientFor(), 'sess_123', ['a1', 'b2']);
    assert.equal(mock.seen.length, 1);
    assert.equal(mock.seen[0].url, `${BASE}/api/voice/ig-queue/ack`);
    assert.deepEqual(JSON.parse(mock.seen[0].body), { session_id: 'sess_123', ids: ['a1', 'b2'] });
    assert.deepEqual(res, { linked: true, acked: 2 });
  } finally {
    mock.restore();
  }
});

test('ack rejects malformed responses', async () => {
  const mock = installFetchMock(() => jsonRes(200, { ok: true, linked: true, acked: 'two' }));
  try {
    await assert.rejects(ackVoiceQueue(clientFor(), 'sess_123', ['a1']), asCode('invalid_response'));
  } finally {
    mock.restore();
  }
});

test('queue calls never put secrets in the URL', async () => {
  const mock = installFetchMock((url) =>
    url.endsWith('/claim') ? jsonRes(200, claimBody()) : jsonRes(200, { ok: true, linked: true, acked: 1 }),
  );
  try {
    await claimVoiceQueue(clientFor(), 'sess_123');
    await ackVoiceQueue(clientFor(), 'sess_123', ['a1']);
    for (const call of mock.seen) {
      assert.ok(!call.url.includes('TEST_ONLY_voice_token'), 'token must not appear in URL');
      assert.ok(!call.url.includes('?'), 'queue POSTs carry no query string');
    }
  } finally {
    mock.restore();
  }
});
