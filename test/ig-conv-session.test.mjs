// test/ig-conv-session.test.mjs
//
// Unified Instagram + voice shared conversation context: verified linking,
// bounded context recording, speakable reply queue (claim/ack), kill-switch
// enforcement, cross-user isolation, and documented concurrency behavior.
//
// Safety: synthetic env + in-memory KV + test-only origin only. Network
// isolation is installed at module load; behavioral tests assert zero new
// blocked attempts each, so any unexpected outbound call fails.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import {
  TEST_ORIGIN,
  InMemoryKV,
  createSyntheticEnv,
  syntheticSecrets,
  assertSyntheticEnv,
  installNetworkIsolation,
  buildInstagramWebhookRequest,
  buildTextMessagePayload,
  createTestContext,
  drainWaitUntil,
  messagesFor,
  assertNoSecretsInText,
} from './helpers.mjs';

const isolation = installNetworkIsolation();
const VOICE_TOKEN = 'TEST_ONLY_voice_token_9f2c7a41';

function voiceEnv(extra = {}) {
  const env = createSyntheticEnv({
    B8I_VOICE_API_TOKEN: VOICE_TOKEN,
    B8I_VOICE_ENABLED: 'true',
    ...extra,
  });
  assertSyntheticEnv(env);
  return env;
}

let senderSeq = 0;
const nextSender = () => `igconv_sender_${Date.now()}_${(senderSeq += 1)}`;

async function kvJson(env, key) {
  const raw = await env.INSTAGRAM_CONVERSATIONS.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function kvPut(env, key, value, ttl) {
  await env.INSTAGRAM_CONVERSATIONS.put(
    key,
    JSON.stringify(value),
    ttl ? { expirationTtl: ttl } : undefined,
  );
}

async function kvList(env, prefix) {
  const page = await env.INSTAGRAM_CONVERSATIONS.list({ prefix, limit: 100 });
  return (page.keys || []).map((k) => k.name);
}

async function postVoiceSession(env, body, token = VOICE_TOKEN) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return worker.fetch(
    new Request(`${TEST_ORIGIN}/api/voice/registration-session`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    env,
    createTestContext().ctx,
  );
}

async function claimQueue(env, payload, token = VOICE_TOKEN) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return worker.fetch(
    new Request(`${TEST_ORIGIN}/api/voice/ig-queue/claim`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    }),
    env,
    createTestContext().ctx,
  );
}

async function ackQueue(env, payload, token = VOICE_TOKEN) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return worker.fetch(
    new Request(`${TEST_ORIGIN}/api/voice/ig-queue/ack`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    }),
    env,
    createTestContext().ctx,
  );
}

async function postTextAndDrain({ text, env, senderId, mid = null }) {
  const tctx = createTestContext();
  const payload = buildTextMessagePayload(senderId, text, mid);
  const req = buildInstagramWebhookRequest({ payload, secret: env.INSTAGRAM_APP_SECRET });
  const before = isolation.snapshot();
  const res = await worker.fetch(req, env, tctx.ctx);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'EVENT_RECEIVED');
  await drainWaitUntil(tctx);
  const after = isolation.snapshot();
  assert.equal(
    after.blockedFailClosed - before.blockedFailClosed,
    0,
    'behavioral flow must not attempt blocked outbound calls',
  );
  return messagesFor(isolation.sentMessages, senderId);
}

async function createSession(env, purpose = 'influencer') {
  const res = await postVoiceSession(env, {
    purpose,
    details: { full_name: 'IG Conv Test' },
  });
  assert.equal(res.status, 200);
  return res.json();
}

function seedQueueItem(env, senderId, sessionId, overrides = {}) {
  const now = Date.now();
  const item = {
    v: 1,
    id: `seed${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16)}`.slice(0, 32),
    instagram_user_id: senderId,
    voice_session_id: sessionId,
    at: new Date(now).toISOString(),
    expires_at: new Date(now + 10 * 60 * 1000).toISOString(),
    text: 'Seeded speakable reply.',
    status: 'pending',
    claimed_at: null,
    claim_expires_at: null,
    ...overrides,
  };
  return kvPut(env, `IG_CONV_Q:${senderId}:${item.id}`, item, 600).then(() => item);
}

