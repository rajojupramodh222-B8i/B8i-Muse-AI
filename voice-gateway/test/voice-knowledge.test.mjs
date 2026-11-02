// Maintained tests for the shared B8i knowledge service (voice side).
// The Worker owns the canonical facts at GET /api/b8i/knowledge; these tests
// prove the gateway validates, caches, and renders that payload without
// inventing prices, limits, or support details. Network is stubbed in-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWLEDGE_VERSION,
  answerFromKnowledge,
  buildMuseKnowledgeBlock,
  createKnowledgeCache,
  supportContactLine,
  validateKnowledge
} from '../src/services/knowledge.js';
import { B8iWorkerError, getB8iKnowledge } from '../src/services/b8i-worker.js';

/** Contract-shaped payload. Amounts are intentionally distinctive so tests
 *  prove derivation from the payload instead of hard-coded numbers. */
export const sampleKnowledge = () => ({
  ok: true,
  version: KNOWLEDGE_VERSION,
  updated_at: '2026-11-02T00:00:00.000Z',
  marketplace: {
    summary: 'B8i connects businesses with influencers for paid campaigns and product collaborations.'
  },
  influencer_membership: {
    plans: [
      { key: 'starter', name: 'Starter', amount: 111, currency: 'INR', interval: 'monthly', request_limit: 5, description: '5 campaign requests per month.' },
      { key: 'growth', name: 'Growth', amount: 222, currency: 'INR', interval: 'monthly', request_limit: 15, description: '15 campaign requests per month.' },
      { key: 'pro', name: 'Pro', amount: 333, currency: 'INR', interval: 'monthly', request_limit: null, description: 'Unlimited eligible campaign requests.' }
    ],
    notes: ['No free subscription or free trial.']
  },
  vendor_campaigns: {
    platform_fee_percent: 8,
    min_creator_payout: 5000,
    currency: 'INR',
    product_for_post_tiers: [
      { max_creators: 1, per_creator: 399, label: '1 creator' },
      { max_creators: 4, per_creator: 299, label: '2 to 4 creators' },
      { max_creators: 9, per_creator: 249, label: '5 to 9 creators' },
      { max_creators: null, per_creator: 200, label: '10 or more creators' }
    ]
  },
  eligibility: {
    min_followers: 3500,
    guideline: 'Genuine reach and engagement matter too; admin review decides.'
  },
  registration: {
    influencer: 'Complete your profile, verification, and membership to become eligible.',
    vendor: 'Enter brand and campaign details, then complete payment securely.',
    verification: 'Every creator is manually reviewed before activation.'
  },
  payments: {
    provider: 'Razorpay',
    refund_policy: 'Refunds are processed manually by the B8i admin team.',
    escalation: 'Reply "support" and B8i customer support will help with your specific payment.'
  },
  support: {
    phone: '+91-90000-00000',
    text: 'B8i Customer Support: +91-90000-00000. Please call our support team if you need help.'
  },
  content_niches: ['Fashion', 'Food'],
  details: {
    membership_benefits: 'Membership makes a creator eligible to receive campaign invitations.',
    renewal: 'A fresh checkout starts a new subscription.',
    cancellation: 'To cancel a membership, contact B8i support for help.',
    campaign_deliverables: 'Each campaign agrees a number of reels and posts.',
    payment_status: 'After a verified membership payment the profile shows Under Review.',
    troubleshooting: 'Open registration links in Chrome or Safari.',
    faqs: [{ q: 'Who do I contact about a payment?', a: 'Reply support.' }]
  },
  fallback: "I can't confirm that detail. Please contact B8i customer support."
});

const clientFor = (overrides = {}) => ({
  enabled: true,
  baseUrl: 'https://worker.test',
  token: 'TEST_ONLY_voice_token',
  timeoutMs: 2000,
  ...overrides
});

function installFetchMock(handler) {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method || 'GET' });
    return handler(String(url), init);
  };
  return { seen, restore: () => { globalThis.fetch = orig; } };
}

const jsonRes = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

test('validateKnowledge accepts the contract payload and rejects bad shapes', () => {
  const good = validateKnowledge(sampleKnowledge());
  assert.equal(good.ok, true);
  assert.equal(good.knowledge.version, KNOWLEDGE_VERSION);

  const badPlans = sampleKnowledge();
  badPlans.influencer_membership.plans = [];
  assert.equal(validateKnowledge(badPlans).ok, false);

  const badVersion = sampleKnowledge();
  badVersion.version = 99;
  assert.equal(validateKnowledge(badVersion).ok, false);

  const badSupport = sampleKnowledge();
  badSupport.support = { phone: null, text: '' };
  assert.equal(validateKnowledge(badSupport).ok, false);

  assert.equal(validateKnowledge(null).ok, false);
  assert.equal(validateKnowledge({ ok: true }).ok, false);
});

