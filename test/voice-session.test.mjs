// COPY TO: C:\B8i\test\voice-session.test.mjs
// (C:\B8i is outside the gateway workspace; this file lives here until copied.)
//
// B8i voice registration sessions: LINK-code creation, Instagram redemption,
// form pre-fill, session status, and auth/rate-limit guards.
//
// Safety: synthetic env + in-memory KV + test-only origin only. Network
// isolation is installed at module load; behavioral tests assert zero new
// blocked attempts each, so any unexpected outbound call fails.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  generateVoiceLinkCode,
  parseVoiceLinkCommand,
} from '../worker.js';
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

function voiceEnv() {
  // B8I_VOICE_ENABLED=true is required: the worker enforces the voice
  // kill-switch on session creation (kill-switch-off is covered in
  // ig-conv-session.test.mjs).
  const env = createSyntheticEnv({ B8I_VOICE_API_TOKEN: VOICE_TOKEN, B8I_VOICE_ENABLED: 'true' });
  assertSyntheticEnv(env);
  return env;
}

let senderSeq = 0;
const nextSender = () => `voice_sender_${Date.now()}_${(senderSeq += 1)}`;

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

async function getVoiceSessionStatus(env, sessionId, token = VOICE_TOKEN) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return worker.fetch(
    new Request(
      `${TEST_ORIGIN}/api/voice/registration-session/status?session_id=${encodeURIComponent(sessionId)}`,
      { method: 'GET', headers },
    ),
    env,
    createTestContext().ctx,
  );
}

