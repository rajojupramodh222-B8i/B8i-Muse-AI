// COPY TO: C:\B8i\test\lifecycle-payments.test.mjs
// (Mirror lives in the gateway repo; run docs/run-audit-suites.cjs to sync+run.)
//
// Subscription lifecycle (webhooks, renewal, expiry), payment capability
// tokens + order idempotency, admin session TTL, and free-tier-disabled
// evidence.
//
// Safety: synthetic env + in-memory KV + test-only origin only. Razorpay
// HTTP is answered by an in-test mock wrapper; nothing leaves the process.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../worker.js';
import {
  TEST_ORIGIN,
  createSyntheticEnv,
  assertSyntheticEnv,
  installNetworkIsolation,
  createTestContext,
  drainWaitUntil,
} from './helpers.mjs';

const isolation = installNetworkIsolation();

let seq = 0;
const nextId = (prefix) => `${prefix}_${Date.now()}_${(seq += 1)}`;

function lifecycleEnv(overrides = {}) {
  const env = createSyntheticEnv({
    RZP_PLAN_STARTER: 'plan_test_starter',
    RZP_PLAN_GROWTH: 'plan_test_growth',
    RZP_PLAN_PRO: 'plan_test_pro',
    THEVAL_ADMIN_API_KEY: 'TEST_ONLY_admin_key_9f2c7a41',
    ...overrides,
  });
  assertSyntheticEnv(env);
  return env;
}

async function kvPut(env, key, value) {
  await env.INSTAGRAM_CONVERSATIONS.put(key, JSON.stringify(value));
}

async function kvJson(env, key) {
  const raw = await env.INSTAGRAM_CONVERSATIONS.get(key);
  return raw ? JSON.parse(raw) : null;
}

// Answers api.razorpay.com shapes; delegates everything else to the
// isolation stub. Records calls for idempotency assertions.
function installRazorpayMock() {
  const inner = globalThis.fetch;
  const calls = { orders: [], subscriptions: [], plans: [] };
  const planAmount = (id) => {
    if (String(id).includes('starter')) return 19900;
    if (String(id).includes('growth')) return 29900;
    return 49900;
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = typeof url === 'string' ? url : String(url?.url ?? '');
    if (u.startsWith('https://api.razorpay.com/')) {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && u.includes('/v1/plans/')) {
        const id = decodeURIComponent(u.split('/v1/plans/')[1].split('?')[0]);
        calls.plans.push(id);
        return Response.json({
          id,
          item: { amount: planAmount(id), currency: 'INR' },
          period: 'monthly',
          interval: 1,
        });
      }
      if (method === 'POST' && u.endsWith('/v1/orders')) {
        const body = JSON.parse(init.body);
        calls.orders.push(body);
        return Response.json({
          id: `order_test_${calls.orders.length}`,
          amount: body.amount,
          currency: body.currency || 'INR',
          status: 'created',
        });
      }
      if (method === 'POST' && u.endsWith('/v1/subscriptions')) {
        const body = JSON.parse(init.body);
        calls.subscriptions.push(body);
        return Response.json({ id: `sub_test_${calls.subscriptions.length}`, status: 'created' });
      }
      throw new Error(`unexpected Razorpay call in test: ${method} ${u}`);
    }
    return inner(url, init);
  };
  return { calls, restore: () => void (globalThis.fetch = inner) };
}

async function postRazorpayWebhook({ env, event, entityKey, entity, eventId = null }) {
  const tctx = createTestContext();
  const rawBody = JSON.stringify({ event, payload: { [entityKey]: { entity } } });
  const sig = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  const headers = { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig };
  if (eventId) headers['X-Razorpay-Event-Id'] = eventId;
  const res = await worker.fetch(
    new Request(`${TEST_ORIGIN}/webhooks/razorpay`, { method: 'POST', headers, body: rawBody }),
    env,
    tctx.ctx,
  );
  await drainWaitUntil(tctx);
  return res;
}

const seedInfluencer = (overrides = {}) => {
  const id = nextId('lc_inf');
  return {
    id,
    record: {
      instagram_user_id: id,
      instagram_username: id,
      full_name: 'Lifecycle Tester',
      followers_count: 6000,
      verification_status: 'APPROVED',
      subscription_status: 'active',
      ...overrides,
    },
  };
};

