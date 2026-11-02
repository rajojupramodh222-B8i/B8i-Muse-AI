// Maintained tests for voice registration capture: handle/phone/geo extraction,
// single-field correction, code readback honesty, and structured prefill state.
// Backend actions are faked; no network, no model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeHandle,
  createFlow,
  extractHandle,
  extractNamePart,
  extractPhoneDigits,
  formatPhoneForSpeech,
  getRegistrationState,
  spellForSpeech,
  stepFlow,
  validateRegistrationDetails
} from '../src/services/registration-flow.js';

const fakeActions = (impl = {}) => ({
  calls: [],
  statusCalls: [],
  statusResult: impl.statusResult || { used: false, expired: false, purpose: 'influencer' },
  linkCode: impl.linkCode || 'K7P-2MD',
  async createVoiceSession(args) {
    this.calls.push(args);
    if (impl.fail) throw new Error('backend down');
    return { sessionId: 'sess_1', linkCode: this.linkCode, expiresAt: '2030-01-01T00:00:00.000Z' };
  },
  async getVoiceSessionStatus(id) {
    this.statusCalls.push(id);
    if (impl.statusFail) throw new Error('backend down');
    return this.statusResult;
  }
});

const ctxWith = (actions, extra = {}) => ({ enabled: true, actions, igHandle: 'b8i.test', ...extra });

async function drive(flow, transcripts, ctx) {
  const spoken = [];
  for (const t of transcripts) {
    const out = await stepFlow(flow, t, ctx);
    spoken.push(out?.speak ?? null);
  }
  return spoken;
}

const reachConfirm = async (actions, ctx) => {
  const flow = createFlow();
  const c = ctx || ctxWith(actions);
  await drive(
    flow,
    ['I am an influencer', '@handle_one', 'Ann', 'skip', '98765 43210', 'yes', 'Goa', 'skip', 'skip', 'food'],
    c
  );
  assert.equal(flow.state, 'confirm');
  return { flow, ctx: c };
};

test('spoken handles: underscores, digits, dots, and leading at', () => {
  assert.equal(extractHandle('priya_creates_99'), 'priya_creates_99');
  assert.equal(extractHandle('priya dot creates'), 'priya.creates');
  assert.equal(extractHandle('priya underscore creates'), 'priya_creates');
  assert.equal(extractHandle('at priya_creates'), 'priya_creates');
  assert.equal(extractHandle('at @priya.creates99'), 'priya.creates99');
  assert.equal(extractHandle('my instagram handle is travel_with_raj'), 'travel_with_raj');
  assert.equal(extractHandle('p r i y a'), 'priya');
});

test('full names are never parsed as handles', () => {
  for (const name of ['Priya Sharma', 'my name is Priya Sharma', 'Rahul Verma', 'Ann Lee']) {
    assert.equal(extractHandle(name), null, name);
    assert.equal(analyzeHandle(name).confidence, 'none', name);
  }
  // At the handle slot a full name reprompts instead of storing.
  const flow = createFlow();
  const actions = fakeActions();
  const ctx = ctxWith(actions);
  return (async () => {
    await stepFlow(flow, 'I am an influencer', ctx);
    const out = await stepFlow(flow, 'Priya Sharma', ctx);
    assert.match(out.speak, /handle/);
    assert.equal(flow.fields.instagram_username, undefined);
    assert.equal(flow.state, 'collect');
  })();
});

test('ambiguous handles trigger spelling, then exact-candidate confirmation', async () => {
  assert.equal(analyzeHandle('priya creates').confidence, 'low');
  assert.equal(analyzeHandle('my handle is um priya_creates').confidence, 'low');
  assert.equal(extractHandle('priya creates'), null);

  const flow = createFlow();
  const actions = fakeActions();
  const ctx = ctxWith(actions);
  await stepFlow(flow, 'I am an influencer', ctx);
  const asked = await stepFlow(flow, 'priya creates', ctx);
  assert.match(asked.speak, /spell your handle slowly/);
  assert.equal(flow.fields.instagram_username, undefined);

  const confirm = await stepFlow(flow, 'p r i y a underscore c r e a t e s', ctx);
  assert.match(confirm.speak, /@priya_creates/);
  assert.match(confirm.speak, /p r i y a underscore c r e a t e s/);
  assert.match(confirm.speak, /Is that correct/);
  // Still not stored until the caller confirms the exact candidate.
  assert.equal(flow.fields.instagram_username, undefined);

  const accepted = await stepFlow(flow, 'yes correct', ctx);
  assert.match(accepted.speak, /first name/);
  assert.equal(flow.fields.instagram_username, 'priya_creates');
});

