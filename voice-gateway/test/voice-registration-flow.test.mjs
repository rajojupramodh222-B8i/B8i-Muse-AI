// Maintained tests for the voice registration state machine.
// Backend actions are faked; no network, no model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFlow,
  detectIntent,
  extractFreeText,
  extractHandle,
  isAffirmative,
  isNegative,
  stepFlow
} from '../src/services/registration-flow.js';

const fakeActions = (impl = {}) => ({
  calls: [],
  statusCalls: [],
  statusResult: impl.statusResult || { used: false, expired: false, purpose: 'influencer' },
  async createVoiceSession(args) {
    this.calls.push(args);
    if (impl.fail) throw new Error('backend down');
    return { sessionId: 'sess_1', linkCode: 'K7P-2MD', expiresAt: '2030-01-01T00:00:00.000Z' };
  },
  async getVoiceSessionStatus(id) {
    this.statusCalls.push(id);
    if (impl.statusFail) throw new Error('backend down');
    return this.statusResult;
  }
});

const ctxWith = actions => ({ enabled: true, actions, igHandle: 'b8i.test' });

async function drive(flow, transcripts, ctx) {
  const spoken = [];
  for (const t of transcripts) {
    const out = await stepFlow(flow, t, ctx);
    spoken.push(out?.speak ?? null);
  }
  return spoken;
}

test('detectIntent routes the four workflows', () => {
  assert.equal(detectIntent('I want to register as an influencer'), 'influencer');
  assert.equal(detectIntent('I am a creator on Instagram'), 'influencer');
  assert.equal(detectIntent('I want to register my business'), 'vendor');
  assert.equal(detectIntent('I want to run a campaign for my brand'), 'vendor');
  assert.equal(detectIntent('what is the status of my campaign'), 'campaign_info');
  assert.equal(detectIntent('I need help with my account'), 'account_support');
  assert.equal(detectIntent('hello there'), 'unknown');
  assert.equal(detectIntent('I am a vendor and an influencer'), 'unknown');
});

test('extractHandle normalizes spoken handles', () => {
  assert.equal(extractHandle('@Priya.Creates'), 'Priya.Creates');
  assert.equal(extractHandle('my handle is priya_creates'), 'priya_creates');
  assert.equal(extractHandle('it is @priya_creates'), 'priya_creates');
  assert.equal(extractHandle('a'), null);
  assert.equal(extractHandle('hello world test'), null);
});

test('extractFreeText rejects question echoes and bare yes/no', () => {
  assert.equal(extractFreeText('Mumbai'), 'Mumbai');
  assert.equal(extractFreeText('what?'), null);
  assert.equal(extractFreeText('how do I do that'), null);
  assert.equal(extractFreeText('yes'), null);
  assert.equal(extractFreeText('x'), null);
});

test('yes/no recognition', () => {
  assert.equal(isAffirmative('yes please'), true);
  assert.equal(isAffirmative('sounds good'), true);
  assert.equal(isAffirmative('no'), false);
  assert.equal(isNegative('no, that is wrong'), true);
  assert.equal(isNegative("don't use it"), true);
  assert.equal(isNegative('yes'), false);
});

test('disabled flow never owns a turn', async () => {
  const flow = createFlow();
  const out = await stepFlow(flow, 'I want to register as an influencer', { enabled: false });
  assert.equal(out, null);
  assert.equal(flow.state, 'intent');
});

test('non-registration intents stay with the model', async () => {
  const flow = createFlow();
  const actions = fakeActions();
  assert.equal(
    await stepFlow(flow, 'what is the status of my campaign', ctxWith(actions)),
    null
  );
  assert.equal(flow.state, 'intent');
  assert.equal(actions.calls.length, 0);
});

