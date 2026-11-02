// test/phase1-assistant.test.mjs
//
// B8i Phase 1 local tests: Instagram webhook verification + the Phase 1
// assistant's free-text branches (payout/payment, registration, business
// model, campaigns, greetings, support fallback).
//
// Safety: synthetic env + in-memory KV + test-only origin only. Network
// isolation is installed at module load (before any test) and the first
// test re-proves the fail-closed gate in-suite. Behavioral tests assert
// zero new blocked attempts each, so any unexpected outbound call fails.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  buildMembershipText,
  B8I_NUDGE_TEXT,
  parseRecommendIntent,
  parseFollowerMinimum,
  creatorFollowers,
  rankCreators,
  formatCreatorCard,
  b8iAuthorizedCreatorIds,
  b8iNicheMix,
  indexVendorCampaign,
  listVendorCampaignIds,
  detectChatLanguage,
  classifyChatIntent,
  b8iMarketingTipsKey,
  initiateInfluencerPayout,
  initiateInfluencerPayoutsEnhanced,
  getChatContext,
  timingSafeEqual,
  createManualPayoutRecords,
} from '../worker.js';
import {
  TEST_ORIGIN,
  ISOLATION_ERROR_PATTERN,
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
  stripUrls,
} from './helpers.mjs';

// Installed before any test or worker call in this file.
const isolation = installNetworkIsolation();

let senderSeq = 0;
const nextSender = () => `test_sender_${Date.now()}_${(senderSeq += 1)}`;

// POST one signed text message through the real webhook route, drain the
// worker's background tasks, and return the DMs captured for that sender.
// Fails the test if the flow attempted any blocked outbound call.
async function postTextAndDrain({ text, env, tctx, senderId, mid = null }) {
  const sender = senderId ?? nextSender();
  const payload = buildTextMessagePayload(sender, text, mid);
  const req = buildInstagramWebhookRequest({
    payload,
    secret: env.INSTAGRAM_APP_SECRET,
  });
  const before = isolation.snapshot();
  const sentBefore = isolation.sentMessages.length;
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
  return {
    sender,
    dms: messagesFor(isolation.sentMessages, sender),
    newDms: messagesFor(isolation.sentMessages.slice(sentBefore), sender),
  };
}

async function getKvJson(env, key) {
  const raw = await env.INSTAGRAM_CONVERSATIONS.get(key);
  return raw ? JSON.parse(raw) : null;
}

describe('Phase 1 assistant — network isolation gate', () => {
  it('uses a synthetic-only env, in-memory KV, and test-only origin', () => {
    const env = createSyntheticEnv();
    assertSyntheticEnv(env);
    assert.ok(env.INSTAGRAM_CONVERSATIONS instanceof InMemoryKV);
    assert.equal(env.APP_BASE_URL, TEST_ORIGIN);
  });

  it('fails closed on every non-Instagram outbound shape', async () => {
    const blockedShapes = [
      // Baseten advisory ranking
      ['POST', 'https://inference.baseten.co/v1/chat/completions'],
      // Razorpay payments surface
      ['POST', 'https://api.razorpay.com/v1/orders'],
      ['GET', 'https://api.razorpay.com/v1/plans/plan_test123'],
      ['POST', 'https://api.razorpay.com/v1/plans'],
      ['POST', 'https://api.razorpay.com/v1/subscriptions'],
      ['POST', 'https://api.razorpay.com/v1/transfers'],
      ['POST', 'https://api.razorpay.com/v1/subscriptions/sub_test/cancel'],
      // Resend admin email
      ['POST', 'https://api.resend.com/emails'],
      // Instagram profile lookup shape (fields != id) is NOT mocked
      [
        'GET',
        'https://graph.instagram.com/12345?fields=username,followers_count&access_token=x',
      ],
      // Unknown hosts and the test origin itself via fetch()
      ['GET', 'https://example.com/'],
      ['POST', `${TEST_ORIGIN}/webhook/instagram`],
      ['GET', 'https://graph.instagram.com/v26.0/unknown-shape'],
    ];
    for (const [method, url] of blockedShapes) {
      await assert.rejects(
        () => fetch(url, { method }),
        new RegExp(ISOLATION_ERROR_PATTERN),
        `expected fail-closed block for ${method} ${url}`,
      );
    }
    // The two Phase 1 Instagram shapes stay mocked in-process.
    const lookup = await fetch(
      'https://graph.instagram.com/v26.0/me?fields=id&access_token=TEST_ONLY_probe',
      { method: 'GET' },
    );
    assert.equal(lookup.ok, true);
    assert.ok((await lookup.json()).id);
    const send = await fetch(
      'https://graph.instagram.com/v26.0/me/messages',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: 'isolation_selfcheck_probe' },
          message: { text: 'probe' },
        }),
      },
    );
    assert.equal(send.ok, true);
    assert.match((await send.json()).message_id, /^mid_test_/);
  });
});