test('a rejected spelling keeps the slot open without storing a guess', async () => {
  const flow = createFlow();
  const ctx = ctxWith(fakeActions());
  await stepFlow(flow, 'I am an influencer', ctx);
  await stepFlow(flow, 'priya creates', ctx);
  await stepFlow(flow, 'p r i y a underscore c r e a t e s', ctx);
  const out = await stepFlow(flow, 'no, wrong', ctx);
  assert.match(out.speak, /No problem/);
  assert.match(out.speak, /handle/);
  assert.equal(flow.fields.instagram_username, undefined);
});

test('spellForSpeech reads handles character by character', () => {
  assert.equal(spellForSpeech('ab_9.z'), 'a b underscore 9 dot z');
});

test('names accept letters but reject sentences and questions', () => {
  assert.equal(extractNamePart('Priya'), 'Priya');
  assert.equal(extractNamePart("O'Brien"), "O'Brien");
  assert.equal(extractNamePart('how do I do that'), null);
  assert.equal(extractNamePart('yes'), null);
  assert.equal(extractNamePart('my instagram handle is priya creates today please'), null);
});

test('phone parsing accepts digits, plus signs, and number words', () => {
  assert.deepEqual(extractPhoneDigits('98765 43210'), { digits: '9876543210', display: '9876543210' });
  assert.deepEqual(extractPhoneDigits('+91-98765-43210'), { digits: '919876543210', display: '+919876543210' });
  assert.deepEqual(
    extractPhoneDigits('nine eight seven six five four three two one zero'),
    { digits: '9876543210', display: '9876543210' }
  );
  assert.equal(extractPhoneDigits('123'), null);
  assert.equal(extractPhoneDigits('call me maybe'), null);
  assert.equal(extractPhoneDigits('what?'), null);
  assert.equal(formatPhoneForSpeech('9876543210'), '9 8 7 6 5, 4 3 2 1 0');
  assert.equal(formatPhoneForSpeech('+919876543210'), 'plus 9 1, 9 8 7 6 5, 4 3 2 1 0');
});

test('phone numbers are confirmed by readback and can be re-spoken', async () => {
  const flow = createFlow();
  const ctx = ctxWith(fakeActions());
  await drive(flow, ['I am an influencer', '@handle_one', 'Ann', 'skip'], ctx);
  const confirm = await stepFlow(flow, '98765 43210', ctx);
  assert.match(confirm.speak, /I heard 9 8 7 6 5, 4 3 2 1 0/);
  assert.equal(flow.fields.phone, undefined);
  const denied = await stepFlow(flow, 'no, wrong', ctx);
  assert.match(denied.speak, /No problem/);
  assert.equal(flow.fields.phone, undefined);
  const confirm2 = await stepFlow(flow, '98111 22233', ctx);
  assert.match(confirm2.speak, /I heard 9 8 1 1 1, 2 2 2 3 3/);
  const accepted = await stepFlow(flow, 'yes', ctx);
  assert.match(accepted.speak, /city/);
  assert.equal(flow.fields.phone, '9811122233');
});