async function postTextAndDrain({ text, env, senderId }) {
  const tctx = createTestContext();
  const payload = buildTextMessagePayload(senderId, text);
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

async function kvJson(env, key) {
  const raw = await env.INSTAGRAM_CONVERSATIONS.get(key);
  return raw ? JSON.parse(raw) : null;
}

describe('pure LINK-code helpers', () => {
  it('parses LINK commands case-insensitively', () => {
    assert.equal(parseVoiceLinkCommand('LINK K7P-2MD'), 'K7P-2MD');
    assert.equal(parseVoiceLinkCommand('link k7p-2md'), 'K7P-2MD');
    assert.equal(parseVoiceLinkCommand('  Link   ABC-234  '), 'ABC-234');
    assert.equal(parseVoiceLinkCommand('hello'), null);
    assert.equal(parseVoiceLinkCommand('LINK'), null);
    assert.equal(parseVoiceLinkCommand('link this please'), null);
  });

  it('generates speakable unique codes', () => {
    const seen = new Set();
    for (let i = 0; i < 100; i++) {
      const code = generateVoiceLinkCode();
      assert.match(code, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
      assert.ok(!/[01ILO]/.test(code), `ambiguous char in ${code}`);
      seen.add(code);
    }
    assert.equal(seen.size, 100);
  });
});

describe('POST /api/voice/registration-session', () => {
  it('rejects missing and wrong credentials', async () => {
    const env = voiceEnv();
    const noAuth = await postVoiceSession(env, { purpose: 'vendor' }, null);
    assert.equal(noAuth.status, 401);
    const wrong = await postVoiceSession(env, { purpose: 'vendor' }, 'TEST_ONLY_wrong');
    assert.equal(wrong.status, 401);
  });

  it('creates an influencer session and allowlists details', async () => {
    const env = voiceEnv();
    const res = await postVoiceSession(env, {
      purpose: 'influencer',
      instagram_username: 'priya.creates',
      details: { full_name: 'Priya Sharma', city: 'Mumbai', password: 'drop-me' },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.session_id);
    assert.match(data.link_code, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    assert.ok(Date.parse(data.expires_at) > Date.now());

    const record = await kvJson(env, `VOICE_SESSION:${data.session_id}`);
    assert.equal(record.purpose, 'influencer');
    assert.equal(record.claimed_instagram_username, 'priya.creates');
    assert.deepEqual(record.details, { full_name: 'Priya Sharma', city: 'Mumbai' });
    assert.equal(record.used, false);
    const link = await kvJson(env, `VOICE_LINK:${data.link_code}`);
    assert.equal(link.session_id, data.session_id);
  });

  it('validates purpose and username', async () => {
    const env = voiceEnv();
    const badPurpose = await postVoiceSession(env, { purpose: 'other' });
    assert.equal(badPurpose.status, 400);
    const badUser = await postVoiceSession(env, {
      purpose: 'vendor',
      instagram_username: 'bad name!',
    });
    assert.equal(badUser.status, 400);
  });

  it('rate-limits creation bursts', async () => {
    const env = voiceEnv();
    let last = 200;
    for (let i = 0; i < 31; i++) {
      const res = await postVoiceSession(env, { purpose: 'vendor' });
      last = res.status;
    }
    assert.equal(last, 429);
  });
});

describe('LINK redemption in Instagram DM', () => {
  it('redeems a code, mints a token, and DMs the pre-filled form link', async () => {
    const env = voiceEnv();
    const created = await (
      await postVoiceSession(env, {
        purpose: 'influencer',
        instagram_username: 'priya.creates',
        details: { full_name: 'Priya Sharma', city: 'Mumbai', niche: 'Fashion' },
      })
    ).json();

    const sender = nextSender();
    const dms = await postTextAndDrain({ text: `LINK ${created.link_code}`, env, senderId: sender });
    assert.equal(dms.length, 1);
    const dmText = dms[0].message.text;
    assert.match(dmText, /\/register\/influencer\?token=/);
    const secrets = [...syntheticSecrets(env), VOICE_TOKEN];
    assertNoSecretsInText(dmText, secrets, 'link-dm');

    const token = dmText.match(/token=([^\s"'&]+)/)[1];
    const reg = await kvJson(env, `REGISTRATION:${token}`);
    assert.equal(reg.instagram_user_id, sender);
    assert.equal(reg.registration_type, 'influencer');
    assert.deepEqual(reg.voice_prefill, {
      full_name: 'Priya Sharma',
      city: 'Mumbai',
      niche: 'Fashion',
    });
    const session = await kvJson(env, `VOICE_SESSION:${created.session_id}`);
    assert.equal(session.used, true);
    assert.equal(session.used_by, sender);

    // Pre-filled form renders consented values + review banner.
    const form = await worker.fetch(
      new Request(`${TEST_ORIGIN}/register/influencer?token=${encodeURIComponent(token)}`),
      env,
      createTestContext().ctx,
    );
    assert.equal(form.status, 200);
    const html = await form.text();
    assert.match(html, /value="Priya Sharma"/);
    assert.match(html, /value="Mumbai"/);
    assert.match(html, /voice-prefill-note/);
    assert.match(html, /please review everything before submitting/);
    assertNoSecretsInText(html, secrets, 'prefill-form');
  });

  it('rejects unknown, reused, and malformed codes without minting tokens', async () => {
    const env = voiceEnv();
    const before = env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('REGISTRATION:').length;

    const dms1 = await postTextAndDrain({
      text: 'LINK ZZZ-999',
      env,
      senderId: nextSender(),
    });
    assert.match(dms1[0].message.text, /didn't work/);

    const created = await (
      await postVoiceSession(env, { purpose: 'vendor' })
    ).json();
    const first = nextSender();
    await postTextAndDrain({ text: `LINK ${created.link_code}`, env, senderId: first });
    const second = nextSender();
    const dms2 = await postTextAndDrain({
      text: `LINK ${created.link_code}`,
      env,
      senderId: second,
    });
    assert.match(dms2[0].message.text, /didn't work/);

    const minted = env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('REGISTRATION:').length - before;
    assert.equal(minted, 1);
  });

  it('enforces one-account-one-role on redemption', async () => {
    const env = voiceEnv();
    const sender = nextSender();
    await env.INSTAGRAM_CONVERSATIONS.put(
      `INFLUENCER:${sender}`,
      JSON.stringify({ instagram_user_id: sender, verification_status: 'APPROVED' }),
    );
    const created = await (
      await postVoiceSession(env, { purpose: 'vendor' })
    ).json();
    const dms = await postTextAndDrain({
      text: `LINK ${created.link_code}`,
      env,
      senderId: sender,
    });
    assert.match(dms[0].message.text, /already registered as an influencer/);
  });

  it('renders vendor pre-fill for business fields', async () => {
    const env = voiceEnv();
    const created = await (
      await postVoiceSession(env, {
        purpose: 'vendor',
        details: { business_name: 'Acme Foods', contact_name: 'Rahul', city: 'Delhi' },
      })
    ).json();
    const sender = nextSender();
    const dms = await postTextAndDrain({
      text: `link ${created.link_code.toLowerCase()}`,
      env,
      senderId: sender,
    });
    const token = dms[0].message.text.match(/token=([^\s"'&]+)/)[1];
    const form = await worker.fetch(
      new Request(`${TEST_ORIGIN}/register/vendor?token=${encodeURIComponent(token)}`),
      env,
      createTestContext().ctx,
    );
    assert.equal(form.status, 200);
    const html = await form.text();
    assert.match(html, /value="Acme Foods"/);
    assert.match(html, /value="Rahul"/);
    assert.match(html, /value="Delhi"/);
    assert.match(html, /voice-prefill-note/);
  });
});

describe('LINK hardening: expiry, isolation, duplicates', () => {
  it('rejects expired codes without minting tokens', async () => {
    const env = voiceEnv();
    const past = new Date(Date.now() - 1000).toISOString();
    await env.INSTAGRAM_CONVERSATIONS.put(
      'VOICE_SESSION:vs_expired',
      JSON.stringify({
        session_id: 'vs_expired',
        link_code: 'EXP-ABC',
        purpose: 'influencer',
        claimed_instagram_username: null,
        details: {},
        created_at: past,
        expires_at: past,
        used: false,
        used_by: null,
        used_at: null,
      }),
    );
    await env.INSTAGRAM_CONVERSATIONS.put(
      'VOICE_LINK:EXP-ABC',
      JSON.stringify({ session_id: 'vs_expired' }),
    );
    const before = env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('REGISTRATION:').length;
    const dms = await postTextAndDrain({ text: 'LINK EXP-ABC', env, senderId: nextSender() });
    assert.match(dms[0].message.text, /didn't work/);
    assert.equal(env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('REGISTRATION:').length, before);
  });

  it('isolates sessions: each redeemer gets only their own prefill', async () => {
    const env = voiceEnv();
    const a = await (
      await postVoiceSession(env, {
        purpose: 'influencer',
        details: { full_name: 'Person A', city: 'City A' },
      })
    ).json();
    const b = await (
      await postVoiceSession(env, {
        purpose: 'vendor',
        details: { business_name: 'Biz B', city: 'City B' },
      })
    ).json();
    const senderA = nextSender();
    const senderB = nextSender();
    const dmA = await postTextAndDrain({ text: `LINK ${a.link_code}`, env, senderId: senderA });
    const dmB = await postTextAndDrain({ text: `LINK ${b.link_code}`, env, senderId: senderB });
    const tokenA = dmA[0].message.text.match(/token=([^\s"'&]+)/)[1];
    const tokenB = dmB[0].message.text.match(/token=([^\s"'&]+)/)[1];
    assert.notEqual(tokenA, tokenB);
    const regA = await kvJson(env, `REGISTRATION:${tokenA}`);
    const regB = await kvJson(env, `REGISTRATION:${tokenB}`);
    assert.equal(regA.instagram_user_id, senderA);
    assert.equal(regB.instagram_user_id, senderB);
    assert.deepEqual(regA.voice_prefill, { full_name: 'Person A', city: 'City A' });
    assert.deepEqual(regB.voice_prefill, { business_name: 'Biz B', city: 'City B' });
  });

  it('accepts sessions with no details and duplicate posts yield distinct codes', async () => {
    const env = voiceEnv();
    const first = await (await postVoiceSession(env, { purpose: 'vendor' })).json();
    assert.equal(first.ok, true);
    const record = await kvJson(env, `VOICE_SESSION:${first.session_id}`);
    assert.deepEqual(record.details, {});
    const second = await (await postVoiceSession(env, { purpose: 'vendor' })).json();
    assert.notEqual(second.link_code, first.link_code);
    // Both codes redeem independently.
    const dm1 = await postTextAndDrain({
      text: `LINK ${first.link_code}`,
      env,
      senderId: nextSender(),
    });
    const dm2 = await postTextAndDrain({
      text: `LINK ${second.link_code}`,
      env,
      senderId: nextSender(),
    });
    assert.match(dm1[0].message.text, /\/register\/vendor\?token=/);
    assert.match(dm2[0].message.text, /\/register\/vendor\?token=/);
  });

  it('fails closed with 503 when KV storage is unavailable', async () => {
    const env = { ...voiceEnv(), INSTAGRAM_CONVERSATIONS: null };
    const res = await postVoiceSession(env, { purpose: 'vendor' });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'storage_unavailable');
  });

  it('leaves the session unused when the form-link DM is not accepted', async () => {
    const env = voiceEnv();
    const created = await (await postVoiceSession(env, { purpose: 'influencer' })).json();
    const sender = nextSender();
    const realFetch = globalThis.fetch;
    let failedOnce = false;
    globalThis.fetch = async (url, init = {}) => {
      const u = typeof url === 'string' ? url : String(url?.url ?? '');
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (!failedOnce && method === 'POST' && u.includes('/me/messages')) {
        failedOnce = true;
        return new Response(JSON.stringify({ error: { message: 'synthetic', code: 1 } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return realFetch(url, init);
    };
    try {
      const dms = await postTextAndDrain({ text: `LINK ${created.link_code}`, env, senderId: sender });
      assert.equal(dms.length, 0);
      assert.equal(failedOnce, true);
      const session = await kvJson(env, `VOICE_SESSION:${created.session_id}`);
      assert.equal(session.used, false);
    } finally {
      globalThis.fetch = realFetch;
    }
    // Same code retries successfully once delivery works.
    const retry = await postTextAndDrain({ text: `LINK ${created.link_code}`, env, senderId: sender });
    assert.match(retry[0].message.text, /\/register\/influencer\?token=/);
    const used = await kvJson(env, `VOICE_SESSION:${created.session_id}`);
    assert.equal(used.used, true);
  });
});

describe('pre-fill correctness and existing-flow preservation', () => {
  it('pre-fills vendor campaign fields from the voice campaign step', async () => {
    const env = voiceEnv();
    const created = await (
      await postVoiceSession(env, {
        purpose: 'vendor',
        details: {
          business_name: 'Acme Foods',
          campaign_title: 'Summer Launch',
          niche: 'Food',
          target_location: 'Mumbai',
        },
      })
    ).json();
    const dms = await postTextAndDrain({
      text: `LINK ${created.link_code}`,
      env,
      senderId: nextSender(),
    });
    const token = dms[0].message.text.match(/token=([^\s"'&]+)/)[1];
    const form = await worker.fetch(
      new Request(`${TEST_ORIGIN}/register/vendor?token=${encodeURIComponent(token)}`),
      env,
      createTestContext().ctx,
    );
    assert.equal(form.status, 200);
    const html = await form.text();
    assert.match(html, /value="Acme Foods"/);
    assert.match(html, /value="Summer Launch"/);
    assert.match(html, /value="Food"/);
    assert.match(html, /value="Mumbai"/);
    assert.match(html, /voice-prefill-note/);
  });

  it('renders no banner for tokens without voice prefill (existing flows unchanged)', async () => {
    const env = voiceEnv();
    const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await env.INSTAGRAM_CONVERSATIONS.put(
      'REGISTRATION:rawtok_influencer',
      JSON.stringify({
        token: 'rawtok_influencer',
        instagram_user_id: nextSender(),
        registration_type: 'influencer',
        created_at: new Date().toISOString(),
        expires_at: future,
        used: false,
      }),
    );
    await env.INSTAGRAM_CONVERSATIONS.put(
      'REGISTRATION:rawtok_vendor',
      JSON.stringify({
        token: 'rawtok_vendor',
        instagram_user_id: nextSender(),
        registration_type: 'vendor',
        created_at: new Date().toISOString(),
        expires_at: future,
        used: false,
      }),
    );
    for (const [role, token] of [
      ['influencer', 'rawtok_influencer'],
      ['vendor', 'rawtok_vendor'],
    ]) {
      const form = await worker.fetch(
        new Request(`${TEST_ORIGIN}/register/${role}?token=${token}`),
        env,
        createTestContext().ctx,
      );
      assert.equal(form.status, 200);
      const html = await form.text();
      assert.doesNotMatch(html, /voice-prefill-note/);
    }
  });

  it('submit stores user edits and runs unchanged validation', async () => {
    const env = voiceEnv();
    const created = await (
      await postVoiceSession(env, {
        purpose: 'influencer',
        details: { full_name: 'Voice Name', city: 'Voice City', niche: 'Fashion' },
      })
    ).json();
    const sender = nextSender();
    const dms = await postTextAndDrain({ text: `LINK ${created.link_code}`, env, senderId: sender });
    const token = dms[0].message.text.match(/token=([^\s"'&]+)/)[1];

    const form = await worker.fetch(
      new Request(`${TEST_ORIGIN}/register/influencer?token=${encodeURIComponent(token)}`),
      env,
      createTestContext().ctx,
    );
    assert.match(await form.text(), /value="Voice Name"/);

    // User edits pre-filled values before submitting.
    const body = new URLSearchParams({
      token,
      full_name: 'Edited Name',
      email: 'edited@example.com',
      phone: '+911234567890',
      city: 'Edited City',
      area: 'Area',
      state: 'State',
      country: 'India',
      pincode: '500001',
      address_line: 'Some address',
      instagram_url: 'https://instagram.com/edited',
      facebook_url: '',
      youtube_url: '',
      niche: 'Fashion',
      social_links: '',
      verification_screenshot_data: 'data:image/png;base64,iVBORw0KGgo=',
      payout_method: 'upi',
      upi_id: 'edited@okbank',
    });
    const submit = await worker.fetch(
      new Request(`${TEST_ORIGIN}/register/influencer/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      }),
      env,
      createTestContext().ctx,
    );
    assert.equal(submit.status, 303);
    const influencer = await kvJson(env, `INFLUENCER:${sender}`);
    assert.equal(influencer.full_name, 'Edited Name');
    assert.equal(influencer.city, 'Edited City');
    assert.equal(influencer.verification_status, 'AWAITING_SUBSCRIPTION');
    const reg = await kvJson(env, `REGISTRATION:${token}`);
    assert.equal(reg.used, true);
  });
});

describe('GET /api/voice/registration-session/status', () => {
  it('reports redemption state without PII', async () => {
    const env = voiceEnv();
    const created = await (
      await postVoiceSession(env, { purpose: 'influencer' })
    ).json();

    const fresh = await (await getVoiceSessionStatus(env, created.session_id)).json();
    assert.deepEqual(fresh, { ok: true, used: false, expired: false, purpose: 'influencer' });

    await postTextAndDrain({
      text: `LINK ${created.link_code}`,
      env,
      senderId: nextSender(),
    });
    const used = await (await getVoiceSessionStatus(env, created.session_id)).json();
    assert.deepEqual(used, { ok: true, used: true, expired: false, purpose: 'influencer' });

    const unknown = await getVoiceSessionStatus(env, 'nope');
    assert.equal(unknown.status, 404);
    const noAuth = await getVoiceSessionStatus(env, created.session_id, null);
    assert.equal(noAuth.status, 401);
  });
});