describe('Phase 1 assistant — webhook verification', () => {
  it('GET verification echoes the challenge for the synthetic token', async () => {
    const env = createSyntheticEnv();
    const challenge = 'challenge_12345';
    const req = new Request(
      `${TEST_ORIGIN}/webhook/instagram?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(env.INSTAGRAM_VERIFY_TOKEN)}&hub.challenge=${challenge}`,
      { method: 'GET' },
    );
    const res = await worker.fetch(req, env, createTestContext().ctx);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), challenge);
  });

  it('GET verification rejects a wrong token with 403', async () => {
    const env = createSyntheticEnv();
    const req = new Request(
      `${TEST_ORIGIN}/webhook/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`,
      { method: 'GET' },
    );
    const res = await worker.fetch(req, env, createTestContext().ctx);
    assert.equal(res.status, 403);
  });

  it('POST rejects an invalid signature with 403 and sends nothing', async () => {
    const env = createSyntheticEnv();
    const tctx = createTestContext();
    const sender = nextSender();
    const req = buildInstagramWebhookRequest({
      payload: buildTextMessagePayload(sender, 'hello'),
      secret: 'TEST_ONLY_wrong_secret_for_negative_case',
    });
    const res = await worker.fetch(req, env, tctx.ctx);
    assert.equal(res.status, 403);
    await drainWaitUntil(tctx);
    assert.equal(messagesFor(isolation.sentMessages, sender).length, 0);
  });

  it('POST rejects a missing signature with 403 and sends nothing', async () => {
    const env = createSyntheticEnv();
    const tctx = createTestContext();
    const sender = nextSender();
    const req = new Request(`${TEST_ORIGIN}/webhook/instagram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTextMessagePayload(sender, 'hello')),
    });
    const res = await worker.fetch(req, env, tctx.ctx);
    assert.equal(res.status, 403);
    await drainWaitUntil(tctx);
    assert.equal(messagesFor(isolation.sentMessages, sender).length, 0);
  });
});

describe('Phase 1 assistant — payout and payment branches', () => {
  it('explicit payout query gets the neutral workflow explainer, no token', async () => {
    const env = createSyntheticEnv();
    const { sender, dms } = await postTextAndDrain({
      text: 'when will i be paid for my campaign work',
      env,
      tctx: createTestContext(),
    });
    assert.equal(dms.length, 1);
    const text = dms[0].message.text;
    assert.match(text, /Here's how B8i payouts work/);
    assert.match(text, /Reply "vendor" or "influencer"/);
    assert.match(text, /support/);
    assert.equal(
      env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('REGISTRATION:').length,
      0,
    );
    assertNoSecretsInText(text, syntheticSecrets(env), `payout:${sender}`);
  });

  it('generic payment query gets a clarifying question, no lookup', async () => {
    const env = createSyntheticEnv();
    const { sender, dms } = await postTextAndDrain({
      text: 'where is my payment',
      env,
      tctx: createTestContext(),
    });
    assert.equal(dms.length, 1);
    const text = dms[0].message.text;
    assert.match(text, /I don't want to guess about payments/);
    assert.match(text, /subscription or payment you made to B8i/);
    assert.match(text, /money owed/);
    assert.equal(
      env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('REGISTRATION:').length,
      0,
    );
    assertNoSecretsInText(text, syntheticSecrets(env), `payment:${sender}`);
  });
});

describe('Phase 1 assistant — registration branches', () => {
  it('"vendor" creates a vendor token and a test-origin form link', async () => {
    const env = createSyntheticEnv();
    const { sender, dms } = await postTextAndDrain({
      text: 'vendor',
      env,
      tctx: createTestContext(),
    });
    assert.equal(dms.length, 1);
    const text = dms[0].message.text;
    const match = text.match(
      new RegExp(
        `${TEST_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/register/vendor\\?token=([0-9a-f]{64})`,
      ),
    );
    assert.ok(match, 'vendor DM must carry a test-origin form link');
    const token = match[1];
    const record = await getKvJson(env, `REGISTRATION:${token}`);
    assert.ok(record);
    assert.equal(record.registration_type, 'vendor');
    assert.equal(record.instagram_user_id, sender);
    assert.equal(record.used, false);
    assert.ok(Date.parse(record.expires_at) > Date.now());
    const convo = await getKvJson(env, `CONVERSATION:${sender}`);
    assert.ok(convo);
    assert.equal(convo.registration_type, 'vendor');
    assert.ok(String(convo.url).startsWith(TEST_ORIGIN));
    assertNoSecretsInText(
      stripUrls(text),
      syntheticSecrets(env),
      `vendor:${sender}`,
    );
  });

  it('"influencer" creates an influencer token and a test-origin form link', async () => {
    const env = createSyntheticEnv();
    const { sender, dms } = await postTextAndDrain({
      text: 'influencer',
      env,
      tctx: createTestContext(),
    });
    assert.equal(dms.length, 1);
    const text = dms[0].message.text;
    const match = text.match(
      new RegExp(
        `${TEST_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/register/influencer\\?token=([0-9a-f]{64})`,
      ),
    );
    assert.ok(match, 'influencer DM must carry a test-origin form link');
    const token = match[1];
    const record = await getKvJson(env, `REGISTRATION:${token}`);
    assert.ok(record);
    assert.equal(record.registration_type, 'influencer');
    assert.equal(record.instagram_user_id, sender);
    assert.equal(record.used, false);
    assert.ok(Date.parse(record.expires_at) > Date.now());
    const convo = await getKvJson(env, `CONVERSATION:${sender}`);
    assert.ok(convo);
    assert.equal(convo.registration_type, 'influencer');
    assertNoSecretsInText(
      stripUrls(text),
      syntheticSecrets(env),
      `influencer:${sender}`,
    );
  });

  it('already-registered vendor gets the welcome-back path, still test-origin', async () => {
    const env = createSyntheticEnv();
    const sender = nextSender();
    await env.INSTAGRAM_CONVERSATIONS.put(
      `VENDOR:${sender}`,
      JSON.stringify({ instagram_user_id: sender, business_name: 'Probe Co' }),
    );
    const { dms } = await postTextAndDrain({
      text: 'vendor',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /already registered/);
    assert.match(
      dms[0].message.text,
      new RegExp(TEST_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });
});

describe('Phase 1 assistant — explainer and fallback branches', () => {
  it('"what is b8i" gets the neutral business-model explainer, no token', async () => {
    const env = createSyntheticEnv();
    const { sender, dms } = await postTextAndDrain({
      text: 'what is b8i',
      env,
      tctx: createTestContext(),
    });
    assert.equal(dms.length, 1);
    const text = dms[0].message.text;
    assert.match(text, /connects businesses with influencers/);
    assert.match(text, /Reply "vendor" or "influencer"/);
    assert.equal(
      env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('REGISTRATION:').length,
      0,
    );
    assertNoSecretsInText(text, syntheticSecrets(env), `about:${sender}`);
  });

  it('vendor-flavored campaign question gets vendor creation steps', async () => {
    const env = createSyntheticEnv();
    const { sender, dms } = await postTextAndDrain({
      text: 'I want to promote my brand and find influencers',
      env,
      tctx: createTestContext(),
    });
    assert.equal(dms.length, 1);
    const text = dms[0].message.text;
    assert.match(text, /To create a campaign on B8i as a vendor/);
    assert.match(text, /reply "vendor"/);
    assert.equal(
      env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('REGISTRATION:').length,
      0,
    );
    assertNoSecretsInText(text, syntheticSecrets(env), `campaign-v:${sender}`);
  });

  it('creator-flavored campaign question gets creator steps', async () => {
    const env = createSyntheticEnv();
    const { sender, dms } = await postTextAndDrain({
      text: 'how can I earn money from campaigns',
      env,
      tctx: createTestContext(),
    });
    assert.equal(dms.length, 1);
    const text = dms[0].message.text;
    assert.match(text, /For creators on B8i/);
    assert.match(text, /reply "influencer"/);
    assert.equal(
      env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('REGISTRATION:').length,
      0,
    );
    assertNoSecretsInText(text, syntheticSecrets(env), `campaign-i:${sender}`);
  });

  it('greeting gets the welcome message with role quick replies', async () => {
    const env = createSyntheticEnv();
    const { dms } = await postTextAndDrain({
      text: 'hello',
      env,
      tctx: createTestContext(),
    });
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /Welcome to B8i/);
    const payloads = (dms[0].message.quick_replies ?? []).map((r) => r.payload);
    assert.deepEqual(payloads, ['VENDOR', 'INFLUENCER']);
  });

  it('unrecognized text falls back to the welcome message', async () => {
    const env = createSyntheticEnv();
    const { dms } = await postTextAndDrain({
      text: 'zxqv blorp snork',
      env,
      tctx: createTestContext(),
    });
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /Welcome to B8i/);
    const payloads = (dms[0].message.quick_replies ?? []).map((r) => r.payload);
    assert.deepEqual(payloads, ['VENDOR', 'INFLUENCER']);
  });

  it('"support" routes to customer support with the synthetic number', async () => {
    const env = createSyntheticEnv();
    const { sender, dms } = await postTextAndDrain({
      text: 'support',
      env,
      tctx: createTestContext(),
    });
    assert.equal(dms.length, 1);
    const text = dms[0].message.text;
    assert.match(text, /Customer Support/);
    assert.ok(text.includes(env.CUSTOMER_SUPPORT_PHONE));
    assert.equal(
      env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('REGISTRATION:').length,
      0,
    );
    assertNoSecretsInText(text, syntheticSecrets(env), `support:${sender}`);
  });
});

describe('Phase 1 assistant — privacy and isolation accounting', () => {
  it('no captured outbound DM leaks a synthetic secret', () => {
    const env = createSyntheticEnv();
    const secrets = syntheticSecrets(env);
    for (const dm of isolation.sentMessages) {
      if (dm.recipient === 'isolation_selfcheck_probe') continue;
      assertNoSecretsInText(
        stripUrls(dm.message?.text ?? ''),
        secrets,
        `dm:${dm.recipient}`,
      );
    }
    assert.ok(isolation.sentMessages.length > 0);
  });

  it('isolation counters account for every intercepted call', () => {
    const c = isolation.counters;
    assert.equal(
      c.totalIntercepted,
      c.instagramSenderLookups + c.instagramSends + c.blockedFailClosed,
      `counters must reconcile: ${JSON.stringify(c)}`,
    );
    assert.ok(c.instagramSends > 0, 'expected mocked Instagram sends');
    assert.ok(c.blockedFailClosed > 0, 'expected fail-closed blocks');
    console.log(`[isolation] ${JSON.stringify(c)}`);
  });
});

describe('Phase 1 assistant — reported screenshot messages', () => {
  it('exact message 1 keeps the business explainer', async () => {
    const env = createSyntheticEnv();
    const { dms } = await postTextAndDrain({
      text: 'What is B8i and how does it help influencers?',
      env,
      tctx: createTestContext(),
    });
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /connects businesses with influencers/);
  });

  it('exact message 2 returns verified membership pricing, no token', async () => {
    const env = createSyntheticEnv();
    const { dms } = await postTextAndDrain({
      text: 'What are the influencers membership plans?',
      env,
      tctx: createTestContext(),
    });
    assert.equal(dms.length, 1);
    const text = dms[0].message.text;
    assert.match(text, /Starter ₹199\/month — 5 campaign requests\./);
    assert.match(text, /Growth ₹299\/month — 15 campaign requests\./);
    assert.match(text, /Pro ₹499\/month — unlimited campaign requests\./);
    assert.match(text, /not vendor charges/);
    assert.equal(
      env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('REGISTRATION:').length,
      0,
    );
  });

  it('exact message 3 gets welcome once, then the nudge', async () => {
    const env = createSyntheticEnv();
    const sender = `nudge_sender_${Date.now()}`;
    const first = await postTextAndDrain({
      text: 'Can u help me with something different??',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.equal(first.dms.length, 1);
    assert.match(first.dms[0].message.text, /Welcome to B8i/);
    assert.equal(
      await env.INSTAGRAM_CONVERSATIONS.get(`WELCOMED:${sender}`),
      '1',
    );
    const second = await postTextAndDrain({
      text: 'Can u help me with something different??',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.equal(second.newDms.length, 1);
    assert.equal(second.newDms[0].message.text, B8I_NUDGE_TEXT);
    assert.deepEqual(
      (second.newDms[0].message.quick_replies ?? []).map((r) => r.payload),
      ['VENDOR', 'INFLUENCER'],
    );
  });

  it('repeat greeting gets welcome once, then the nudge', async () => {
    const env = createSyntheticEnv();
    const sender = `greet_sender_${Date.now()}`;
    const first = await postTextAndDrain({
      text: 'hello',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.match(first.dms[0].message.text, /Welcome to B8i/);
    const second = await postTextAndDrain({
      text: 'hello',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.equal(second.newDms.length, 1);
    assert.equal(second.newDms[0].message.text, B8I_NUDGE_TEXT);
  });

  it('welcome returns after the marker expires', async () => {
    const env = createSyntheticEnv();
    const sender = `expire_sender_${Date.now()}`;
    await postTextAndDrain({
      text: 'zxqv blorp',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    await env.INSTAGRAM_CONVERSATIONS.delete(`WELCOMED:${sender}`);
    const again = await postTextAndDrain({
      text: 'zxqv blorp',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.equal(again.newDms.length, 1);
    assert.match(again.newDms[0].message.text, /Welcome to B8i/);
  });

  it('unrelated help question gets welcome once, then the natural fallback', async () => {
    const env = createSyntheticEnv();
    const sender = `fallback_${Date.now()}`;
    const first = await postTextAndDrain({
      text: 'Can you help me with something difficult?',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.equal(first.dms.length, 1);
    assert.match(first.dms[0].message.text, /Welcome to B8i/);
    const second = await postTextAndDrain({
      text: 'Can you help me with something difficult?',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.equal(second.newDms.length, 1);
    assert.equal(second.newDms[0].message.text, B8I_NUDGE_TEXT);
    assert.match(
      second.newDms[0].message.text,
      /Tell me what you need help with/,
    );
    assert.deepEqual(
      (second.newDms[0].message.quick_replies ?? []).map((r) => r.payload),
      ['VENDOR', 'INFLUENCER'],
    );
  });
});

describe('Phase 1 assistant — membership variants and exclusions', () => {
  it('answers pricing variants from verified plan values', async () => {
    for (const text of [
      'how much is a membership',
      'influencer pricing',
      'HOW MUCH DOES IT COST',
    ]) {
      const env = createSyntheticEnv();
      const { dms } = await postTextAndDrain({
        text,
        env,
        tctx: createTestContext(),
      });
      assert.equal(dms.length, 1, text);
      assert.equal(dms[0].message.text, buildMembershipText(), text);
    }
  });

  it('routes payment problems to clarification, not pricing', async () => {
    const env = createSyntheticEnv();
    const { dms } = await postTextAndDrain({
      text: 'my membership payment failed',
      env,
      tctx: createTestContext(),
    });
    assert.match(dms[0].message.text, /I don't want to guess about payments/);
  });

  it('routes vendor cost questions to campaign steps, never creator prices', async () => {
    const env = createSyntheticEnv();
    const { dms } = await postTextAndDrain({
      text: 'how much does a campaign cost',
      env,
      tctx: createTestContext(),
    });
    assert.match(dms[0].message.text, /To create a campaign on B8i as a vendor/);
    assert.ok(!dms[0].message.text.includes('₹199'));
  });

  it('routes earnings questions away from pricing', async () => {
    const env = createSyntheticEnv();
    const { dms } = await postTextAndDrain({
      text: 'how much do influencers earn',
      env,
      tctx: createTestContext(),
    });
    assert.ok(!dms[0].message.text.includes('₹199'));
  });
});

describe('Phase 2 recommendations — intent parsing', () => {
  it('extracts niche, follower minimum, and rating intent', () => {
    assert.deepEqual(parseRecommendIntent('Suggest an influencer.'), {
      niche: null,
      minFollowers: 0,
      wantsRated: false,
    });
    assert.deepEqual(
      parseRecommendIntent('I need a beauty influencer with at least 10k followers.'),
      { niche: 'beauty', minFollowers: 10000, wantsRated: false },
    );
    assert.deepEqual(parseRecommendIntent('Suggest a fashion influencer.'), {
      niche: 'fashion',
      minFollowers: 0,
      wantsRated: false,
    });
    const rated = parseRecommendIntent('Show me the best-rated influencers.');
    assert.equal(rated.niche, null);
    assert.equal(rated.wantsRated, true);
    assert.equal(parseRecommendIntent('hello'), null);
    assert.equal(parseRecommendIntent('vendor'), null);
    assert.equal(parseRecommendIntent('what is b8i'), null);
    assert.equal(parseRecommendIntent('zxqv blorp'), null);
  });

  it('parses follower minimums', () => {
    assert.equal(parseFollowerMinimum('at least 10k followers'), 10000);
    assert.equal(parseFollowerMinimum('2m followers'), 2000000);
    assert.equal(parseFollowerMinimum('over 25,000 followers'), 25000);
    assert.equal(parseFollowerMinimum('no numbers here'), 0);
  });

  it('ranks verified reviews first without letting one rating dominate', () => {
    const solo = { id: 'solo', avg_rating: 4.9, rating_count: 1, followers: 8000 };
    const proven = { id: 'proven', avg_rating: 4.7, rating_count: 25, followers: 9000 };
    const unrated = { id: 'unrated', followers: 500000 };
    const ranked = rankCreators([solo, unrated, proven]).map((r) => r.id);
    assert.deepEqual(ranked, ['proven', 'solo', 'unrated']);
    assert.deepEqual(rankCreators([]), []);
  });

  it('formats cards from verified fields only', () => {
    const card = formatCreatorCard({
      full_name: 'Aria',
      instagram_username: 'aria_style',
      niche: 'fashion',
      followers: 120000,
      instagram_url: 'https://www.instagram.com/aria_style/',
      phone: '+91-99999-99999',
      email: 'aria@example.com',
    });
    assert.ok(card.includes('Aria'));
    assert.ok(card.includes('120,000 followers'));
    assert.ok(card.includes('https://www.instagram.com/aria_style/'));
    assert.ok(!card.includes('99999'));
    assert.ok(!card.includes('aria@example.com'));
    assert.ok(!card.includes('★'));
    const rated = formatCreatorCard({
      full_name: 'Bea',
      avg_rating: 4.7,
      rating_count: 25,
    });
    assert.ok(rated.includes('★ 4.7 (25 reviews)'));
    const bare = formatCreatorCard({ full_name: 'No Link' });
    assert.ok(!bare.includes('https://'));
  });
});

describe('Phase 2 recommendations — end to end', () => {
  async function seed(env, id, record) {
    await env.INSTAGRAM_CONVERSATIONS.put(
      `INFLUENCER:${id}`,
      JSON.stringify({
        instagram_user_id: id,
        verification_status: 'APPROVED',
        subscription_status: 'active',
        ...record,
      }),
    );
  }

  async function postRecommend(env, sender, text) {
    return postTextAndDrain({
      text,
      env,
      tctx: createTestContext(),
      senderId: sender ?? `reco_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    });
  }

  it('pre-authorization: counts and niche mix, never identities', async () => {
    const env = createSyntheticEnv();
    await seed(env, 'c_aria', { full_name: 'Aria', instagram_username: 'aria_style', niche: 'fashion', followers: 120000 });
    await seed(env, 'c_bella', { full_name: 'Bella', instagram_username: 'bella_beauty', niche: 'beauty', followers: 45000 });
    await seed(env, 'c_coco', { full_name: 'Coco', instagram_username: 'coco_creates', niche: 'fashion', followers: 8000 });
    const { dms } = await postRecommend(env, null, 'Suggest an influencer.');
    assert.equal(dms.length, 1);
    const text = dms[0].message.text;
    assert.match(text, /I found 3 eligible creators/);
    assert.match(text, /stay private until your campaign is active/);
    assert.ok(text.includes('fashion (2)'));
    assert.ok(text.includes('beauty (1)'));
    for (const leak of ['Aria', 'Bella', 'Coco', 'aria_style', '120,000', '45,000', 'instagram.com']) {
      assert.ok(!text.includes(leak), leak);
    }
    assert.match(text, /narrow it down/);
    assert.match(text, /Suggestions only/);
  });

  it('excludes unapproved and inactive creators from the count', async () => {
    const env = createSyntheticEnv();
    await seed(env, 'c_ok', { full_name: 'Ok', niche: 'tech', followers: 50000 });
    await seed(env, 'c_pending', { full_name: 'Pending', niche: 'tech', followers: 999000, verification_status: 'PENDING' });
    await seed(env, 'c_expired', { full_name: 'Expired', niche: 'tech', followers: 888000, subscription_status: 'expired' });
    const { dms } = await postRecommend(env, null, 'Suggest a tech influencer.');
    const text = dms[0].message.text;
    assert.match(text, /I found 1 eligible tech creator/);
    for (const leak of ['Ok', 'Pending', 'Expired', '999', '888']) {
      assert.ok(!text.includes(leak), leak);
    }
  });

  it('best-rated requests get honesty, never fabricated ratings', async () => {
    const env = createSyntheticEnv();
    await seed(env, 'c_a', { full_name: 'Ann', niche: 'beauty', followers: 30000 });
    const { dms } = await postRecommend(env, null, 'Show me the best-rated influencers.');
    const text = dms[0].message.text;
    assert.match(text, /don't have verified creator ratings yet/);
    assert.match(text, /I found 1 eligible creator in total/);
    assert.ok(!text.includes('★'));
    assert.ok(!text.includes('4.'));
    assert.ok(!text.includes('Top-rated'));
    assert.ok(!text.includes('best-rated'));
    assert.ok(!text.includes('Ann'));
  });

  it('filters by niche and follower minimum, reporting only the count', async () => {
    const env = createSyntheticEnv();
    await seed(env, 'c_b', { full_name: 'Bea', niche: 'beauty', followers: 45000 });
    await seed(env, 'c_small', { full_name: 'Small', niche: 'beauty', followers: 4000 });
    await seed(env, 'c_f', { full_name: 'Fay', niche: 'fashion', followers: 200000 });
    const { dms } = await postRecommend(
      env,
      null,
      'I need a beauty influencer with at least 10k followers.',
    );
    const text = dms[0].message.text;
    // Only Bea passes both filters, but pre-authorization reveals no names.
    assert.match(text, /I found 1 eligible beauty creator/);
    for (const leak of ['Bea', 'Small', 'Fay', '45,000', '200,000']) {
      assert.ok(!text.includes(leak), leak);
    }
  });

  it('matches fashion 10k matrix: strings, fallbacks, and exclusions', async () => {
    const env = createSyntheticEnv();
    await seed(env, 'm_num', { full_name: 'Numa', niche: 'fashion', followers: 15000 });
    await seed(env, 'm_str', { full_name: 'Stria', niche: 'fashion', followers: '25000' });
    await seed(env, 'm_sub', { full_name: 'Subby', niche: 'fashion', verification_followers_at_submission: 12000 });
    await seed(env, 'm_low', { full_name: 'Lowa', niche: 'fashion', followers: 9000 });
    await seed(env, 'm_food', { full_name: 'Fuda', niche: 'food', followers: 50000 });
    await seed(env, 'm_none', { full_name: 'Nonia', niche: 'fashion' });
    await seed(env, 'm_pend', { full_name: 'Penda', niche: 'fashion', followers: 100000, subscription_status: 'pending_admin_approval' });
    const { dms } = await postRecommend(env, null, 'Suggest a fashion influencer with at least 10k followers.');
    const text = dms[0].message.text;
    // Numa + Stria + Subby match (count proves the same filtering); no names leak.
    assert.match(text, /I found 3 eligible fashion creators/);
    for (const name of ['Numa', 'Stria', 'Subby', 'Lowa', 'Fuda', 'Nonia', 'Penda']) {
      assert.ok(!text.includes(name), name);
    }
  });

  it('reads follower counts from numbers, strings, and the submission fallback', () => {
    assert.equal(creatorFollowers({ followers: 15000 }), 15000);
    assert.equal(creatorFollowers({ followers: '25000' }), 25000);
    assert.equal(creatorFollowers({ followers: '15,000' }), 15000);
    assert.equal(creatorFollowers({ verification_followers_at_submission: 12000 }), 12000);
    assert.equal(creatorFollowers({}), 0);
    assert.equal(creatorFollowers({ followers: 'not a number' }), 0);
  });

  it('explicit recommendation wins over generic campaign steps', async () => {
    const env = createSyntheticEnv();
    await seed(env, 'c_x', { full_name: 'Xen', niche: 'fitness', followers: 22000 });
    const { dms } = await postRecommend(env, null, 'Recommend influencers for my campaign.');
    assert.match(dms[0].message.text, /I found 1 eligible creator/);
    assert.ok(!dms[0].message.text.includes('Xen'));
    assert.ok(!dms[0].message.text.includes('To create a campaign'));
  });

  it('answers honestly when nothing matches', async () => {
    const env = createSyntheticEnv();
    await seed(env, 'c_y', { full_name: 'Yara', niche: 'food', followers: 9000 });
    const { dms } = await postRecommend(env, null, 'Suggest a gaming influencer with at least 5m followers.');
    assert.match(dms[0].message.text, /couldn't find eligible creators/);
    assert.ok(!dms[0].message.text.includes('•'));
  });

  it('never exposes private contact or payment fields', async () => {
    const env = createSyntheticEnv();
    await seed(env, 'c_p', {
      full_name: 'Pam',
      niche: 'travel',
      followers: 77000,
      phone: '+91-11111-22222',
      email: 'pam-private@example.com',
      verification_screenshot: 'https://cdn.example.com/secret.jpg',
      bank_account_number: '999000111222',
    });
    const { dms } = await postRecommend(env, null, 'Suggest a travel influencer.');
    const text = dms[0].message.text;
    for (const leak of ['Pam', '11111', 'pam-private', 'cdn.example.com', '999000111222', '77,000']) {
      assert.ok(!text.includes(leak), leak);
    }
    assert.match(text, /I found 1 eligible travel creator/);
  });

  it('creates no campaigns, registrations, or invitations', async () => {
    const env = createSyntheticEnv();
    await seed(env, 'c_z', { full_name: 'Zed', niche: 'tech', followers: 15000 });
    await postRecommend(env, null, 'Suggest a tech influencer.');
    assert.equal(env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('REGISTRATION:').length, 0);
    assert.equal(env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('CAMPAIGN:').length, 0);
    assert.equal(env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('INVITE:').length, 0);
  });

  it('parses post-noun niches like "for a food promotion"', () => {
    assert.equal(
      parseRecommendIntent('Find creators for a food promotion.').niche,
      'food',
    );
    assert.equal(
      parseRecommendIntent('Recommend influencers for my campaign.').niche,
      null,
    );
    assert.equal(
      parseRecommendIntent('Suggest a fashion influencer.').niche,
      'fashion',
    );
  });

  it('defers find/payout/pricing questions to the existing branches', () => {
    assert.equal(
      parseRecommendIntent('I want to promote my brand and find influencers'),
      null,
    );
    assert.equal(
      parseRecommendIntent('how do I find influencers'),
      null,
    );
    assert.equal(parseRecommendIntent('show me influencer payouts'), null);
    assert.equal(
      parseRecommendIntent('find the price of influencer membership'),
      null,
    );
    assert.equal(
      parseRecommendIntent('I need to register as an influencer'),
      null,
    );
    assert.ok(parseRecommendIntent('Find approved influencers.'));
    assert.ok(parseRecommendIntent('Find a fashion influencer.'));
  });
});

describe('Quick replies — regression', () => {
  it('VENDOR quick reply starts vendor registration', async () => {
    const env = createSyntheticEnv();
    const sender = `qr_vendor_${Date.now()}`;
    const before = isolation.snapshot();
    const sentBefore = isolation.sentMessages.length;
    const tctx = createTestContext();
    const res = await worker.fetch(
      buildInstagramWebhookRequest({
        payload: {
          object: 'instagram',
          entry: [
            {
              id: 'test_entry_1',
              messaging: [
                {
                  sender: { id: sender },
                  recipient: { id: 'test_page_1' },
                  message: {
                    mid: `mid_qr_${sender}`,
                    text: "I'm a Vendor",
                    quick_reply: { payload: 'VENDOR' },
                  },
                },
              ],
            },
          ],
        },
        secret: env.INSTAGRAM_APP_SECRET,
      }),
      env,
      tctx.ctx,
    );
    assert.equal(res.status, 200);
    await drainWaitUntil(tctx);
    const after = isolation.snapshot();
    assert.equal(after.blockedFailClosed - before.blockedFailClosed, 0);
    const dms = messagesFor(isolation.sentMessages.slice(sentBefore), sender);
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /campaign/);
    assert.equal(
      env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('REGISTRATION:').length,
      1,
    );
  });
});

describe('Payout DM formatting — regression', () => {
  it('mark-paid completion DM uses real line breaks', async () => {
    const env = createSyntheticEnv({ ADMIN_API_KEY: 'TEST_ONLY_admin_key' });
    await env.INSTAGRAM_CONVERSATIONS.put(
      'MPAY:cmp1:inf1',
      JSON.stringify({
        status: 'READY',
        campaign_id: 'cmp1',
        influencer_instagram_user_id: 'inf1',
        campaign_title: 'Test Campaign',
        amount: 500,
      }),
    );
    const before = isolation.snapshot();
    const sentBefore = isolation.sentMessages.length;
    const tctx = createTestContext();
    const res = await worker.fetch(
      new Request(`${TEST_ORIGIN}/admin/payouts/mark-paid`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'TEST_ONLY_admin_key',
        },
        body: JSON.stringify({
          record_id: 'MPAY:cmp1:inf1',
          payment_reference: 'TEST_ONLY_UTR1',
        }),
      }),
      env,
      tctx.ctx,
    );
    assert.equal(res.status, 200);
    await drainWaitUntil(tctx);
    const after = isolation.snapshot();
    assert.equal(after.blockedFailClosed - before.blockedFailClosed, 0);
    const dms = messagesFor(isolation.sentMessages.slice(sentBefore), 'inf1');
    assert.equal(dms.length, 1);
    const text = dms[0].message.text;
    assert.match(text, /Manual payout completed/);
    assert.ok(text.includes('\n'), 'DM must contain real line breaks');
    assert.ok(
      !text.includes('\\n'),
      'DM must not contain literal backslash-n sequences',
    );
  });

  it('payout-pay completion DM uses real line breaks', async () => {
    const env = createSyntheticEnv();
    await env.INSTAGRAM_CONVERSATIONS.put(
      'MPAY:cmp2:inf2',
      JSON.stringify({
        status: 'READY',
        campaign_id: 'cmp2',
        influencer_instagram_user_id: 'inf2',
        campaign_title: 'Test Campaign 2',
        amount: 750,
      }),
    );
    await env.INSTAGRAM_CONVERSATIONS.put(
      'ADMIN_PAYOUT_SESSION:TEST_ONLY_sess1',
      JSON.stringify({
        record_id: 'MPAY:cmp2:inf2',
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    );
    const before = isolation.snapshot();
    const sentBefore = isolation.sentMessages.length;
    const tctx = createTestContext();
    const res = await worker.fetch(
      new Request(`${TEST_ORIGIN}/admin/payouts/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          session_token: 'TEST_ONLY_sess1',
          payment_reference: 'TEST_ONLY_UTR2',
        }).toString(),
      }),
      env,
      tctx.ctx,
    );
    assert.equal(res.status, 200);
    await drainWaitUntil(tctx);
    const after = isolation.snapshot();
    assert.equal(after.blockedFailClosed - before.blockedFailClosed, 0);
    const dms = messagesFor(isolation.sentMessages.slice(sentBefore), 'inf2');
    assert.equal(dms.length, 1);
    const text = dms[0].message.text;
    assert.match(text, /Manual payout completed/);
    assert.ok(text.includes('\n'), 'DM must contain real line breaks');
    assert.ok(
      !text.includes('\\n'),
      'DM must not contain literal backslash-n sequences',
    );
  });
});

describe('Friendly chatbot — casual conversation', () => {
  it('lunch question gets a contextual reply, not the generic fallback', async () => {
    const env = createSyntheticEnv();
    const sender = `casual_${Date.now()}_1`;
    const first = await postTextAndDrain({
      text: 'Have u had your lunch?',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.equal(first.dms.length, 1);
    assert.match(first.dms[0].message.text, /AI/i);
    assert.ok(!first.dms[0].message.text.includes('creator recommendations'));
  });

  it('Tenglish lunch question gets a Tenglish reply', async () => {
    const env = createSyntheticEnv();
    const sender = `casual_${Date.now()}_2`;
    const { dms } = await postTextAndDrain({
      text: 'Tinnava?',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /nenu AI/i);
    assert.ok(!dms[0].message.text.includes('creator recommendations'));
  });

  it('how-is-your-day gets a warm reply with no button spam', async () => {
    const env = createSyntheticEnv();
    const sender = `casual_${Date.now()}_3`;
    const { dms } = await postTextAndDrain({
      text: 'Hello how is your day?',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /day/i);
    assert.ok(!dms[0].message.text.includes('creator recommendations'));
    assert.equal((dms[0].message.quick_replies ?? []).length, 0);
  });

  it('thanks gets a short warm reply', async () => {
    const env = createSyntheticEnv();
    const sender = `casual_${Date.now()}_4`;
    const { dms } = await postTextAndDrain({
      text: 'Thank you',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /welcome/i);
    assert.ok(!dms[0].message.text.includes('What brings you here'));
  });

  it('falls back to English when a translation is missing', async () => {
    const env = createSyntheticEnv();
    const { dms } = await postTextAndDrain({
      text: 'Cuéntame un chiste',
      env,
      tctx: createTestContext(),
    });
    assert.match(dms[0].message.text, /ladder|engagement/i);
  });

  it('casual chat stays deterministic with the model enabled', async () => {
    const env = createSyntheticEnv({
      META_MODEL_API_ENABLED: '1',
      META_MODEL_API_KEY: 'TEST_ONLY_model_key',
      META_MODEL_SPEND_CAP_ND: '1000000000',
      MODEL_BUDGET: {
        idFromName: () => 'test-id',
        get: () => ({
          fetch: async () =>
            new Response(JSON.stringify({ ok: true, granted: true }), {
              status: 200,
            }),
        }),
      },
    });
    const { dms } = await postTextAndDrain({
      text: 'Thanks a lot!',
      env,
      tctx: createTestContext(),
    });
    assert.match(dms[0].message.text, /welcome|anytime/i);
  });
});

describe('Friendly chatbot — intent classification', () => {
  it('classifies casual intents', () => {
    assert.equal(classifyChatIntent('hey there'), 'greeting');
    assert.equal(classifyChatIntent('hola amigo'), 'greeting');
    assert.equal(classifyChatIntent('Have u had your lunch?'), 'lunch');
    assert.equal(classifyChatIntent('Tinnava?'), 'lunch');
    assert.equal(classifyChatIntent('Hello how is your day?'), 'howru');
    assert.equal(classifyChatIntent('Ela unnavu?'), 'howru');
    assert.equal(classifyChatIntent('Thank you so much'), 'thanks');
    assert.equal(classifyChatIntent('dhanyavadalu'), 'thanks');
    assert.equal(classifyChatIntent('bye, see you'), 'bye');
    assert.equal(classifyChatIntent('tell me a joke'), 'fun');
  });

  it('classifies marketplace intents', () => {
    assert.equal(classifyChatIntent('I want to become a vendor'), 'vendor_reg');
    assert.equal(
      classifyChatIntent('Nenu influencer ga register avvali'),
      'influencer_reg',
    );
    assert.equal(classifyChatIntent('Naaku influencers kavali'), 'want');
    assert.equal(
      classifyChatIntent('I want to promote my clothing brand'),
      'campaign_plan',
    );
    assert.equal(classifyChatIntent('What are your plans?'), 'membership');
    assert.equal(
      classifyChatIntent('Where is my approval status?'),
      'account_help',
    );
    assert.equal(classifyChatIntent('speak in telugu'), 'lang_switch');
    assert.equal(classifyChatIntent('hindi'), 'lang_switch');
  });

  it('returns null for unclear and pinned fallback messages', () => {
    assert.equal(
      classifyChatIntent('Can u help me with something different??'),
      null,
    );
    assert.equal(
      classifyChatIntent('Can you help me with something difficult?'),
      null,
    );
    assert.equal(classifyChatIntent('zxqv blorp snork'), null);
    assert.equal(classifyChatIntent(''), null);
    assert.equal(classifyChatIntent('x'.repeat(501)), null);
  });

  it('guards short triggers with word boundaries', () => {
    assert.equal(classifyChatIntent('How is your day'), 'howru');
    assert.equal(classifyChatIntent('Can you create an account?'), null);
    assert.equal(classifyChatIntent('Please explain how refunds work'), null);
  });

  it('recognizes confirm and cancel answers', () => {
    assert.equal(classifyChatIntent('yes'), 'brief_confirm');
    assert.equal(classifyChatIntent('yes, create it'), 'brief_confirm');
    assert.equal(classifyChatIntent('no'), 'brief_cancel');
    assert.equal(classifyChatIntent('not now'), 'brief_cancel');
    assert.equal(classifyChatIntent('yesterday'), null);
    assert.equal(classifyChatIntent('normal'), null);
    assert.equal(classifyChatIntent('knowledge'), null);
  });
});

describe('Friendly chatbot — language detection', () => {
  it('detects scripts and transliterated languages', () => {
    assert.equal(detectChatLanguage('నమస్తే'), 'te');
    assert.equal(detectChatLanguage('नमस्ते, कैसे हो?'), 'hi');
    assert.equal(detectChatLanguage('Tinnava?'), 'tenglish');
    assert.equal(detectChatLanguage('Naaku influencers kavali'), 'tenglish');
    assert.equal(detectChatLanguage('Mujhe influencers chahiye'), 'hi');
    assert.equal(detectChatLanguage('Hola, ¿cómo estás?'), 'es');
    assert.equal(detectChatLanguage('Olá, tudo bem?'), 'pt');
    assert.equal(detectChatLanguage('Hello there'), 'en');
  });

  it('falls back to preference then English', () => {
    assert.equal(detectChatLanguage('Hello', 'es'), 'es');
    assert.equal(detectChatLanguage('Hello', 'xx'), 'en');
    assert.equal(detectChatLanguage('Hello'), 'en');
  });
});

describe('Friendly chatbot — Tenglish marketplace intents', () => {
  it('kavali asks for a niche, then recommends from real records', async () => {
    const env = createSyntheticEnv();
    await env.INSTAGRAM_CONVERSATIONS.put(
      'INFLUENCER:t_fash',
      JSON.stringify({
        instagram_user_id: 't_fash',
        verification_status: 'APPROVED',
        subscription_status: 'active',
        full_name: 'Meena',
        niche: 'fashion',
        followers: 25000,
      }),
    );
    const sender = `teng_${Date.now()}`;
    const first = await postTextAndDrain({
      text: 'Naaku influencers kavali',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.match(first.dms[0].message.text, /Niche enti/);
    const second = await postTextAndDrain({
      text: 'fashion',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.match(second.newDms[0].message.text, /I found 1 eligible fashion creator/);
    assert.ok(!second.newDms[0].message.text.includes('Meena'));
  });

  it('Tenglish influencer registration reaches the form', async () => {
    const env = createSyntheticEnv();
    const { dms } = await postTextAndDrain({
      text: 'Nenu influencer ga register avvali',
      env,
      tctx: createTestContext(),
    });
    assert.match(dms[0].message.text, /creator profile|form/i);
    assert.equal(
      env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('REGISTRATION:').length,
      1,
    );
  });

  it('Tenglish campaign message keeps existing vendor-steps routing', async () => {
    const env = createSyntheticEnv();
    const { dms } = await postTextAndDrain({
      text: 'Campaign create cheyali',
      env,
      tctx: createTestContext(),
    });
    assert.match(dms[0].message.text, /To create a campaign on B8i as a vendor/);
  });
});

describe('Friendly chatbot — campaign brief flow', () => {
  it('plans a brief across turns and confirms to the vendor form', async () => {
    const env = createSyntheticEnv();
    const sender = `brief_${Date.now()}`;
    const first = await postTextAndDrain({
      text: 'I want to promote my clothing brand',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.match(first.dms[0].message.text, /plan this/i);
    assert.match(first.dms[0].message.text, /niche/i);
    const second = await postTextAndDrain({
      text: 'fashion',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.match(second.newDms[0].message.text, /budget/i);
    const third = await postTextAndDrain({
      text: '₹50000',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.match(third.newDms[0].message.text, /campaign brief/i);
    assert.match(third.newDms[0].message.text, /clothing/i);
    const fourth = await postTextAndDrain({
      text: 'yes',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.match(fourth.newDms[0].message.text, /campaign/i);
    assert.equal(
      env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('REGISTRATION:').length,
      1,
    );
    assert.equal(
      env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('CAMPAIGN:').length,
      0,
    );
  });

  it('advice alone creates nothing and cancel clears the brief', async () => {
    const env = createSyntheticEnv();
    const sender = `brief2_${Date.now()}`;
    await postTextAndDrain({
      text: 'Give me marketing strategy advice',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.equal(
      env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('CAMPAIGN:').length,
      0,
    );
    assert.equal(
      env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('REGISTRATION:').length,
      0,
    );
    const cancel = await postTextAndDrain({
      text: 'cancel',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.match(cancel.newDms[0].message.text, /cleared/i);
    const ctx = await getChatContext(env, sender);
    assert.equal(ctx.pendingBrief, undefined);
  });
});

describe('Friendly chatbot — contextual buttons', () => {
  async function postPayload(env, sender, text, payload) {
    const before = isolation.snapshot();
    const sentBefore = isolation.sentMessages.length;
    const tctx = createTestContext();
    const res = await worker.fetch(
      buildInstagramWebhookRequest({
        payload: {
          object: 'instagram',
          entry: [
            {
              id: 'test_entry_1',
              messaging: [
                {
                  sender: { id: sender },
                  recipient: { id: 'test_page_1' },
                  message: {
                    mid: `mid_btn_${sender}_${Date.now()}_${Math.floor(Math.random() * 1e9)}`,
                    text,
                    quick_reply: { payload },
                  },
                },
              ],
            },
          ],
        },
        secret: env.INSTAGRAM_APP_SECRET,
      }),
      env,
      tctx.ctx,
    );
    assert.equal(res.status, 200);
    await drainWaitUntil(tctx);
    const after = isolation.snapshot();
    assert.equal(after.blockedFailClosed - before.blockedFailClosed, 0);
    return messagesFor(isolation.sentMessages.slice(sentBefore), sender);
  }

  it('FIND_INFLUENCERS asks for a niche, then recommends', async () => {
    const env = createSyntheticEnv();
    await env.INSTAGRAM_CONVERSATIONS.put(
      'INFLUENCER:b_food',
      JSON.stringify({
        instagram_user_id: 'b_food',
        verification_status: 'APPROVED',
        subscription_status: 'active',
        full_name: 'Ravi',
        niche: 'food',
        followers: 40000,
      }),
    );
    const sender = `btn_${Date.now()}_1`;
    const dms = await postPayload(env, sender, 'Find Influencers', 'FIND_INFLUENCERS');
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /niche/i);
    const follow = await postTextAndDrain({
      text: 'food',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.match(follow.newDms[0].message.text, /I found 1 eligible food creator/);
    assert.ok(!follow.newDms[0].message.text.includes('Ravi'));
  });

  it('PLAN_CAMPAIGN starts the brief', async () => {
    const env = createSyntheticEnv();
    const dms = await postPayload(
      env,
      `btn_${Date.now()}_2`,
      'Plan a Campaign',
      'PLAN_CAMPAIGN',
    );
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /promoting/i);
  });

  it('VIEW_PLANS sends membership text', async () => {
    const env = createSyntheticEnv();
    const dms = await postPayload(
      env,
      `btn_${Date.now()}_3`,
      'View Membership Plans',
      'VIEW_PLANS',
    );
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /Starter/);
    assert.deepEqual(
      (dms[0].message.quick_replies ?? []).map((r) => r.payload),
      ['INFLUENCER'],
    );
  });

  it('PAYMENT_HELP sends the clarify question', async () => {
    const env = createSyntheticEnv();
    const dms = await postPayload(
      env,
      `btn_${Date.now()}_4`,
      'Help with Payments',
      'PAYMENT_HELP',
    );
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /guess about payments/);
  });
});

describe('Friendly chatbot — webhook redelivery', () => {
  it('duplicate delivery of the same mid replies once', async () => {
    const env = createSyntheticEnv();
    const sender = `dedup_${Date.now()}`;
    const mid = `mid_dup_${sender}`;
    const first = await postTextAndDrain({
      text: 'Thank you',
      env,
      tctx: createTestContext(),
      senderId: sender,
      mid,
    });
    assert.equal(first.newDms.length, 1);
    const second = await postTextAndDrain({
      text: 'Thank you',
      env,
      tctx: createTestContext(),
      senderId: sender,
      mid,
    });
    assert.equal(second.newDms.length, 0);
  });
});

describe('Friendly chatbot — conversation context', () => {
  it('stores language and turns, then varies repeats', async () => {
    const env = createSyntheticEnv();
    const sender = `ctx_${Date.now()}`;
    await postTextAndDrain({
      text: 'Tinnava?',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    const ctx = await getChatContext(env, sender);
    assert.equal(ctx.lang, 'tenglish');
    assert.equal(ctx.turns, 1);
    const again = await postTextAndDrain({
      text: 'Tinnava?',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.match(again.newDms[0].message.text, /baga tinnava/);
  });

  it('corrupt context fails open to a normal reply', async () => {
    const env = createSyntheticEnv();
    const sender = `ctxbad_${Date.now()}`;
    await env.INSTAGRAM_CONVERSATIONS.put(`CHATCTX:${sender}`, '{not-json');
    const { dms } = await postTextAndDrain({
      text: 'Thank you',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.match(dms[0].message.text, /welcome/i);
  });
});

describe('Global chatbot — expanded intent classification', () => {
  it('handles ambiguous lunch forms without greeting hijacks', () => {
    assert.equal(classifyChatIntent('Tina'), 'lunch');
    assert.equal(classifyChatIntent('Tindi?'), 'lunch');
    assert.equal(classifyChatIntent("Hi, I'm Tina"), 'greeting');
    assert.equal(classifyChatIntent('Thinnava?'), 'lunch');
    assert.equal(classifyChatIntent('Argentina routine'), null);
  });

  it('clarifies bare registration and catches support variants', () => {
    assert.equal(classifyChatIntent('register'), 'register_clarify');
    assert.equal(classifyChatIntent('sign up'), 'register_clarify');
    assert.equal(classifyChatIntent('talk to support'), 'support');
    assert.equal(classifyChatIntent('support number?'), 'support');
    assert.equal(classifyChatIntent('madad'), 'support');
    assert.equal(classifyChatIntent('necesito soporte'), 'support');
    assert.equal(classifyChatIntent('mere paise kab aayenge'), 'payout_any');
    assert.equal(classifyChatIntent('mi pago'), 'payment_any');
    assert.equal(classifyChatIntent('payment'), 'payment_any');
  });

  it('routes multilingual pricing and campaign triggers', () => {
    assert.equal(classifyChatIntent('cuánto cuesta'), 'membership');
    assert.equal(classifyChatIntent('kitna'), 'membership');
    assert.equal(classifyChatIntent('dhara enti'), 'membership');
    assert.equal(classifyChatIntent('what do you charge?'), 'membership');
    assert.equal(classifyChatIntent('campanha nova'), 'campaign_plan');
    assert.equal(classifyChatIntent('promover mi marca'), 'campaign_plan');
    assert.equal(classifyChatIntent('Quero ser vendedor'), 'vendor_reg');
    assert.equal(classifyChatIntent('influenciador'), 'influencer_reg');
  });

  it('matches script-language intents', () => {
    assert.equal(classifyChatIntent('నమస్తే'), 'greeting');
    assert.equal(classifyChatIntent('ధన్యవాదాలు'), 'thanks');
    assert.equal(classifyChatIntent('నాకు influencers కావాలి'), 'want');
    assert.equal(classifyChatIntent('नमस्ते'), 'greeting');
    assert.equal(classifyChatIntent('कैसे हो?'), 'howru');
    assert.equal(classifyChatIntent('Mujhe influencers चाहिए'), 'want');
  });

  it('keeps pinned fallbacks and guards intact', () => {
    assert.equal(
      classifyChatIntent('Can u help me with something different??'),
      null,
    );
    assert.equal(
      classifyChatIntent('Can you help me with something difficult?'),
      null,
    );
    assert.equal(classifyChatIntent('zxqv blorp'), null);
    assert.equal(classifyChatIntent('How is your day'), 'howru');
    assert.equal(classifyChatIntent('Can you create an account?'), null);
  });
});

describe('Global chatbot — expanded language detection', () => {
  it('detects variants and avoids known collisions', () => {
    assert.equal(detectChatLanguage('Naku telusu'), 'tenglish');
    assert.equal(detectChatLanguage('Thinava?'), 'tenglish');
    assert.equal(detectChatLanguage('Mere paise kab aayenge'), 'hi');
    assert.equal(detectChatLanguage('Quanto custa?'), 'pt');
    assert.equal(detectChatLanguage('Dhruv dhara enti'), 'tenglish');
    assert.equal(detectChatLanguage('branding tips'), 'en');
    assert.equal(detectChatLanguage('What are your plans?'), 'en');
  });

  it('documents genuinely unsupported input honestly', async () => {
    const env = createSyntheticEnv();
    const { dms } = await postTextAndDrain({
      text: 'Bonjour, comment ça va?',
      env,
      tctx: createTestContext(),
    });
    assert.match(dms[0].message.text, /Welcome to B8i/);
  });
});

describe('Global chatbot — multilingual end to end', () => {
  it('variant spelling plus business context still recommends', async () => {
    const env = createSyntheticEnv();
    await env.INSTAGRAM_CONVERSATIONS.put(
      'INFLUENCER:g_tech',
      JSON.stringify({
        instagram_user_id: 'g_tech',
        verification_status: 'APPROVED',
        subscription_status: 'active',
        full_name: 'Kiran',
        niche: 'tech',
        followers: 30000,
      }),
    );
    const sender = `gx_${Date.now()}`;
    const first = await postTextAndDrain({
      text: 'Naku oka influencer kavali na business ki',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.match(first.dms[0].message.text, /Niche enti/);
    const second = await postTextAndDrain({
      text: 'tech',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.match(second.newDms[0].message.text, /I found 1 eligible tech creator/);
    assert.ok(!second.newDms[0].message.text.includes('Kiran'));
  });

  it('uses niche and minimum already provided, without re-asking', async () => {
    const env = createSyntheticEnv();
    for (const [id, name, followers] of [
      ['g_small', 'Chotu', 8000],
      ['g_big', 'Pedda', 25000],
    ]) {
      await env.INSTAGRAM_CONVERSATIONS.put(
        `INFLUENCER:${id}`,
        JSON.stringify({
          instagram_user_id: id,
          verification_status: 'APPROVED',
          subscription_status: 'active',
          full_name: name,
          niche: 'food',
          followers,
        }),
      );
    }
    const { dms } = await postTextAndDrain({
      text: 'Naaku food influencers with 10k kavali',
      env,
      tctx: createTestContext(),
    });
    // Only Pedda passes the 10k minimum (count proves it); no names leak.
    assert.match(dms[0].message.text, /I found 1 eligible food creator/);
    assert.ok(!dms[0].message.text.includes('Pedda'));
    assert.ok(!dms[0].message.text.includes('Chotu'));
    assert.ok(!dms[0].message.text.includes('Niche enti'));
  });

  it('bare register asks which role with working buttons', async () => {
    const env = createSyntheticEnv();
    const { dms } = await postTextAndDrain({
      text: 'register',
      env,
      tctx: createTestContext(),
    });
    assert.match(dms[0].message.text, /vendor or an influencer/);
    assert.deepEqual(
      (dms[0].message.quick_replies ?? []).map((r) => r.payload),
      ['VENDOR', 'INFLUENCER'],
    );
  });

  it('support variants return the configured contact', async () => {
    for (const text of ['talk to support', 'support number?', 'madad']) {
      const env = createSyntheticEnv();
      const { dms } = await postTextAndDrain({
        text,
        env,
        tctx: createTestContext(),
      });
      assert.match(dms[0].message.text, /support/i, text);
    }
  });

  it('non-English payout and payment reuse verified explainers', async () => {
    const payoutEnv = createSyntheticEnv();
    const payout = await postTextAndDrain({
      text: 'mere paise kab aayenge',
      env: payoutEnv,
      tctx: createTestContext(),
    });
    assert.match(payout.dms[0].message.text, /Here's how B8i payouts work/);
    const payEnv = createSyntheticEnv();
    const pay = await postTextAndDrain({
      text: '¿dónde está mi pago?',
      env: payEnv,
      tctx: createTestContext(),
    });
    assert.match(pay.dms[0].message.text, /don't want to guess about payments/);
  });

  it('non-English pricing returns verified plans', async () => {
    for (const text of ['quanto custa a assinatura?', 'sadasyata kitna hai']) {
      const env = createSyntheticEnv();
      const { dms } = await postTextAndDrain({
        text,
        env,
        tctx: createTestContext(),
      });
      assert.ok(dms[0].message.text.includes('₹199'), text);
      assert.ok(dms[0].message.text.includes('Starter'), text);
    }
  });

  it('script greeting and script want reply in-script', async () => {
    const env = createSyntheticEnv();
    const greet = await postTextAndDrain({
      text: 'నమస్తే',
      env,
      tctx: createTestContext(),
    });
    assert.match(greet.dms[0].message.text, /స్వాగతం/);
    const want = await postTextAndDrain({
      text: 'నాకు influencers కావాలి',
      env,
      tctx: createTestContext(),
    });
    assert.match(want.dms[0].message.text, /Niche ఏది/);
  });

  it('language switch persists to the next reply', async () => {
    const env = createSyntheticEnv();
    const sender = `lang_${Date.now()}`;
    await postTextAndDrain({
      text: 'speak hindi',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    const next = await postTextAndDrain({
      text: 'thank you',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.match(next.newDms[0].message.text, /स्वागत/);
  });

  it('explicit intents win over a pending brief, which then resumes', async () => {
    const env = createSyntheticEnv();
    const sender = `stale_${Date.now()}`;
    await postTextAndDrain({
      text: 'promote my soap',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    const thanks = await postTextAndDrain({
      text: 'thanks',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.match(thanks.newDms[0].message.text, /welcome|anytime/i);
    const resume = await postTextAndDrain({
      text: 'fashion',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.match(resume.newDms[0].message.text, /budget/i);
  });

  it('vendor account attempting influencer registration gets the rule, not fallback', async () => {
    const env = createSyntheticEnv();
    const sender = `role_${Date.now()}`;
    await env.INSTAGRAM_CONVERSATIONS.put(
      `VENDOR:${sender}`,
      JSON.stringify({ instagram_user_id: sender, status: 'active' }),
    );
    const { dms } = await postTextAndDrain({
      text: 'Nenu influencer ga register avvali',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    assert.match(dms[0].message.text, /already registered as a vendor/);
  });
});

describe('Creator privacy gate — option (b)', () => {
  async function seedCreator(env, id, record) {
    await env.INSTAGRAM_CONVERSATIONS.put(
      `INFLUENCER:${id}`,
      JSON.stringify({
        instagram_user_id: id,
        verification_status: 'APPROVED',
        subscription_status: 'active',
        ...record,
      }),
    );
  }

  async function seedCampaign(env, id, record) {
    await env.INSTAGRAM_CONVERSATIONS.put(
      `CAMPAIGN:${id}`,
      JSON.stringify({ campaign_id: id, ...record }),
    );
  }

  it('authorizes only paid + accepted creators on the sender campaign', async () => {
    const env = createSyntheticEnv();
    const vendor = `pv_${Date.now()}`;
    await seedCampaign(env, 'camp_ok', {
      vendor_instagram_user_id: vendor,
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['pv_yes'],
    });
    await seedCampaign(env, 'camp_unpaid', {
      vendor_instagram_user_id: vendor,
      payment_status: 'PENDING',
      status: 'AWAITING_PAYMENT',
      accepted_influencer_ids: ['pv_no_pay'],
    });
    await seedCampaign(env, 'camp_failed', {
      vendor_instagram_user_id: vendor,
      payment_status: 'FAILED',
      status: 'AWAITING_PAYMENT',
      accepted_influencer_ids: ['pv_no_fail'],
    });
    await seedCampaign(env, 'camp_other', {
      vendor_instagram_user_id: 'someone_else',
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['pv_no_other'],
    });
    await seedCampaign(env, 'camp_noaccept', {
      vendor_instagram_user_id: vendor,
      payment_status: 'CAPTURED',
      status: 'PAID',
      accepted_influencer_ids: [],
      candidate_ids: ['pv_no_candidate'],
    });
    const authorized = await b8iAuthorizedCreatorIds(vendor, env);
    assert.deepEqual([...authorized], ['pv_yes']);
    assert.deepEqual([...(await b8iAuthorizedCreatorIds('stranger', env))], []);
  });

  it('fails closed on corrupt records and missing storage', async () => {
    const env = createSyntheticEnv();
    const vendor = `pc_${Date.now()}`;
    await seedCampaign(env, 'camp_corrupt', {
      vendor_instagram_user_id: vendor,
      payment_status: 'CAPTURED',
      accepted_influencer_ids: 'not-an-array',
    });
    assert.deepEqual([...(await b8iAuthorizedCreatorIds(vendor, env))], []);
    assert.deepEqual([...(await b8iAuthorizedCreatorIds(vendor, {}))], []);
    assert.deepEqual([...(await b8iAuthorizedCreatorIds('', env))], []);
  });

  it('builds a non-identifying niche mix', () => {
    assert.equal(
      b8iNicheMix([
        { niche: 'fashion' },
        { niche: 'food' },
        { niche: 'fashion' },
        { category: 'tech' },
        {},
      ]),
      'fashion (2), food (1), tech (1)',
    );
    assert.equal(b8iNicheMix([]), '');
    assert.equal(
      b8iNicheMix([{ niche: 'a' }, { niche: 'b' }], 1),
      'a (1), and 1 more niche',
    );
  });

  it('post-authorization vendor sees accepted creators only, in ranked order', async () => {
    const env = createSyntheticEnv();
    const vendor = `pa_${Date.now()}`;
    await seedCreator(env, 'pa_big', {
      full_name: 'Bigya',
      instagram_username: 'bigya_style',
      niche: 'fashion',
      followers: 200000,
      instagram_url: 'https://www.instagram.com/bigya_style/',
    });
    await seedCreator(env, 'pa_small', {
      full_name: 'Smala',
      instagram_username: 'smala_style',
      niche: 'fashion',
      followers: 30000,
      instagram_url: 'https://www.instagram.com/smala_style/',
    });
    await seedCreator(env, 'pa_out', {
      full_name: 'Outi',
      instagram_username: 'outi_style',
      niche: 'fashion',
      followers: 500000,
      instagram_url: 'https://www.instagram.com/outi_style/',
    });
    await seedCampaign(env, 'camp_pa', {
      vendor_instagram_user_id: vendor,
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['pa_big', 'pa_small'],
    });
    const { dms } = await postTextAndDrain({
      text: 'Suggest a fashion influencer.',
      env,
      tctx: createTestContext(),
      senderId: vendor,
    });
    const text = dms[0].message.text;
    assert.match(text, /from your active campaigns/);
    assert.ok(text.indexOf('Bigya') < text.indexOf('Smala'));
    assert.ok(text.includes('200,000 followers'));
    assert.ok(text.includes('https://www.instagram.com/bigya_style/'));
    assert.match(text, /Plus 1 more eligible creator/);
    for (const leak of ['Outi', 'outi_style', '500,000']) {
      assert.ok(!text.includes(leak), leak);
    }
  });

  it('post-authorization best-rated shows verified ratings for accepted creators', async () => {
    const env = createSyntheticEnv();
    const vendor = `pr_${Date.now()}`;
    await seedCreator(env, 'pr_rated', {
      full_name: 'Ratia',
      niche: 'beauty',
      followers: 40000,
      avg_rating: 4.8,
      rating_count: 12,
    });
    await seedCampaign(env, 'camp_pr', {
      vendor_instagram_user_id: vendor,
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['pr_rated'],
    });
    const { dms } = await postTextAndDrain({
      text: 'Show me the best-rated influencers.',
      env,
      tctx: createTestContext(),
      senderId: vendor,
    });
    const text = dms[0].message.text;
    assert.match(text, /Top-rated eligible creators from your active campaigns/);
    assert.ok(text.includes('Ratia'));
    assert.ok(text.includes('★ 4.8 (12 reviews)'));
  });

  it('unpaid or unaccepted campaigns stay pre-authorization', async () => {
    for (const [label, campaign] of [
      ['unpaid', { payment_status: 'PENDING', status: 'AWAITING_PAYMENT', accepted_influencer_ids: ['pu_1'] }],
      ['failed', { payment_status: 'FAILED', status: 'AWAITING_PAYMENT', accepted_influencer_ids: ['pu_1'] }],
      ['not-accepted', { payment_status: 'CAPTURED', status: 'PAID', accepted_influencer_ids: [], candidate_ids: ['pu_1'] }],
    ]) {
      const env = createSyntheticEnv();
      const vendor = `pu_${Date.now()}_${label}`;
      await seedCreator(env, 'pu_1', { full_name: 'Privya', niche: 'travel', followers: 60000 });
      await seedCampaign(env, 'camp_pu', {
        vendor_instagram_user_id: vendor,
        ...campaign,
      });
      const { dms } = await postTextAndDrain({
        text: 'Suggest a travel influencer.',
        env,
        tctx: createTestContext(),
        senderId: vendor,
      });
      assert.match(dms[0].message.text, /I found 1 eligible travel creator/, label);
      assert.ok(!dms[0].message.text.includes('Privya'), label);
    }
  });

  it('niche mix appears only for unfiltered browsing', async () => {
    const env = createSyntheticEnv();
    await seedCreator(env, 'mx_1', { full_name: 'Mixa', niche: 'food', followers: 10000 });
    const browse = await postTextAndDrain({
      text: 'Suggest an influencer.',
      env,
      tctx: createTestContext(),
    });
    assert.ok(browse.dms[0].message.text.includes('Eligible right now: food (1).'));
    const filtered = await postTextAndDrain({
      text: 'Suggest a food influencer.',
      env,
      tctx: createTestContext(),
    });
    assert.ok(!filtered.dms[0].message.text.includes('Eligible right now:'));
  });
});

describe('Vendor AI match — aggregate-only', () => {
  async function seedVendorToken(env, token) {
    await env.INSTAGRAM_CONVERSATIONS.put(
      `REGISTRATION:${token}`,
      JSON.stringify({
        registration_type: 'vendor',
        used: false,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    );
  }

  async function seedCreator(env, id, record) {
    await env.INSTAGRAM_CONVERSATIONS.put(
      `INFLUENCER:${id}`,
      JSON.stringify({
        instagram_user_id: id,
        verification_status: 'APPROVED',
        subscription_status: 'active',
        ...record,
      }),
    );
  }

  async function postAiMatch(env, body) {
    const before = isolation.snapshot();
    const res = await worker.fetch(
      new Request(`${TEST_ORIGIN}/api/vendor/ai-match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      createTestContext().ctx,
    );
    const after = isolation.snapshot();
    assert.equal(
      after.blockedFailClosed - before.blockedFailClosed,
      0,
      'aggregate availability must not attempt outbound calls',
    );
    return { res, data: await res.json() };
  }

  const campaign = {
    campaign_title: 'Test soap launch',
    category: 'beauty',
    niche: 'beauty',
    target_location: 'Hyderabad',
    required_influencers: 2,
  };

  it('returns aggregates without identities and without any AI key', async () => {
    const env = createSyntheticEnv();
    delete env.BASETEN_API_KEY;
    await seedVendorToken(env, 'tok_agg');
    await seedCreator(env, 'am_1', {
      full_name: 'Aggie',
      instagram_username: 'aggie_style',
      niche: 'beauty',
      city: 'Hyderabad',
      followers: 45000,
      instagram_url: 'https://www.instagram.com/aggie_style/',
      profile_picture_url: 'https://cdn.example.com/aggie.jpg',
      phone: '+91-00000-11111',
    });
    await seedCreator(env, 'am_2', {
      full_name: 'Baggie',
      instagram_username: 'baggie_style',
      niche: 'fashion',
      city: 'Delhi',
      followers: 90000,
    });
    await seedCreator(env, 'am_3', {
      full_name: 'Nope',
      niche: 'beauty',
      city: 'Hyderabad',
      followers: 80000,
      subscription_status: 'expired',
    });
    const { res, data } = await postAiMatch(env, { token: 'tok_agg', campaign });
    assert.equal(res.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.mode, 'aggregate_only');
    assert.deepEqual(data.recommendations, []);
    assert.equal(data.summary.eligible_matches, 2);
    assert.equal(data.summary.candidate_pool, 2);
    assert.equal(data.summary.requested_creators, 2);
    assert.equal(data.summary.shortfall, 0);
    assert.deepEqual(data.summary.niche_breakdown, { beauty: 1, fashion: 1 });
    const raw = JSON.stringify(data);
    for (const leak of ['Aggie', 'aggie_style', 'instagram.com', 'cdn.example.com', '45000', '90000', '00000-11111', 'Nope']) {
      assert.ok(!raw.includes(leak), leak);
    }
  });

  it('keeps token auth, validation, and rate limits', async () => {
    const env = createSyntheticEnv();
    await seedVendorToken(env, 'tok_ok');
    await seedVendorToken(env, 'tok_rl');
    await env.INSTAGRAM_CONVERSATIONS.put(
      'REGISTRATION:tok_used',
      JSON.stringify({ registration_type: 'vendor', used: true, expires_at: new Date(Date.now() + 60000).toISOString() }),
    );
    await env.INSTAGRAM_CONVERSATIONS.put(
      'REGISTRATION:tok_inf',
      JSON.stringify({ registration_type: 'influencer', used: false, expires_at: new Date(Date.now() + 60000).toISOString() }),
    );
    let r = await postAiMatch(env, { campaign });
    assert.equal(r.res.status, 400);
    r = await postAiMatch(env, { token: 'tok_missing', campaign });
    assert.equal(r.res.status, 401);
    r = await postAiMatch(env, { token: 'tok_used', campaign });
    assert.equal(r.res.status, 401);
    r = await postAiMatch(env, { token: 'tok_inf', campaign });
    assert.equal(r.res.status, 401);
    r = await postAiMatch(env, { token: 'tok_ok', campaign: { category: 'beauty' } });
    assert.equal(r.res.status, 422);
    for (let i = 0; i < 5; i++) {
      r = await postAiMatch(env, { token: 'tok_rl', campaign });
      assert.equal(r.res.status, 200, `call ${i + 1}`);
    }
    r = await postAiMatch(env, { token: 'tok_rl', campaign });
    assert.equal(r.res.status, 429);
  });

  it('reports no_matches when nothing is eligible', async () => {
    const env = createSyntheticEnv();
    await seedVendorToken(env, 'tok_empty');
    const { res, data } = await postAiMatch(env, { token: 'tok_empty', campaign });
    assert.equal(res.status, 200);
    assert.equal(data.mode, 'no_matches');
    assert.deepEqual(data.recommendations, []);
    assert.equal(data.summary.eligible_matches, 0);
  });
});

describe('Influencer profile API — authenticated self/admin access', () => {
  async function seedCreator(env, id, record) {
    await env.INSTAGRAM_CONVERSATIONS.put(
      `INFLUENCER:${id}`,
      JSON.stringify({ instagram_user_id: id, ...record }),
    );
  }

  async function seedToken(env, token, record) {
    await env.INSTAGRAM_CONVERSATIONS.put(
      `REGISTRATION:${token}`,
      JSON.stringify({
        registration_type: 'influencer',
        used: false,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        ...record,
      }),
    );
  }

  async function seedAdminSession(env, token, expiresAtMs) {
    await env.INSTAGRAM_CONVERSATIONS.put(
      `ADMIN_SESSION:${token}`,
      JSON.stringify({
        created_at: new Date().toISOString(),
        expires_at: expiresAtMs,
      }),
    );
  }

  async function getRaw(env, key) {
    return env.INSTAGRAM_CONVERSATIONS.get(key);
  }

  async function postProfile(env, body, cookie = null) {
    const before = isolation.snapshot();
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const res = await worker.fetch(
      new Request(`${TEST_ORIGIN}/api/influencer/profile`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }),
      env,
      createTestContext().ctx,
    );
    const after = isolation.snapshot();
    assert.equal(
      after.blockedFailClosed - before.blockedFailClosed,
      0,
      'profile endpoint must not attempt outbound calls',
    );
    return { res, data: await res.json() };
  }

  it('rejects unauthenticated reads with no user oracle', async () => {
    const env = createSyntheticEnv();
    await seedCreator(env, 'victim_1', {
      full_name: 'Victima',
      instagram_username: 'victima_style',
      niche: 'beauty',
      followers: 45000,
    });
    const existing = await postProfile(env, { instagram_user_id: 'victim_1' });
    const missing = await postProfile(env, { instagram_user_id: 'nobody_here' });
    assert.equal(existing.res.status, 401);
    assert.equal(missing.res.status, 401);
    assert.deepEqual(existing.data, missing.data);
    assert.ok(!JSON.stringify(existing.data).includes('Victima'));
  });

  it('rejects unknown and expired tokens', async () => {
    const env = createSyntheticEnv();
    await seedCreator(env, 'victim_2', { full_name: 'Victimb', niche: 'food' });
    await seedToken(env, 'tok_expired', {
      instagram_user_id: 'victim_2',
      expires_at: new Date(Date.now() - 60000).toISOString(),
    });
    const unknown = await postProfile(env, { token: 'tok_missing', instagram_user_id: 'victim_2' });
    assert.equal(unknown.res.status, 401);
    const expired = await postProfile(env, { token: 'tok_expired', instagram_user_id: 'victim_2' });
    assert.equal(expired.res.status, 401);
    assert.deepEqual(unknown.data, expired.data);
  });

  it('rejects vendor tokens and mismatched identities without leaking', async () => {
    const env = createSyntheticEnv();
    await seedCreator(env, 'victim_3', { full_name: 'Victimc', niche: 'tech', followers: 60000 });
    await seedCreator(env, 'self_3', { full_name: 'Selda', niche: 'tech' });
    await seedToken(env, 'tok_vendor', { registration_type: 'vendor', instagram_user_id: 'vendor_x' });
    await seedToken(env, 'tok_self', { instagram_user_id: 'self_3' });
    const before = await getRaw(env, 'INFLUENCER:victim_3');
    const vendor = await postProfile(env, { token: 'tok_vendor', instagram_user_id: 'victim_3' });
    assert.equal(vendor.res.status, 401);
    const mismatchReal = await postProfile(env, { token: 'tok_self', instagram_user_id: 'victim_3' });
    const mismatchFake = await postProfile(env, { token: 'tok_self', instagram_user_id: 'ghost_9' });
    assert.equal(mismatchReal.res.status, 403);
    assert.equal(mismatchFake.res.status, 403);
    assert.deepEqual(mismatchReal.data, mismatchFake.data);
    assert.ok(!JSON.stringify(mismatchReal.data).includes('Victimc'));
    assert.equal(await getRaw(env, 'INFLUENCER:victim_3'), before);
  });

  it('rejects unauthenticated writes without changing records', async () => {
    const env = createSyntheticEnv();
    await seedCreator(env, 'victim_4', { full_name: 'Victimd', niche: 'travel', area: 'Old Area' });
    const before = await getRaw(env, 'INFLUENCER:victim_4');
    const r = await postProfile(env, {
      instagram_user_id: 'victim_4',
      area: 'Hacked Area',
      instagram_url: 'https://www.instagram.com/hacked/',
    });
    assert.equal(r.res.status, 401);
    assert.equal(await getRaw(env, 'INFLUENCER:victim_4'), before);
  });

  it('allows token-bound self-access, ignoring no ID and trusting no foreign ID', async () => {
    const env = createSyntheticEnv();
    await seedCreator(env, 'self_5', { full_name: 'Selde', niche: 'food', area: 'Old Area' });
    await seedCreator(env, 'other_5', { full_name: 'Othera', niche: 'food', area: 'Other Area' });
    await seedToken(env, 'tok_self5', { instagram_user_id: 'self_5' });
    const otherBefore = await getRaw(env, 'INFLUENCER:other_5');
    // No caller-supplied ID at all: the token selects the record.
    const r = await postProfile(env, {
      token: 'tok_self5',
      area: 'New Area',
      instagram_url: 'https://www.instagram.com/selde_food/',
    });
    assert.equal(r.res.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.profile.full_name, 'Selde');
    assert.equal(r.data.profile.area, 'New Area');
    assert.equal(r.data.profile.instagram_url, 'https://www.instagram.com/selde_food/');
    const stored = JSON.parse(await getRaw(env, 'INFLUENCER:self_5'));
    assert.equal(stored.area, 'New Area');
    assert.equal(await getRaw(env, 'INFLUENCER:other_5'), otherBefore);
    // An echoed ID matching the token still works.
    const echo = await postProfile(env, { token: 'tok_self5', instagram_user_id: 'self_5' });
    assert.equal(echo.res.status, 200);
    assert.equal(echo.data.profile.full_name, 'Selde');
  });

  it('allows used-but-unexpired tokens for self-service continuity', async () => {
    const env = createSyntheticEnv();
    await seedCreator(env, 'self_6', { full_name: 'Seldf', niche: 'tech' });
    await seedToken(env, 'tok_used6', { instagram_user_id: 'self_6', used: true });
    const r = await postProfile(env, { token: 'tok_used6', area: 'Post-submit Area' });
    assert.equal(r.res.status, 200);
    assert.equal(r.data.profile.area, 'Post-submit Area');
  });

  it('allows admin session to manage any profile, and fails closed otherwise', async () => {
    const env = createSyntheticEnv();
    await seedCreator(env, 'victim_7', { full_name: 'Victime', niche: 'fashion' });
    await seedAdminSession(env, 'adm_good', Date.now() + 60 * 60 * 1000);
    await seedAdminSession(env, 'adm_old', Date.now() - 1000);
    const ok = await postProfile(
      env,
      { instagram_user_id: 'victim_7', area: 'Admin Area' },
      'B8I_ADMIN_SESSION=adm_good',
    );
    assert.equal(ok.res.status, 200);
    assert.equal(ok.data.profile.full_name, 'Victime');
    assert.equal(ok.data.profile.area, 'Admin Area');
    const expired = await postProfile(
      env,
      { instagram_user_id: 'victim_7' },
      'B8I_ADMIN_SESSION=adm_old',
    );
    assert.equal(expired.res.status, 401);
    const noTarget = await postProfile(env, {}, 'B8I_ADMIN_SESSION=adm_good');
    assert.equal(noTarget.res.status, 400);
  });
});

describe('Vendor profile API — authenticated self/admin access', () => {
  async function seedVendor(env, id, record) {
    await env.INSTAGRAM_CONVERSATIONS.put(
      `VENDOR:${id}`,
      JSON.stringify({ instagram_user_id: id, ...record }),
    );
  }

  async function seedToken(env, token, record) {
    await env.INSTAGRAM_CONVERSATIONS.put(
      `REGISTRATION:${token}`,
      JSON.stringify({
        registration_type: 'vendor',
        used: false,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        ...record,
      }),
    );
  }

  async function seedAdminSession(env, token, expiresAtMs) {
    await env.INSTAGRAM_CONVERSATIONS.put(
      `ADMIN_SESSION:${token}`,
      JSON.stringify({
        created_at: new Date().toISOString(),
        expires_at: expiresAtMs,
      }),
    );
  }

  async function getRaw(env, key) {
    return env.INSTAGRAM_CONVERSATIONS.get(key);
  }

  async function postVendorProfile(env, body, cookie = null) {
    const before = isolation.snapshot();
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const res = await worker.fetch(
      new Request(`${TEST_ORIGIN}/api/vendor/profile`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }),
      env,
      createTestContext().ctx,
    );
    const after = isolation.snapshot();
    assert.equal(
      after.blockedFailClosed - before.blockedFailClosed,
      0,
      'vendor profile endpoint must not attempt outbound calls',
    );
    return { res, data: await res.json() };
  }

  it('rejects unauthenticated reads with no vendor oracle', async () => {
    const env = createSyntheticEnv();
    await seedVendor(env, 'vvictim_1', {
      business_name: 'Victim Mart',
      city: 'Hyderabad',
      phone: '+91-00000-22222',
    });
    const existing = await postVendorProfile(env, { instagram_user_id: 'vvictim_1' });
    const missing = await postVendorProfile(env, { instagram_user_id: 'nobody_here' });
    assert.equal(existing.res.status, 401);
    assert.equal(missing.res.status, 401);
    assert.deepEqual(existing.data, missing.data);
    assert.ok(!JSON.stringify(existing.data).includes('Victim Mart'));
  });

  it('rejects unknown and expired tokens', async () => {
    const env = createSyntheticEnv();
    await seedVendor(env, 'vvictim_2', { business_name: 'Victim Store' });
    await seedToken(env, 'vtok_expired', {
      instagram_user_id: 'vvictim_2',
      expires_at: new Date(Date.now() - 60000).toISOString(),
    });
    const unknown = await postVendorProfile(env, { token: 'vtok_missing', instagram_user_id: 'vvictim_2' });
    assert.equal(unknown.res.status, 401);
    const expired = await postVendorProfile(env, { token: 'vtok_expired', instagram_user_id: 'vvictim_2' });
    assert.equal(expired.res.status, 401);
    assert.deepEqual(unknown.data, expired.data);
  });

  it('rejects influencer tokens and mismatched identities without leaking', async () => {
    const env = createSyntheticEnv();
    await seedVendor(env, 'vvictim_3', { business_name: 'Victim Foods', city: 'Delhi' });
    await seedVendor(env, 'vself_3', { business_name: 'Self Goods' });
    await seedToken(env, 'vtok_inf', { registration_type: 'influencer', instagram_user_id: 'creator_x' });
    await seedToken(env, 'vtok_self', { instagram_user_id: 'vself_3' });
    const before = await getRaw(env, 'VENDOR:vvictim_3');
    const wrongClass = await postVendorProfile(env, { token: 'vtok_inf', instagram_user_id: 'vvictim_3' });
    assert.equal(wrongClass.res.status, 401);
    const mismatchReal = await postVendorProfile(env, { token: 'vtok_self', instagram_user_id: 'vvictim_3' });
    const mismatchFake = await postVendorProfile(env, { token: 'vtok_self', instagram_user_id: 'ghost_9' });
    assert.equal(mismatchReal.res.status, 403);
    assert.equal(mismatchFake.res.status, 403);
    assert.deepEqual(mismatchReal.data, mismatchFake.data);
    assert.ok(!JSON.stringify(mismatchReal.data).includes('Victim Foods'));
    assert.equal(await getRaw(env, 'VENDOR:vvictim_3'), before);
  });

  it('rejects unauthenticated writes without changing records', async () => {
    const env = createSyntheticEnv();
    await seedVendor(env, 'vvictim_4', { business_name: 'Victim Wear', area: 'Old Area' });
    const before = await getRaw(env, 'VENDOR:vvictim_4');
    const r = await postVendorProfile(env, {
      instagram_user_id: 'vvictim_4',
      area: 'Hacked Area',
      instagram_url: 'https://www.instagram.com/hacked/',
    });
    assert.equal(r.res.status, 401);
    assert.equal(await getRaw(env, 'VENDOR:vvictim_4'), before);
  });

  it('allows token-bound self-access, trusting no foreign ID', async () => {
    const env = createSyntheticEnv();
    await seedVendor(env, 'vself_5', { business_name: 'Self Mart', city: 'Hyderabad', area: 'Old Area' });
    await seedVendor(env, 'vother_5', { business_name: 'Other Mart', area: 'Other Area' });
    await seedToken(env, 'vtok_self5', { instagram_user_id: 'vself_5' });
    const otherBefore = await getRaw(env, 'VENDOR:vother_5');
    // No caller-supplied ID at all: the token selects the record.
    const r = await postVendorProfile(env, {
      token: 'vtok_self5',
      area: 'New Area',
      instagram_url: 'https://www.instagram.com/self_mart/',
    });
    assert.equal(r.res.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.profile.business_name, 'Self Mart');
    assert.equal(r.data.profile.area, 'New Area');
    assert.equal(r.data.profile.instagram_url, 'https://www.instagram.com/self_mart/');
    const stored = JSON.parse(await getRaw(env, 'VENDOR:vself_5'));
    assert.equal(stored.area, 'New Area');
    assert.equal(await getRaw(env, 'VENDOR:vother_5'), otherBefore);
    // An echoed ID matching the token still works.
    const echo = await postVendorProfile(env, { token: 'vtok_self5', instagram_user_id: 'vself_5' });
    assert.equal(echo.res.status, 200);
    assert.equal(echo.data.profile.business_name, 'Self Mart');
  });

  it('allows used-but-unexpired tokens for self-service continuity', async () => {
    const env = createSyntheticEnv();
    await seedVendor(env, 'vself_6', { business_name: 'Self Foods' });
    await seedToken(env, 'vtok_used6', { instagram_user_id: 'vself_6', used: true });
    const r = await postVendorProfile(env, { token: 'vtok_used6', area: 'Post-submit Area' });
    assert.equal(r.res.status, 200);
    assert.equal(r.data.profile.area, 'Post-submit Area');
  });

  it('allows admin session to manage any vendor, and fails closed otherwise', async () => {
    const env = createSyntheticEnv();
    await seedVendor(env, 'vvictim_7', { business_name: 'Victim Electro' });
    await seedAdminSession(env, 'vadm_good', Date.now() + 60 * 60 * 1000);
    await seedAdminSession(env, 'vadm_old', Date.now() - 1000);
    const ok = await postVendorProfile(
      env,
      { instagram_user_id: 'vvictim_7', area: 'Admin Area' },
      'B8I_ADMIN_SESSION=vadm_good',
    );
    assert.equal(ok.res.status, 200);
    assert.equal(ok.data.profile.business_name, 'Victim Electro');
    assert.equal(ok.data.profile.area, 'Admin Area');
    const expired = await postVendorProfile(
      env,
      { instagram_user_id: 'vvictim_7' },
      'B8I_ADMIN_SESSION=vadm_old',
    );
    assert.equal(expired.res.status, 401);
    const noTarget = await postVendorProfile(env, {}, 'B8I_ADMIN_SESSION=vadm_good');
    assert.equal(noTarget.res.status, 400);
  });
});

describe('Privacy gate — per-vendor campaign index', () => {
  function kvKeys(env, prefix) {
    return env.INSTAGRAM_CONVERSATIONS.keysWithPrefix(prefix);
  }

  async function seedCreator(env, id, record) {
    await env.INSTAGRAM_CONVERSATIONS.put(
      `INFLUENCER:${id}`,
      JSON.stringify({
        instagram_user_id: id,
        verification_status: 'APPROVED',
        subscription_status: 'active',
        ...record,
      }),
    );
  }

  async function seedCampaign(env, id, record) {
    await env.INSTAGRAM_CONVERSATIONS.put(
      `CAMPAIGN:${id}`,
      JSON.stringify({ campaign_id: id, ...record }),
    );
  }

  async function seedMembership(env, vendor, campaign) {
    await env.INSTAGRAM_CONVERSATIONS.put(
      `VENDOR_CAMPAIGN:${vendor}:${campaign}`,
      JSON.stringify({ v: 1, vendor_id: vendor, campaign_id: campaign }),
    );
  }

  async function seedMarker(env, vendor, record = {}) {
    await env.INSTAGRAM_CONVERSATIONS.put(
      `VENDOR_CAMPAIGN_SYNC:${vendor}`,
      JSON.stringify({ v: 1, updated_at: new Date().toISOString(), scan_complete: true, ...record }),
    );
  }

  function spyLists(env) {
    const kv = env.INSTAGRAM_CONVERSATIONS;
    const lists = [];
    const orig = kv.list.bind(kv);
    kv.list = async (args) => {
      lists.push({ ...(args || {}) });
      return orig(args);
    };
    return { lists, restore() { delete kv.list; } };
  }

  it('indexed lookup authorizes without any global scan', async () => {
    const env = createSyntheticEnv();
    const vendor = `ix_${Date.now()}`;
    await seedCampaign(env, 'camp_ix', {
      vendor_instagram_user_id: vendor,
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['ix_yes'],
    });
    await seedMembership(env, vendor, 'camp_ix');
    await seedMarker(env, vendor);
    const spy = spyLists(env);
    const authorized = await b8iAuthorizedCreatorIds(vendor, env);
    spy.restore();
    assert.deepEqual([...authorized], ['ix_yes']);
    assert.ok(
      spy.lists.every((call) => (call.prefix || '') !== 'CAMPAIGN:'),
      `global scan occurred: ${JSON.stringify(spy.lists.map((c) => c.prefix))}`,
    );
    assert.ok(spy.lists.some((call) => (call.prefix || '').startsWith('VENDOR_CAMPAIGN:')));
  });

  it('indexed end to end shows the accepted card', async () => {
    const env = createSyntheticEnv();
    const vendor = `ie_${Date.now()}`;
    await seedCreator(env, 'ie_yes', { full_name: 'Indexa', niche: 'food', followers: 40000 });
    await seedCreator(env, 'ie_no', { full_name: 'Outdex', niche: 'food', followers: 90000 });
    await seedCampaign(env, 'camp_ie', {
      vendor_instagram_user_id: vendor,
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['ie_yes'],
    });
    await seedMembership(env, vendor, 'camp_ie');
    await seedMarker(env, vendor);
    const { dms } = await postTextAndDrain({
      text: 'Suggest a food influencer.',
      env,
      tctx: createTestContext(),
      senderId: vendor,
    });
    assert.ok(dms[0].message.text.includes('Indexa'));
    assert.ok(!dms[0].message.text.includes('Outdex'));
  });

  it('backfills legacy campaigns once, then memoizes', async () => {
    const env = createSyntheticEnv();
    const vendor = `lb_${Date.now()}`;
    await seedCampaign(env, 'camp_lb', {
      vendor_instagram_user_id: vendor,
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['lb_yes'],
    });
    const first = spyLists(env);
    const authorized = await b8iAuthorizedCreatorIds(vendor, env);
    first.restore();
    assert.deepEqual([...authorized], ['lb_yes']);
    assert.ok(first.lists.some((call) => (call.prefix || '') === 'CAMPAIGN:'));
    const markerRaw = await env.INSTAGRAM_CONVERSATIONS.get(`VENDOR_CAMPAIGN_SYNC:${vendor}`);
    assert.equal(JSON.parse(markerRaw).scan_complete, true);
    const keyRaw = await env.INSTAGRAM_CONVERSATIONS.get(`VENDOR_CAMPAIGN:${vendor}:camp_lb`);
    assert.equal(JSON.parse(keyRaw).campaign_id, 'camp_lb');
    const second = spyLists(env);
    assert.deepEqual([...(await b8iAuthorizedCreatorIds(vendor, env))], ['lb_yes']);
    second.restore();
    assert.ok(second.lists.every((call) => (call.prefix || '') !== 'CAMPAIGN:'));
  });

  it('retries incomplete backfills instead of stranding campaigns', async () => {
    const env = createSyntheticEnv();
    const vendor = `rt_${Date.now()}`;
    await seedCampaign(env, 'camp_rt', {
      vendor_instagram_user_id: vendor,
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['rt_yes'],
    });
    await seedMarker(env, vendor, { scan_complete: false });
    const spy = spyLists(env);
    const authorized = await b8iAuthorizedCreatorIds(vendor, env);
    spy.restore();
    assert.deepEqual([...authorized], ['rt_yes']);
    assert.ok(spy.lists.some((call) => (call.prefix || '') === 'CAMPAIGN:'));
    const markerRaw = await env.INSTAGRAM_CONVERSATIONS.get(`VENDOR_CAMPAIGN_SYNC:${vendor}`);
    assert.equal(JSON.parse(markerRaw).scan_complete, true);
  });

  it('fails closed on unverifiable index entries', async () => {
    const env = createSyntheticEnv();
    const vendor = `fc_${Date.now()}`;
    await seedCampaign(env, 'camp_unpaid', {
      vendor_instagram_user_id: vendor,
      payment_status: 'PENDING',
      accepted_influencer_ids: ['fc_no'],
    });
    await seedCampaign(env, 'camp_other', {
      vendor_instagram_user_id: 'someone_else',
      payment_status: 'CAPTURED',
      accepted_influencer_ids: ['fc_no2'],
    });
    await seedMembership(env, vendor, 'camp_unpaid');
    await seedMembership(env, vendor, 'camp_other');
    await seedMembership(env, vendor, 'camp_ghost');
    // Malformed key: the index reader must skip it, never throw.
    await env.INSTAGRAM_CONVERSATIONS.put(
      `VENDOR_CAMPAIGN:${vendor}:a:b`,
      JSON.stringify({ v: 1 }),
    );
    await seedMarker(env, vendor);
    assert.deepEqual([...(await b8iAuthorizedCreatorIds(vendor, env))], []);
  });

  it('memoized vendors skip unindexed campaigns until resync', async () => {
    const env = createSyntheticEnv();
    const vendor = `mm_${Date.now()}`;
    await seedCampaign(env, 'camp_mm', {
      vendor_instagram_user_id: vendor,
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['mm_yes'],
    });
    await seedMarker(env, vendor, { scan_complete: true });
    // Fail-closed while the campaign is invisible to the index.
    assert.deepEqual([...(await b8iAuthorizedCreatorIds(vendor, env))], []);
    // Dropping the marker (as a failed creation write does) heals via backfill.
    await env.INSTAGRAM_CONVERSATIONS.delete(`VENDOR_CAMPAIGN_SYNC:${vendor}`);
    assert.deepEqual([...(await b8iAuthorizedCreatorIds(vendor, env))], ['mm_yes']);
  });

  it('paginates vendor lists and dedupes authorizations', async () => {
    const env = createSyntheticEnv();
    const vendor = `pg_${Date.now()}`;
    for (const camp of ['c1', 'c2', 'c3', 'c4', 'c5']) {
      await seedMembership(env, vendor, camp);
    }
    assert.deepEqual(
      await listVendorCampaignIds(env, vendor, { pageSize: 2 }),
      ['c1', 'c2', 'c3', 'c4', 'c5'],
    );
    assert.deepEqual(
      await listVendorCampaignIds(env, vendor, { pageSize: 2, maxIds: 3 }),
      ['c1', 'c2', 'c3'],
    );
    assert.deepEqual(await listVendorCampaignIds(env, '', { pageSize: 2 }), []);
    await seedCampaign(env, 'camp_dup', {
      vendor_instagram_user_id: vendor,
      payment_status: 'CAPTURED',
      accepted_influencer_ids: ['dup_1', 'dup_1'],
    });
    await seedMembership(env, vendor, 'camp_dup');
    await seedMarker(env, vendor);
    assert.deepEqual([...(await b8iAuthorizedCreatorIds(vendor, env))], ['dup_1']);
  });

  it('keeps vendors isolated from each other', async () => {
    const env = createSyntheticEnv();
    await seedCampaign(env, 'camp_iso', {
      vendor_instagram_user_id: 'vendor_a',
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['iso_yes'],
    });
    await seedMembership(env, 'vendor_a', 'camp_iso');
    await seedMarker(env, 'vendor_a');
    await seedMarker(env, 'vendor_b');
    const spy = spyLists(env);
    assert.deepEqual([...(await b8iAuthorizedCreatorIds('vendor_b', env))], []);
    spy.restore();
    for (const call of spy.lists) {
      assert.ok(
        (call.prefix || '').startsWith('VENDOR_CAMPAIGN:vendor_b:'),
        `cross-vendor list: ${call.prefix}`,
      );
    }
  });

  it('backfill survives partial write failures and heals', async () => {
    const env = createSyntheticEnv();
    const vendor = `wf_${Date.now()}`;
    await seedCampaign(env, 'camp_wf', {
      vendor_instagram_user_id: vendor,
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['wf_yes'],
    });
    const kv = env.INSTAGRAM_CONVERSATIONS;
    const origPut = kv.put.bind(kv);
    kv.put = async (key, value, opts) => {
      // Membership keys use the 'VENDOR_CAMPAIGN:<vendor>:' shape; the
      // 'VENDOR_CAMPAIGN_SYNC:' marker never matches this prefix.
      if (String(key).startsWith('VENDOR_CAMPAIGN:')) {
        throw new Error('synthetic put failure');
      }
      return origPut(key, value, opts);
    };
    // Live verification still authorizes (the scan found and verified the
    // campaign); only index persistence failed, so the marker stays incomplete.
    assert.deepEqual([...(await b8iAuthorizedCreatorIds(vendor, env))], ['wf_yes']);
    const markerRaw = await kv.get(`VENDOR_CAMPAIGN_SYNC:${vendor}`);
    assert.equal(JSON.parse(markerRaw).scan_complete, false);
    delete kv.put;
    assert.deepEqual([...(await b8iAuthorizedCreatorIds(vendor, env))], ['wf_yes']);
    const healed = await kv.get(`VENDOR_CAMPAIGN_SYNC:${vendor}`);
    assert.equal(JSON.parse(healed).scan_complete, true);
  });

  it('creation path writes the membership key', async () => {
    const env = createSyntheticEnv();
    const vendor = `vc_${Date.now()}`;
    await env.INSTAGRAM_CONVERSATIONS.put(
      `REGISTRATION:tok_create`,
      JSON.stringify({
        registration_type: 'vendor',
        used: false,
        instagram_user_id: vendor,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    );
    await env.INSTAGRAM_CONVERSATIONS.put(
      `IG_PROFILE:${vendor}`,
      JSON.stringify({ username: 'vendor_shop', followers: 0 }),
    );
    const form = new FormData();
    for (const [key, value] of [
      ['token', 'tok_create'],
      ['business_name', 'Soap Shop'],
      ['contact_name', 'Sam'],
      ['email', 'shop@example.com'],
      ['phone', '+91-00000-33333'],
      ['campaign_title', 'Soap Launch'],
      ['niche', 'beauty'],
      ['reels', '1'],
      ['posts', '0'],
      ['budget', '5000'],
      ['required_influencers', '1'],
      ['compensation_type', 'money'],
    ]) {
      form.set(key, value);
    }
    const before = isolation.snapshot();
    const res = await worker.fetch(
      new Request(`${TEST_ORIGIN}/register/vendor/submit`, { method: 'POST', body: form }),
      env,
      createTestContext().ctx,
    );
    const after = isolation.snapshot();
    assert.equal(res.status, 200);
    assert.equal(after.blockedFailClosed - before.blockedFailClosed, 0);
    const campaigns = kvKeys(env, 'CAMPAIGN:');
    assert.equal(campaigns.length, 1);
    const campaignId = campaigns[0].slice('CAMPAIGN:'.length);
    const keyRaw = await env.INSTAGRAM_CONVERSATIONS.get(`VENDOR_CAMPAIGN:${vendor}:${campaignId}`);
    assert.ok(keyRaw, 'membership key written at creation');
    assert.equal(JSON.parse(keyRaw).campaign_id, campaignId);
  });

  it('index write failure never fails creation, and backfill heals', async () => {
    const env = createSyntheticEnv();
    const vendor = `vh_${Date.now()}`;
    await env.INSTAGRAM_CONVERSATIONS.put(
      `REGISTRATION:tok_heal`,
      JSON.stringify({
        registration_type: 'vendor',
        used: false,
        instagram_user_id: vendor,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    );
    await env.INSTAGRAM_CONVERSATIONS.put(
      `IG_PROFILE:${vendor}`,
      JSON.stringify({ username: 'heal_shop', followers: 0 }),
    );
    const kv = env.INSTAGRAM_CONVERSATIONS;
    const origPut = kv.put.bind(kv);
    kv.put = async (key, value, opts) => {
      if (String(key).startsWith('VENDOR_CAMPAIGN:')) {
        throw new Error('synthetic put failure');
      }
      return origPut(key, value, opts);
    };
    const form = new FormData();
    for (const [key, value] of [
      ['token', 'tok_heal'],
      ['business_name', 'Heal Shop'],
      ['contact_name', 'Hal'],
      ['email', 'heal@example.com'],
      ['phone', '+91-00000-44444'],
      ['campaign_title', 'Heal Launch'],
      ['niche', 'food'],
      ['reels', '1'],
      ['posts', '0'],
      ['budget', '5000'],
      ['required_influencers', '1'],
      ['compensation_type', 'money'],
    ]) {
      form.set(key, value);
    }
    const res = await worker.fetch(
      new Request(`${TEST_ORIGIN}/register/vendor/submit`, { method: 'POST', body: form }),
      env,
      createTestContext().ctx,
    );
    delete kv.put;
    assert.equal(res.status, 200);
    assert.equal(kvKeys(env, 'CAMPAIGN:').length, 1);
    assert.equal(kvKeys(env, 'VENDOR_CAMPAIGN:').length, 0);
    // The gate backfills the missing key on demand (fail-closed until then).
    await seedCreator(env, 'healed_1', { full_name: 'Heala', niche: 'food', followers: 10000 });
    assert.deepEqual([...(await b8iAuthorizedCreatorIds(vendor, env))], []);
    const campaigns = kvKeys(env, 'CAMPAIGN:');
    const campaign = JSON.parse(await env.INSTAGRAM_CONVERSATIONS.get(campaigns[0]));
    campaign.payment_status = 'CAPTURED';
    campaign.accepted_influencer_ids = ['healed_1'];
    await env.INSTAGRAM_CONVERSATIONS.put(campaigns[0], JSON.stringify(campaign));
    assert.deepEqual([...(await b8iAuthorizedCreatorIds(vendor, env))], ['healed_1']);
    assert.equal(kvKeys(env, 'VENDOR_CAMPAIGN:').length, 1);
    const markerRaw = await env.INSTAGRAM_CONVERSATIONS.get(`VENDOR_CAMPAIGN_SYNC:${vendor}`);
    assert.equal(JSON.parse(markerRaw).scan_complete, true);
  });

  it('index helper rejects empty identities without throwing', async () => {
    const env = createSyntheticEnv();
    assert.equal(await indexVendorCampaign(env, '', 'camp_x'), false);
    assert.equal(await indexVendorCampaign(env, 'vendor_x', ''), false);
    assert.equal(await indexVendorCampaign({}, 'vendor_x', 'camp_x'), false);
    assert.equal(await indexVendorCampaign(env, 'vendor_x', 'camp_x'), true);
    assert.ok(await env.INSTAGRAM_CONVERSATIONS.get('VENDOR_CAMPAIGN:vendor_x:camp_x'));
  });

  it('caps backfill honestly and retries instead of stranding campaigns', async () => {
    const env = createSyntheticEnv();
    const vendor = `cap_${Date.now()}`;
    for (let i = 1; i <= 260; i++) {
      const n = String(i).padStart(3, '0');
      await seedCampaign(env, `cap_${n}`, {
        vendor_instagram_user_id: vendor,
        payment_status: 'CAPTURED',
        status: 'ACCEPTED',
        accepted_influencer_ids: [`capacc_${n}`],
      });
    }
    const authorized = await b8iAuthorizedCreatorIds(vendor, env);
    assert.equal(authorized.size, 250);
    assert.ok(authorized.has('capacc_001'));
    assert.ok(!authorized.has('capacc_260'));
    const markerRaw = await env.INSTAGRAM_CONVERSATIONS.get(`VENDOR_CAMPAIGN_SYNC:${vendor}`);
    assert.equal(JSON.parse(markerRaw).scan_complete, false);
    assert.equal(kvKeys(env, `VENDOR_CAMPAIGN:${vendor}:`).length, 250);
    // An honest incomplete marker forces a rescan on the next call.
    const spy = spyLists(env);
    await b8iAuthorizedCreatorIds(vendor, env);
    spy.restore();
    assert.ok(spy.lists.some((call) => (call.prefix || '') === 'CAMPAIGN:'));
  });

  it('malformed markers trigger bounded recovery', async () => {
    for (const [label, raw] of [
      ['missing field', JSON.stringify({ v: 1 })],
      ['wrong type', JSON.stringify({ v: 1, scan_complete: 'yes' })],
      ['corrupt json', '{not-json'],
    ]) {
      const env = createSyntheticEnv();
      const vendor = `mm2_${Date.now()}_${label.length}`;
      await seedCampaign(env, 'camp_mm2', {
        vendor_instagram_user_id: vendor,
        payment_status: 'CAPTURED',
        status: 'ACCEPTED',
        accepted_influencer_ids: ['mm2_yes'],
      });
      await env.INSTAGRAM_CONVERSATIONS.put(`VENDOR_CAMPAIGN_SYNC:${vendor}`, raw);
      const spy = spyLists(env);
      const authorized = await b8iAuthorizedCreatorIds(vendor, env);
      spy.restore();
      assert.deepEqual([...authorized], ['mm2_yes'], label);
      assert.ok(
        spy.lists.some((call) => (call.prefix || '') === 'CAMPAIGN:'),
        `no recovery scan for ${label}`,
      );
      const healed = await env.INSTAGRAM_CONVERSATIONS.get(`VENDOR_CAMPAIGN_SYNC:${vendor}`);
      assert.equal(JSON.parse(healed).scan_complete, true, label);
    }
  });

  it('marker-write failure forces retry without stranding verified campaigns', async () => {
    const env = createSyntheticEnv();
    const vendor = `mw_${Date.now()}`;
    await seedCampaign(env, 'camp_mw', {
      vendor_instagram_user_id: vendor,
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['mw_yes'],
    });
    const kv = env.INSTAGRAM_CONVERSATIONS;
    const origPut = kv.put.bind(kv);
    kv.put = async (key, value, opts) => {
      if (String(key).startsWith('VENDOR_CAMPAIGN_SYNC:')) {
        throw new Error('synthetic marker failure');
      }
      return origPut(key, value, opts);
    };
    // Verified authorization still succeeds; only the memo is missing.
    assert.deepEqual([...(await b8iAuthorizedCreatorIds(vendor, env))], ['mw_yes']);
    assert.equal(await kv.get(`VENDOR_CAMPAIGN_SYNC:${vendor}`), null);
    const spy = spyLists(env);
    assert.deepEqual([...(await b8iAuthorizedCreatorIds(vendor, env))], ['mw_yes']);
    spy.restore();
    assert.ok(spy.lists.some((call) => (call.prefix || '') === 'CAMPAIGN:'));
    delete kv.put;
    assert.deepEqual([...(await b8iAuthorizedCreatorIds(vendor, env))], ['mw_yes']);
    const healed = await kv.get(`VENDOR_CAMPAIGN_SYNC:${vendor}`);
    assert.equal(JSON.parse(healed).scan_complete, true);
  });

  it('transient read errors poison the marker but keep verified auth', async () => {
    const env = createSyntheticEnv();
    const vendor = `re_${Date.now()}`;
    await seedCampaign(env, 'camp_re1', {
      vendor_instagram_user_id: vendor,
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['re_yes'],
    });
    await seedCampaign(env, 'camp_re2', {
      vendor_instagram_user_id: vendor,
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['re_flaky'],
    });
    const kv = env.INSTAGRAM_CONVERSATIONS;
    const origGet = kv.get.bind(kv);
    let flaked = false;
    kv.get = async (key, opts) => {
      if (!flaked && String(key) === 'CAMPAIGN:camp_re2') {
        flaked = true;
        throw new Error('synthetic transient read');
      }
      return origGet(key, opts);
    };
    const authorized = await b8iAuthorizedCreatorIds(vendor, env);
    delete kv.get;
    assert.deepEqual([...authorized], ['re_yes']);
    const markerRaw = await kv.get(`VENDOR_CAMPAIGN_SYNC:${vendor}`);
    assert.equal(JSON.parse(markerRaw).scan_complete, false);
    // The retry heals: both campaigns authorize and the marker completes.
    assert.deepEqual(
      [...(await b8iAuthorizedCreatorIds(vendor, env))].sort(),
      ['re_flaky', 're_yes'],
    );
    const healed = await kv.get(`VENDOR_CAMPAIGN_SYNC:${vendor}`);
    assert.equal(JSON.parse(healed).scan_complete, true);
  });

  it('concurrent first lookups converge without corruption', async () => {
    const env = createSyntheticEnv();
    const vendor = `cc_${Date.now()}`;
    await seedCampaign(env, 'camp_cc', {
      vendor_instagram_user_id: vendor,
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['cc_yes'],
    });
    // Best-effort interleaving check: the in-memory stub serializes
    // trivially, so this proves idempotent convergence, not true races.
    const results = await Promise.all([
      b8iAuthorizedCreatorIds(vendor, env),
      b8iAuthorizedCreatorIds(vendor, env),
      b8iAuthorizedCreatorIds(vendor, env),
    ]);
    for (const authorized of results) {
      assert.deepEqual([...authorized], ['cc_yes']);
    }
    assert.equal(kvKeys(env, `VENDOR_CAMPAIGN:${vendor}:`).length, 1);
    const markerRaw = await env.INSTAGRAM_CONVERSATIONS.get(`VENDOR_CAMPAIGN_SYNC:${vendor}`);
    assert.equal(JSON.parse(markerRaw).scan_complete, true);
  });

  it('lister honors page and id bounds', async () => {
    const env = createSyntheticEnv();
    const vendor = `bd_${Date.now()}`;
    for (const camp of ['d1', 'd2', 'd3', 'd4', 'd5']) {
      await seedMembership(env, vendor, camp);
    }
    assert.deepEqual(
      await listVendorCampaignIds(env, vendor, { pageSize: 2, maxPages: 1 }),
      ['d1', 'd2'],
    );
    assert.deepEqual(
      await listVendorCampaignIds(env, vendor, { pageSize: 2, maxPages: 9 }),
      ['d1', 'd2', 'd3', 'd4', 'd5'],
    );
  });
});

describe('Discovery hardening — dedup and URL safety', () => {
  it('rankCreators dedupes repeat profiles, keeping the best rank', () => {
    const ranked = rankCreators([
      { instagram_user_id: 'dup', avg_rating: 4.5, rating_count: 10, followers: 1000 },
      { instagram_user_id: 'dup', followers: 999000 },
      { instagram_user_id: 'solo', followers: 5000 },
    ]);
    assert.deepEqual(ranked.map((r) => r.instagram_user_id), ['dup', 'solo']);
    assert.equal(ranked[0].followers, 1000);
  });

  it('matching counts each creator once across duplicate keys', async () => {
    const env = createSyntheticEnv();
    await env.INSTAGRAM_CONVERSATIONS.put(
      'REGISTRATION:tok_dedup',
      JSON.stringify({
        registration_type: 'vendor',
        used: false,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    );
    for (const key of ['INFLUENCER:dup_k1', 'INFLUENCER:dup_k2']) {
      await env.INSTAGRAM_CONVERSATIONS.put(
        key,
        JSON.stringify({
          instagram_user_id: 'dupmate',
          verification_status: 'APPROVED',
          subscription_status: 'active',
          niche: 'beauty',
          city: 'Hyderabad',
          followers: 20000,
        }),
      );
    }
    const res = await worker.fetch(
      new Request(`${TEST_ORIGIN}/api/vendor/ai-match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'tok_dedup',
          campaign: {
            campaign_title: 'Dedup check',
            category: 'beauty',
            niche: 'beauty',
            target_location: 'Hyderabad',
            required_influencers: 2,
          },
        }),
      }),
      env,
      createTestContext().ctx,
    );
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.summary.eligible_matches, 1);
    assert.deepEqual(data.summary.niche_breakdown, { beauty: 1 });
  });

  it('never builds a profile URL from a numeric internal ID', async () => {
    const env = createSyntheticEnv();
    await env.INSTAGRAM_CONVERSATIONS.put(
      'INFLUENCER:num_1',
      JSON.stringify({
        instagram_user_id: 'num_1',
        verification_status: 'APPROVED',
        subscription_status: 'active',
        full_name: 'Numera',
        instagram_username: '12345678',
        niche: 'tech',
      }),
    );
    await env.INSTAGRAM_CONVERSATIONS.put(
      'REGISTRATION:tok_num',
      JSON.stringify({
        registration_type: 'influencer',
        used: false,
        instagram_user_id: 'num_1',
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    );
    const res = await worker.fetch(
      new Request(`${TEST_ORIGIN}/api/influencer/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'tok_num' }),
      }),
      env,
      createTestContext().ctx,
    );
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.profile.instagram_url, '');
    // Non-numeric handles still resolve.
    await env.INSTAGRAM_CONVERSATIONS.put(
      'INFLUENCER:num_2',
      JSON.stringify({
        instagram_user_id: 'num_2',
        instagram_username: 'real_handle',
        niche: 'tech',
      }),
    );
    await env.INSTAGRAM_CONVERSATIONS.put(
      'REGISTRATION:tok_num2',
      JSON.stringify({
        registration_type: 'influencer',
        used: false,
        instagram_user_id: 'num_2',
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    );
    const res2 = await worker.fetch(
      new Request(`${TEST_ORIGIN}/api/influencer/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'tok_num2' }),
      }),
      env,
      createTestContext().ctx,
    );
    const data2 = await res2.json();
    assert.equal(res2.status, 200);
    assert.ok(data2.profile.instagram_url.includes('real_handle'));
  });
});

describe('Marketing tips — deterministic general advice', () => {
  it('classifies content and engagement sub-intents without stealing briefs', () => {
    assert.equal(b8iMarketingTipsKey('content ideas for marketing'), 'marketing_content_tips');
    assert.equal(b8iMarketingTipsKey('give me reel ideas'), 'marketing_content_tips');
    assert.equal(b8iMarketingTipsKey('how to boost engagement'), 'marketing_engagement_tips');
    assert.equal(b8iMarketingTipsKey('how can I grow followers'), 'marketing_engagement_tips');
    assert.equal(b8iMarketingTipsKey('promote my soap'), null);
    assert.equal(b8iMarketingTipsKey('marketing strategy'), null);
    assert.equal(b8iMarketingTipsKey('fashion'), null);
  });

  it('answers content questions with tips, not a brief interrogation', async () => {
    const env = createSyntheticEnv();
    const { dms } = await postTextAndDrain({
      text: 'Give me content ideas to promote my soap',
      env,
      tctx: createTestContext(),
    });
    assert.match(dms[0].message.text, /unboxing/);
    assert.match(dms[0].message.text, /not B8i performance data/);
    assert.ok(!dms[0].message.text.includes('What product'));
  });

  it('answers engagement questions and keeps the brief for real briefs', async () => {
    const env = createSyntheticEnv();
    const tips = await postTextAndDrain({
      text: 'How can I boost engagement for my marketing?',
      env,
      tctx: createTestContext(),
    });
    assert.match(tips.dms[0].message.text, /first 2 seconds/);
    const brief = await postTextAndDrain({
      text: 'I want to promote my soap brand',
      env,
      tctx: createTestContext(),
    });
    assert.match(brief.dms[0].message.text, /Which creator niche|What product/);
  });

  it('serves tips through the want path with English fallback', async () => {
    const env = createSyntheticEnv();
    const { dms } = await postTextAndDrain({
      text: 'Nenu reel ideas kavali',
      env,
      tctx: createTestContext(),
    });
    assert.match(dms[0].message.text, /unboxing/);
  });
});

describe('Campaign status — own campaigns only', () => {
  async function seedVendor(env, id, record = {}) {
    await env.INSTAGRAM_CONVERSATIONS.put(
      `VENDOR:${id}`,
      JSON.stringify({ instagram_user_id: id, ...record }),
    );
  }

  async function seedCreator(env, id, record = {}) {
    await env.INSTAGRAM_CONVERSATIONS.put(
      `INFLUENCER:${id}`,
      JSON.stringify({ instagram_user_id: id, ...record }),
    );
  }

  async function seedCampaign(env, id, record) {
    await env.INSTAGRAM_CONVERSATIONS.put(
      `CAMPAIGN:${id}`,
      JSON.stringify({ campaign_id: id, ...record }),
    );
  }

  it('vendor sees each own campaign with state and next step', async () => {
    const env = createSyntheticEnv();
    const vendor = `st_${Date.now()}`;
    await seedVendor(env, vendor, { business_name: 'Status Shop' });
    await seedCampaign(env, 'st_unpaid', {
      vendor_instagram_user_id: vendor,
      campaign_title: 'Soap Launch',
      payment_status: 'PENDING',
      status: 'AWAITING_PAYMENT',
    });
    await seedCampaign(env, 'st_match', {
      vendor_instagram_user_id: vendor,
      campaign_title: 'Oil Promo',
      payment_status: 'CAPTURED',
      status: 'MATCHING',
    });
    await seedCampaign(env, 'st_acc', {
      vendor_instagram_user_id: vendor,
      campaign_title: 'Tea Time',
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['c1', 'c2'],
    });
    const { dms } = await postTextAndDrain({
      text: 'Where is my campaign?',
      env,
      tctx: createTestContext(),
      senderId: vendor,
    });
    const text = dms[0].message.text;
    assert.match(text, /Soap Launch — waiting for payment/);
    assert.match(text, /Complete payment from your campaign link/);
    assert.match(text, /Oil Promo — finding creators/);
    assert.match(text, /Tea Time — 2 creators on board/);
  });

  it('vendors never see another vendor campaigns', async () => {
    const env = createSyntheticEnv();
    await seedVendor(env, 'st_a', { business_name: 'Shop A' });
    await seedVendor(env, 'st_b', { business_name: 'Shop B' });
    await seedCampaign(env, 'st_secret', {
      vendor_instagram_user_id: 'st_a',
      campaign_title: 'Secret Launch',
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['c9'],
    });
    // Forged index entry pointing B at A's campaign must not leak it.
    await env.INSTAGRAM_CONVERSATIONS.put(
      'VENDOR_CAMPAIGN:st_b:st_secret',
      JSON.stringify({ v: 1, vendor_id: 'st_b', campaign_id: 'st_secret' }),
    );
    await env.INSTAGRAM_CONVERSATIONS.put(
      'VENDOR_CAMPAIGN_SYNC:st_b',
      JSON.stringify({ v: 1, scan_complete: true }),
    );
    const { dms } = await postTextAndDrain({
      text: 'What is the status of my campaign?',
      env,
      tctx: createTestContext(),
      senderId: 'st_b',
    });
    assert.match(dms[0].message.text, /No campaigns found on your vendor account/);
    assert.ok(!dms[0].message.text.includes('Secret Launch'));
  });

  it('creator sees invitations and accepted work, nothing else', async () => {
    const env = createSyntheticEnv();
    const creator = `sc_${Date.now()}`;
    await seedCreator(env, creator, {
      full_name: 'Statia',
      b8i_active_campaign_ids: ['sc_work'],
    });
    await seedCampaign(env, 'sc_offer', {
      vendor_instagram_user_id: 'some_vendor',
      campaign_title: 'Offer Campaign',
      payment_status: 'CAPTURED',
      status: 'PAID',
      required_influencers: 2,
      accepted_influencer_ids: [],
    });
    await env.INSTAGRAM_CONVERSATIONS.put(
      `INFLUENCER_OPPORTUNITY:${creator}:sc_offer`,
      JSON.stringify({ campaign_id: 'sc_offer', campaign_title: 'Offer Campaign', payout: 500 }),
    );
    await env.INSTAGRAM_CONVERSATIONS.put(
      `CAMPAIGN_RESPONSE:sc_offer:${creator}`,
      JSON.stringify({ status: 'notified' }),
    );
    await seedCampaign(env, 'sc_work', {
      vendor_instagram_user_id: 'some_vendor',
      campaign_title: 'Work Campaign',
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: [creator],
      influencer_work_statuses: { [creator]: { status: 'SUBMITTED' } },
    });
    const { dms } = await postTextAndDrain({
      text: 'What is the status of my application?',
      env,
      tctx: createTestContext(),
      senderId: creator,
    });
    const text = dms[0].message.text;
    assert.match(text, /Offer Campaign — invitation waiting/);
    assert.match(text, /Work Campaign — work submitted, waiting for vendor review/);
  });

  it('accounts without campaigns get role guidance, not data', async () => {
    const env = createSyntheticEnv();
    const { dms } = await postTextAndDrain({
      text: 'Track my campaign please',
      env,
      tctx: createTestContext(),
    });
    assert.match(dms[0].message.text, /do not see any campaigns on this account/);
  });

  it('backend read errors fail safe with a retry message', async () => {
    const env = createSyntheticEnv();
    const sender = `se_${Date.now()}`;
    await env.INSTAGRAM_CONVERSATIONS.put(
      `VENDOR:${sender}`,
      JSON.stringify({ instagram_user_id: sender, business_name: 'Err Shop' }),
    );
    const kv = env.INSTAGRAM_CONVERSATIONS;
    const origGet = kv.get.bind(kv);
    kv.get = async (key, opts) => {
      if (String(key).startsWith('VENDOR:') || String(key).startsWith('INFLUENCER:')) {
        throw new Error('synthetic storage failure');
      }
      return origGet(key, opts);
    };
    const { dms } = await postTextAndDrain({
      text: 'Where is my campaign?',
      env,
      tctx: createTestContext(),
      senderId: sender,
    });
    delete kv.get;
    assert.match(dms[0].message.text, /can't pull up campaigns right now/);
    assert.ok(!dms[0].message.text.includes('Err Shop'));
  });

  it('disputed and completed states explain the next step', async () => {
    const env = createSyntheticEnv();
    const vendor = `sd_${Date.now()}`;
    await seedVendor(env, vendor, {});
    await seedCampaign(env, 'sd_disp', {
      vendor_instagram_user_id: vendor,
      campaign_title: 'Disputed One',
      payment_status: 'CAPTURED',
      status: 'DISPUTED',
    });
    await seedCampaign(env, 'sd_done', {
      vendor_instagram_user_id: vendor,
      campaign_title: 'Done One',
      payment_status: 'CAPTURED',
      status: 'COMPLETED',
    });
    const { dms } = await postTextAndDrain({
      text: 'Give me a campaign status update',
      env,
      tctx: createTestContext(),
      senderId: vendor,
    });
    assert.match(dms[0].message.text, /Disputed One — under review/);
    assert.match(dms[0].message.text, /Done One — complete/);
    assert.match(dms[0].message.text, /processed manually/);
  });

  it('status signals do not steal recommendations or creation guides', async () => {
    const env = createSyntheticEnv();
    await env.INSTAGRAM_CONVERSATIONS.put(
      'INFLUENCER:st_r1',
      JSON.stringify({
        instagram_user_id: 'st_r1',
        verification_status: 'APPROVED',
        subscription_status: 'active',
        full_name: 'Statira',
        niche: 'food',
        followers: 20000,
      }),
    );
    const reco = await postTextAndDrain({
      text: 'Recommend influencers for my campaign.',
      env,
      tctx: createTestContext(),
    });
    assert.match(reco.dms[0].message.text, /I found 1 eligible creator/);
    const steps = await postTextAndDrain({
      text: 'How do I create a campaign?',
      env,
      tctx: createTestContext(),
    });
    assert.match(steps.dms[0].message.text, /To create a campaign on B8i/);
  });

  it('legacy vendors get status through backfill', async () => {
    const env = createSyntheticEnv();
    const vendor = `sl_${Date.now()}`;
    await seedVendor(env, vendor, {});
    await seedCampaign(env, 'sl_old', {
      vendor_instagram_user_id: vendor,
      campaign_title: 'Legacy Launch',
      payment_status: 'CAPTURED',
      status: 'MATCHING',
    });
    const { dms } = await postTextAndDrain({
      text: 'Where is my campaign?',
      env,
      tctx: createTestContext(),
      senderId: vendor,
    });
    assert.match(dms[0].message.text, /Legacy Launch — finding creators/);
    const markerRaw = await env.INSTAGRAM_CONVERSATIONS.get(`VENDOR_CAMPAIGN_SYNC:${vendor}`);
    assert.equal(JSON.parse(markerRaw).scan_complete, true);
  });
});

describe('Payout invariants — manual only', () => {
  function razorpayAttemptsSince(index) {
    return isolation.attempts.slice(index).filter((a) => a.url.includes('api.razorpay.com'));
  }

  it('single payout stays inert without the route flag', async () => {
    const env = createSyntheticEnv();
    assert.equal(env.RAZORPAY_ROUTE_ENABLED, undefined);
    await env.INSTAGRAM_CONVERSATIONS.put(
      'INFLUENCER:pay_1',
      JSON.stringify({
        instagram_user_id: 'pay_1',
        razorpay_linked_account_id: 'acc_linked',
        upi_id: 'pay1@upi',
      }),
    );
    const campaign = {
      campaign_id: 'camp_pay1',
      campaign_title: 'Pay Campaign',
      compensation_type: 'money',
      influencer_id: 'pay_1',
      budget: 10000,
      required_influencers: 1,
    };
    const mark = isolation.attempts.length;
    await initiateInfluencerPayout(campaign, env);
    assert.deepEqual(razorpayAttemptsSince(mark), []);
    assert.equal(campaign.payout_status, undefined);
    assert.equal(campaign.razorpay_transfer_id, undefined);
  });

  it('multi payout stays inert without the route flag', async () => {
    const env = createSyntheticEnv();
    const campaign = {
      campaign_id: 'camp_pay2',
      campaign_title: 'Pay Campaign 2',
      compensation_type: 'money',
      budget: 20000,
      required_influencers: 2,
      accepted_influencer_ids: ['pay_a', 'pay_b'],
    };
    const mark = isolation.attempts.length;
    await initiateInfluencerPayoutsEnhanced(campaign, env);
    assert.deepEqual(razorpayAttemptsSince(mark), []);
    assert.equal(campaign.payout_transfer_records, undefined);
  });

  it('enabled flag reaches the transfer call (gate is load-bearing)', async () => {
    const env = createSyntheticEnv();
    env.RAZORPAY_ROUTE_ENABLED = 'true';
    await env.INSTAGRAM_CONVERSATIONS.put(
      'INFLUENCER:pay_3',
      JSON.stringify({
        instagram_user_id: 'pay_3',
        razorpay_linked_account_id: 'acc_linked',
        upi_id: 'pay3@upi',
      }),
    );
    const campaign = {
      campaign_id: 'camp_pay3',
      campaign_title: 'Pay Campaign 3',
      compensation_type: 'money',
      influencer_id: 'pay_3',
      budget: 10000,
      required_influencers: 1,
    };
    const mark = isolation.attempts.length;
    await assert.rejects(
      () => initiateInfluencerPayout(campaign, env),
      /NETWORK_ISOLATION_BLOCKED/,
    );
    const attempts = razorpayAttemptsSince(mark);
    assert.equal(attempts.length, 1);
    assert.ok(attempts[0].blocked);
  });

  it('barter campaigns never reach transfers even when enabled', async () => {
    const env = createSyntheticEnv();
    env.RAZORPAY_ROUTE_ENABLED = 'true';
    const single = {
      campaign_id: 'camp_bar1',
      compensation_type: 'product_for_post',
      influencer_id: 'pay_1',
      budget: 0,
    };
    const multi = {
      campaign_id: 'camp_bar2',
      compensation_type: 'product_for_post',
      budget: 0,
      accepted_influencer_ids: ['pay_a'],
    };
    const mark = isolation.attempts.length;
    await initiateInfluencerPayout(single, env);
    await initiateInfluencerPayoutsEnhanced(multi, env);
    assert.deepEqual(razorpayAttemptsSince(mark), []);
  });

  it('mark-paid requires admin key, record, and reference', async () => {
    const env = createSyntheticEnv({ ADMIN_API_KEY: 'TEST_ONLY_admin_key' });
    await env.INSTAGRAM_CONVERSATIONS.put(
      'MPAY:camp_m1:pay_m1',
      JSON.stringify({
        status: 'READY_FOR_MANUAL_PAYMENT',
        campaign_id: 'camp_m1',
        campaign_title: 'Manual One',
        influencer_instagram_user_id: 'pay_m1',
        amount: 1500,
      }),
    );
    const post = (body, key) => worker.fetch(
      new Request(`${TEST_ORIGIN}/admin/payouts/mark-paid`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { 'X-Admin-Key': key } : {}),
        },
        body: JSON.stringify(body),
      }),
      env,
      createTestContext().ctx,
    );
    const adminKey = env.ADMIN_API_KEY;
    let res = await post({ record_id: 'MPAY:camp_m1:pay_m1', payment_reference: 'ref-1' });
    assert.equal(res.status, 401);
    res = await post({ record_id: 'MPAY:camp_m1:pay_m1', payment_reference: 'ref-1' }, 'wrong-key');
    assert.equal(res.status, 401);
    res = await post({ record_id: 'MPAY:camp_m1:pay_m1' }, adminKey);
    assert.equal(res.status, 400);
    res = await post({ record_id: 'MPAY:nope:nobody', payment_reference: 'ref-1' }, adminKey);
    assert.equal(res.status, 404);
    const stored = JSON.parse(
      await env.INSTAGRAM_CONVERSATIONS.get('MPAY:camp_m1:pay_m1'),
    );
    assert.equal(stored.status, 'READY_FOR_MANUAL_PAYMENT');
  });
});

describe('Audit fixes — constant-time admin compare and redacted payout logs', () => {
  it('timingSafeEqual accepts matches and rejects mismatches safely', () => {
    assert.equal(timingSafeEqual('TEST_ONLY_admin_key', 'TEST_ONLY_admin_key'), true);
    assert.equal(timingSafeEqual('TEST_ONLY_admin_key', 'TEST_ONLY_admin_kez'), false);
    assert.equal(timingSafeEqual('short', 'a much longer string'), false);
    assert.equal(timingSafeEqual('', ''), true);
    assert.equal(timingSafeEqual('key', ''), false);
    assert.equal(timingSafeEqual(null, 'key'), false);
    assert.equal(timingSafeEqual('key', undefined), false);
    assert.equal(timingSafeEqual(12345, 12345), false);
  });

  it('admin endpoints keep 401 behavior under constant-time compare', async () => {
    const env = createSyntheticEnv({ ADMIN_API_KEY: 'TEST_ONLY_admin_key' });
    const post = (body, key) => worker.fetch(
      new Request(`${TEST_ORIGIN}/admin/payouts/mark-paid`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { 'X-Admin-Key': key } : {}),
        },
        body: JSON.stringify(body),
      }),
      env,
      createTestContext().ctx,
    );
    // Same-length near-miss exercises the constant-time path; still 401.
    let res = await post(
      { record_id: 'MPAY:nope:nobody', payment_reference: 'ref-1' },
      'TEST_ONLY_admin_kez',
    );
    assert.equal(res.status, 401);
    // Correct key passes auth (404: record simply missing).
    res = await post(
      { record_id: 'MPAY:nope:nobody', payment_reference: 'ref-1' },
      'TEST_ONLY_admin_key',
    );
    assert.equal(res.status, 404);
  });

  it('payout debug logs never emit creator names, handles, or phone numbers', async () => {
    const env = createSyntheticEnv({ ADMIN_IG_USER_ID: 'admin_ig_1' });
    await env.INSTAGRAM_CONVERSATIONS.put(
      'INFLUENCER:redact_1',
      JSON.stringify({
        instagram_user_id: 'redact_1',
        instagram_username: 'redacted_handle_zzz',
        full_name: 'Redacted Fullname Zzz',
        phone: '+91-99999-11111',
        upi_id: 'redact1@upi',
      }),
    );
    const campaign = {
      campaign_id: 'camp_redact1',
      campaign_title: 'Redaction Check',
      compensation_type: 'money',
      budget: 5000,
      required_influencers: 1,
      accepted_influencer_ids: ['redact_1'],
    };
    const captured = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => { captured.push(args); };
    console.error = (...args) => { captured.push(args); };
    let recordIds;
    try {
      recordIds = await createManualPayoutRecords(campaign, env, ['redact_1']);
    } finally {
      console.log = origLog;
      console.error = origError;
    }
    assert.deepEqual(recordIds, ['MPAY:camp_redact1:redact_1']);
    const text = JSON.stringify(captured);
    for (const secret of [
      'Redacted Fullname Zzz',
      'redacted_handle_zzz',
      '+91-99999-11111',
      'redact1@upi',
    ]) {
      assert.ok(!text.includes(secret), `payout log leaked: ${secret}`);
    }
    assert.ok(text.includes('redact_1'), 'diagnostic id must remain for troubleshooting');
  });
});

before(() => {
  assertSyntheticEnv(createSyntheticEnv());
});

after(() => {
  console.log(
    `[phase1] captured DMs: ${isolation.sentMessages.length}, counters: ${JSON.stringify(isolation.counters)}`,
  );
  isolation.restore();
});