function allSecrets(env) {
  return [...syntheticSecrets(env, { includePhone: true }), VOICE_TOKEN];
}

describe('voice kill-switch enforcement', () => {
  it('creation requires the kill-switch flag (503 voice_disabled)', async () => {
    const off = voiceEnv({ B8I_VOICE_ENABLED: 'false' });
    const res = await postVoiceSession(off, { purpose: 'vendor' });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'voice_disabled');

    const missing = createSyntheticEnv({ B8I_VOICE_API_TOKEN: VOICE_TOKEN });
    const res2 = await postVoiceSession(missing, { purpose: 'vendor' });
    assert.equal(res2.status, 503);
    assert.equal((await res2.json()).error, 'voice_disabled');
  });

  it('bearer check runs before the kill-switch (no enablement oracle)', async () => {
    const off = voiceEnv({ B8I_VOICE_ENABLED: 'false' });
    const noAuth = await postVoiceSession(off, { purpose: 'vendor' }, null);
    assert.equal(noAuth.status, 401);
    const wrong = await postVoiceSession(off, { purpose: 'vendor' }, 'TEST_ONLY_wrong');
    assert.equal(wrong.status, 401);
  });

  it('claim/ack enforce bearer + kill-switch; status stays PII-free readable', async () => {
    const env = voiceEnv();
    const session = await createSession(env, 'vendor');
    env.B8I_VOICE_ENABLED = 'false';

    const claim = await claimQueue(env, { session_id: session.session_id });
    assert.equal(claim.status, 503);
    const ack = await ackQueue(env, { session_id: session.session_id, ids: ['x'] });
    assert.equal(ack.status, 503);

    const status = await worker.fetch(
      new Request(
        `${TEST_ORIGIN}/api/voice/registration-session/status?session_id=${encodeURIComponent(session.session_id)}`,
        { method: 'GET', headers: { Authorization: `Bearer ${VOICE_TOKEN}` } },
      ),
      env,
      createTestContext().ctx,
    );
    assert.equal(status.status, 200);
    assert.deepEqual(Object.keys(await status.json()).sort(), ['expired', 'ok', 'purpose', 'used']);
  });
});