test('getB8iKnowledge fetches the endpoint and validates strictly', async () => {
  const mock = installFetchMock(url => {
    assert.match(url, /\/api\/b8i\/knowledge$/);
    return jsonRes(200, sampleKnowledge());
  });
  try {
    const out = await getB8iKnowledge(clientFor());
    assert.equal(out.version, KNOWLEDGE_VERSION);
    assert.equal(out.influencer_membership.plans.length, 3);
    assert.equal(mock.seen.length, 1);
  } finally {
    mock.restore();
  }

  const bad = installFetchMock(() => jsonRes(200, { ok: true, version: 99 }));
  try {
    await assert.rejects(getB8iKnowledge(clientFor()), err => {
      assert.ok(err instanceof B8iWorkerError);
      assert.equal(err.code, 'invalid_response');
      return true;
    });
  } finally {
    bad.restore();
  }

  const down = installFetchMock(() => jsonRes(503, { error: 'unavailable' }));
  try {
    await assert.rejects(getB8iKnowledge(clientFor()), err => {
      assert.ok(err instanceof B8iWorkerError);
      assert.equal(err.code, 'http_503');
      return true;
    });
  } finally {
    down.restore();
  }
});

test('voice answers derive every number from the payload (no hard-coding)', () => {
  const k = sampleKnowledge();
  const plans = answerFromKnowledge(k, 'plans');
  assert.match(plans, /₹111/);
  assert.match(plans, /₹222/);
  assert.match(plans, /₹333/);
  assert.match(plans, /not vendor charges/);

  const fee = answerFromKnowledge(k, 'vendor_fee');
  assert.match(fee, /8%/);
  assert.match(fee, /₹5,000/);

  const pfp = answerFromKnowledge(k, 'product_for_post');
  assert.match(pfp, /₹399/);
  assert.match(pfp, /₹200/);
  assert.match(pfp, /no cash payout/i);

  const elig = answerFromKnowledge(k, 'eligibility');
  assert.match(elig, /3,500/);

  assert.match(answerFromKnowledge(k, 'marketplace'), /paid campaigns and product collaborations/);
  assert.match(answerFromKnowledge(k, 'niches'), /Fashion/);
  assert.match(answerFromKnowledge(k, 'membership'), /eligible to receive campaign invitations/);
  assert.match(answerFromKnowledge(k, 'campaigns'), /reels and posts/);
  assert.match(answerFromKnowledge(k, 'troubleshooting'), /Chrome or Safari/);
  assert.equal(answerFromKnowledge(k, 'nope'), null);
  assert.equal(answerFromKnowledge(null, 'plans'), null);
});

test('unknown fees fall back to cannot-confirm instead of invented numbers', () => {
  const missing = sampleKnowledge();
  delete missing.influencer_membership;
  assert.equal(validateKnowledge(missing).ok, false);
  assert.equal(answerFromKnowledge(missing, 'plans'), null);
  assert.match(buildMuseKnowledgeBlock(missing), /unavailable/);

  const empty = sampleKnowledge();
  empty.influencer_membership.plans = [];
  assert.equal(answerFromKnowledge(empty, 'plans'), null);
});

test('payments, refunds, and support always escalate without claiming resolution', () => {
  const k = sampleKnowledge();
  const pay = answerFromKnowledge(k, 'payments');
  assert.match(pay, /Razorpay/);
  assert.match(pay, /can't check or change/);
  assert.match(pay, /support/);

  const refund = answerFromKnowledge(k, 'refunds');
  assert.match(refund, /manually/);
  assert.match(refund, /support/);
  assert.doesNotMatch(refund, /approve|resolve your/i);

  assert.match(answerFromKnowledge(k, 'support'), /\+91-90000-00000/);

  const noPhone = sampleKnowledge();
  noPhone.support = { phone: null, text: 'B8i Customer Support. The support phone number is currently being configured.' };
  assert.match(supportContactLine(noPhone), /being configured/);
  assert.doesNotMatch(supportContactLine(noPhone), /\+91/);
});

test('Muse knowledge block embeds verified facts, or fails closed', () => {
  const withFacts = buildMuseKnowledgeBlock(sampleKnowledge());
  assert.match(withFacts, /₹111/);
  assert.match(withFacts, /₹333/);
  assert.match(withFacts, /8% platform fee/);
  assert.match(withFacts, /3,500 followers/);
  assert.match(withFacts, /cannot confirm the detail/);
  assert.match(withFacts, /cannot check, change, approve, or resolve any payment/);
  assert.match(withFacts, /\+91-90000-00000/);

  const withoutFacts = buildMuseKnowledgeBlock(null);
  assert.match(withoutFacts, /unavailable/);
  assert.match(withoutFacts, /Do not state any fee, price/);
  assert.doesNotMatch(withoutFacts, /₹111/);
  assert.doesNotMatch(withoutFacts, /3,500/);

  const invalid = buildMuseKnowledgeBlock({ ok: true, version: 99 });
  assert.match(invalid, /unavailable/);
});

test('knowledge cache fetches once per TTL and shares in-flight loads', async () => {
  let loads = 0;
  const cache = createKnowledgeCache({
    ttlMs: 60_000,
    load: async () => {
      loads++;
      return sampleKnowledge();
    }
  });
  const [a, b] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(loads, 1);
  assert.equal(a, b);
  assert.ok(cache.peek());
  await cache.get(true);
  assert.equal(loads, 2);
  cache.clear();
  assert.equal(cache.peek(), null);
});