test('influencer happy path collects, confirms, consents, and speaks the code', async () => {
  const flow = createFlow();
  const actions = fakeActions();
  const ctx = ctxWith(actions);
  const spoken = await drive(
    flow,
    [
      'I want to register as an influencer',
      '@priya.creates',
      'Priya',
      'Sharma',
      '98765 43210',
      'yes',
      'Mumbai',
      'Maharashtra',
      'India',
      'fashion',
      'yes that is correct',
      'yes please do'
    ],
    ctx
  );
  assert.match(spoken[0], /Instagram handle/);
  assert.match(spoken[1], /first name/);
  assert.match(spoken[2], /last name/);
  assert.match(spoken[3], /phone number/);
  assert.match(spoken[4], /I heard 9 8 7 6 5, 4 3 2 1 0/);
  assert.match(spoken[5], /city/);
  assert.match(spoken[6], /state/);
  assert.match(spoken[7], /country/);
  assert.match(spoken[8], /niche/);
  assert.match(spoken[9], /@priya\.creates/);
  assert.match(spoken[9], /Priya Sharma/);
  assert.match(spoken[9], /Mumbai/);
  assert.match(spoken[9], /Maharashtra/);
  assert.match(spoken[9], /India/);
  assert.match(spoken[9], /Is that correct/);
  assert.match(spoken[10], /May I use these details/);
  assert.match(spoken[11], /K 7 P - 2 M D/);
  assert.match(spoken[11], /LINK K7P-2MD/);
  assert.match(spoken[11], /@b8i\.test/);
  assert.match(spoken[11], /verified when you complete your registration/);
  assert.equal(actions.calls.length, 1);
  assert.equal(actions.calls[0].purpose, 'influencer');
  assert.equal(actions.calls[0].instagramUsername, 'priya.creates');
  assert.deepEqual(actions.calls[0].details, {
    full_name: 'Priya Sharma',
    phone: '9876543210',
    city: 'Mumbai',
    state: 'Maharashtra',
    country: 'India',
    niche: 'fashion'
  });
  assert.match(actions.calls[0].clientRequestId, /^vc-[A-Za-z0-9-]+$/);
  assert.equal(flow.state, 'awaiting_link');
  assert.equal(await stepFlow(flow, 'hello?', ctx), null);
});

test('vendor happy path sends business details', async () => {
  const flow = createFlow();
  const actions = fakeActions();
  const spoken = await drive(
    flow,
    [
      'I want to register my business',
      'Acme Foods',
      'Rahul',
      '98100 12345',
      'yes',
      'Delhi',
      'skip',
      'India',
      'no thanks',
      'yes',
      'yes'
    ],
    ctxWith(actions)
  );
  assert.match(spoken[7], /add campaign requirements now/);
  assert.match(spoken[8], /Acme Foods/);
  assert.doesNotMatch(spoken[8], /campaign /);
  assert.match(spoken[8], /Delhi/);
  assert.match(spoken[10], /LINK K7P-2MD/);
  assert.equal(actions.calls[0].purpose, 'vendor');
  assert.equal(actions.calls[0].instagramUsername, null);
  assert.deepEqual(actions.calls[0].details, {
    business_name: 'Acme Foods',
    contact_name: 'Rahul',
    phone: '9810012345',
    city: 'Delhi',
    country: 'India'
  });
});

test('vendor campaign step is separate and explicit', async () => {
  const flow = createFlow();
  const actions = fakeActions();
  const spoken = await drive(
    flow,
    [
      'I want to register my business',
      'Acme Foods',
      'Rahul',
      '98100 12345',
      'yes',
      'Delhi',
      'Delhi',
      'India',
      'yes please',
      'Summer Launch',
      'food',
      'Mumbai',
      'yes',
      'yes'
    ],
    ctxWith(actions)
  );
  assert.match(spoken[8], /What should we call the campaign/);
  assert.match(spoken[9], /influencer niche/);
  assert.match(spoken[10], /city or area/);
  assert.match(spoken[11], /campaign Summer Launch, niche food, target Mumbai/);
  assert.match(spoken[13], /LINK K7P-2MD/);
  assert.deepEqual(actions.calls[0].details, {
    business_name: 'Acme Foods',
    contact_name: 'Rahul',
    phone: '9810012345',
    city: 'Delhi',
    state: 'Delhi',
    country: 'India',
    campaign_title: 'Summer Launch',
    niche: 'food',
    target_location: 'Mumbai'
  });
});