describe('verified link creation', () => {
  it('LINK redemption creates a verified cross-channel link', async () => {
    const env = voiceEnv();
    const senderId = nextSender();
    const session = await createSession(env, 'influencer');
    const dms = await postTextAndDrain({ text: `LINK ${session.link_code}`, env, senderId });
    assert.ok(dms.length >= 1, 'redemption DM delivered');

    const conv = await kvJson(env, `IG_CONV:${senderId}`);
    assert.ok(conv, 'IG_CONV record exists');
    assert.equal(conv.instagram_user_id, senderId);
    assert.equal(conv.link.voice_session_id, session.session_id);
    assert.equal(conv.link.purpose, 'influencer');
    assert.equal(conv.link.method, 'link_code_redemption');
    assert.equal(conv.link.revoked_at, null);
    assert.ok(Date.parse(conv.link.consented_at) <= Date.now());
    assert.ok(Date.parse(conv.link.expires_at) > Date.now());
    assert.ok(Date.parse(conv.link.expires_at) <= Date.parse(session.expires_at));
    assert.ok(Date.parse(conv.link.expires_at) <= Date.now() + 4 * 60 * 60 * 1000 + 60 * 1000);

    const stored = await kvJson(env, `VOICE_SESSION:${session.session_id}`);
    assert.equal(stored.used_by, senderId);
  });

  it('replay of the same code fails and leaves the link unchanged', async () => {
    const env = voiceEnv();
    const senderId = nextSender();
    const session = await createSession(env, 'vendor');
    await postTextAndDrain({ text: `LINK ${session.link_code}`, env, senderId });
    const before = await kvJson(env, `IG_CONV:${senderId}`);

    const dms = await postTextAndDrain({ text: `link ${session.link_code.toLowerCase()}`, env, senderId });
    assert.ok(dms.some((m) => String(m.message?.text || '').includes("didn't work")));
    const after = await kvJson(env, `IG_CONV:${senderId}`);
    assert.equal(after.link.consented_at, before.link.consented_at);
    assert.equal(after.link.voice_session_id, session.session_id);
  });

  it('expired sessions never link', async () => {
    const env = voiceEnv();
    const senderId = nextSender();
    const past = new Date(Date.now() - 1000).toISOString();
    await kvPut(env, 'VOICE_SESSION:expired_session_1', {
      session_id: 'expired_session_1',
      link_code: 'ABC-234',
      purpose: 'influencer',
      details: {},
      created_at: past,
      expires_at: past,
      used: false,
      used_by: null,
      used_at: null,
    }, 3600);
    await kvPut(env, 'VOICE_LINK:ABC-234', { session_id: 'expired_session_1' }, 3600);

    const dms = await postTextAndDrain({ text: 'LINK ABC-234', env, senderId });
    assert.ok(dms.some((m) => String(m.message?.text || '').includes("didn't work")));
    const conv = await kvJson(env, `IG_CONV:${senderId}`);
    assert.equal(conv?.link ?? null, null);
  });

  it('role guards still block linking (vendor code + influencer account)', async () => {
    const env = voiceEnv();
    const senderId = nextSender();
    await kvPut(env, `INFLUENCER:${senderId}`, { instagram_user_id: senderId }, 3600);
    const session = await createSession(env, 'vendor');

    const dms = await postTextAndDrain({ text: `LINK ${session.link_code}`, env, senderId });
    assert.ok(dms.some((m) => String(m.message?.text || '').includes('already registered as an influencer')));
    const conv = await kvJson(env, `IG_CONV:${senderId}`);
    assert.equal(conv?.link ?? null, null);
  });

  it('a username alone never creates a link', async () => {
    const env = voiceEnv();
    const res = await postVoiceSession(env, {
      purpose: 'influencer',
      instagram_username: 'someone.famous',
      details: { full_name: 'Someone' },
    });
    assert.equal(res.status, 200);
    const session = await res.json();

    const senderId = nextSender();
    await postTextAndDrain({ text: 'hello, I am someone famous', env, senderId });
    const conv = await kvJson(env, `IG_CONV:${senderId}`);
    assert.equal(conv?.link ?? null, null);

    const claim = await claimQueue(env, { session_id: session.session_id });
    assert.equal(claim.status, 200);
    assert.equal((await claim.json()).linked, false);
  });
});

describe('inbound context recording', () => {
  it('appends bounded events with a rolling digest', async () => {
    const env = voiceEnv();
    const senderId = nextSender();
    // Each greeting yields an ig_in + ig_out pair via the verified
    // assistant path: 12 messages -> 24 events -> oldest 4 trimmed.
    for (let i = 0; i < 12; i++) {
      await postTextAndDrain({ text: `hello ${i}`, env, senderId });
    }
    const conv = await kvJson(env, `IG_CONV:${senderId}`);
    assert.equal(conv.events.length, 20);
    assert.equal(conv.events[0].text, 'hello 2');
    assert.equal(conv.events[0].src, 'ig_in');
    assert.equal(conv.events[19].src, 'ig_out');
    assert.ok(conv.events.every((e) => e.text.length <= 300 && e.at));
    assert.ok(conv.summary.text.length <= 500);
    assert.ok(conv.summary.text.includes('hello 11'));
  });

  it('duplicate deliveries append once (mid idempotency)', async () => {
    const env = voiceEnv();
    const senderId = nextSender();
    await postTextAndDrain({ text: 'first delivery', env, senderId, mid: 'mid_dup_001' });
    await postTextAndDrain({ text: 'first delivery', env, senderId, mid: 'mid_dup_001' });
    const conv = await kvJson(env, `IG_CONV:${senderId}`);
    assert.equal(conv.events.length, 1);
    assert.equal(conv.events[0].mid, 'mid_dup_001');
  });

  it('LINK codes are stored as a marker, never verbatim', async () => {
    const env = voiceEnv();
    const senderId = nextSender();
    const session = await createSession(env, 'influencer');
    await postTextAndDrain({ text: `LINK ${session.link_code}`, env, senderId });
    const conv = await kvJson(env, `IG_CONV:${senderId}`);
    const blob = JSON.stringify(conv.events);
    assert.ok(!blob.includes(session.link_code), 'raw LINK code must not be stored');
    assert.ok(conv.events.some((e) => e.text === '[link code]'));
  });
});