test('provider caller ID is used only when supplied and confirmed', async () => {
  // Confirmed: the full caller ID is stored without re-asking digits.
  const flow = createFlow();
  const ctx = ctxWith(fakeActions(), { callerId: '+919876543210' });
  await drive(flow, ['I am an influencer', '@handle_one', 'Ann', 'skip'], ctx);
  const offer = await stepFlow(flow, 'use my calling number', ctx);
  assert.match(offer.speak, /ending in 3210/);
  assert.equal(flow.fields.phone, undefined);
  const accepted = await stepFlow(flow, 'yes', ctx);
  assert.match(accepted.speak, /city/);
  assert.equal(flow.fields.phone, '+919876543210');

  // Declined: the caller speaks a different number, which is confirmed.
  const flow2 = createFlow();
  const ctx2 = ctxWith(fakeActions(), { callerId: '+919876543210' });
  await drive(flow2, ['I am an influencer', '@handle_one', 'Ann', 'skip'], ctx2);
  await stepFlow(flow2, 'hello', ctx2);
  const declined = await stepFlow(flow2, 'no, a different number', ctx2);
  assert.match(declined.speak, /phone number/);
  assert.equal(flow2.fields.phone, undefined);
  const spoken = await stepFlow(flow2, '98111 22233', ctx2);
  assert.match(spoken.speak, /I heard/);
  await stepFlow(flow2, 'yes', ctx2);
  assert.equal(flow2.fields.phone, '9811122233');

  // Speaking digits directly at the offer also overrides caller ID.
  const flow3 = createFlow();
  const ctx3 = ctxWith(fakeActions(), { callerId: '+919876543210' });
  await drive(flow3, ['I am an influencer', '@handle_one', 'Ann', 'skip'], ctx3);
  await stepFlow(flow3, 'hello', ctx3);
  const override = await stepFlow(flow3, '98111 22233', ctx3);
  assert.match(override.speak, /I heard 9 8 1 1 1, 2 2 2 3 3/);
  await stepFlow(flow3, 'yes', ctx3);
  assert.equal(flow3.fields.phone, '9811122233');

  // No caller ID supplied: the flow asks for digits outright.
  const flow4 = createFlow();
  const ctx4 = ctxWith(fakeActions());
  const spoken4 = await drive(flow4, ['I am an influencer', '@handle_one', 'Ann', 'skip'], ctx4);
  assert.match(spoken4[spoken4.length - 1], /What is your phone number/);
});

test('city, state, and country are stored separately with no inference', async () => {
  const flow = createFlow();
  const ctx = ctxWith(fakeActions());
  await drive(
    flow,
    ['I am an influencer', '@handle_one', 'Ann', 'skip', '98765 43210', 'yes', 'Mumbai', 'Maharashtra', 'India', 'food'],
    ctx
  );
  assert.equal(flow.fields.city, 'Mumbai');
  assert.equal(flow.fields.state, 'Maharashtra');
  assert.equal(flow.fields.country, 'India');
  // A city alone never implies a country.
  const flow2 = createFlow();
  await drive(
    flow2,
    ['I am an influencer', '@handle_one', 'Ann', 'skip', '98765 43210', 'yes', 'Paris', 'skip', 'skip', 'food'],
    ctx
  );
  assert.equal(flow2.fields.city, 'Paris');
  assert.equal(flow2.fields.state, undefined);
  assert.equal(flow2.fields.country, undefined);
});

test('role and niche are stored on the canonical state', async () => {
  const { flow } = await reachConfirm(fakeActions(), null);
  const state = getRegistrationState(flow);
  assert.equal(state.role, 'influencer');
  assert.equal(state.niche, 'food');
  assert.equal(state.instagramHandle, 'handle_one');
  assert.equal(state.firstName, 'Ann');
  assert.equal(state.lastName, null);
  assert.equal(state.consent, false);
  assert.equal(state.registrationCode, null);
  assert.equal(state.registrationStatus, 'none');
  assert.equal(state.registrationLinkStatus, 'none');
  assert.deepEqual(state.errors, []);
});

test('validateRegistrationDetails maps fields and reports per-field errors', () => {
  const good = validateRegistrationDetails('influencer', {
    instagram_username: 'priya.creates',
    first_name: 'Priya',
    last_name: 'Sharma',
    phone: '+919876543210',
    city: 'Mumbai',
    state: 'Maharashtra',
    country: 'India',
    niche: 'fashion'
  });
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.details, {
    full_name: 'Priya Sharma',
    phone: '+919876543210',
    city: 'Mumbai',
    state: 'Maharashtra',
    country: 'India',
    niche: 'fashion'
  });
  assert.equal(good.instagramUsername, 'priya.creates');

  const bad = validateRegistrationDetails('influencer', {
    instagram_username: 'not a handle!',
    first_name: '',
    phone: '123'
  });
  assert.ok(bad.errors.length >= 3);
  assert.ok(bad.errors.some(e => e.field === 'instagram_username'));
  assert.ok(bad.errors.some(e => e.field === 'phone'));

  const vendor = validateRegistrationDetails('vendor', {
    business_name: 'Acme',
    phone: '9810012345',
    campaign_title: 'Launch'
  });
  assert.deepEqual(vendor.errors, []);
  assert.equal(vendor.details.business_name, 'Acme');
  assert.equal(vendor.instagramUsername, null);
});

test('original utterances are preserved per slot for debugging', async () => {
  const { flow } = await reachConfirm(fakeActions(), null);
  assert.equal(flow.heard.instagram_username, '@handle_one');
  assert.equal(flow.heard.city, 'Goa');
  assert.equal(flow.heard.phone, '98765 43210');
});

