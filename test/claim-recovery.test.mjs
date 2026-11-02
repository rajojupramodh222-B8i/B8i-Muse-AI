// COPY TO: C:\B8i\test\claim-recovery.test.mjs
// (Mirror lives in the gateway repo; run docs/run-audit-suites.cjs to sync+run.)
//
// Stuck-slot recovery: KV write failure mid-commit, release failure, retry
// after failure, aged-grant recovery, duplicate taps, simultaneous accepts.
//
// Safety: synthetic env + in-memory KV + test-only origin only. Instagram
// DMs are answered by the in-test isolation mock; nothing leaves the process.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import {
  TEST_ORIGIN,
  InMemoryKV,
  createSyntheticEnv,
  assertSyntheticEnv,
  installNetworkIsolation,
  buildInstagramWebhookRequest,
  createTestContext,
  drainWaitUntil,
  messagesFor,
} from './helpers.mjs';

const isolation = installNetworkIsolation();

// Claim stub with grant timestamps (mirrors B8iCampaignClaim incl. the
// granted_at map) plus a release-failure toggle and exposed state.
function createRecoveryStub({ failRelease = false } = {}) {
  const instances = new Map();
  const chains = new Map();
  const flags = { failRelease };
  const run = (name, fn) => {
    const prev = chains.get(name) || Promise.resolve();
    const next = prev.then(fn, fn);
    chains.set(name, next.catch(() => {}));
    return next;
  };
  const load = (name) => {
    let st = instances.get(name);
    if (!st) {
      st = { accepted_ids: [], required: 1, closed: false, granted_at: {} };
      instances.set(name, st);
    }
    if (!st.granted_at || typeof st.granted_at !== 'object') st.granted_at = {};
    return st;
  };
  return {
    instances,
    flags,
    idFromName: (name) => ({ __claim_stub_id: name }),
    get: (id) => ({
      fetch: async (url, init = {}) => {
        const { pathname } = new URL(String(url));
        const body = init.body ? JSON.parse(init.body) : {};
        return run(id.__claim_stub_id, async () => {
          const st = load(id.__claim_stub_id);
          if (pathname === '/claim') {
            st.required = Math.max(st.required, Math.min(50, Math.max(1, Number(body.required) || 1)));
            const iid = body.influencer_id;
            if (st.closed) {
              return Response.json({ ok: true, granted: false, reason: 'closed', accepted_ids: [...st.accepted_ids] });
            }
            if (st.accepted_ids.includes(iid)) {
              return Response.json({ ok: true, granted: false, reason: 'duplicate', accepted_ids: [...st.accepted_ids], granted_at: st.granted_at[iid] || null });
            }
            if (st.accepted_ids.length >= st.required) {
              return Response.json({ ok: true, granted: false, reason: 'filled', accepted_ids: [...st.accepted_ids] });
            }
            st.accepted_ids.push(iid);
            st.granted_at[iid] = Date.now();
            return Response.json({ ok: true, granted: true, accepted_ids: [...st.accepted_ids], granted_at: st.granted_at[iid], remaining: st.required - st.accepted_ids.length });
          }
          if (pathname === '/release') {
            if (flags.failRelease) return Response.json({ ok: false, error: 'release_failed' }, { status: 500 });
            st.accepted_ids = st.accepted_ids.filter((x) => x !== body.influencer_id);
            delete st.granted_at[body.influencer_id];
            return Response.json({ ok: true, released: true, accepted_ids: [...st.accepted_ids] });
          }
          if (pathname === '/close') {
            st.closed = true;
            return Response.json({ ok: true, closed: true });
          }
          return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
        });
      },
    }),
  };
}

// KV wrapper that throws on configured puts (armed after seeding).
class FailingKV extends InMemoryKV {
  constructor() {
    super();
    this.failures = []; // { prefix, once, fired }
  }
  failNextPut(prefix) {
    this.failures.push({ prefix, once: true, fired: false });
  }
  failAllPuts(prefix) {
    this.failures.push({ prefix, once: false, fired: false });
  }
  clearFailures() {
    this.failures = [];
  }
  async put(key, value, opts) {
    for (const f of this.failures) {
      if (String(key).startsWith(f.prefix) && (!f.once || !f.fired)) {
        f.fired = true;
        throw new Error(`KV_PUT_FAILED_TEST:${key}`);
      }
    }
    return super.put(key, value, opts);
  }
}