describe('speakable queue claim/ack', () => {
  it('end-to-end: assistant reply enqueues, claim returns item + context, ack removes', async () => {
    const env = voiceEnv();
    const senderId = nextSender();
    const session = await createSession(env, 'influencer');
    await postTextAndDrain({ text: `LINK ${session.link_code}`, env, senderId });

    const dms = await postTextAndDrain({ text: 'what is b8i', env, senderId });
    assert.ok(dms.some((m) => String(m.message?.text || '').includes('B8i connects businesses')));

    const queued = await kvList(env, `IG_CONV_Q:${senderId}:`);
    assert.equal(queued.length, 1);

    const claim = await claimQueue(env, { session_id: session.session_id });
    assert.equal(claim.status, 200);
    const body = await claim.json();
    assert.equal(body.ok, true);
    assert.equal(body.linked, true);
    assert.equal(body.session_id, session.session_id);
    assert.equal(body.items.length, 1);
    assert.ok(body.items[0].text.includes('B8i connects businesses'));
    assert.ok(body.items[0].lease_expires_at);
    assert.equal(body.context.linked, true);
    assert.equal(body.context.purpose, 'influencer');
    assert.ok(body.context.recent.length >= 1);
    assert.ok(body.context.recent.length <= 8);
    assertNoSecretsInText(JSON.stringify(body), allSecrets(env), 'claim');

    const ack = await ackQueue(env, { session_id: session.session_id, ids: [body.items[0].id] });
    assert.equal(ack.status, 200);
    assert.deepEqual(await ack.json(), { ok: true, linked: true, session_id: session.session_id, acked: 1 });

    const again = await claimQueue(env, { session_id: session.session_id });
    assert.equal((await again.json()).items.length, 0);
  });

  it('sensitive assistant replies are recorded but never enqueued', async () => {
    const env = voiceEnv();
    const senderId = nextSender();
    const session = await createSession(env, 'vendor');
    await postTextAndDrain({ text: `LINK ${session.link_code}`, env, senderId });

    const dms = await postTextAndDrain({ text: 'influencer payout', env, senderId });
    assert.ok(dms.length >= 1, 'sensitive reply still delivered on IG');
    assert.equal((await kvList(env, `IG_CONV_Q:${senderId}:`)).length, 0);

    const conv = await kvJson(env, `IG_CONV:${senderId}`);
    assert.ok(conv.events.some((e) => e.src === 'ig_out'), 'outbound recorded in context');
  });

  it('unlinked senders never enqueue', async () => {
    const env = voiceEnv();
    const senderId = nextSender();
    await postTextAndDrain({ text: 'what is b8i', env, senderId });
    assert.equal((await kvList(env, `IG_CONV_Q:${senderId}:`)).length, 0);
  });

  it('claim/ack validate auth, body, and session binding', async () => {
    const env = voiceEnv();
    const senderId = nextSender();
    const session = await createSession(env, 'influencer');
    await postTextAndDrain({ text: `LINK ${session.link_code}`, env, senderId });

    assert.equal((await claimQueue(env, { session_id: session.session_id }, null)).status, 401);
    assert.equal((await claimQueue(env, { session_id: session.session_id }, 'TEST_ONLY_wrong')).status, 401);
    assert.equal((await ackQueue(env, { session_id: session.session_id, ids: ['x'] }, null)).status, 401);

    const noSession = await claimQueue(env, {});
    assert.equal(noSession.status, 400);
    const unknown = await claimQueue(env, { session_id: 'no_such_session' });
    assert.equal(unknown.status, 404);

    const fresh = await createSession(env, 'vendor');
    const unlinked = await claimQueue(env, { session_id: fresh.session_id });
    assert.equal(unlinked.status, 200);
    assert.deepEqual(await unlinked.json(), {
      ok: true, linked: false, session_id: fresh.session_id, items: [], context: null,
    });

    const noIds = await ackQueue(env, { session_id: session.session_id, ids: [] });
    assert.equal(noIds.status, 400);
  });

  it('expired links fail closed to linked:false', async () => {
    const env = voiceEnv();
    const senderId = nextSender();
    const session = await createSession(env, 'influencer');
    await postTextAndDrain({ text: `LINK ${session.link_code}`, env, senderId });
    await postTextAndDrain({ text: 'what is b8i', env, senderId });
    assert.equal((await kvList(env, `IG_CONV_Q:${senderId}:`)).length, 1);

    const conv = await kvJson(env, `IG_CONV:${senderId}`);
    conv.link.expires_at = new Date(Date.now() - 1000).toISOString();
    await kvPut(env, `IG_CONV:${senderId}`, conv, 7 * 24 * 3600);

    const claim = await claimQueue(env, { session_id: session.session_id });
    assert.equal(claim.status, 200);
    assert.equal((await claim.json()).linked, false);
  });

  it('expired items are skipped and collected; leases allow bounded redelivery', async () => {
    const env = voiceEnv();
    const senderId = nextSender();
    const session = await createSession(env, 'influencer');
    await postTextAndDrain({ text: `LINK ${session.link_code}`, env, senderId });

    // Record-expired but KV-live item: claim must skip and delete it.
    const dead = await seedQueueItem(env, senderId, session.session_id, {
      id: 'seeddead000000000000000000000001',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const live = await seedQueueItem(env, senderId, session.session_id, {
      id: 'seedlive000000000000000000000001',
    });

    const first = await (await claimQueue(env, { session_id: session.session_id })).json();
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].id, live.id);
    assert.equal(await kvJson(env, `IG_CONV_Q:${senderId}:${dead.id}`), null);

    // Lease held: immediate re-claim returns nothing (no busy duplicate).
    const held = await (await claimQueue(env, { session_id: session.session_id })).json();
    assert.equal(held.items.length, 0);

    // Lease expired: the same item id is redelivered once (at-least-once).
    const stored = await kvJson(env, `IG_CONV_Q:${senderId}:${live.id}`);
    stored.claim_expires_at = new Date(Date.now() - 1000).toISOString();
    await kvPut(env, `IG_CONV_Q:${senderId}:${live.id}`, stored, 600);
    const redelivered = await (await claimQueue(env, { session_id: session.session_id })).json();
    assert.equal(redelivered.items.length, 1);
    assert.equal(redelivered.items[0].id, live.id);

    // Ack is idempotent: second ack of the same id acks nothing.
    const ack1 = await (await ackQueue(env, { session_id: session.session_id, ids: [live.id] })).json();
    assert.equal(ack1.acked, 1);
    const ack2 = await (await ackQueue(env, { session_id: session.session_id, ids: [live.id] })).json();
    assert.equal(ack2.acked, 0);
  });

  it('claim honors max; ack ignores foreign and malformed ids', async () => {
    const env = voiceEnv();
    const senderA = nextSender();
    const senderB = nextSender();
    const sessionA = await createSession(env, 'influencer');
    const sessionB = await createSession(env, 'vendor');
    await postTextAndDrain({ text: `LINK ${sessionA.link_code}`, env, senderId: senderA });
    await postTextAndDrain({ text: `LINK ${sessionB.link_code}`, env, senderId: senderB });

    const a1 = await seedQueueItem(env, senderA, sessionA.session_id, { id: 'seeda10000000000000000000000001' });
    await seedQueueItem(env, senderA, sessionA.session_id, { id: 'seeda20000000000000000000000001' });
    await seedQueueItem(env, senderA, sessionA.session_id, { id: 'seeda30000000000000000000000001' });
    const b1 = await seedQueueItem(env, senderB, sessionB.session_id, { id: 'seedb10000000000000000000000001' });

    const capped = await (await claimQueue(env, { session_id: sessionA.session_id, max: 2 })).json();
    assert.equal(capped.items.length, 2);

    // B's item id acked under A's session: not deleted (different owner key).
    const foreign = await (await ackQueue(env, { session_id: sessionA.session_id, ids: [b1.id, '../../x', ''] })).json();
    assert.equal(foreign.acked, 0);
    assert.ok(await kvJson(env, `IG_CONV_Q:${senderB}:${b1.id}`), 'foreign item untouched');

    // Forged record under A's own prefix but stamped for another owner: skipped.
    await seedQueueItem(env, senderA, sessionA.session_id, {
      id: 'seedforged0000000000000000000001',
      instagram_user_id: senderB,
    });
    const forgedAck = await (await ackQueue(env, {
      session_id: sessionA.session_id,
      ids: ['seedforged0000000000000000000001', a1.id],
    })).json();
    assert.equal(forgedAck.acked, 1);
    assert.ok(await kvJson(env, `IG_CONV_Q:${senderA}:seedforged0000000000000000000001`));
  });
});

