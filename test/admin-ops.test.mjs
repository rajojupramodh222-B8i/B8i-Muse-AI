// COPY TO: C:\B8i\test\admin-ops.test.mjs
// (Mirror lives in the gateway repo; run docs/run-audit-suites.cjs to sync+run.)
//
// Batch C: lifecycle expiry sweep, ops counters, admin audit trail, payout
// pay cooldown, dashboard health/vendor-dedupe.
//
// Safety: synthetic env + in-memory KV + test-only origin only. Instagram
// DMs are answered by the in-test isolation mock; nothing leaves the process.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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

function adminEnv(overrides = {}) {
  const env = createSyntheticEnv({
    THEVAL_ADMIN_API_KEY: 'TEST_ONLY_admin_key_9f2c7a41',
    THEVAL_REVENUE_ADMIN_PASSWORD: 'TEST_ONLY_admin_pw_9f2c7a41',
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

async function seedAdminSession(env, token = `sess_${nextId('adm')}`) {
  await kvPut(env, `ADMIN_SESSION:${token}`, {
    created_at: new Date().toISOString(),
    expires_at: Date.now() + 3600_000,
  });
  return token;
}

const YESTERDAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const TOMORROW = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

function campaignRecord(id, overrides = {}) {
  return {
    campaign_id: id,
    campaign_title: `Campaign ${id}`,
    status: 'PAID',
    vendor_instagram_user_id: `vendor_${id}`,
    ...overrides,
  };
}

describe('expiry sweep via scheduled cron', () => {
  it('expires only dead open-acceptance campaigns past end-date', async () => {
    const env = adminEnv();
    await kvPut(env, 'CAMPAIGN:dead1', campaignRecord('dead1', { end_date: YESTERDAY }));
    await kvPut(env, 'CAMPAIGN:pending1', campaignRecord('pending1', { end_date: YESTERDAY }));
    await kvPut(env, 'CAMPAIGN_RESPONSE:pending1:rx1', { status: 'notified' });
    await kvPut(env, 'CAMPAIGN:filled1', campaignRecord('filled1', {
      end_date: YESTERDAY,
      accepted_influencer_ids: ['rx2'],
      accepted_influencer_count: 1,
    }));
    await kvPut(env, 'CAMPAIGN:future1', campaignRecord('future1', { end_date: TOMORROW }));
    await kvPut(env, 'CAMPAIGN:done1', campaignRecord('done1', { end_date: YESTERDAY, status: 'COMPLETED' }));

    const tctx = createTestContext();
    await worker.scheduled({}, env, tctx.ctx);
    await drainWaitUntil(tctx);

    const dead = await kvJson(env, 'CAMPAIGN:dead1');
    assert.equal(dead.status, 'EXPIRED');
    assert.ok(dead.expired_at);
    assert.equal((await kvJson(env, 'CAMPAIGN:pending1')).status, 'PAID');
    assert.equal((await kvJson(env, 'CAMPAIGN:filled1')).status, 'PAID');
    assert.equal((await kvJson(env, 'CAMPAIGN:future1')).status, 'PAID');
    assert.equal((await kvJson(env, 'CAMPAIGN:done1')).status, 'COMPLETED');
    assert.equal((await kvJson(env, 'OPSCTR:campaigns_expired'))?.count, 1);

    const vendorDms = isolation.sentMessages.filter(
      (m) => m.recipient === 'vendor_dead1' && String(m.message?.text || '').includes('has expired')
    );
    assert.equal(vendorDms.length, 1);
  });
});

describe('ops counters', () => {
  it('invalid webhook signature returns 403 and bumps the counter', async () => {
    const env = adminEnv();
    const tctx = createTestContext();
    const rawBody = JSON.stringify({ event: 'payment.captured', payload: {} });
    const res = await worker.fetch(
      new Request(`${TEST_ORIGIN}/webhooks/razorpay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': 'deadbeef' },
        body: rawBody,
      }),
      env,
      tctx.ctx
    );
    assert.equal(res.status, 403);
    assert.equal((await kvJson(env, 'OPSCTR:webhook_sig_failed'))?.count, 1);
  });
});

describe('admin audit trail', () => {
  it('mark-paid writes an audit entry with reference and amount', async () => {
    const env = adminEnv();
    await kvPut(env, 'MPAY:campA:infA', {
      campaign_id: 'campA',
      influencer_instagram_user_id: 'infA',
      campaign_title: 'Audit Campaign',
      amount: 5200,
      status: 'READY_FOR_MANUAL_PAYMENT',
    });
    const tctx = createTestContext();
    const res = await worker.fetch(
      new Request(`${TEST_ORIGIN}/admin/payouts/mark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'TEST_ONLY_admin_key_9f2c7a41' },
        body: JSON.stringify({ record_id: 'MPAY:campA:infA', payment_reference: 'UTR_AUDIT_1' }),
      }),
      env,
      tctx.ctx
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'PAID');
    const keys = env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('ADMIN_AUDIT:');
    assert.equal(keys.length, 1);
    const entry = await kvJson(env, keys[0]);
    assert.equal(entry.action, 'payout.mark_paid');
    assert.equal(entry.record_id, 'MPAY:campA:infA');
    assert.equal(entry.payment_reference, 'UTR_AUDIT_1');
    assert.equal(entry.amount, 5200);
  });

  it('mark-paid rejects unauthenticated callers without side effects', async () => {
    const env = adminEnv();
    await kvPut(env, 'MPAY:campB:infB', {
      campaign_id: 'campB',
      influencer_instagram_user_id: 'infB',
      campaign_title: 'Nope Campaign',
      amount: 1000,
      status: 'READY_FOR_MANUAL_PAYMENT',
    });
    const tctx = createTestContext();
    const res = await worker.fetch(
      new Request(`${TEST_ORIGIN}/admin/payouts/mark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'wrong_key' },
        body: JSON.stringify({ record_id: 'MPAY:campB:infB', payment_reference: 'UTR_X' }),
      }),
      env,
      tctx.ctx
    );
    assert.equal(res.status, 401);
    assert.equal((await kvJson(env, 'MPAY:campB:infB')).status, 'READY_FOR_MANUAL_PAYMENT');
    assert.deepEqual(env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('ADMIN_AUDIT:'), []);
  });
});

describe('payout pay cooldown', () => {
  it('rate-limits repeated pay confirmations and audits the success', async () => {
    const env = adminEnv();
    await kvPut(env, 'MPAY:campC:infC', {
      campaign_id: 'campC',
      influencer_instagram_user_id: 'infC',
      campaign_title: 'Cooldown Campaign',
      amount: 3000,
      status: 'READY_FOR_MANUAL_PAYMENT',
    });
    await kvPut(env, 'ADMIN_PAYOUT_SESSION:paytok_cool', {
      record_id: 'MPAY:campC:infC',
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    const postPay = async () => {
      const tctx = createTestContext();
      const res = await worker.fetch(
        new Request(`${TEST_ORIGIN}/admin/payouts/pay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ session_token: 'paytok_cool', payment_reference: 'UTR_COOL' }),
        }),
        env,
        tctx.ctx
      );
      await drainWaitUntil(tctx);
      return res.status;
    };
    const statuses = [];
    for (let i = 0; i < 6; i += 1) statuses.push(await postPay());
    assert.deepEqual(statuses, [200, 409, 409, 409, 409, 429]);
    const keys = env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('ADMIN_AUDIT:');
    assert.equal(keys.length, 1);
    assert.equal((await kvJson(env, keys[0])).action, 'payout.pay_confirmed');
  });
});