describe('subscription webhook lifecycle', () => {
  it('activated keeps unapproved creators Under Review; approved+paid go active', async () => {
    const env = lifecycleEnv();
    const pending = seedInfluencer({ subscription_id: 'sub_pend_1', subscription_admin_status: 'PENDING', verification_status: 'UNDER_REVIEW' });
    const approved = seedInfluencer({ subscription_id: 'sub_appr_1', subscription_admin_status: 'APPROVED' });
    await kvPut(env, `INFLUENCER:${pending.id}`, pending.record);
    await kvPut(env, `INFLUENCER:${approved.id}`, approved.record);
    await kvPut(env, 'RZP_SUBSCRIPTION:sub_pend_1', { instagram_user_id: pending.id, plan: 'growth', status: 'created', payment_received: true, payment_id: 'pay_1' });
    await kvPut(env, 'RZP_SUBSCRIPTION:sub_appr_1', { instagram_user_id: approved.id, plan: 'growth', status: 'created', payment_received: true, payment_id: 'pay_2', admin_approval_status: 'APPROVED' });

    await postRazorpayWebhook({ env, event: 'subscription.activated', entityKey: 'subscription', entity: { id: 'sub_pend_1' }, eventId: nextId('evt') });
    await postRazorpayWebhook({ env, event: 'subscription.activated', entityKey: 'subscription', entity: { id: 'sub_appr_1' }, eventId: nextId('evt') });

    const pendAfter = await kvJson(env, `INFLUENCER:${pending.id}`);
    assert.equal(pendAfter.subscription_status, 'pending_admin_approval');
    assert.equal(pendAfter.verification_status, 'UNDER_REVIEW');
    const apprAfter = await kvJson(env, `INFLUENCER:${approved.id}`);
    assert.equal(apprAfter.subscription_status, 'active');
  });

  it('terminal webhooks clear payment flags so renewal is possible', async () => {
    for (const event of ['subscription.completed', 'subscription.cancelled', 'subscription.halted', 'subscription.expired']) {
      const env = lifecycleEnv();
      const inf = seedInfluencer({ subscription_id: 'sub_term_1', subscription_payment_received: true, subscription_payment_id: 'pay_old', subscription_admin_status: 'APPROVED' });
      await kvPut(env, `INFLUENCER:${inf.id}`, inf.record);
      await kvPut(env, 'RZP_SUBSCRIPTION:sub_term_1', { instagram_user_id: inf.id, plan: 'growth', status: 'active', payment_received: true, payment_id: 'pay_old' });
      const res = await postRazorpayWebhook({ env, event, entityKey: 'subscription', entity: { id: 'sub_term_1' }, eventId: nextId('evt') });
      assert.equal(res.status, 200);
      const after = await kvJson(env, `INFLUENCER:${inf.id}`);
      assert.equal(after.subscription_status, 'inactive');
      assert.equal(after.subscription_payment_received, false);
      assert.equal(after.subscription_payment_id, null);
    }
  });

  it('paused deactivates without clearing flags; pending is a no-op; resumed honors approval', async () => {
    const env = lifecycleEnv();
    const paused = seedInfluencer({ subscription_id: 'sub_pause_1', subscription_payment_received: true, subscription_payment_id: 'pay_p' });
    await kvPut(env, `INFLUENCER:${paused.id}`, paused.record);
    await kvPut(env, 'RZP_SUBSCRIPTION:sub_pause_1', { instagram_user_id: paused.id, status: 'active', payment_received: true, payment_id: 'pay_p' });
    await postRazorpayWebhook({ env, event: 'subscription.paused', entityKey: 'subscription', entity: { id: 'sub_pause_1' }, eventId: nextId('evt') });
    const pausedAfter = await kvJson(env, `INFLUENCER:${paused.id}`);
    assert.equal(pausedAfter.subscription_status, 'inactive');
    assert.equal(pausedAfter.subscription_payment_received, true);

    const pend = seedInfluencer({ subscription_id: 'sub_pend_2' });
    await kvPut(env, `INFLUENCER:${pend.id}`, pend.record);
    await kvPut(env, 'RZP_SUBSCRIPTION:sub_pend_2', { instagram_user_id: pend.id, status: 'created' });
    await postRazorpayWebhook({ env, event: 'subscription.pending', entityKey: 'subscription', entity: { id: 'sub_pend_2' }, eventId: nextId('evt') });
    assert.equal((await kvJson(env, `INFLUENCER:${pend.id}`)).subscription_status, 'active');

    const resumed = seedInfluencer({ subscription_id: 'sub_res_1', subscription_status: 'inactive', subscription_admin_status: 'APPROVED' });
    await kvPut(env, `INFLUENCER:${resumed.id}`, resumed.record);
    await kvPut(env, 'RZP_SUBSCRIPTION:sub_res_1', { instagram_user_id: resumed.id, status: 'active' });
    await postRazorpayWebhook({ env, event: 'subscription.resumed', entityKey: 'subscription', entity: { id: 'sub_res_1' }, eventId: nextId('evt') });
    assert.equal((await kvJson(env, `INFLUENCER:${resumed.id}`)).subscription_status, 'active');
  });

  it('duplicate webhook delivery is idempotent', async () => {
    const env = lifecycleEnv();
    const inf = seedInfluencer({ subscription_id: 'sub_dup_1' });
    await kvPut(env, `INFLUENCER:${inf.id}`, inf.record);
    await kvPut(env, 'RZP_SUBSCRIPTION:sub_dup_1', { instagram_user_id: inf.id, plan: 'growth', status: 'created', payment_received: true, payment_id: 'pay_d', admin_approval_status: 'APPROVED' });
    const eventId = nextId('evt_dup');
    const entity = { id: 'sub_dup_1' };
    const first = await postRazorpayWebhook({ env, event: 'subscription.activated', entityKey: 'subscription', entity, eventId });
    assert.equal(first.status, 200);
    const second = await postRazorpayWebhook({ env, event: 'subscription.activated', entityKey: 'subscription', entity, eventId });
    assert.equal(second.status, 200);
    const evt = await kvJson(env, `RZP_EVENT:${eventId}`);
    assert.equal(evt.status, 'processed');
    const after = await kvJson(env, `INFLUENCER:${inf.id}`);
    assert.equal(after.subscription_status, 'active');
  });

  it('full renewal: completed sub can re-subscribe (no 409 trap)', async () => {
    const mock = installRazorpayMock();
    try {
      const env = lifecycleEnv();
      const inf = seedInfluencer({ subscription_id: 'sub_old_1', subscription_admin_status: 'APPROVED' });
      await kvPut(env, `INFLUENCER:${inf.id}`, inf.record);
      await kvPut(env, 'RZP_SUBSCRIPTION:sub_old_1', { instagram_user_id: inf.id, plan: 'growth', status: 'active', payment_received: true, payment_id: 'pay_old' });
      await postRazorpayWebhook({ env, event: 'subscription.completed', entityKey: 'subscription', entity: { id: 'sub_old_1' }, eventId: nextId('evt') });

      // Fresh plans-page capability, then subscribe again.
      const plans = await worker.fetch(
        new Request(`${TEST_ORIGIN}/influencer/plans?instagram_user_id=${inf.id}`),
        env,
        createTestContext().ctx,
      );
      assert.equal(plans.status, 200);
      const subKeys = env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('SUBCAP:');
      assert.equal(subKeys.length, 1);
      const capToken = subKeys[0].replace(/^SUBCAP:/, '');
      const res = await worker.fetch(
        new Request(`${TEST_ORIGIN}/api/influencer/subscription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instagram_user_id: inf.id, plan: 'growth', subscription_token: capToken }),
        }),
        env,
        createTestContext().ctx,
      );
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.mode, 'subscription');
      // No trial fields are ever sent to Razorpay.
      assert.ok(mock.calls.subscriptions.length >= 1);
      for (const body of mock.calls.subscriptions) {
        assert.equal('trial_period' in body, false);
        assert.equal('trial_end' in body, false);
        assert.equal('start_at' in body, false);
      }
    } finally {
      mock.restore();
    }
  });
});

describe('payment capability tokens + rate limits', () => {
  it('subscription create requires a plans-page capability', async () => {
    const env = lifecycleEnv();
    const inf = seedInfluencer({});
    await kvPut(env, `INFLUENCER:${inf.id}`, inf.record);
    const noCap = await worker.fetch(
      new Request(`${TEST_ORIGIN}/api/influencer/subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instagram_user_id: inf.id, plan: 'growth' }),
      }),
      env,
      createTestContext().ctx,
    );
    assert.equal(noCap.status, 403);
    const wrongTarget = await worker.fetch(
      new Request(`${TEST_ORIGIN}/api/influencer/subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instagram_user_id: inf.id, plan: 'growth', subscription_token: 'cap_for_someone_else' }),
      }),
      env,
      createTestContext().ctx,
    );
    assert.equal(wrongTarget.status, 403);
  });

  it('subscription create is rate-limited', async () => {
    const env = lifecycleEnv();
    let last = 200;
    for (let i = 0; i < 31; i++) {
      const res = await worker.fetch(
        new Request(`${TEST_ORIGIN}/api/influencer/subscription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
          body: JSON.stringify({ instagram_user_id: 'ghost', plan: 'growth' }),
        }),
        env,
        createTestContext().ctx,
      );
      last = res.status;
    }
    assert.equal(last, 429);
  });

  it('vendor payment requires a submit-issued capability; order creation is idempotent', async () => {
    const mock = installRazorpayMock();
    try {
      const env = lifecycleEnv();
      const campaignId = nextId('lc_pay_cmp');
      await kvPut(env, `CAMPAIGN:${campaignId}`, {
        campaign_id: campaignId,
        vendor_instagram_user_id: nextId('lc_vendor'),
        business_name: 'Pay Biz',
        campaign_title: 'Pay Campaign',
        status: 'AWAITING_PAYMENT',
        required_influencers: 1,
        compensation_type: 'money',
        budget: 10000,
        reels: 1,
        posts: 0,
      });
      const noCap = await worker.fetch(
        new Request(`${TEST_ORIGIN}/api/vendor/payment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ campaign_id: campaignId }),
        }),
        env,
        createTestContext().ctx,
      );
      assert.equal(noCap.status, 403);

      // Mint a capability the way vendor submit does, then pay twice.
      const capToken = `paycap_test_${Date.now()}`;
      await kvPut(env, `PAYCAP:${capToken}`, {
        kind: 'PAYCAP',
        ref: campaignId,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
      const pay = () =>
        worker.fetch(
          new Request(`${TEST_ORIGIN}/api/vendor/payment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ campaign_id: campaignId, payment_token: capToken }),
          }),
          env,
          createTestContext().ctx,
        );
      const first = await pay();
      assert.equal(first.status, 200);
      const firstData = await first.json();
      assert.equal(firstData.ok, true);
      // Server-computed amount: budget-derived paise, never client input.
      assert.equal(firstData.amount, mock.calls.orders[0].amount);
      const second = await pay();
      assert.equal(second.status, 200);
      assert.equal((await second.json()).order_id, firstData.order_id);
      assert.equal(mock.calls.orders.length, 1);
    } finally {
      mock.restore();
    }
  });
});