describe('UNLINK revocation', () => {
  it('UNLINK revokes the link, drains the queue, and fails claim closed', async () => {
    const env = voiceEnv();
    const senderId = nextSender();
    const session = await createSession(env, 'vendor');
    await postTextAndDrain({ text: `LINK ${session.link_code}`, env, senderId });
    await postTextAndDrain({ text: 'what is b8i', env, senderId });
    assert.equal((await kvList(env, `IG_CONV_Q:${senderId}:`)).length, 1);

    const dms = await postTextAndDrain({ text: 'UNLINK', env, senderId });
    assert.ok(dms.some((m) => String(m.message?.text || '').includes('no longer linked')));

    const conv = await kvJson(env, `IG_CONV:${senderId}`);
    assert.ok(conv.link.revoked_at);
    assert.equal((await kvList(env, `IG_CONV_Q:${senderId}:`)).length, 0);

    const claim = await (await claimQueue(env, { session_id: session.session_id })).json();
    assert.equal(claim.linked, false);
    assert.equal(claim.items.length, 0);
  });

  it('UNLINK with no link answers safely; near-matches do not trigger', async () => {
    const env = voiceEnv();
    const senderId = nextSender();
    const dms = await postTextAndDrain({ text: 'unlink', env, senderId });
    assert.ok(dms.some((m) => String(m.message?.text || '').includes('no active link')));

    const other = nextSender();
    const dms2 = await postTextAndDrain({ text: 'please unlink me now', env, senderId: other });
    assert.ok(!dms2.some((m) => /no longer linked|no active link/.test(String(m.message?.text || ''))));
  });
});