test('campaign offer non-answers default to form-later', async () => {
  const flow = createFlow();
  const actions = fakeActions();
  const ctx = ctxWith(actions);
  await drive(flow, ['I want to register my business', 'Acme', 'Rahul', '98100 12345', 'yes', 'Delhi', 'skip', 'skip'], ctx);
  assert.equal(flow.state, 'campaign_offer');
  const once = await stepFlow(flow, 'hmm', ctx);
  assert.match(once.speak, /yes or no/);
  const twice = await stepFlow(flow, 'well', ctx);
  assert.match(twice.speak, /add campaign details on the form/);
  assert.match(twice.speak, /Is that correct/);
  assert.equal(flow.state, 'confirm');
  assert.equal(actions.calls.length, 0);
});

test('a no at confirm corrects one field without losing the others', async () => {
  const flow = createFlow();
  const actions = fakeActions();
  const ctx = ctxWith(actions);
  await drive(
    flow,
    ['I am an influencer', '@handle_one', 'Ann', 'Lee', '98765 43210', 'yes', 'Goa', 'skip', 'skip', 'food', 'no, wrong'],
    ctx
  );
  assert.equal(flow.state, 'correct');
  assert.equal(actions.calls.length, 0);
  // Other fields are preserved.
  assert.equal(flow.fields.instagram_username, 'handle_one');
  assert.equal(flow.fields.first_name, 'Ann');
  const menu = await stepFlow(flow, 'the city', ctx);
  assert.match(menu.speak, /What should your city be/);
  const fixed = await stepFlow(flow, 'Pune', ctx);
  assert.match(fixed.speak, /Pune/);
  assert.match(fixed.speak, /@handle_one/);
  assert.match(fixed.speak, /Ann Lee/);
  assert.match(fixed.speak, /Is that correct/);
  assert.equal(flow.fields.city, 'Pune');
  assert.equal(flow.fields.niche, 'food');
  assert.equal(flow.state, 'confirm');
});