function recoveryEnv({ kv = null, stub = null } = {}) {
  const env = createSyntheticEnv({
    CAMPAIGN_CLAIM: stub || createRecoveryStub(),
    ...(kv ? { INSTAGRAM_CONVERSATIONS: kv } : {}),
  });
  assertSyntheticEnv(env);
  return env;
}

let seq = 0;
const nextId = (prefix) => `${prefix}_${Date.now()}_${(seq += 1)}`;

async function kvPut(env, key, value) {
  await env.INSTAGRAM_CONVERSATIONS.put(key, JSON.stringify(value));
}

async function kvJson(env, key) {
  const raw = await env.INSTAGRAM_CONVERSATIONS.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function seedRecoveryWorld(env, { campaign = {}, influencers = [] }) {
  const campaignId = nextId('rec_cmp');
  await kvPut(env, `CAMPAIGN:${campaignId}`, {
    campaign_id: campaignId,
    vendor_instagram_user_id: nextId('rec_vendor'),
    business_name: 'Recovery Biz',
    campaign_title: 'Recovery Campaign',
    status: 'PAID',
    match_status: 'MATCHING',
    required_influencers: 1,
    candidate_ids: [],
    accepted_influencer_ids: [],
    accepted_influencers: [],
    compensation_type: 'money',
    budget: 10000,
    reels: 1,
    posts: 1,
    ...campaign,
    campaign_id: campaignId,
  });
  const ids = [];
  for (const inf of influencers) {
    const id = nextId('rec_inf');
    ids.push(id);
    await kvPut(env, `INFLUENCER:${id}`, {
      instagram_user_id: id,
      instagram_username: id,
      full_name: 'Recovery Tester',
      followers_count: 5000,
      verification_status: 'APPROVED',
      subscription_status: 'active',
      ...inf,
      instagram_user_id: id,
    });
    await kvPut(env, `CAMPAIGN_RESPONSE:${campaignId}:${id}`, {
      status: 'notified',
      notified_at: new Date().toISOString(),
    });
  }
  if (ids.length) {
    const cmp = await kvJson(env, `CAMPAIGN:${campaignId}`);
    cmp.candidate_ids = ids;
    await kvPut(env, `CAMPAIGN:${campaignId}`, cmp);
  }
  return { campaignId, influencerIds: ids };
}

async function postTap({ env, senderId, campaignId }) {
  const tctx = createTestContext();
  const mid = `mid_rec_${senderId}_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const req = buildInstagramWebhookRequest({
    payload: {
      object: 'instagram',
      entry: [{
        id: 'test_entry_1',
        messaging: [{
          sender: { id: senderId },
          recipient: { id: 'test_page_1' },
          message: { mid, text: 'Accept', quick_reply: { payload: `ACCEPT:${campaignId}` } },
        }],
      }],
    },
    secret: env.INSTAGRAM_APP_SECRET,
  });
  const res = await worker.fetch(req, env, tctx.ctx);
  assert.equal(res.status, 200);
  await drainWaitUntil(tctx);
  return messagesFor(isolation.sentMessages, senderId);
}

const lastText = (dms) => String(dms[dms.length - 1]?.message?.text || '');
const claimState = (env, campaignId) =>
  env.CAMPAIGN_CLAIM.instances.get(`campaign:${campaignId}`) || { accepted_ids: [] };

describe('stuck-slot recovery', () => {
  it('KV failure before commit rolls back, releases, and stays honest; retry succeeds', async () => {
    const kv = new FailingKV();
    const env = recoveryEnv({ kv });
    const { campaignId, influencerIds } = await seedRecoveryWorld(env, {
      campaign: { required_influencers: 1 },
      influencers: [{}],
    });
    const [inf] = influencerIds;
    kv.failNextPut(`CAMPAIGN_ACCEPT:${campaignId}:`);

    const dms = await postTap({ env, senderId: inf, campaignId });
    assert.match(lastText(dms), /could not record your acceptance/);
    assert.match(lastText(dms), /nothing was claimed/);
    assert.doesNotMatch(dms.map((m) => m.message?.text || '').join('\n'), /already accepted/);

    // No acceptance record; mirror rolled back to the open state.
    assert.equal(await kvJson(env, `CAMPAIGN_ACCEPT:${campaignId}:${inf}`), null);
    const rolled = await kvJson(env, `CAMPAIGN:${campaignId}`);
    assert.deepEqual(rolled.accepted_influencer_ids, []);
    assert.equal(rolled.accepted_influencer_count, 0);
    assert.equal(rolled.status, 'PAID');
    assert.equal(rolled.remaining_influencer_slots, 1);
    const resp = await kvJson(env, `CAMPAIGN_RESPONSE:${campaignId}:${inf}`);
    assert.equal(resp.status, 'notified');
    assert.ok(resp.rolled_back_at);
    // Slot released; clean recovery bumps no failure counters.
    assert.deepEqual(claimState(env, campaignId).accepted_ids, []);
    assert.equal(await kvJson(env, 'OPSCTR:claim_release_failed'), null);
    assert.equal(await kvJson(env, 'OPSCTR:claim_rollback_failed'), null);

    // Retry on healthy storage completes the acceptance exactly once.
    const retry = await postTap({ env, senderId: inf, campaignId });
    assert.match(retry.map((m) => m.message?.text || '').join('\n'), /Campaign accepted/);
    assert.ok(await kvJson(env, `CAMPAIGN_ACCEPT:${campaignId}:${inf}`));
    const done = await kvJson(env, `CAMPAIGN:${campaignId}`);
    assert.deepEqual(done.accepted_influencer_ids, [inf]);
    assert.equal(done.accepted_influencer_count, 1);
  });

  it('release failure is counted loudly; aged grant recovers via re-tap without over-count', async () => {
    const kv = new FailingKV();
    const stub = createRecoveryStub({ failRelease: true });
    const env = recoveryEnv({ kv, stub });
    const { campaignId, influencerIds } = await seedRecoveryWorld(env, {
      campaign: { required_influencers: 1 },
      influencers: [{}],
    });
    const [inf] = influencerIds;
    kv.failNextPut(`CAMPAIGN_ACCEPT:${campaignId}:`);

    await postTap({ env, senderId: inf, campaignId });
    assert.equal((await kvJson(env, 'OPSCTR:claim_release_failed'))?.count, 1);
    assert.deepEqual(claimState(env, campaignId).accepted_ids, [inf], 'slot still held');

    // Fresh duplicate: in-flight wording, no release, no false success.
    const soon = await postTap({ env, senderId: inf, campaignId });
    assert.match(lastText(soon), /still processing/);
    assert.equal(await kvJson(env, `CAMPAIGN_ACCEPT:${campaignId}:${inf}`), null);
    assert.deepEqual(claimState(env, campaignId).accepted_ids, [inf]);

    // Aged duplicate: stale grant released, creator asked to tap again.
    stub.flags.failRelease = false;
    stub.instances.get(`campaign:${campaignId}`).granted_at[inf] = Date.now() - 120000;
    const aged = await postTap({ env, senderId: inf, campaignId });
    assert.match(lastText(aged), /tap Accept again/);
    assert.deepEqual(claimState(env, campaignId).accepted_ids, []);

    // Final tap claims fresh and commits exactly once.
    const fin = await postTap({ env, senderId: inf, campaignId });
    assert.match(fin.map((m) => m.message?.text || '').join('\n'), /Campaign accepted/);
    const done = await kvJson(env, `CAMPAIGN:${campaignId}`);
    assert.deepEqual(done.accepted_influencer_ids, [inf]);
    assert.equal(done.accepted_influencer_count, 1);
  });

  it('rollback failure is counted and never silent; later retry still heals', async () => {
    const kv = new FailingKV();
    const env = recoveryEnv({ kv });
    const { campaignId, influencerIds } = await seedRecoveryWorld(env, {
      campaign: { required_influencers: 1 },
      influencers: [{}],
    });
    const [inf] = influencerIds;
    kv.failAllPuts('CAMPAIGN:');

    const dms = await postTap({ env, senderId: inf, campaignId });
    assert.match(lastText(dms), /could not record your acceptance/);
    assert.equal((await kvJson(env, 'OPSCTR:claim_rollback_failed'))?.count, 1);
    // Release runs independently of the rollback outcome.
    assert.deepEqual(claimState(env, campaignId).accepted_ids, []);

    kv.clearFailures();
    const retry = await postTap({ env, senderId: inf, campaignId });
    assert.match(retry.map((m) => m.message?.text || '').join('\n'), /Campaign accepted/);
    assert.equal((await kvJson(env, `CAMPAIGN:${campaignId}`)).accepted_influencer_count, 1);
  });

  it('duplicate taps stay idempotent with the verified record path', async () => {
    const env = recoveryEnv();
    const { campaignId, influencerIds } = await seedRecoveryWorld(env, {
      campaign: { required_influencers: 1 },
      influencers: [{}],
    });
    const [inf] = influencerIds;
    await postTap({ env, senderId: inf, campaignId });
    const dup = await postTap({ env, senderId: inf, campaignId });
    assert.match(lastText(dup), /already accepted/);
    const done = await kvJson(env, `CAMPAIGN:${campaignId}`);
    assert.deepEqual(done.accepted_influencer_ids, [inf]);
    assert.equal(done.accepted_influencer_count, 1);
    assert.deepEqual(claimState(env, campaignId).accepted_ids, [inf]);
  });

  it('simultaneous single-campaign accepts yield exactly one winner', async () => {
    const env = recoveryEnv();
    const { campaignId, influencerIds } = await seedRecoveryWorld(env, {
      campaign: { required_influencers: 1 },
      influencers: [{}, {}],
    });
    const [a, b] = influencerIds;
    const [dmsA, dmsB] = await Promise.all([
      postTap({ env, senderId: a, campaignId }),
      postTap({ env, senderId: b, campaignId }),
    ]);
    const textA = dmsA.map((m) => m.message?.text || '').join('\n');
    const textB = dmsB.map((m) => m.message?.text || '').join('\n');
    const aWon = /Campaign accepted/.test(textA);
    const bWon = /Campaign accepted/.test(textB);
    assert.equal(Number(aWon) + Number(bWon), 1, 'exactly one winner');
    const loserText = aWon ? textB : textA;
    assert.match(loserText, /filled by another creator|no longer open/);
    const done = await kvJson(env, `CAMPAIGN:${campaignId}`);
    assert.equal(done.accepted_influencer_ids.length, 1);
    assert.equal(done.accepted_influencer_count, 1);
    assert.equal(claimState(env, campaignId).accepted_ids.length, 1);
  });

  it('simultaneous multi-campaign accepts never exceed the target', async () => {
    const env = recoveryEnv();
    const { campaignId, influencerIds } = await seedRecoveryWorld(env, {
      campaign: { required_influencers: 2 },
      influencers: [{}, {}, {}],
    });
    const results = await Promise.all(influencerIds.map((senderId) => postTap({ env, senderId, campaignId })));
    const winners = results.filter((dms) => /Campaign accepted/.test(dms.map((m) => m.message?.text || '').join('\n')));
    assert.equal(winners.length, 2);
    const done = await kvJson(env, `CAMPAIGN:${campaignId}`);
    assert.equal(done.accepted_influencer_ids.length, 2);
    assert.equal(done.accepted_influencer_count, 2);
    assert.equal(done.remaining_influencer_slots, 0);
    assert.ok(done.slots_closed_at);
    assert.equal(new Set(done.accepted_influencer_ids).size, 2);
  });

  it('stale mirror entry without a record falls through and commits cleanly', async () => {
    const env = recoveryEnv();
    const { campaignId, influencerIds } = await seedRecoveryWorld(env, {
      campaign: { required_influencers: 2 },
      influencers: [{}, {}],
    });
    const [inf] = influencerIds;
    // Simulate a partial mirror left by a dead attempt (no ACCEPT record).
    const cmp = await kvJson(env, `CAMPAIGN:${campaignId}`);
    cmp.accepted_influencer_ids = [inf];
    cmp.accepted_influencer_count = 1;
    await kvPut(env, `CAMPAIGN:${campaignId}`, cmp);

    const dms = await postTap({ env, senderId: inf, campaignId });
    assert.doesNotMatch(dms.map((m) => m.message?.text || '').join('\n'), /already accepted/);
    assert.ok(await kvJson(env, `CAMPAIGN_ACCEPT:${campaignId}:${inf}`));
    const done = await kvJson(env, `CAMPAIGN:${campaignId}`);
    assert.deepEqual(done.accepted_influencer_ids, [inf]);
    assert.equal(done.accepted_influencer_count, 1);
  });
});
