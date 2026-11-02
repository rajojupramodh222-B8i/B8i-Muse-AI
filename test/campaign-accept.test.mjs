// COPY TO: C:\B8i\test\campaign-accept.test.mjs
// (Mirror lives in the gateway repo; run docs/run-audit-suites.cjs to sync+run.)
//
// Campaign acceptance: single-winner atomicity, multi-target capacity,
// idempotency, closed-state rejects, quota, and the B8iCampaignClaim DO.
//
// Safety: synthetic env + in-memory KV + test-only origin only. Network
// isolation is installed at module load. Accept flows may attempt an
// Instagram profile refresh that fails closed by design; these tests do not
// assert zero-blocked counters for that reason.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker, { B8iCampaignClaim } from '../worker.js';
import {
  TEST_ORIGIN,
  createSyntheticEnv,
  assertSyntheticEnv,
  installNetworkIsolation,
  buildInstagramWebhookRequest,
  createTestContext,
  drainWaitUntil,
  messagesFor,
} from './helpers.mjs';

const isolation = installNetworkIsolation();

// Serialized in-process stand-in for the CAMPAIGN_CLAIM Durable Object
// namespace. The promise chain per campaign emulates what
// blockConcurrencyWhile guarantees in production: grants serialize.
// The real B8iCampaignClaim class is ALSO tested directly below.
function createClaimStub() {
  const instances = new Map();
  const chains = new Map();
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
    idFromName: (name) => ({ __claim_stub_id: name }),
    get: (id) => ({
      fetch: async (url, init = {}) => {
        const { pathname } = new URL(String(url));
        const body = init.body ? JSON.parse(init.body) : {};
        return run(id.__claim_stub_id, async () => {
          const st = load(id.__claim_stub_id);
          if (init.method === 'GET' && pathname === '/status') {
            return Response.json({ ok: true, ...st, accepted_ids: [...st.accepted_ids] });
          }
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

function claimEnv() {
  const env = createSyntheticEnv({ CAMPAIGN_CLAIM: createClaimStub() });
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

function seedInfluencer(overrides = {}) {
  const id = nextId('acc_inf');
  return {
    id,
    record: {
      instagram_user_id: id,
      instagram_username: id,
      full_name: 'Accept Tester',
      followers_count: 5000,
      verification_status: 'APPROVED',
      subscription_status: 'active',
      ...overrides,
    },
  };
}

function seedCampaign(overrides = {}) {
  const id = nextId('acc_cmp');
  return {
    id,
    record: {
      campaign_id: id,
      vendor_instagram_user_id: nextId('acc_vendor'),
      business_name: 'Accept Biz',
      campaign_title: 'Accept Campaign',
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
      ...overrides,
    },
  };
}

async function seedAcceptWorld(env, { campaign = {}, influencers = [] }) {
  const cmp = seedCampaign(campaign);
  await kvPut(env, `CAMPAIGN:${cmp.id}`, cmp.record);
  const ids = [];
  for (const inf of influencers) {
    const seeded = seedInfluencer(inf);
    ids.push(seeded.id);
    await kvPut(env, `INFLUENCER:${seeded.id}`, seeded.record);
    await kvPut(env, `CAMPAIGN_RESPONSE:${cmp.id}:${seeded.id}`, {
      status: 'notified',
      notified_at: new Date().toISOString(),
    });
  }
  if (ids.length) {
    cmp.record.candidate_ids = ids;
    await kvPut(env, `CAMPAIGN:${cmp.id}`, cmp.record);
  }
  return { campaignId: cmp.id, influencerIds: ids };
}

function buildAcceptPayload(senderId, campaignId, mid) {
  return {
    object: 'instagram',
    entry: [
      {
        id: 'test_entry_1',
        messaging: [
          {
            sender: { id: senderId },
            recipient: { id: 'test_page_1' },
            message: {
              mid: mid || `mid_accept_${senderId}_${Date.now()}_${Math.floor(Math.random() * 1e9)}`,
              text: 'Accept',
              quick_reply: { payload: `ACCEPT:${campaignId}` },
            },
          },
        ],
      },
    ],
  };
}

async function postAccept({ env, senderId, campaignId, mid = null }) {
  const tctx = createTestContext();
  const req = buildInstagramWebhookRequest({
    payload: buildAcceptPayload(senderId, campaignId, mid),
    secret: env.INSTAGRAM_APP_SECRET,
  });
  const res = await worker.fetch(req, env, tctx.ctx);
  assert.equal(res.status, 200);
  await drainWaitUntil(tctx);
  return messagesFor(isolation.sentMessages, senderId);
}

describe('B8iCampaignClaim DO class (real logic, fake state)', () => {
  const fakeState = (store = new Map()) => ({
    storage: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => void store.set(k, v),
    },
    blockConcurrencyWhile: (fn) => fn(),
  });
  const claimReq = (body) =>
    new Request('https://campaign-claim/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('grants up to required, then reports filled; duplicates identified', async () => {
    const claim = new B8iCampaignClaim(fakeState(), {});
    const first = await (await claim.fetch(claimReq({ influencer_id: 'a', required: 2 }))).json();
    assert.equal(first.granted, true);
    assert.ok(Number.isFinite(first.granted_at), 'grant carries a timestamp');
    const dup = await (await claim.fetch(claimReq({ influencer_id: 'a', required: 2 }))).json();
    assert.equal(dup.granted, false);
    assert.equal(dup.reason, 'duplicate');
    assert.equal(dup.granted_at, first.granted_at, 'duplicate echoes the grant timestamp');
    const second = await (await claim.fetch(claimReq({ influencer_id: 'b', required: 2 }))).json();
    assert.equal(second.granted, true);
    const third = await (await claim.fetch(claimReq({ influencer_id: 'c', required: 2 }))).json();
    assert.equal(third.granted, false);
    assert.equal(third.reason, 'filled');
  });

  it('releases grants and honors close; rejects bad input', async () => {
    const store = new Map();
    const claim = new B8iCampaignClaim(fakeState(store), {});
    await claim.fetch(claimReq({ influencer_id: 'a', required: 1 }));
    const rel = await (
      await claim.fetch(
        new Request('https://campaign-claim/release', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ influencer_id: 'a' }),
        }),
      )
    ).json();
    assert.equal(rel.released, true);
    assert.deepEqual(store.get('claim').granted_at, {}, 'release clears the grant timestamp');
    const retry = await (await claim.fetch(claimReq({ influencer_id: 'b', required: 1 }))).json();
    assert.equal(retry.granted, true);
    const legacy = new B8iCampaignClaim(fakeState(new Map([['claim', { accepted_ids: ['z'], required: 1, closed: false }]])), {});
    const legacyDup = await (await legacy.fetch(claimReq({ influencer_id: 'z', required: 1 }))).json();
    assert.equal(legacyDup.reason, 'duplicate');
    assert.equal(legacyDup.granted_at, null, 'pre-upgrade grants surface a null timestamp');
    await claim.fetch(
      new Request('https://campaign-claim/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    const afterClose = await (await claim.fetch(claimReq({ influencer_id: 'c', required: 5 }))).json();
    assert.equal(afterClose.reason, 'closed');
    const bad = await claim.fetch(claimReq({ influencer_id: '', required: 1 }));
    assert.equal(bad.status, 400);
    const wrongMethod = await claim.fetch(new Request('https://campaign-claim/claim', { method: 'GET' }));
    assert.equal(wrongMethod.status, 405);
  });
});

describe('single-influencer acceptance', () => {
  it('one influencer accepts: records, counts, and no duplicate side effects', async () => {
    const env = claimEnv();
    const { campaignId, influencerIds } = await seedAcceptWorld(env, {
      campaign: { required_influencers: 1 },
      influencers: [{}],
    });
    const [inf] = influencerIds;
    const dms = await postAccept({ env, senderId: inf, campaignId });
    assert.ok(dms.length > 0, 'winner receives acceptance DMs');
    const campaign = await kvJson(env, `CAMPAIGN:${campaignId}`);
    assert.deepEqual(campaign.accepted_influencer_ids, [inf]);
    assert.equal(campaign.accepted_influencer_count, 1);
    assert.equal(campaign.status, 'ACCEPTED');
    assert.ok(campaign.slots_closed_at, 'filling the last slot stamps slots_closed_at');
    const response = await kvJson(env, `CAMPAIGN_RESPONSE:${campaignId}:${inf}`);
    assert.equal(response.status, 'accepted');
    const accept = await kvJson(env, `CAMPAIGN_ACCEPT:${campaignId}:${inf}`);
    assert.equal(accept.campaign_id, campaignId);

    // Duplicate tap: idempotent, no duplicate records or counts.
    const dupDms = await postAccept({ env, senderId: inf, campaignId });
    assert.match(dupDms[dupDms.length - 1].message.text, /already accepted/);
    const after = await kvJson(env, `CAMPAIGN:${campaignId}`);
    assert.deepEqual(after.accepted_influencer_ids, [inf]);
    assert.equal(after.accepted_influencer_count, 1);
  });

  it('concurrent double accept: exactly one winner, loser gets filled message', async () => {
    const env = claimEnv();
    const { campaignId, influencerIds } = await seedAcceptWorld(env, {
      campaign: { required_influencers: 1 },
      influencers: [{}, {}],
    });
    const [a, b] = influencerIds;
    await Promise.all([
      postAccept({ env, senderId: a, campaignId }),
      postAccept({ env, senderId: b, campaignId }),
    ]);
    const campaign = await kvJson(env, `CAMPAIGN:${campaignId}`);
    assert.equal(campaign.accepted_influencer_ids.length, 1);
    const winner = campaign.accepted_influencer_ids[0];
    const loser = winner === a ? b : a;
    const loserDms = messagesFor(isolation.sentMessages, loser);
    assert.ok(
      loserDms.some((m) => /filled by another creator/.test(m.message.text)),
      'loser receives the already-filled message',
    );
    const loserResponse = await kvJson(env, `CAMPAIGN_RESPONSE:${campaignId}:${loser}`);
    assert.notEqual(loserResponse.status, 'accepted');
  });
});

describe('multi-influencer acceptance', () => {
  it('accepts distinct influencers up to target; rest get full/closed', async () => {
    const env = claimEnv();
    const { campaignId, influencerIds } = await seedAcceptWorld(env, {
      campaign: { required_influencers: 3 },
      influencers: [{}, {}, {}, {}, {}],
    });
    await Promise.all(influencerIds.map((senderId) => postAccept({ env, senderId, campaignId })));
    const campaign = await kvJson(env, `CAMPAIGN:${campaignId}`);
    assert.equal(campaign.accepted_influencer_ids.length, 3);
    assert.equal(new Set(campaign.accepted_influencer_ids).size, 3);
    assert.equal(campaign.accepted_influencer_count, 3);
    const losers = influencerIds.filter((id) => !campaign.accepted_influencer_ids.includes(id));
    assert.equal(losers.length, 2);
    for (const loser of losers) {
      const dms = messagesFor(isolation.sentMessages, loser);
      assert.ok(
        dms.some((m) => /filled by another creator|no longer open/.test(m.message.text)),
        `loser ${loser} told the campaign is full/closed`,
      );
    }
  });

  it('same influencer counted once even across retries', async () => {
    const env = claimEnv();
    const { campaignId, influencerIds } = await seedAcceptWorld(env, {
      campaign: { required_influencers: 2 },
      influencers: [{}, {}],
    });
    const [a, b] = influencerIds;
    await postAccept({ env, senderId: a, campaignId });
    await postAccept({ env, senderId: a, campaignId });
    await postAccept({ env, senderId: b, campaignId });
    await postAccept({ env, senderId: b, campaignId });
    const campaign = await kvJson(env, `CAMPAIGN:${campaignId}`);
    assert.equal(campaign.accepted_influencer_ids.length, 2);
    assert.equal(campaign.remaining_influencer_slots, 0);
    assert.ok(campaign.slots_closed_at, 'multi fill stamps slots_closed_at once slots hit zero');
  });
});

describe('closed-state and eligibility rejects', () => {
  it('rejects accepts on non-open campaigns', async () => {
    for (const status of ['COMPLETED', 'AWAITING_PAYMENT', 'CANCELLED', 'EXPIRED']) {
      const env = claimEnv();
      const { campaignId, influencerIds } = await seedAcceptWorld(env, {
        campaign: { required_influencers: 1, status },
        influencers: [{}],
      });
      const dms = await postAccept({ env, senderId: influencerIds[0], campaignId });
      assert.match(dms[dms.length - 1].message.text, /no longer open/);
      const campaign = await kvJson(env, `CAMPAIGN:${campaignId}`);
      assert.deepEqual(campaign.accepted_influencer_ids, []);
    }
  });

  it('rejects declined responses even for listed candidates', async () => {
    const env = claimEnv();
    const { campaignId, influencerIds } = await seedAcceptWorld(env, {
      campaign: { required_influencers: 1 },
      influencers: [{}],
    });
    const [inf] = influencerIds;
    await kvPut(env, `CAMPAIGN_RESPONSE:${campaignId}:${inf}`, { status: 'declined' });
    const dms = await postAccept({ env, senderId: inf, campaignId });
    assert.match(dms[dms.length - 1].message.text, /no longer available/);
    const campaign = await kvJson(env, `CAMPAIGN:${campaignId}`);
    assert.deepEqual(campaign.accepted_influencer_ids, []);
  });

  it('falls back to legacy path when the claim binding is missing', async () => {
    const env = createSyntheticEnv();
    assertSyntheticEnv(env);
    const { campaignId, influencerIds } = await seedAcceptWorld(env, {
      campaign: { required_influencers: 1 },
      influencers: [{}],
    });
    await postAccept({ env, senderId: influencerIds[0], campaignId });
    const campaign = await kvJson(env, `CAMPAIGN:${campaignId}`);
    assert.deepEqual(campaign.accepted_influencer_ids, [influencerIds[0]]);
  });
});

describe('subscription quota on accepts', () => {
  it('blocks accepts past the monthly plan limit', async () => {
    const env = claimEnv();
    const period = new Date().toISOString().slice(0, 7);
    const { campaignId, influencerIds } = await seedAcceptWorld(env, {
      campaign: { required_influencers: 2 },
      influencers: [{ subscription_id: 'sub_quota_1' }, {}],
    });
    const [limited] = influencerIds;
    await kvPut(env, 'RZP_SUBSCRIPTION:sub_quota_1', { request_limit: 1, status: 'active' });
    await kvPut(env, `SUB_QUOTA:${limited}:${period}`, { count: 1 });
    const dms = await postAccept({ env, senderId: limited, campaignId });
    assert.match(dms[dms.length - 1].message.text, /reached your plan/);
    const campaign = await kvJson(env, `CAMPAIGN:${campaignId}`);
    assert.deepEqual(campaign.accepted_influencer_ids, []);
  });

  it('consumes quota on success; unlimited plans and missing data allow', async () => {
    const env = claimEnv();
    const period = new Date().toISOString().slice(0, 7);
    const { campaignId, influencerIds } = await seedAcceptWorld(env, {
      campaign: { required_influencers: 3 },
      influencers: [
        { subscription_id: 'sub_quota_5' },
        { subscription_id: 'sub_quota_pro' },
        {},
      ],
    });
    const [limited, pro, plain] = influencerIds;
    await kvPut(env, 'RZP_SUBSCRIPTION:sub_quota_5', { request_limit: 5, status: 'active' });
    await kvPut(env, 'RZP_SUBSCRIPTION:sub_quota_pro', { request_limit: null, status: 'active' });
    await postAccept({ env, senderId: limited, campaignId });
    await postAccept({ env, senderId: pro, campaignId });
    await postAccept({ env, senderId: plain, campaignId });
    const campaign = await kvJson(env, `CAMPAIGN:${campaignId}`);
    assert.equal(campaign.accepted_influencer_ids.length, 3);
    const counter = await kvJson(env, `SUB_QUOTA:${limited}:${period}`);
    assert.equal(counter.count, 1);
    assert.equal(await kvJson(env, `SUB_QUOTA:${pro}:${period}`), null);
  });

  it('blocks accepts past subscription_current_end', async () => {
    const env = claimEnv();
    const past = new Date(Date.now() - 86400000).toISOString();
    const { campaignId, influencerIds } = await seedAcceptWorld(env, {
      campaign: { required_influencers: 1 },
      influencers: [{ subscription_current_end: past }],
    });
    const dms = await postAccept({ env, senderId: influencerIds[0], campaignId });
    assert.match(dms[dms.length - 1].message.text, /membership is not active/);
    const campaign = await kvJson(env, `CAMPAIGN:${campaignId}`);
    assert.deepEqual(campaign.accepted_influencer_ids, []);
  });
});
