// Maintained tests for the Muse Spark request wiring and registration prompt.
// The model itself is never called: fetch is stubbed in-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerWithMuse, buildSystemPrompt } from '../src/services/muse.js';

const REQUIRED_PHRASES = [
  'one question at a time',
  'influencer registration',
  'vendor registration',
  'verification is still required',
  'Never claim',
  'Never ask for passwords',
  'cannot confirm',
  'customer support'
];

test('answerWithMuse sends model, system prompt, and messages', async () => {
  const origFetch = globalThis.fetch;
  const origKey = process.env.META_MODEL_API_KEY;
  const origBase = process.env.META_BASE_URL;
  const origName = process.env.META_MODEL_NAME;
  const seen = [];
  process.env.META_MODEL_API_KEY = 'TEST_ONLY_model_key';
  process.env.META_BASE_URL = 'https://model.test/';
  delete process.env.META_MODEL_NAME;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(
      JSON.stringify({ content: [{ type: 'text', text: 'Hello there.' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
  try {
    const reply = await answerWithMuse([{ role: 'user', content: 'hi' }]);
    assert.equal(reply, 'Hello there.');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://model.test/v1/messages');
    assert.equal(seen[0].init.method, 'POST');
    assert.equal(seen[0].init.headers.authorization, 'Bearer TEST_ONLY_model_key');
    const body = JSON.parse(seen[0].init.body);
    assert.equal(body.model, 'muse-spark-1.3');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
    for (const phrase of REQUIRED_PHRASES) {
      assert.ok(
        body.system.includes(phrase),
        `system prompt is missing required phrase: ${phrase}`
      );
    }
  } finally {
    globalThis.fetch = origFetch;
    if (origKey === undefined) delete process.env.META_MODEL_API_KEY;
    else process.env.META_MODEL_API_KEY = origKey;
    if (origBase === undefined) delete process.env.META_BASE_URL;
    else process.env.META_BASE_URL = origBase;
    if (origName === undefined) delete process.env.META_MODEL_NAME;
    else process.env.META_MODEL_NAME = origName;
  }
});

test('system prompt states no hard-coded fee or policy number without knowledge', () => {
  const system = buildSystemPrompt(null);
  assert.match(system, /Live B8i facts are unavailable/);
  assert.doesNotMatch(system, /3,500/);
  assert.doesNotMatch(system, /₹199/);
  assert.doesNotMatch(system, /8% platform fee/);
});

test('answerWithMuse injects verified knowledge facts when provided', async () => {
  const origFetch = globalThis.fetch;
  const origKey = process.env.META_MODEL_API_KEY;
  process.env.META_MODEL_API_KEY = 'TEST_ONLY_model_key';
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(
      JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
  const knowledge = {
    ok: true,
    version: 1,
    updated_at: '2026-11-02T00:00:00.000Z',
    marketplace: { summary: 'B8i connects businesses with influencers.' },
    influencer_membership: {
      plans: [
        { key: 'starter', name: 'Starter', amount: 111, currency: 'INR', interval: 'monthly', request_limit: 5, description: '' }
      ],
      notes: []
    },
    vendor_campaigns: {
      platform_fee_percent: 8,
      min_creator_payout: 5000,
      currency: 'INR',
      product_for_post_tiers: [{ max_creators: 1, per_creator: 399, label: '1 creator' }]
    },
    eligibility: { min_followers: 3500, guideline: '' },
    registration: { influencer: '', vendor: '', verification: '' },
    payments: { provider: 'Razorpay', refund_policy: 'Manual refunds.', escalation: 'Contact support.' },
    support: { phone: null, text: 'B8i Customer Support.' },
    content_niches: [],
    details: {
      membership_benefits: 'Benefits.',
      renewal: 'Renewal.',
      cancellation: 'Cancellation.',
      campaign_deliverables: 'Deliverables.',
      payment_status: 'Status.',
      troubleshooting: 'Troubleshooting.',
      faqs: [{ q: 'Q?', a: 'A.' }]
    },
    fallback: "I can't confirm that detail."
  };
  try {
    await answerWithMuse([{ role: 'user', content: 'what are the plans?' }], { knowledge });
    const body = JSON.parse(seen[0].init.body);
    assert.match(body.system, /₹111/);
    assert.match(body.system, /3,500 followers/);
    assert.match(body.system, /cannot confirm the detail/);
  } finally {
    globalThis.fetch = origFetch;
    if (origKey === undefined) delete process.env.META_MODEL_API_KEY;
    else process.env.META_MODEL_API_KEY = origKey;
  }
});

test('answerWithMuse fails closed without an API key', async () => {
  const orig = process.env.META_MODEL_API_KEY;
  delete process.env.META_MODEL_API_KEY;
  try {
    await assert.rejects(answerWithMuse([{ role: 'user', content: 'hi' }]), /not configured/);
  } finally {
    if (orig !== undefined) process.env.META_MODEL_API_KEY = orig;
  }
});

test('answerWithMuse rejects empty model text', async () => {
  const origFetch = globalThis.fetch;
  const origKey = process.env.META_MODEL_API_KEY;
  process.env.META_MODEL_API_KEY = 'TEST_ONLY_model_key';
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ content: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  try {
    await assert.rejects(answerWithMuse([{ role: 'user', content: 'hi' }]), /no text/);
  } finally {
    globalThis.fetch = origFetch;
    if (origKey === undefined) delete process.env.META_MODEL_API_KEY;
    else process.env.META_MODEL_API_KEY = origKey;
  }
});