test('a no at consent ends the flow and never sends details', async () => {
  const flow = createFlow();
  const actions = fakeActions();
  const ctx = ctxWith(actions);
  const spoken = await drive(
    flow,
    ['I am an influencer', '@handle_one', 'Ann', 'skip', '98765 43210', 'yes', 'Goa', 'skip', 'skip', 'food', 'yes', 'no stop'],
    ctx
  );
  assert.match(spoken[spoken.length - 1], /won't use your details/);
  assert.equal(actions.calls.length, 0);
  assert.equal(flow.state, 'done');
});

test('backend failure is spoken honestly and allows one retry', async () => {
  const flow = createFlow();
  const actions = fakeActions({ fail: true });
  const ctx = ctxWith(actions);
  await drive(flow, ['I am an influencer', '@handle_one', 'Ann', 'skip', '98765 43210', 'yes', 'Goa', 'skip', 'skip', 'food', 'yes'], ctx);
  const failed = await stepFlow(flow, 'yes', ctx);
  assert.match(failed.speak, /couldn't create your code/);
  assert.match(failed.speak, /Nothing was submitted/);
  assert.doesNotMatch(failed.speak, /Your code is ready/);
  assert.equal(actions.calls.length, 1);
  const retry = await stepFlow(flow, 'yes try again', ctx);
  assert.match(retry.speak, /couldn't create your code/);
  assert.equal(actions.calls.length, 2);
});

test('awaiting_link answers status from the backend only', async () => {
  const reach = async actions => {
    const flow = createFlow();
    const ctx = ctxWith(actions);
    await drive(flow, ['I am an influencer', '@handle_one', 'Ann', 'skip', '98765 43210', 'yes', 'Goa', 'skip', 'skip', 'food', 'yes', 'yes'], ctx);
    assert.equal(flow.state, 'awaiting_link');
    return { flow, ctx };
  };

  const pending = fakeActions();
  const p = await reach(pending);
  const s1 = await stepFlow(p.flow, 'has my link been used yet?', p.ctx);
  assert.match(s1.speak, /still waiting to be used/);
  assert.match(s1.speak, /LINK K7P-2MD/);
  assert.deepEqual(pending.statusCalls, ['sess_1']);

  const used = fakeActions({ statusResult: { used: true, expired: false, purpose: 'influencer' } });
  const u = await reach(used);
  const s2 = await stepFlow(u.flow, 'check my code status', u.ctx);
  assert.match(s2.speak, /has been used/);
  assert.match(s2.speak, /payment, verification, and admin review/);
  assert.equal(u.flow.state, 'done');

  const expired = fakeActions({ statusResult: { used: false, expired: true, purpose: 'vendor' } });
  const e = await reach(expired);
  const s3 = await stepFlow(e.flow, 'is my code still valid', e.ctx);
  assert.match(s3.speak, /expired/);
  assert.match(s3.speak, /fresh code/);
  assert.equal(e.flow.state, 'consent');
  const renew = await stepFlow(e.flow, 'yes', e.ctx);
  assert.match(renew.speak, /Your code is ready/);
  assert.equal(expired.calls.length, 2);

  const down = fakeActions({ statusFail: true });
  const d = await reach(down);
  const s4 = await stepFlow(d.flow, 'what is the status', d.ctx);
  assert.match(s4.speak, /couldn't reach the registration service/);
  assert.doesNotMatch(s4.speak, /has been used/);
});

test('awaiting_link status matcher ignores unrelated use/instagram mentions', async () => {
  const reach = async actions => {
    const flow = createFlow();
    const ctx = ctxWith(actions);
    await drive(flow, ['I am an influencer', '@handle_one', 'Ann', 'skip', '98765 43210', 'yes', 'Goa', 'skip', 'skip', 'food', 'yes', 'yes'], ctx);
    assert.equal(flow.state, 'awaiting_link');
    return { flow, ctx };
  };

  // Hijack regressions: these must return to Muse (null), not status-check.
  for (const utterance of [
    'because I was busy yesterday',
    'what is your instagram handle',
    'how do I use the form',
    'can I use UPI for payment',
    'hello?'
  ]) {
    const actions = fakeActions();
    const { flow, ctx } = await reach(actions);
    assert.equal(await stepFlow(flow, utterance, ctx), null, utterance);
    assert.deepEqual(actions.statusCalls, [], utterance);
    assert.equal(flow.state, 'awaiting_link', utterance);
  }

  // Genuine status paraphrases still stay with the flow.
  for (const utterance of [
    'did you send my link',
    "i didn't get the code",
    'send it again please',
    'has it expired',
    'not received yet'
  ]) {
    const actions = fakeActions();
    const { flow, ctx } = await reach(actions);
    const reply = await stepFlow(flow, utterance, ctx);
    assert.ok(reply && reply.speak, utterance);
    assert.deepEqual(actions.statusCalls, ['sess_1'], utterance);
  }
});

test('optional slots are skipped after repeated misses; required handle is not', async () => {
  const flow = createFlow();
  const actions = fakeActions();
  const ctx = ctxWith(actions);
  await drive(flow, ['I am an influencer', '@handle_one', 'Ann', 'skip', '98765 43210', 'yes'], ctx);
  assert.equal(flow.state, 'collect');
  const s1 = await stepFlow(flow, 'what?', ctx);
  assert.match(s1.speak, /city/);
  const s2 = await stepFlow(flow, 'huh?', ctx);
  assert.match(s2.speak, /city/);
  const s3 = await stepFlow(flow, 'pardon?', ctx);
  assert.match(s3.speak, /skip that/);
  assert.match(s3.speak, /state/);
  const s3b = await stepFlow(flow, 'skip', ctx);
  assert.match(s3b.speak, /country/);
  const s3c = await stepFlow(flow, 'skip', ctx);
  assert.match(s3c.speak, /niche/);
  const s4 = await stepFlow(flow, 'food', ctx);
  assert.match(s4.speak, /Is that correct/);
  assert.doesNotMatch(s4.speak, /city /);

  const flow2 = createFlow();
  await stepFlow(flow2, 'I am an influencer', ctx);
  for (let i = 0; i < 3; i++) {
    const r = await stepFlow(flow2, 'um well hmm', ctx);
    if (r) assert.match(r.speak, /handle/);
  }
  assert.ok(['collect', 'idle'].includes(flow2.state));
  assert.equal(actions.calls.length, 0);
});