describe('admin session TTL + free-tier evidence', () => {
  it('admin login issues a ~12h session that authorizes /admin', async () => {
    const env = lifecycleEnv();
    const login = await worker.fetch(
      new Request(`${TEST_ORIGIN}/admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: 'TEST_ONLY_admin_key_9f2c7a41' }),
      }),
      env,
      createTestContext().ctx,
    );
    assert.equal(login.status, 302);
    const cookie = login.headers.get('Set-Cookie');
    assert.match(cookie, /B8I_ADMIN_SESSION=/);
    const token = decodeURIComponent(cookie.split('B8I_ADMIN_SESSION=')[1].split(';')[0]);
    const session = await kvJson(env, `ADMIN_SESSION:${token}`);
    const ttlMs = session.expires_at - Date.now();
    assert.ok(ttlMs > 11 * 3600 * 1000 && ttlMs <= 12 * 3600 * 1000 + 60000);
    const home = await worker.fetch(
      new Request(`${TEST_ORIGIN}/admin`, { headers: { Cookie: `B8I_ADMIN_SESSION=${token}` } }),
      env,
      createTestContext().ctx,
    );
    assert.equal(home.status, 200);
  });

  it('paid-only positioning: chooser shows paid plans, no free/trial path', async () => {
    const env = lifecycleEnv();
    const inf = seedInfluencer({ subscription_status: 'inactive' });
    await kvPut(env, `INFLUENCER:${inf.id}`, inf.record);
    const res = await worker.fetch(
      new Request(`${TEST_ORIGIN}/influencer/plans?instagram_user_id=${inf.id}`),
      env,
      createTestContext().ctx,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /₹199/);
    assert.match(html, /₹499/);
    assert.match(html, /no free subscription or free trial/i);
    assert.doesNotMatch(html, /₹0/);
    // Unknown plans are rejected with the paid plan list (valid session).
    const subKeys = env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('SUBCAP:');
    const capToken = subKeys[0].replace(/^SUBCAP:/, '');
    const bad = await worker.fetch(
      new Request(`${TEST_ORIGIN}/api/influencer/subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instagram_user_id: inf.id, plan: 'free', subscription_token: capToken }),
      }),
      env,
      createTestContext().ctx,
    );
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /₹199, ₹299 or ₹499 per month/);
  });
});