describe('cross-user isolation', () => {
  it('two linked users keep separate queues and contexts, no secret leakage', async () => {
    const env = voiceEnv();
    const senderA = nextSender();
    const senderB = nextSender();
    const sessionA = await createSession(env, 'influencer');
    const sessionB = await createSession(env, 'vendor');
    await postTextAndDrain({ text: `LINK ${sessionA.link_code}`, env, senderId: senderA });
    await postTextAndDrain({ text: `LINK ${sessionB.link_code}`, env, senderId: senderB });
    await seedQueueItem(env, senderA, sessionA.session_id, { id: 'seedisoa000000000000000000000001', text: 'Alpha-only speakable.' });
    await seedQueueItem(env, senderB, sessionB.session_id, { id: 'seedisob000000000000000000000001', text: 'Beta-only speakable.' });

    const bodyA = await (await claimQueue(env, { session_id: sessionA.session_id })).json();
    const bodyB = await (await claimQueue(env, { session_id: sessionB.session_id })).json();
    assert.equal(bodyA.items.length, 1);
    assert.equal(bodyA.items[0].text, 'Alpha-only speakable.');
    assert.equal(bodyB.items.length, 1);
    assert.equal(bodyB.items[0].text, 'Beta-only speakable.');
    assert.equal(bodyA.context.purpose, 'influencer');
    assert.equal(bodyB.context.purpose, 'vendor');
    assert.ok(!JSON.stringify(bodyA).includes('Beta-only'));
    assert.ok(!JSON.stringify(bodyB).includes('Alpha-only'));
    assertNoSecretsInText(JSON.stringify(bodyA), allSecrets(env), 'claim-A');
    assertNoSecretsInText(JSON.stringify(bodyB), allSecrets(env), 'claim-B');

    // B cannot ack A's item.
    const cross = await (await ackQueue(env, { session_id: sessionB.session_id, ids: [bodyA.items[0].id] })).json();
    assert.equal(cross.acked, 0);
    const stillThere = await (await claimQueue(env, { session_id: sessionA.session_id, max: 10 })).json();
    assert.ok(stillThere.items.length <= 1);
  });
});