test('correction never overwrites a confirmed value with an empty one', async () => {
  const actions = fakeActions();
  const { flow, ctx } = await reachConfirm(actions, null);
  await stepFlow(flow, 'no', ctx);
  await stepFlow(flow, 'city', ctx);
  const kept = await drive(flow, ['huh?', 'what?', 'pardon?'], ctx);
  assert.match(kept[kept.length - 1], /Kept your previous city/);
  assert.match(kept[kept.length - 1], /Goa/);
  assert.equal(flow.fields.city, 'Goa');
  assert.equal(flow.state, 'confirm');
  // The confirm turn still works afterwards (retries were reset).
  const again = await stepFlow(flow, 'sorry?', ctx);
  assert.match(again.speak, /yes or no/);
  assert.equal(flow.state, 'confirm');
});

test('consent retry replays the same idempotency key (no duplicate codes)', async () => {
  const actions = fakeActions({ fail: true });
  const { flow, ctx } = await reachConfirm(actions, null);
  await stepFlow(flow, 'yes', ctx);
  await stepFlow(flow, 'yes', ctx);
  await stepFlow(flow, 'yes try again', ctx);
  assert.equal(actions.calls.length, 2);
  assert.equal(actions.calls[0].clientRequestId, actions.calls[1].clientRequestId);
  assert.match(actions.calls[0].clientRequestId, /^vc-[A-Za-z0-9-]+$/);
});

test('registration code is read back exactly as returned, with no corrections', async () => {
  const actions = fakeActions({ linkCode: 'B8-8BBZ' });
  const { flow, ctx } = await reachConfirm(actions, null);
  await stepFlow(flow, 'yes', ctx);
  const out = await stepFlow(flow, 'yes', ctx);
  assert.match(out.speak, /B 8 - 8 B B Z/);
  assert.match(out.speak, /LINK B8-8BBZ/);
  assert.doesNotMatch(out.speak, /B8-8BBY|B8-8BBA/);
  const state = getRegistrationState(flow);
  assert.equal(state.registrationCode, 'B8-8BBZ');
  assert.equal(state.registrationStatus, 'pending');
  assert.equal(state.registrationLinkStatus, 'waiting');
  assert.equal(state.consent, true);
});

test('pending status never claims Instagram delivery; repeat is controlled to one', async () => {
  const actions = fakeActions();
  const { flow, ctx } = await reachConfirm(actions, null);
  await stepFlow(flow, 'yes', ctx);
  await stepFlow(flow, 'yes', ctx);

  const first = await stepFlow(flow, 'has my link been used?', ctx);
  assert.match(first.speak, /still waiting to be used/);
  assert.match(first.speak, /LINK K7P-2MD/);
  assert.doesNotMatch(first.speak, /has been sent|delivered|is waiting for you in Instagram/);

  const second = await stepFlow(flow, 'can you repeat the code?', ctx);
  assert.match(second.speak, /still waiting to be used/);
  assert.doesNotMatch(second.speak, /LINK K7P-2MD/);
  assert.match(second.speak, /new code|support/);
});

test('used status is claimed only after the backend confirms it', async () => {
  const actions = fakeActions({ statusResult: { used: true, expired: false, purpose: 'influencer' } });
  const { flow, ctx } = await reachConfirm(actions, null);
  await stepFlow(flow, 'yes', ctx);
  await stepFlow(flow, 'yes', ctx);
  const out = await stepFlow(flow, 'check my code status', ctx);
  assert.match(out.speak, /has been used/);
  assert.deepEqual(actions.statusCalls, ['sess_1']);
  const state = getRegistrationState(flow);
  assert.equal(state.registrationStatus, 'used');
  assert.equal(state.registrationLinkStatus, 'delivered');
});

test('status outage never invents a redemption claim', async () => {
  const actions = fakeActions({ statusFail: true });
  const { flow, ctx } = await reachConfirm(actions, null);
  await stepFlow(flow, 'yes', ctx);
  await stepFlow(flow, 'yes', ctx);
  const out = await stepFlow(flow, 'has my link been used?', ctx);
  assert.match(out.speak, /couldn't reach the registration service/);
  assert.doesNotMatch(out.speak, /has been used/);
  const state = getRegistrationState(flow);
  assert.equal(state.registrationStatus, 'unknown');
});