describe('admin dashboard', () => {
  it('shows health signals and dedupes vendors by name+phone', async () => {
    const env = adminEnv({ B8I_VOICE_ENABLED: 'true' });
    const token = await seedAdminSession(env);
    await kvPut(env, 'VENDOR:vend_dup_1', {
      instagram_user_id: 'vend_dup_1', business_name: 'Acme Co', phone: '+91-111', contact_name: 'A',
    });
    await kvPut(env, 'VENDOR:vend_dup_2', {
      instagram_user_id: 'vend_dup_2', business_name: 'Acme Co', phone: '+91-111', contact_name: 'B',
    });
    await kvPut(env, 'RZP_ORDER:ord_dup_1', {
      purpose: 'campaign', status: 'paid', vendor_instagram_user_id: 'vend_dup_1', vendor_total_amount: 3000,
    });
    await kvPut(env, 'RZP_ORDER:ord_dup_2', {
      purpose: 'campaign', status: 'paid', vendor_instagram_user_id: 'vend_dup_2', vendor_total_amount: 5000,
    });
    await kvPut(env, 'OPSCTR:webhook_sig_failed', { count: 3, updated_at: new Date().toISOString() });

    const tctx = createTestContext();
    const res = await worker.fetch(
      new Request(`${TEST_ORIGIN}/admin`, { headers: { Cookie: `B8I_ADMIN_SESSION=${token}` } }),
      env,
      tctx.ctx
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /System health/);
    assert.match(html, /Webhook signature failures/);
    assert.match(html, />3</);
    assert.match(html, /Voice registration/);
    assert.match(html, /ENABLED/);
    assert.match(html, /1 duplicate rows merged/);
    assert.equal(html.split('Acme Co').length - 1, 1);
  });

  it('does not render the dashboard without an admin session', async () => {
    const env = adminEnv();
    const tctx = createTestContext();
    const res = await worker.fetch(new Request(`${TEST_ORIGIN}/admin`), env, tctx.ctx);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Sign in securely/);
    assert.doesNotMatch(html, /System health/);
  });
});