describe('concurrency', () => {
  it('concurrent same-sender deliveries both persist (isolate chain)', async () => {
    const env = voiceEnv();
    const senderId = nextSender();
    const build = (text, mid) => buildInstagramWebhookRequest({
      payload: buildTextMessagePayload(senderId, text, mid),
      secret: env.INSTAGRAM_APP_SECRET,
    });
    const t1 = createTestContext();
    const t2 = createTestContext();
    const [r1, r2] = await Promise.all([
      worker.fetch(build('concurrent one', 'mid_conc_1'), env, t1.ctx),
      worker.fetch(build('concurrent two', 'mid_conc_2'), env, t2.ctx),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    await Promise.all([drainWaitUntil(t1), drainWaitUntil(t2)]);
    const conv = await kvJson(env, `IG_CONV:${senderId}`);
    const texts = conv.events.map((e) => e.text);
    assert.ok(texts.includes('concurrent one') && texts.includes('concurrent two'));
  });

  it('concurrent redemption of one code yields exactly one verified link', async () => {
    const env = voiceEnv();
    const senderA = nextSender();
    const senderB = nextSender();
    const session = await createSession(env, 'influencer');
    const build = (senderId, mid) => buildInstagramWebhookRequest({
      payload: buildTextMessagePayload(senderId, `LINK ${session.link_code}`, mid),
      secret: env.INSTAGRAM_APP_SECRET,
    });
    const t1 = createTestContext();
    const t2 = createTestContext();
    await Promise.all([
      worker.fetch(build(senderA, 'mid_race_a'), env, t1.ctx),
      worker.fetch(build(senderB, 'mid_race_b'), env, t2.ctx),
    ]);
    await Promise.all([drainWaitUntil(t1), drainWaitUntil(t2)]);

    const stored = await kvJson(env, `VOICE_SESSION:${session.session_id}`);
    assert.equal(stored.used, true);
    const convA = await kvJson(env, `IG_CONV:${senderA}`);
    const convB = await kvJson(env, `IG_CONV:${senderB}`);
    const verified = [convA, convB].filter(
      (c) => c?.link?.voice_session_id === session.session_id
        && stored.used_by === c.instagram_user_id
        && !c.link.revoked_at,
    );
    // Both senders may hold a link record, but read-time verification
    // (used_by agreement) admits exactly one of them — fail closed.
    assert.equal(verified.length, 1);
  });

  it('DOCUMENTED RESIDUAL RACE: raw KV read-modify-write is last-write-wins', async () => {
    // This test pins KV semantics, not worker behavior: two interleaved
    // read-modify-write cycles on one key lose the first update. The worker
    // avoids this shape via pure-PUT enqueue, per-sender isolate chains, and
    // id/lease/expiry-bounded queue items; cross-isolate interleavings remain
    // possible and fail safe (stale context or bounded redelivery, never
    // cross-user).
    const env = voiceEnv();
    await kvPut(env, 'IG_CONV_Q:race_doc:semantics', { n: 0 }, 60);
    const firstRead = await kvJson(env, 'IG_CONV_Q:race_doc:semantics');
    const secondRead = await kvJson(env, 'IG_CONV_Q:race_doc:semantics');
    firstRead.n = 1;
    secondRead.n = 2;
    await kvPut(env, 'IG_CONV_Q:race_doc:semantics', firstRead, 60);
    await kvPut(env, 'IG_CONV_Q:race_doc:semantics', secondRead, 60);
    assert.equal((await kvJson(env, 'IG_CONV_Q:race_doc:semantics')).n, 2);
  });
});
