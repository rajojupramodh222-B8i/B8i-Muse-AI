// test/verification.test.mjs
//
// B8i response-verification regression suite (workshop adaptation).
// Covers the required cases G1..G25 plus root-cause pins R1..R4 found
// during inspection of worker.js. Same safety contract as the other
// suites: synthetic env + in-memory KV + test-only origin + network
// isolation (mocked Instagram shapes only; everything else fails closed
// and every behavioral test asserts zero new blocked attempts).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  B8I_MODEL_MAX_ANSWER_CHARS,
  B8iModelBudget,
  B8I_VERIFY_BUILD_TIMEOUT_MS,
  B8I_VERIFY_FORBIDDEN_MAX_ENTRIES,
  B8I_VERIFY_MAX_ATTEMPTS,
  B8I_VERIFY_MAX_OUTBOUND_CHARS,
  B8I_VERIFY_MAX_OUTBOUND_REPLIES,
  B8I_VERIFY_MAX_RESPONSE_CHARS,
  B8I_VERIFY_MINIMAL_FALLBACK_EN,
  B8I_VERIFY_SEMANTIC_TIMEOUT_MS,
  verifyResponseBeforeSend,
  verifyAssistantResponse,
  semanticEvaluateResponse,
  defaultSemanticEvaluator,
  validateSemanticResult,
  deliverVerifiedAssistantResponse,
  verificationFallbackText,
  verifyFallbackSafe,
  verifyFinalOutboundPayload,
  verifyIntentForText,
  verifyMessageShape,
  isB8iStatusQueryText,
  extractVerifyEntities,
  b8iNormalizeEntityValue,
  b8iTrustedTitleEntities,
  buildVerificationEvaluatorPayload,
  b8iRecommendForbiddenPii,
  b8iRecommendTrustedEntities,
  b8iRecommendCardNames,
  b8iRecommendCardUrls,
  b8iRecommendRequired,
  classifyChatIntent,
  detectChatLanguage,
  chatReply,
  chatFlow,
  parseRecommendIntent,
  buildMembershipText,
  validateModelReply,
  createManualPayoutRecords,
  initiateInfluencerPayout,
} from '../worker.js';
import {
  TEST_ORIGIN,
  ISOLATION_ERROR_PATTERN,
  createSyntheticEnv,
  installNetworkIsolation,
  buildInstagramWebhookRequest,
  buildTextMessagePayload,
  createTestContext,
  drainWaitUntil,
  messagesFor,
} from './helpers.mjs';

// Installed before any test or worker call in this file.
const isolation = installNetworkIsolation();

let senderSeq = 0;
const nextSender = (tag) => `verify_${tag}_${Date.now()}_${(senderSeq += 1)}`;

// POST one signed text message through the real webhook route, drain the
// worker's background tasks, and return the DMs captured for that sender.
// Fails the test if the flow attempted any blocked outbound call.
async function postTextAndDrain({ text, env, tctx, senderId, mid = null }) {
  const sender = senderId ?? nextSender('dm');
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

async function seedJson(env, key, record) {
  await env.INSTAGRAM_CONVERSATIONS.put(key, JSON.stringify(record));
}

// POST one signed quick-reply tap through the real webhook route and drain.
async function postQuickReplyAndDrain({ payload, text, env, senderId }) {
  const sender = senderId ?? nextSender('qr');
  const req = buildInstagramWebhookRequest({
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
                mid: `mid_qr_${sender}_${Date.now()}`,
                text,
                quick_reply: { payload },
              },
            },
          ],
        },
      ],
    },
    secret: env.INSTAGRAM_APP_SECRET,
  });
  const before = isolation.snapshot();
  const tctx = createTestContext();
  const res = await worker.fetch(req, env, tctx.ctx);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'EVENT_RECEIVED');
  await drainWaitUntil(tctx);
  const after = isolation.snapshot();
  assert.equal(
    after.blockedFailClosed - before.blockedFailClosed,
    0,
    'quick tap must not attempt blocked outbound calls',
  );
  return { sender, dms: messagesFor(isolation.sentMessages, sender) };
}

async function seedVendor(env, id, record = {}) {
  await seedJson(env, `VENDOR:${id}`, { instagram_user_id: id, ...record });
}

async function seedCreator(env, id, record = {}) {
  await seedJson(env, `INFLUENCER:${id}`, {
    instagram_user_id: id,
    verification_status: 'APPROVED',
    subscription_status: 'active',
    ...record,
  });
}

async function seedCampaign(env, id, record) {
  await seedJson(env, `CAMPAIGN:${id}`, { campaign_id: id, ...record });
}

const STATUS_REQUIRED = [
  { id: 'vendor_header', anyOf: ['Your campaigns as a vendor:'] },
  { id: 'vendor_detail', anyOf: ['waiting for payment', 'finding creators'] },
];

describe('Verification — Layer 1 deterministic gate (G1..G10)', () => {
  it('[G1] relevant English answer passes', async () => {
    const r = verifyResponseBeforeSend({
      userText: 'Where is my campaign?',
      intent: 'status',
      lang: 'en',
      responseText:
        'Your campaigns as a vendor:\n• Soap Launch — waiting for payment. ' +
        'Next: Complete payment from your campaign link to activate creator matching.',
      required: STATUS_REQUIRED,
      mustContain: ['Soap Launch'],
      sensitive: true,
    });
    assert.equal(r.verdict, 'pass');
    assert.deepEqual(r.reasonCodes, []);
    assert.deepEqual(r.missingParts, []);

    // And the real wired path delivers the real reply (not a fallback).
    const env = createSyntheticEnv();
    const vendor = nextSender('g1');
    await seedVendor(env, vendor, { business_name: 'G1 Shop' });
    await seedCampaign(env, `g1_${Date.now()}`, {
      vendor_instagram_user_id: vendor,
      campaign_title: 'Soap Launch',
      payment_status: 'PENDING',
      status: 'AWAITING_PAYMENT',
    });
    const { dms } = await postTextAndDrain({
      text: 'Where is my campaign?',
      env,
      tctx: createTestContext(),
      senderId: vendor,
    });
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /Soap Launch — waiting for payment/);
  });

  it('[G2] relevant Telugu answer passes', async () => {
    assert.equal(detectChatLanguage('నమస్తే', undefined), 'te');
    assert.equal(classifyChatIntent('నమస్తే'), 'greeting');
    const reply = chatReply('greeting', 'te', 0);
    const r = verifyResponseBeforeSend({
      userText: 'నమస్తే',
      intent: 'greeting',
      lang: 'te',
      responseText: reply,
      replyIntent: 'greeting',
    });
    assert.equal(r.verdict, 'pass');

    const env = createSyntheticEnv();
    const { dms } = await postTextAndDrain({
      text: 'నమస్తే',
      env,
      tctx: createTestContext(),
      senderId: nextSender('g2'),
    });
    assert.equal(dms.length, 1);
    assert.equal(dms[0].message.text, reply);
  });

  it('[G3] Tenglish input preserves its meaning', () => {
    assert.equal(
      detectChatLanguage('nenu vendor ga join avvali', undefined),
      'tenglish',
    );
    const routed = verifyIntentForText('nenu vendor ga join avvali', 'vendor_reg');
    assert.equal(routed.ok, true);
    assert.equal(routed.evidence, 'classifier');

    // Tenglish flow reply resolves exactly; Tenglish summary keeps data.
    const q = chatFlow('brief_q_product', 'tenglish');
    const flow = verifyResponseBeforeSend({
      userText: 'emi kavali',
      intent: 'brief_answer',
      lang: 'tenglish',
      responseText: q,
      flowKey: 'brief_q_product',
    });
    assert.equal(flow.verdict, 'pass');

    const summary =
      'Nee campaign brief:\n• Product: soap\n• Niche: beauty\n' +
      '• Budget: ₹50,000\n\n"yes" ani cheppu, vendor form link istanu — leka em marchalo cheppu.';
    const checked = verifyResponseBeforeSend({
      userText: 'soap beauty 50000',
      intent: 'brief_answer',
      lang: 'tenglish',
      responseText: summary,
      summaryFor: 'tenglish',
      mustContain: ['soap', 'beauty', '₹50,000'],
      invariantSource: 'soap | beauty | ₹50,000',
    });
    assert.equal(checked.verdict, 'pass');
  });

  it('[G4] Hindi, Spanish, and Portuguese intent remains correct', () => {
    const cases = [
      ['namaste', 'hi', 'greeting'],
      ['hola', 'es', 'greeting'],
      ['obrigado', 'pt', 'thanks'],
      ['mera payment status batao', 'hi', 'payment_any'],
      ['cuánto cuesta la membresia', 'es', 'membership'],
      ['quero ser vendedor', 'pt', 'vendor_reg'],
    ];
    for (const [text, lang, intent] of cases) {
      assert.equal(detectChatLanguage(text, undefined), lang, text);
      assert.equal(classifyChatIntent(text), intent, text);
      const routed = verifyIntentForText(text, intent);
      assert.equal(routed.ok, true, text);
    }
  });

  it('[G5] generic marketing advice to a campaign-status question fails', () => {
    const tips = chatFlow('marketing_content_tips', 'en');
    assert.ok(tips.length > 50);
    const r = verifyResponseBeforeSend({
      userText: 'What is the status of my campaign?',
      intent: 'status',
      lang: 'en',
      responseText: tips,
      required: STATUS_REQUIRED,
      sensitive: true,
    });
    assert.equal(r.verdict, 'fail');
    assert.ok(r.reasonCodes.includes('missing:vendor_header'));
    assert.ok(r.reasonCodes.includes('missing:vendor_detail'));
    assert.ok(r.missingParts.includes('vendor_header'));
    assert.ok(r.corrections.length > 0);
    // The intent itself matched; the CONTENT failed — relevance is proven
    // by required discourse acts, not keyword overlap.
    assert.equal(r.checks.intent, 'pass');
    assert.equal(r.checks.required, 'fail');
  });

  it('[G6] unrelated influencer recommendations fail', () => {
    const recoText =
      'I found 3 eligible creators. Individual creator profiles stay private ' +
      'until your campaign is active and a creator accepts it.\n\nSuggestions only.';
    const r = verifyResponseBeforeSend({
      userText: 'Where is my payout?',
      intent: 'payout_info',
      lang: 'en',
      responseText: recoText,
      required: [
        { id: 'payout_explainer', anyOf: ["Here's how B8i payouts work"] },
        { id: 'role_question', anyOf: ['Are you asking as the vendor'] },
      ],
      sensitive: true,
    });
    assert.equal(r.verdict, 'fail');
    assert.ok(r.reasonCodes.includes('missing:payout_explainer'));

    // Reverse direction: payout answer to a recommendation question fails.
    const payoutText =
      "Here's how B8i payouts work:\n\n1. The creator submits the completed work.";
    const r2 = verifyResponseBeforeSend({
      userText: 'Suggest a fashion influencer.',
      intent: 'recommend',
      lang: 'en',
      responseText: payoutText,
      required: b8iRecommendRequired({ niche: 'fashion', shownCount: 0, preAuth: true }),
      sensitive: true,
    });
    assert.equal(r2.verdict, 'fail');
    assert.ok(r2.reasonCodes.includes('missing:reco_header'));
  });

  it('[G7] incorrect campaign identity or status fails', () => {
    // Wrong title: the authorized title is Soap Launch, not Secret Launch.
    const wrongTitle = verifyResponseBeforeSend({
      userText: 'What is the status of my campaign?',
      intent: 'status',
      lang: 'en',
      responseText: 'Your campaigns as a vendor:\n• Secret Launch — finding creators.',
      required: STATUS_REQUIRED,
      mustContain: ['Soap Launch'],
      sensitive: true,
    });
    assert.equal(wrongTitle.verdict, 'fail');
    assert.ok(wrongTitle.reasonCodes.includes('missing_required_values'));

    // Wrong count: stated 5, retrieved 3.
    const wrongCount = verifyResponseBeforeSend({
      userText: 'Suggest an influencer.',
      intent: 'recommend',
      lang: 'en',
      responseText: 'I found 5 eligible creators. Suggestions only.',
      required: b8iRecommendRequired({ niche: null, shownCount: 0, preAuth: true }),
      facts: { expectedCount: 3 },
      sensitive: true,
    });
    assert.equal(wrongCount.verdict, 'fail');
    assert.ok(wrongCount.reasonCodes.includes('count_mismatch'));
    assert.ok(
      wrongCount.unsupportedClaims.some((c) => c.includes('stated 5') && c.includes('retrieved 3')),
    );
  });

  it('[G8] missing parts of a multi-part question fail or trigger clarification', async () => {
    const required = [
      { id: 'plans_part', anyOf: ['creator membership plans'] },
      { id: 'payout_part', anyOf: ["Here's how B8i payouts work"] },
    ];
    const r = verifyResponseBeforeSend({
      userText: 'What are the membership plans? And where is my payout?',
      intent: 'payout_info',
      lang: 'en',
      responseText: 'B8i creator membership plans (for influencers): Starter, Growth, Pro.',
      required,
      sensitive: true,
    });
    assert.equal(r.verdict, 'fail');
    assert.deepEqual(r.missingParts, ['payout_part']);
    assert.ok(r.corrections.join(' ').includes('payout_part'));

    // At the loop level the persistent gap yields the clarifying fallback.
    const env = createSyntheticEnv();
    const sender = nextSender('g8');
    const out = await deliverVerifiedAssistantResponse({
      senderId: sender,
      userText: 'What are the membership plans? And where is my payout?',
      intent: 'payout_info',
      lang: 'en',
      facts: {},
      required,
      sensitive: true,
      semanticMode: 'off',
      buildResponse: async () =>
        'B8i creator membership plans (for influencers): Starter, Growth, Pro.',
      env,
    });
    assert.equal(out.delivered, 'fallback');
    const dms = messagesFor(isolation.sentMessages, sender);
    assert.equal(dms.length, 1);
    assert.equal(dms[0].message.text, verificationFallbackText('en', 'clarify'));
  });

  it('[G9] unsupported facts fail', () => {
    const r = verifyResponseBeforeSend({
      userText: 'zxqv blorp snork',
      intent: 'model',
      lang: 'en',
      responseText: 'Your payout of ₹50,000 is ready and was sent on 2026-01-15. See CAMPAIGN:xyz.',
      facts: { kbTrusted: true },
      strictEntities: true,
      forbidActionClaims: true,
      sensitive: true,
    });
    assert.equal(r.verdict, 'fail');
    assert.ok(r.reasonCodes.includes('unsupported_fact'));
    assert.ok(r.unsupportedClaims.includes('₹50,000'));
    assert.ok(r.unsupportedClaims.includes('2026-01-15'));
    assert.ok(r.unsupportedClaims.includes('CAMPAIGN:xyz'));

    // KB-grounded values pass the same strict check.
    const ok = verifyResponseBeforeSend({
      userText: 'zxqv blorp snork',
      intent: 'model',
      lang: 'en',
      responseText: 'Starter membership is ₹199/month with an 8% platform fee on money campaigns.',
      facts: { kbTrusted: true },
      strictEntities: true,
      forbidActionClaims: true,
      sensitive: true,
    });
    assert.equal(ok.verdict, 'pass');
  });

  it('[G10] changed prices, dates, names, and IDs after translation fail', () => {
    const src = 'Total ₹5,000 for @aria_style, campaign CAMPAIGN:ord_1, due 2026-02-01.';
    const base = {
      userText: 'q',
      intent: 'brief_answer',
      lang: 'en',
      invariantSource: src,
    };
    const changed = [
      'Total ₹6,000 for @aria_style, campaign CAMPAIGN:ord_1, due 2026-02-01.',
      'Total ₹5,000 for @aria_style, campaign CAMPAIGN:ord_1, due 2026-03-01.',
      'Total ₹5,000 for @aria_style, campaign CAMPAIGN:ord_2, due 2026-02-01.',
      'Total ₹5,000 for @bella_style, campaign CAMPAIGN:ord_1, due 2026-02-01.',
    ];
    for (const responseText of changed) {
      const r = verifyResponseBeforeSend({ ...base, responseText });
      assert.equal(r.verdict, 'fail', responseText);
      assert.ok(r.reasonCodes.includes('translation_changed_facts'), responseText);
      assert.ok(r.unsupportedClaims.length > 0);
    }
    // Identical invariants pass.
    const ok = verifyResponseBeforeSend({ ...base, responseText: src });
    assert.equal(ok.verdict, 'pass');
    // Names are pinned verbatim via mustContain (data is never paraphrased).
    const renamed = verifyResponseBeforeSend({
      ...base,
      responseText: 'Creator Bella is assigned.',
      invariantSource: null,
      mustContain: ['Aria'],
    });
    assert.equal(renamed.verdict, 'fail');
    assert.ok(renamed.reasonCodes.includes('missing_required_values'));
  });

  it('[R3] strict entities are scoped: static templates pass unstrict, strict without ground truth fails closed', () => {
    // ₹199 in the static membership template is pinned by markers and
    // regression tests — not mistaken for an ungrounded dynamic claim.
    const ok = verifyResponseBeforeSend({
      userText: 'membership plans',
      intent: 'membership_branch',
      lang: 'en',
      responseText: buildMembershipText(),
      required: [{ id: 'membership_header', anyOf: ['B8i creator membership plans'] }],
    });
    assert.equal(ok.verdict, 'pass');

    // Strict validation with no trusted records refuses to guess.
    const bad = verifyResponseBeforeSend({
      userText: 'Suggest an influencer.',
      intent: 'recommend',
      lang: 'en',
      responseText: 'I found 3 eligible creators. Suggestions only.',
      strictEntities: true,
    });
    assert.equal(bad.verdict, 'fail');
    assert.ok(bad.reasonCodes.includes('missing_ground_truth'));
  });

  it('[R4] classifier intent-mismatch is detected; routed branch labels carry route evidence', () => {
    // classifyChatIntent returns null for the canonical payout question,
    // so a classifier-intent claim against it must fail loudly.
    const mismatch = verifyIntentForText('where is my payout', 'payout_any');
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reasonCode, 'intent_mismatch');
    // The phase-1 branch label instead carries routed evidence.
    const routed = verifyIntentForText('where is my payout', 'payout_info');
    assert.equal(routed.ok, true);
    assert.equal(routed.evidence, 'routed');
    // Unknown labels always fail closed.
    assert.equal(verifyIntentForText('hello', 'nope').ok, false);
    assert.equal(verifyIntentForText('hello', '').reasonCode, 'unknown_intent');
  });
});

describe('Verification — Layer 2 semantic evaluation (G11..G12, G23)', () => {
  it('[G11] malformed evaluator output fails safely', async () => {
    const malformed = [
      42,
      'pass',
      null,
      undefined,
      { verdict: 'maybe', reasonCodes: [], unsupportedClaims: [], missingParts: [], corrections: [] },
      { verdict: 'pass' },
      { verdict: 'pass', reasonCodes: ['a'], unsupportedClaims: [], missingParts: [], corrections: [123] },
      { verdict: 'pass', reasonCodes: 'nope', unsupportedClaims: [], missingParts: [], corrections: [] },
      [],
    ];
    for (const bad of malformed) {
      assert.equal(validateSemanticResult(bad), null, JSON.stringify(bad));
      const r = await semanticEvaluateResponse(
        { userText: 'q', intent: 'greeting', lang: 'en', responseText: 'hi', facts: {} },
        { evaluator: async () => bad },
      );
      assert.equal(r.verdict, 'uncertain');
      assert.ok(r.reasonCodes.includes('evaluator_invalid'));
    }
    // A well-formed custom result passes schema validation untouched.
    const good = {
      verdict: 'pass',
      reasonCodes: ['custom_ok'],
      unsupportedClaims: [],
      missingParts: [],
      corrections: [],
    };
    assert.deepEqual(validateSemanticResult(good), good);

    // Uncertain-from-invalid fails closed for sensitive responses...
    const sensitiveInput = {
      userText: 'Where is my campaign?',
      intent: 'status',
      lang: 'en',
      responseText: 'Your campaigns as a vendor:\n• X — finding creators.',
      required: [{ id: 'vendor_header', anyOf: ['Your campaigns as a vendor:'] }],
      semanticMode: 'required',
      sensitive: true,
    };
    const sensitive = await verifyAssistantResponse(sensitiveInput, {
      evaluator: async () => ({ garbage: true }),
    });
    assert.equal(sensitive.verdict, 'fail');
    assert.equal(sensitive.layer, 'semantic');
    assert.ok(sensitive.reasonCodes.includes('evaluator_invalid'));
    assert.ok(sensitive.reasonCodes.includes('uncertain_fails_sensitive'));

    // ...while low-risk chit-chat may pass with an explicit note.
    const casual = await verifyAssistantResponse(
      {
        userText: 'hello',
        intent: 'greeting',
        lang: 'en',
        responseText: chatReply('greeting', 'en', 0),
        replyIntent: 'greeting',
        semanticMode: 'required',
        sensitive: false,
      },
      { evaluator: async () => ({ garbage: true }) },
    );
    assert.equal(casual.verdict, 'pass');
    assert.ok(casual.reasonCodes.includes('semantic_uncertain_low_risk'));
  });

  it('[G11b] default evaluator fails marketing-advice-to-status and passes grounded replies', () => {
    const fail = defaultSemanticEvaluator({
      userText: 'What is the status of my campaign?',
      intent: 'status',
      lang: 'en',
      responseText: chatFlow('marketing_content_tips', 'en'),
      allowEntities: [],
    });
    assert.equal(fail.verdict, 'fail');
    assert.ok(fail.reasonCodes.includes('semantic_missing:status'));
    assert.ok(fail.missingParts.length > 0);

    const pass = defaultSemanticEvaluator({
      userText: 'What is the status of my campaign?',
      intent: 'status',
      lang: 'en',
      responseText: 'Your campaigns as a vendor:\n• X — finding creators.',
      allowEntities: [],
    });
    assert.equal(pass.verdict, 'pass');

    // Unsupported money in a general reply fails even without clauses.
    const money = defaultSemanticEvaluator({
      userText: 'zxqv blorp',
      intent: 'model',
      lang: 'en',
      responseText: 'You won ₹99,999.',
      allowEntities: [{ kind: 'money', value: '199' }],
    });
    assert.equal(money.verdict, 'fail');
    assert.deepEqual(money.unsupportedClaims, ['₹99,999']);

    // Evaluator payloads never carry secrets, contact data, or tokens.
    const payload = buildVerificationEvaluatorPayload({
      userText: 'call TEST_ONLY_secret_9f2c7a41 or me at agent@example.com / +91-11111-22222 id 99000111222',
      intent: 'support',
      lang: 'en',
      responseText: 'ok 99000111222',
      facts: {
        trusted: [{ kind: 'money', value: '199' }],
        token: 'TEST_ONLY_reg_token',
        phone: '+91-00000-00000',
        amount: 500,
      },
    });
    const serialized = JSON.stringify(payload);
    for (const leak of [
      'TEST_ONLY_secret_9f2c7a41',
      'agent@example.com',
      '11111',
      '99000111222',
      'TEST_ONLY_reg_token',
    ]) {
      assert.ok(!serialized.includes(leak), leak);
    }
  });

  it('[G12] evaluator timeout does not cause an infinite loop', async () => {
    const hanging = () => new Promise(() => {});
    const started = Date.now();
    const r = await semanticEvaluateResponse(
      { userText: 'q', intent: 'status', lang: 'en', responseText: 'x', facts: {} },
      { evaluator: hanging, timeoutMs: 30 },
    );
    assert.equal(r.verdict, 'uncertain');
    assert.ok(r.reasonCodes.includes('evaluator_timeout'));
    assert.ok(Date.now() - started < 5000, 'semantic timeout must resolve promptly');

    // The delivery loop still terminates (bounded attempts, then fallback).
    const env = createSyntheticEnv();
    const sender = nextSender('g12');
    const loopStarted = Date.now();
    const out = await deliverVerifiedAssistantResponse({
      senderId: sender,
      userText: 'Where is my campaign?',
      intent: 'status',
      lang: 'en',
      facts: {},
      required: STATUS_REQUIRED,
      mustContain: ['X'],
      sensitive: true,
      semanticMode: 'required',
      timeoutMs: 25,
      maxAttempts: 2,
      evaluator: hanging,
      buildResponse: async () => 'Your campaigns as a vendor:\n• X — finding creators.',
      env,
    });
    assert.ok(Date.now() - loopStarted < 10000, 'delivery loop must terminate');
    assert.equal(out.delivered, 'fallback');
    assert.equal(out.attempts, 2);
    assert.equal(out.log.length, 2);
    assert.ok(out.log.every((e) => e.reasonCodes.includes('evaluator_timeout')));
    const dms = messagesFor(isolation.sentMessages, sender);
    assert.equal(dms.length, 1);
    assert.equal(dms[0].message.text, verificationFallbackText('en', 'default'));
  });

  it('[G23] semantic relevance does not override factual validation', async () => {
    let calls = 0;
    const alwaysPass = async () => {
      calls += 1;
      return {
        verdict: 'pass',
        reasonCodes: ['stub_pass'],
        unsupportedClaims: [],
        missingParts: [],
        corrections: [],
      };
    };
    const r = await verifyAssistantResponse(
      {
        userText: 'zxqv blorp',
        intent: 'model',
        lang: 'en',
        responseText: 'Your balance is ₹99,999.',
        facts: { kbTrusted: true },
        strictEntities: true,
        sensitive: true,
        semanticMode: 'required',
      },
      { evaluator: alwaysPass },
    );
    assert.equal(r.verdict, 'fail');
    assert.equal(r.layer, 'deterministic');
    assert.equal(calls, 0, 'semantic must not run after deterministic factual failure');
    assert.ok(r.reasonCodes.includes('unsupported_fact'));
  });
});

describe('Verification — bounded loop, correction, fallback (G13..G14, G18, G24)', () => {
  it('[G13] failed initial response then valid correction delivers only the corrected response', async () => {
    const env = createSyntheticEnv();
    const sender = nextSender('g13');
    const GOOD = 'Your campaigns as a vendor:\n• Soap Launch — finding creators.';
    const calls = [];
    const out = await deliverVerifiedAssistantResponse({
      senderId: sender,
      userText: 'Where is my campaign?',
      intent: 'status',
      lang: 'en',
      facts: {},
      required: STATUS_REQUIRED,
      mustContain: ['Soap Launch'],
      sensitive: true,
      semanticMode: 'off',
      buildResponse: async ({ attempt, corrections }) => {
        calls.push({ attempt, corrections: [...corrections] });
        return attempt === 1 ? 'Generic marketing tips: post reels daily for growth.' : GOOD;
      },
      env,
    });
    assert.equal(out.delivered, 'corrected');
    assert.equal(out.attempts, 2);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].corrections, []);
    assert.ok(calls[1].corrections.length > 0, 'correction attempt receives failure reasons');
    const dms = messagesFor(isolation.sentMessages, sender);
    assert.equal(dms.length, 1, 'exactly one message is ever delivered');
    assert.equal(dms[0].message.text, GOOD);
    assert.ok(!dms[0].message.text.includes('marketing tips'));
  });

  it('[G14] repeated verification failure produces a safe fallback', async () => {
    const env = createSyntheticEnv();
    const sender = nextSender('g14');
    let builds = 0;
    const out = await deliverVerifiedAssistantResponse({
      senderId: sender,
      userText: 'Where is my campaign?',
      intent: 'status',
      lang: 'en',
      facts: {},
      required: STATUS_REQUIRED,
      sensitive: true,
      semanticMode: 'off',
      buildResponse: async () => {
        builds += 1;
        return 'BAD_WATERMARK_G14 marketing fluff with no status content.';
      },
      env,
    });
    assert.equal(out.delivered, 'fallback');
    assert.equal(out.attempts, B8I_VERIFY_MAX_ATTEMPTS);
    assert.equal(builds, B8I_VERIFY_MAX_ATTEMPTS);
    assert.ok(out.reasonCodes.includes('fallback_delivered'));
    const dms = messagesFor(isolation.sentMessages, sender);
    assert.equal(dms.length, 1);
    assert.ok(!dms[0].message.text.includes('BAD_WATERMARK_G14'));
    assert.equal(dms[0].message.text, verificationFallbackText('en', 'clarify'));
  });

  it('[G18] empty or malformed model output is handled safely', async () => {
    assert.equal(validateModelReply(''), null);
    assert.equal(validateModelReply('   '), null);
    for (const bad of ['', '   ', null, undefined, 123, {}, []]) {
      const r = verifyResponseBeforeSend({
        userText: 'hello',
        intent: 'greeting',
        lang: 'en',
        responseText: bad,
        replyIntent: 'greeting',
      });
      assert.equal(r.verdict, 'fail', JSON.stringify(bad));
      assert.ok(r.reasonCodes.includes('empty_response'), JSON.stringify(bad));
    }
    // A builder that returns '' then throws still ends in a fallback.
    const env = createSyntheticEnv();
    const sender = nextSender('g18');
    let n = 0;
    const out = await deliverVerifiedAssistantResponse({
      senderId: sender,
      userText: 'hello',
      intent: 'greeting',
      lang: 'en',
      facts: {},
      replyIntent: 'greeting',
      semanticMode: 'off',
      maxAttempts: 2,
      buildResponse: async () => {
        n += 1;
        if (n === 1) return '';
        throw new Error('boom');
      },
      env,
    });
    assert.equal(out.delivered, 'fallback');
    assert.equal(out.attempts, 2);
    assert.ok(out.log.some((e) => e.reasonCodes.includes('build_error')));
    assert.ok(out.log.some((e) => e.reasonCodes.includes('empty_response')));
    const dms = messagesFor(isolation.sentMessages, sender);
    assert.equal(dms.length, 1);
  });

  it('[G24] retry count and timeout limits are tested explicitly', async () => {
    assert.equal(B8I_VERIFY_MAX_ATTEMPTS, 3);
    assert.ok(B8I_VERIFY_SEMANTIC_TIMEOUT_MS > 0);
    assert.ok(B8I_VERIFY_MAX_RESPONSE_CHARS >= B8I_MODEL_MAX_ANSWER_CHARS);

    // Persistent failure rebuilds exactly 3 times, then stops.
    const env = createSyntheticEnv();
    let builds = 0;
    const out = await deliverVerifiedAssistantResponse({
      senderId: nextSender('g24'),
      userText: 'Where is my campaign?',
      intent: 'status',
      lang: 'en',
      facts: {},
      required: STATUS_REQUIRED,
      sensitive: true,
      semanticMode: 'off',
      buildResponse: async () => {
        builds += 1;
        return 'still wrong';
      },
      env,
    });
    assert.equal(builds, 3);
    assert.equal(out.attempts, 3);
    assert.equal(out.log.length, 3);

    // A slow evaluator is cut off at the timeout (not awaited).
    const started = Date.now();
    const r = await semanticEvaluateResponse(
      { userText: 'q', intent: 'greeting', lang: 'en', responseText: 'hi', facts: {} },
      {
        timeoutMs: 25,
        evaluator: async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return {
            verdict: 'pass',
            reasonCodes: ['too_slow'],
            unsupportedClaims: [],
            missingParts: [],
            corrections: [],
          };
        },
      },
    );
    assert.equal(r.verdict, 'uncertain');
    assert.ok(Date.now() - started < 400, 'timeout must cut off a slow evaluator');

    // Invalid message shape is also bounded (3 attempts, then fallback).
    const sender = nextSender('g24shape');
    const shaped = await deliverVerifiedAssistantResponse({
      senderId: sender,
      userText: 'hello',
      intent: 'greeting',
      lang: 'en',
      facts: {},
      replyIntent: 'greeting',
      semanticMode: 'off',
      quickReplies: [{ content_type: 'text', title: 'way too long title for meta', payload: 'x' }],
      buildResponse: async () => chatReply('greeting', 'en', 0),
      env,
    });
    assert.equal(shaped.delivered, 'fallback');
    assert.equal(shaped.attempts, 3);
    assert.ok(shaped.reasonCodes.includes('invalid_message_shape'));
    assert.ok(verifyMessageShape({ text: 'hi' }));
    assert.equal(verifyMessageShape({ text: '' }), false);
    assert.equal(verifyMessageShape({ text: 'x'.repeat(B8I_VERIFY_MAX_RESPONSE_CHARS + 1) }), false);

    // Status-query trigger used by the gate mirrors the route condition.
    assert.equal(isB8iStatusQueryText('Where is my campaign?'), true);
    assert.equal(isB8iStatusQueryText('track my application'), true);
    assert.equal(isB8iStatusQueryText('hello there'), false);
    assert.equal(isB8iStatusQueryText(''), false);
  });
});

describe('Verification — privacy and isolation end to end (G15..G17)', () => {
  it('[G15] unauthorized creator information never reaches the user', async () => {
    // Forbidden PII fails the gate at unit level.
    const blocked = verifyResponseBeforeSend({
      userText: 'Suggest a fashion influencer.',
      intent: 'recommend',
      lang: 'en',
      responseText: 'I found 1 eligible creator: • Aria — fashion. Suggestions only.',
      required: b8iRecommendRequired({ niche: 'fashion', shownCount: 1, preAuth: false }),
      facts: { forbidden: ['Aria', 'aria_style'] },
      sensitive: true,
    });
    assert.equal(blocked.verdict, 'fail');
    assert.ok(blocked.reasonCodes.includes('forbidden_content'));

    // Pre-authorization end to end: counts only, zero identities.
    const env = createSyntheticEnv();
    await seedCreator(env, 'v_aria', {
      full_name: 'Aria',
      instagram_username: 'aria_style',
      niche: 'fashion',
      followers: 120000,
      phone: '+91-11111-22222',
      email: 'aria-private@example.com',
      instagram_url: 'https://www.instagram.com/aria_style/',
    });
    const pre = await postTextAndDrain({
      text: 'Suggest a fashion influencer.',
      env,
      tctx: createTestContext(),
      senderId: nextSender('g15pre'),
    });
    assert.equal(pre.dms.length, 1);
    const preText = pre.dms[0].message.text;
    assert.match(preText, /I found 1 eligible fashion creator/);
    for (const leak of [
      'Aria', 'aria_style', '11111', 'aria-private', '120,000', '120000',
      'instagram.com', '•', '★', '@',
    ]) {
      assert.ok(!preText.includes(leak), leak);
    }

    // Post-authorization: the accepted creator is shown; the outsider stays
    // private even though both matched retrieval.
    const env2 = createSyntheticEnv();
    const vendor = nextSender('g15post');
    await seedCreator(env2, 'v_big', {
      full_name: 'Bigya',
      instagram_username: 'bigya_style',
      niche: 'fashion',
      followers: 200000,
      phone: '+91-22222-33333',
      instagram_url: 'https://www.instagram.com/bigya_style/',
    });
    await seedCreator(env2, 'v_out', {
      full_name: 'Outi',
      instagram_username: 'outi_style',
      niche: 'fashion',
      followers: 500000,
      phone: '+91-44444-55555',
      instagram_url: 'https://www.instagram.com/outi_style/',
    });
    await seedCampaign(env2, `g15_${Date.now()}`, {
      vendor_instagram_user_id: vendor,
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['v_big'],
    });
    const post = await postTextAndDrain({
      text: 'Suggest a fashion influencer.',
      env: env2,
      tctx: createTestContext(),
      senderId: vendor,
    });
    assert.equal(post.dms.length, 1);
    const postText = post.dms[0].message.text;
    assert.match(postText, /from your active campaigns/);
    assert.ok(postText.includes('Bigya'));
    assert.ok(postText.includes('200,000 followers'));
    for (const leak of ['Outi', 'outi_style', '44444', '55555', '500,000']) {
      assert.ok(!postText.includes(leak), leak);
    }
  });

  it('[G16] one vendor cannot access another vendor private campaign information', async () => {
    const env = createSyntheticEnv();
    await seedVendor(env, 'v_a', { business_name: 'Shop A' });
    await seedVendor(env, 'v_b', { business_name: 'Shop B' });
    await seedCampaign(env, 'v_secret', {
      vendor_instagram_user_id: 'v_a',
      campaign_title: 'Secret Launch',
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: ['c9'],
    });
    // Forged index entry pointing B at A's campaign must not leak it.
    await seedJson(env, 'VENDOR_CAMPAIGN:v_b:v_secret', {
      v: 1, vendor_id: 'v_b', campaign_id: 'v_secret',
    });
    await seedJson(env, 'VENDOR_CAMPAIGN_SYNC:v_b', { v: 1, scan_complete: true });
    const { dms } = await postTextAndDrain({
      text: 'What is the status of my campaign?',
      env,
      tctx: createTestContext(),
      senderId: 'v_b',
    });
    assert.match(dms[0].message.text, /No campaigns found on your vendor account/);
    assert.ok(!dms[0].message.text.includes('Secret Launch'));

    // The gate's forbidden direction pins the same rule at unit level.
    const r = verifyResponseBeforeSend({
      userText: 'What is the status of my campaign?',
      intent: 'status',
      lang: 'en',
      responseText: 'Your campaigns as a vendor:\n• Secret Launch — finding creators.',
      required: STATUS_REQUIRED,
      facts: { forbidden: ['Secret Launch'] },
      sensitive: true,
    });
    assert.equal(r.verdict, 'fail');
    assert.ok(r.reasonCodes.includes('forbidden_content'));
  });

  it('[G17] concurrent conversations cannot contaminate each other answers', async () => {
    const env = createSyntheticEnv();
    const vendorA = nextSender('g17a');
    const vendorB = nextSender('g17b');
    await seedVendor(env, vendorA, { business_name: 'Shop A' });
    await seedVendor(env, vendorB, { business_name: 'Shop B' });
    await seedCampaign(env, `g17a_${Date.now()}`, {
      vendor_instagram_user_id: vendorA,
      campaign_title: 'Alpha Launch',
      payment_status: 'PENDING',
      status: 'AWAITING_PAYMENT',
    });
    await seedCampaign(env, `g17b_${Date.now()}`, {
      vendor_instagram_user_id: vendorB,
      campaign_title: 'Beta Launch',
      payment_status: 'CAPTURED',
      status: 'MATCHING',
    });
    // Interleaved: A, B, A again. Each answer carries only its own data.
    const a1 = await postTextAndDrain({
      text: 'Where is my campaign?', env, tctx: createTestContext(), senderId: vendorA,
    });
    const b1 = await postTextAndDrain({
      text: 'Where is my campaign?', env, tctx: createTestContext(), senderId: vendorB,
    });
    const a2 = await postTextAndDrain({
      text: 'What is the status of my campaign?', env, tctx: createTestContext(), senderId: vendorA,
    });
    assert.ok(a1.dms[0].message.text.includes('Alpha Launch'));
    assert.ok(!a1.dms[0].message.text.includes('Beta Launch'));
    assert.ok(b1.dms[0].message.text.includes('Beta Launch'));
    assert.ok(!b1.dms[0].message.text.includes('Alpha Launch'));
    assert.ok(a2.dms[0].message.text.includes('Alpha Launch'));
    assert.ok(!a2.dms[0].message.text.includes('Beta Launch'));

    // Per-conversation language state stays separate too.
    const teSender = nextSender('g17te');
    const esSender = nextSender('g17es');
    const te = await postTextAndDrain({
      text: 'నమస్తే', env, tctx: createTestContext(), senderId: teSender,
    });
    const es = await postTextAndDrain({
      text: 'hola', env, tctx: createTestContext(), senderId: esSender,
    });
    assert.equal(te.dms[0].message.text, chatReply('greeting', 'te', 0));
    assert.equal(es.dms[0].message.text, chatReply('greeting', 'es', 0));
  });
});

describe('Verification — cost, bypass-resistance, language (G19..G20, G22)', () => {
  it('[G19] deterministic FAQ responses do not incur unnecessary AI calls', async () => {
    let evaluatorCalls = 0;
    const counting = async (payload) => {
      evaluatorCalls += 1;
      return defaultSemanticEvaluator(payload);
    };
    // Every deterministic branch input verifies with zero evaluator runs,
    // both in production mode (off) and in auto mode (evidence present).
    const deterministicInputs = [
      {
        userText: 'hello', intent: 'greeting', lang: 'en',
        responseText: chatReply('greeting', 'en', 0), replyIntent: 'greeting',
      },
      {
        userText: 'Where is my campaign?', intent: 'status', lang: 'en',
        responseText: 'Your campaigns as a vendor:\n• X — finding creators.',
        required: STATUS_REQUIRED,
      },
      {
        userText: 'where is my payout', intent: 'payout_info', lang: 'en',
        responseText: "Here's how B8i payouts work. Are you asking as the vendor? reply \"support\".",
        required: [
          { id: 'payout_explainer', anyOf: ["Here's how B8i payouts work"] },
          { id: 'role_question', anyOf: ['Are you asking as the vendor'] },
        ],
      },
      {
        userText: 'membership plans', intent: 'membership_branch', lang: 'en',
        responseText: buildMembershipText(),
        required: [{ id: 'membership_header', anyOf: ['B8i creator membership plans'] }],
      },
      {
        userText: 'Suggest an influencer.', intent: 'recommend', lang: 'en',
        responseText: 'I found 2 eligible creators. Profiles stay private. Suggestions only.',
        required: b8iRecommendRequired({ niche: null, shownCount: 0, preAuth: true }),
        facts: { expectedCount: 2 },
      },
    ];
    for (const mode of ['off', 'auto']) {
      for (const input of deterministicInputs) {
        const r = await verifyAssistantResponse(input, { evaluator: counting, semanticMode: mode });
        assert.equal(r.verdict, 'pass', JSON.stringify(input.intent));
        assert.equal(r.semanticRuns, 0, `${mode}/${input.intent}`);
      }
    }
    assert.equal(evaluatorCalls, 0);

    // End to end: deterministic DMs attempt zero blocked (paid/model) calls.
    const env = createSyntheticEnv();
    const before = isolation.snapshot();
    for (const text of ['hello', 'what is b8i', 'membership plans', 'where is my payout']) {
      await postTextAndDrain({ text, env, tctx: createTestContext(), senderId: nextSender('g19') });
    }
    const after = isolation.snapshot();
    assert.equal(after.blockedFailClosed - before.blockedFailClosed, 0);
  });

  it('[G20] no rejected response can bypass the final delivery gate', async () => {
    // Loop level: a watermarked bad reply is never delivered, 3 attempts.
    const env = createSyntheticEnv();
    const sender = nextSender('g20');
    const WATERMARK = 'REJECTED_WATERMARK_9f2c7a41';
    let builds = 0;
    const out = await deliverVerifiedAssistantResponse({
      senderId: sender,
      userText: 'Where is my campaign?',
      intent: 'status',
      lang: 'en',
      facts: {},
      required: STATUS_REQUIRED,
      sensitive: true,
      semanticMode: 'off',
      buildResponse: async () => {
        builds += 1;
        return `${WATERMARK} buy followers cheap, guaranteed viral.`;
      },
      env,
    });
    assert.equal(builds, 3);
    assert.equal(out.delivered, 'fallback');
    for (const dm of messagesFor(isolation.sentMessages, sender)) {
      assert.ok(!dm.message.text.includes(WATERMARK));
    }

    // Model-path end to end: a reply that passes the existing sanitizer but
    // fails grounding is rejected exactly once — no delivery, no paid retry.
    const baseFetch = globalThis.fetch;
    let metaAttempts = 0;
    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? '');
      let host = '';
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        host = '';
      }
      if (host === 'api.meta.ai') {
        metaAttempts += 1;
        return new Response(
          JSON.stringify({
            id: 'chatcmpl_verify_g20',
            object: 'chat.completion',
            model: 'muse-spark-1.3',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'Your campaign CAMPAIGN:evil_1 is CONFIRMED and ready.' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return baseFetch(input, init);
    };
    try {
      // The reply passes the pre-existing sanitizer (no action-claim shape,
      // no links, no solicitation) so the NEW gate is what rejects it.
      assert.equal(
        validateModelReply('Your campaign CAMPAIGN:evil_1 is CONFIRMED and ready.'),
        'Your campaign CAMPAIGN:evil_1 is CONFIRMED and ready.',
      );
      const store = new Map();
      let mutex = Promise.resolve();
      const state = {
        storage: {
          async get(k) { return store.has(k) ? store.get(k) : undefined; },
          async put(k, v) { store.set(k, v); },
          async delete(k) { store.delete(k); },
        },
        async blockConcurrencyWhile(fn) {
          const prev = mutex;
          let release;
          mutex = new Promise((resolve) => { release = resolve; });
          await prev;
          try {
            return await fn();
          } finally {
            release();
          }
        },
      };
      const budget = new B8iModelBudget(state, {});
      const modelEnv = createSyntheticEnv({
        META_MODEL_API_ENABLED: '1',
        META_MODEL_API_KEY: 'TEST_ONLY_meta_model_key',
        META_MODEL_SPEND_CAP_ND: String(145_000_000_000),
        MODEL_BUDGET: {
          idFromName() { return 'test-budget-id'; },
          get() {
            return {
              fetch: (input, init) => budget.fetch(
                new Request(typeof input === 'string' ? input : input.url, init),
              ),
            };
          },
        },
      });
      const modelSender = nextSender('g20model');
      const { dms } = await postTextAndDrain({
        text: 'zxqv blorp snork',
        env: modelEnv,
        tctx: createTestContext(),
        senderId: modelSender,
      });
      assert.equal(metaAttempts, 1, 'exactly one model call; verification never retries paid calls');
      assert.equal(dms.length, 1);
      assert.match(dms[0].message.text, /Welcome to B8i/);
      assert.ok(!dms[0].message.text.includes('CAMPAIGN:evil_1'));
    } finally {
      globalThis.fetch = baseFetch;
    }
  });

  it('[G22] the fallback respects supported language behavior', () => {
    const seen = new Set();
    for (const lang of ['en', 'te', 'tenglish', 'hi', 'es', 'pt']) {
      for (const kind of ['default', 'clarify']) {
        const fb = verificationFallbackText(lang, kind);
        assert.ok(fb.length > 20, `${lang}/${kind}`);
        assert.equal(verifyFallbackSafe(fb).verdict, 'pass', `${lang}/${kind}`);
        assert.deepEqual(extractVerifyEntities(fb), [], `${lang}/${kind} carries no factual claims`);
        assert.ok(fb.toLowerCase().includes('support'), `${lang}/${kind} keeps the support route`);
        seen.add(fb);
      }
    }
    // Six languages × two kinds are all distinct localized strings.
    assert.equal(seen.size, 12);
    // Script check: Telugu and Hindi fallbacks carry their own scripts.
    assert.ok(/[\u0C00-\u0C7F]/.test(verificationFallbackText('te', 'default')));
    assert.ok(/[\u0900-\u097F]/.test(verificationFallbackText('hi', 'default')));
    // Unknown languages fall back to English (documented behavior).
    assert.equal(verificationFallbackText('xx', 'default'), verificationFallbackText('en', 'default'));
    assert.equal(verificationFallbackText('xx'), verificationFallbackText('en', 'default'));
    assert.equal(verificationFallbackText(undefined, 'clarify'), verificationFallbackText('en', 'clarify'));
    assert.ok(verifyFallbackSafe(B8I_VERIFY_MINIMAL_FALLBACK_EN).verdict === 'pass');
    assert.equal(verifyFallbackSafe('').verdict, 'fail');
    assert.equal(verifyFallbackSafe('has {{marker}}').verdict, 'fail');
    // [N3] Same corruption spellings rejected as Layer 1 (any case).
    for (const bad of ['has UNDEFINED', 'is NAN', 'says NULL', 'got [object OBJECT]']) {
      assert.equal(verifyFallbackSafe(bad).verdict, 'fail', bad);
    }
  });
});

describe('Verification — preserved boundaries (G21, G25) and root causes (R1..R2)', () => {
  it('[G21] payment, webhook, campaign state, and payout regression paths still hold', async () => {
    // Webhook signature enforcement is untouched by the gate wiring.
    const env = createSyntheticEnv();
    const badReq = buildInstagramWebhookRequest({
      payload: buildTextMessagePayload(nextSender('g21'), 'hello'),
      secret: 'TEST_ONLY_wrong_secret_for_negative_case',
    });
    const badRes = await worker.fetch(badReq, env, createTestContext().ctx);
    assert.equal(badRes.status, 403);

    // Single payout stays inert without the route flag (no transfers).
    const campaign = {
      campaign_id: 'v_pay1',
      campaign_title: 'V Pay',
      compensation_type: 'money',
      influencer_id: 'v_pay_1',
      budget: 10000,
      required_influencers: 1,
    };
    const mark = isolation.attempts.length;
    await initiateInfluencerPayout(campaign, env);
    assert.deepEqual(
      isolation.attempts.slice(mark).filter((a) => a.url.includes('api.razorpay.com')),
      [],
    );
    assert.equal(campaign.payout_status, undefined);

    // Manual payout records are still created by the manual path only.
    await seedJson(env, 'INFLUENCER:v_c1', {
      instagram_user_id: 'v_c1',
      upi_id: 'vc1@upi',
    });
    const records = await createManualPayoutRecords(
      {
        campaign_id: 'v_pay2',
        campaign_title: 'V Pay 2',
        accepted_influencer_ids: ['v_c1'],
        budget: 1500,
        required_influencers: 1,
      },
      env,
    );
    assert.ok(Array.isArray(records) && records.length > 0);
    assert.deepEqual(records, ['MPAY:v_pay2:v_c1']);
    const stored = JSON.parse(await env.INSTAGRAM_CONVERSATIONS.get('MPAY:v_pay2:v_c1'));
    assert.equal(stored.status, 'READY_FOR_MANUAL_PAYMENT');
    assert.equal(stored.campaign_id, 'v_pay2');
    assert.equal(stored.influencer_instagram_user_id, 'v_c1');

    // Admin mark-paid still requires the admin key (human approval path).
    const adminEnv = createSyntheticEnv({ ADMIN_API_KEY: 'TEST_ONLY_admin_key' });
    await seedJson(adminEnv, 'MPAY:v_pay2:v_c1', {
      status: 'READY_FOR_MANUAL_PAYMENT',
      campaign_id: 'v_pay2',
      campaign_title: 'V Pay 2',
      influencer_instagram_user_id: 'v_c1',
      amount: 1500,
    });
    const noKey = await worker.fetch(
      new Request(`${TEST_ORIGIN}/admin/payouts/mark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record_id: 'MPAY:v_pay2:v_c1', payment_reference: 'ref-1' }),
      }),
      adminEnv,
      createTestContext().ctx,
    );
    assert.equal(noKey.status, 401);
  });

  it('[G25] verification cannot approve payments and creates no state', async () => {
    // Pure verification calls perform zero fetches and zero KV writes.
    const env = createSyntheticEnv();
    const before = isolation.snapshot();
    verifyResponseBeforeSend({
      userText: 'hello', intent: 'greeting', lang: 'en',
      responseText: chatReply('greeting', 'en', 0), replyIntent: 'greeting',
    });
    await semanticEvaluateResponse(
      { userText: 'hello', intent: 'greeting', lang: 'en', responseText: 'hi', facts: {} },
      {},
    );
    await verifyAssistantResponse(
      {
        userText: 'hello', intent: 'greeting', lang: 'en',
        responseText: chatReply('greeting', 'en', 0), replyIntent: 'greeting',
      },
      {},
    );
    const after = isolation.snapshot();
    assert.equal(after.totalIntercepted - before.totalIntercepted, 0);
    assert.equal(env.INSTAGRAM_CONVERSATIONS.keysWithPrefix('').length, 0);

    // Even a full delivery loop to fallback creates no campaign/payment keys.
    const env2 = createSyntheticEnv();
    const out = await deliverVerifiedAssistantResponse({
      senderId: nextSender('g25'),
      userText: 'Where is my campaign?',
      intent: 'status',
      lang: 'en',
      facts: {},
      required: STATUS_REQUIRED,
      sensitive: true,
      semanticMode: 'off',
      buildResponse: async () => 'wrong',
      env: env2,
    });
    assert.equal(out.delivered, 'fallback');
    for (const prefix of ['CAMPAIGN:', 'MPAY:', 'PAYOUT:', 'TRANSFER:', 'INVITE:', 'REGISTRATION:']) {
      assert.equal(env2.INSTAGRAM_CONVERSATIONS.keysWithPrefix(prefix).length, 0, prefix);
    }
  });

  it('[R1] canonical-text payout delegation passes the gate', async () => {
    // handleB8iConversation re-asks phase 1 with canonical English text;
    // the gate verifies that delegated text (not the original Tenglish).
    const env = createSyntheticEnv();
    const { dms } = await postTextAndDrain({
      text: 'naa paise ekkada',
      env,
      tctx: createTestContext(),
      senderId: nextSender('r1'),
    });
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /Here's how B8i payouts work/);
  });

  it('[R2] post-gate pending-action augmentation preserves the verified reply prefix', async () => {
    // attachPendingWorkflowActions runs inside sendInstagramMessage AFTER
    // verification; it may append deterministic authorized lines but must
    // never rewrite the verified text.
    const env = createSyntheticEnv();
    const vendor = nextSender('r2');
    await seedVendor(env, vendor, { b8i_pending_review_campaign_ids: ['r2camp'] });
    await seedCampaign(env, 'r2camp', {
      vendor_instagram_user_id: vendor,
      campaign_title: 'R2 Campaign',
      accepted_influencer_ids: ['r2inf'],
      influencer_work_statuses: { r2inf: { status: 'SUBMITTED' } },
    });
    const { dms } = await postTextAndDrain({
      text: 'thanks',
      env,
      tctx: createTestContext(),
      senderId: vendor,
    });
    assert.equal(dms.length, 1);
    const text = dms[0].message.text;
    assert.ok(text.startsWith(chatReply('thanks', 'en', 0)), 'verified prefix intact');
    assert.ok(text.includes('📌 Pending creator reviews'));
    const payloads = (dms[0].message.quick_replies || []).map((q) => q.payload);
    assert.ok(payloads.includes('CONFIRM:r2camp:r2inf'));
    assert.ok(payloads.includes('DISPUTE:r2camp:r2inf'));
  });

  it('[G0] recommend evidence helpers stay consistent', () => {
    const filtered = [
      { instagram_user_id: 'a', full_name: 'Ann', instagram_username: 'ann_u', phone: '+91-1', followers: 5000, niche: 'fashion', instagram_url: 'https://www.instagram.com/ann_u/' },
      { instagram_user_id: 'b', full_name: 'Bea', instagram_username: 'bea_u', followers: 9000, niche: 'food' },
    ];
    const forbidden = b8iRecommendForbiddenPii(filtered, ['a']);
    assert.ok(!forbidden.includes('Ann'));
    assert.ok(forbidden.includes('Bea'));
    assert.ok(forbidden.includes('bea_u'));
    assert.ok(forbidden.includes('b'));
    const trusted = b8iRecommendTrustedEntities({
      expectedCount: 2, expectedShown: 1, expectedMore: 1, shown: [filtered[0]],
    });
    const has = (kind, value) => trusted.some((t) => t.kind === kind && t.value === value);
    assert.ok(has('bignum', '2'));
    assert.ok(has('bignum', '5000'));
    assert.ok(has('handle', '@ann_u'));
    assert.ok(has('url', 'https://www.instagram.com/ann_u/'));
    assert.deepEqual(b8iRecommendCardNames([filtered[0], filtered[1]]), ['Ann', 'Bea']);
    assert.deepEqual(b8iRecommendCardNames([{ instagram_user_id: 'x' }]), ['Creator']);
    assert.deepEqual(b8iRecommendCardNames([{ instagram_username: 'solo' }]), ['@solo']);
    assert.deepEqual(b8iRecommendCardUrls([filtered[0]]), ['https://www.instagram.com/ann_u/']);
    const groups = b8iRecommendRequired({ niche: 'fashion', shownCount: 1, preAuth: false });
    assert.ok(groups.some((g) => g.id === 'creator_cards'));
    assert.ok(groups.some((g) => g.id === 'niche_filter'));
    const preGroups = b8iRecommendRequired({ niche: null, shownCount: 0, preAuth: true });
    assert.ok(preGroups.some((g) => g.id === 'privacy_notice'));
  });
});

describe('Verification — reviewer finding F2 (quick actions gated)', () => {
  it('[F2] quick-tap assistant replies pass the same gate as typed text', async () => {
    // Tap evidence needs no user text.
    for (const label of ['action_find', 'action_plan', 'action_plans', 'action_payments']) {
      const routed = verifyIntentForText('', label);
      assert.equal(routed.ok, true, label);
      assert.equal(routed.evidence, 'routed', label);
    }

    const env = createSyntheticEnv();
    const find = await postQuickReplyAndDrain({
      payload: 'FIND_INFLUENCERS', text: 'Find Influencers', env, senderId: nextSender('f2find'),
    });
    assert.equal(find.dms.length, 1);
    assert.equal(find.dms[0].message.text, chatFlow('reco_ask_niche', 'en'));

    const plan = await postQuickReplyAndDrain({
      payload: 'PLAN_CAMPAIGN', text: 'Plan a Campaign', env, senderId: nextSender('f2plan'),
    });
    assert.equal(plan.dms.length, 1);
    assert.equal(
      plan.dms[0].message.text,
      chatFlow('brief_advice', 'en') + chatFlow('brief_q_product', 'en'),
    );

    const plans = await postQuickReplyAndDrain({
      payload: 'VIEW_PLANS', text: 'Membership Plans', env, senderId: nextSender('f2plans'),
    });
    assert.equal(plans.dms.length, 1);
    assert.equal(plans.dms[0].message.text, buildMembershipText());
    assert.ok((plans.dms[0].message.quick_replies || []).some((q) => q.payload === 'INFLUENCER'));

    const help = await postQuickReplyAndDrain({
      payload: 'PAYMENT_HELP', text: 'Help with Payments', env, senderId: nextSender('f2help'),
    });
    assert.equal(help.dms.length, 1);
    assert.match(help.dms[0].message.text, /I don't want to guess about payments/);
    assert.match(help.dms[0].message.text, /Reply here, or reply "support"/);
  });
});

describe('Verification — reviewer findings F1..F9', () => {
  it('[F1] smuggled non-owned campaign title fails the status gate', () => {
    const bad = verifyResponseBeforeSend({
      userText: 'What is the status of my campaign?',
      intent: 'status',
      lang: 'en',
      responseText:
        'Your campaigns as a vendor:\n• Soap Launch — finding creators.\n• Secret Launch — finding creators.',
      required: STATUS_REQUIRED,
      mustContain: ['Soap Launch'],
      facts: { bulletAllowlist: ['Soap Launch'] },
      sensitive: true,
    });
    assert.equal(bad.verdict, 'fail');
    assert.ok(bad.reasonCodes.includes('unauthorized_disclosure'));
    assert.ok(bad.unsupportedClaims.some((c) => c.includes('Secret Launch')));

    const ok = verifyResponseBeforeSend({
      userText: 'What is the status of my campaign?',
      intent: 'status',
      lang: 'en',
      responseText: 'Your campaigns as a vendor:\n• Soap Launch — finding creators.',
      required: STATUS_REQUIRED,
      mustContain: ['Soap Launch'],
      facts: { bulletAllowlist: ['Soap Launch'] },
      sensitive: true,
    });
    assert.equal(ok.verdict, 'pass');

    // Empty sections allow no bullets at all.
    const sneaky = verifyResponseBeforeSend({
      userText: 'What is the status of my campaign?',
      intent: 'status',
      lang: 'en',
      responseText: 'No campaigns found on your vendor account yet.\n• Ghost — finding creators.',
      required: [{ id: 'vendor_empty', anyOf: ['No campaigns found on your vendor account yet'] }],
      facts: { bulletAllowlist: [] },
      sensitive: true,
    });
    assert.equal(sneaky.verdict, 'fail');
    assert.ok(sneaky.reasonCodes.includes('unauthorized_disclosure'));

    // [N1] Status replies carry no URLs: a smuggled URL fails the gate.
    const smuggledUrl = verifyResponseBeforeSend({
      userText: 'What is the status of my campaign?',
      intent: 'status',
      lang: 'en',
      responseText: 'Your campaigns as a vendor:\n• Soap Launch — finding creators.\nSee https://evil.example.com/x',
      required: STATUS_REQUIRED,
      mustContain: ['Soap Launch'],
      facts: { bulletAllowlist: ['Soap Launch'], urlAllowlist: [] },
      sensitive: true,
    });
    assert.equal(smuggledUrl.verdict, 'fail');
    assert.ok(smuggledUrl.reasonCodes.includes('unauthorized_disclosure'));
  });

  it('[F3] hallucinated extra creator card fails the recommend gate', () => {
    const bad = verifyResponseBeforeSend({
      userText: 'Suggest a fashion influencer.',
      intent: 'recommend',
      lang: 'en',
      responseText:
        'Here is 1 eligible creator in fashion from your active campaigns:\n\n' +
        '• Bigya — fashion\n  200,000 followers\n  https://www.instagram.com/bigya_style/\n\n' +
        '• Zara — fashion\n\nSuggestions only.',
      required: b8iRecommendRequired({ niche: 'fashion', shownCount: 1, preAuth: false }),
      facts: {
        trusted: [
          { kind: 'bignum', value: '1' }, { kind: 'bignum', value: '1' }, { kind: 'bignum', value: '0' },
          { kind: 'bignum', value: '200000' }, { kind: 'bignum', value: '0' },
          { kind: 'handle', value: '@bigya_style' },
          { kind: 'url', value: 'https://www.instagram.com/bigya_style/' },
        ],
        expectedShown: 1,
        niche: 'fashion',
        bulletAllowlist: ['Bigya'],
        urlAllowlist: ['https://www.instagram.com/bigya_style/'],
      },
      strictEntities: true,
      sensitive: true,
    });
    assert.equal(bad.verdict, 'fail');
    assert.ok(bad.reasonCodes.includes('unauthorized_disclosure'));
    assert.ok(bad.unsupportedClaims.some((c) => c.includes('Zara')));

    // An unauthorized URL fails even when every bullet is allowed.
    const badUrl = verifyResponseBeforeSend({
      userText: 'Suggest a fashion influencer.',
      intent: 'recommend',
      lang: 'en',
      responseText:
        'Here is 1 eligible creator in fashion from your active campaigns:\n\n' +
        '• Bigya — fashion\n  https://evil.example.com/x\n\nSuggestions only.',
      required: b8iRecommendRequired({ niche: 'fashion', shownCount: 1, preAuth: false }),
      facts: {
        trusted: [{ kind: 'bignum', value: '1' }],
        expectedShown: 1,
        niche: 'fashion',
        bulletAllowlist: ['Bigya'],
        urlAllowlist: ['https://www.instagram.com/bigya_style/'],
      },
      strictEntities: true,
      sensitive: true,
    });
    assert.equal(badUrl.verdict, 'fail');
    assert.ok(badUrl.reasonCodes.includes('unauthorized_disclosure'));
  });

  it('[F4] word-form money, month dates, lowercase IDs, and handles are grounded', () => {
    const cases = [
      ['Starter is 999 rupees a month.', '999 rupees'],
      ['Due 15th Feb, pay soon.', '15th Feb'],
      ['See campaign:evil_1 for details.', 'campaign:evil_1'],
      ['Contact @fake_vendor today.', '@fake_vendor'],
    ];
    for (const [responseText, claim] of cases) {
      const r = verifyResponseBeforeSend({
        userText: 'zxqv',
        intent: 'model',
        lang: 'en',
        responseText,
        facts: { kbTrusted: true },
        strictEntities: true,
        sensitive: true,
      });
      assert.equal(r.verdict, 'fail', responseText);
      assert.ok(r.reasonCodes.includes('unsupported_fact'), responseText);
      assert.ok(r.unsupportedClaims.includes(claim), responseText);
    }
    // KB-grounded equivalents still pass.
    for (const responseText of ['Starter is ₹199 per month.', 'The platform fee is 8%.']) {
      const r = verifyResponseBeforeSend({
        userText: 'zxqv',
        intent: 'model',
        lang: 'en',
        responseText,
        facts: { kbTrusted: true },
        strictEntities: true,
        sensitive: true,
      });
      assert.equal(r.verdict, 'pass', responseText);
    }
  });

  it('[F5] lowercase count evasion and corruption variants are caught', () => {
    const evasion = verifyResponseBeforeSend({
      userText: 'Suggest an influencer.',
      intent: 'recommend',
      lang: 'en',
      responseText: 'i found 5 eligible creators. Profiles stay private. Suggestions only.',
      required: b8iRecommendRequired({ niche: null, shownCount: 0, preAuth: true }),
      facts: { expectedCount: 3 },
      sensitive: true,
    });
    assert.equal(evasion.verdict, 'fail');
    assert.ok(evasion.reasonCodes.includes('count_mismatch'));

    for (const bad of [
      'Reply has UNDEFINED value.',
      'Amount is NAN.',
      'Value NULL here.',
      'Got [object object] back.',
    ]) {
      const r = verifyResponseBeforeSend({
        userText: 'hello',
        intent: 'greeting',
        lang: 'en',
        responseText: bad,
        replyIntent: 'greeting',
      });
      assert.equal(r.verdict, 'fail', bad);
      assert.ok(r.reasonCodes.includes('malformed_response'), bad);
    }
  });

  it('[F6] uncertain semantic verdict fails closed on factual branches', async () => {
    const r = await verifyAssistantResponse(
      {
        userText: 'membership plans',
        intent: 'membership_branch',
        lang: 'en',
        responseText: buildMembershipText(),
        required: [{ id: 'membership_header', anyOf: ['B8i creator membership plans'] }],
        semanticMode: 'required',
        sensitive: false,
      },
      { evaluator: async () => ({ garbage: true }) },
    );
    assert.equal(r.verdict, 'fail');
    assert.ok(r.reasonCodes.includes('evaluator_invalid'));
    assert.ok(r.reasonCodes.includes('uncertain_fails_sensitive'));
  });

  it('[F8] hanging builder is timeout-controlled and bounded', async () => {
    assert.ok(B8I_VERIFY_BUILD_TIMEOUT_MS > 0);
    const env = createSyntheticEnv();
    const sender = nextSender('f8');
    const started = Date.now();
    const out = await deliverVerifiedAssistantResponse({
      senderId: sender,
      userText: 'hello',
      intent: 'greeting',
      lang: 'en',
      facts: {},
      replyIntent: 'greeting',
      semanticMode: 'off',
      maxAttempts: 2,
      buildTimeoutMs: 30,
      buildResponse: () => new Promise(() => {}),
      env,
    });
    assert.ok(Date.now() - started < 5000, 'hanging builder must not stall delivery');
    assert.equal(out.delivered, 'fallback');
    assert.equal(out.attempts, 2);
    assert.ok(out.log.every((e) => e.reasonCodes.includes('build_timeout')));
    const dms = messagesFor(isolation.sentMessages, sender);
    assert.equal(dms.length, 1);
  });

  it('[F9a] recommend-path rejection never delivers (final path)', async () => {
    const env = createSyntheticEnv();
    const sender = nextSender('f9a');
    const out = await deliverVerifiedAssistantResponse({
      senderId: sender,
      userText: 'Suggest a fashion influencer.',
      intent: 'recommend',
      lang: 'en',
      facts: {
        trusted: [],
        expectedCount: 2,
        bulletAllowlist: [],
        urlAllowlist: [],
      },
      required: b8iRecommendRequired({ niche: 'fashion', shownCount: 0, preAuth: true }),
      strictEntities: true,
      sensitive: true,
      semanticMode: 'off',
      buildResponse: async () => 'F9A_WATERMARK here is a great marketing idea: post daily.',
      env,
    });
    assert.equal(out.delivered, 'fallback');
    const dms = messagesFor(isolation.sentMessages, sender);
    assert.equal(dms.length, 1);
    assert.ok(!dms[0].message.text.includes('F9A_WATERMARK'));
  });

  it('[F9b] payout-path rejection never delivers (final path)', async () => {
    const env = createSyntheticEnv();
    const sender = nextSender('f9b');
    const out = await deliverVerifiedAssistantResponse({
      senderId: sender,
      userText: 'Where is my payout?',
      intent: 'payout_info',
      lang: 'en',
      facts: {},
      required: [
        { id: 'payout_explainer', anyOf: ["Here's how B8i payouts work"] },
        { id: 'role_question', anyOf: ['Are you asking as the vendor'] },
      ],
      sensitive: true,
      semanticMode: 'off',
      buildResponse: async () => 'F9B_WATERMARK I found 3 eligible creators for you.',
      env,
    });
    assert.equal(out.delivered, 'fallback');
    const dms = messagesFor(isolation.sentMessages, sender);
    assert.equal(dms.length, 1);
    assert.ok(!dms[0].message.text.includes('F9B_WATERMARK'));
  });

  it('[F9c] membership-path rejection never delivers (final path)', async () => {
    const env = createSyntheticEnv();
    const sender = nextSender('f9c');
    const out = await deliverVerifiedAssistantResponse({
      senderId: sender,
      userText: 'membership plans',
      intent: 'membership_branch',
      lang: 'en',
      facts: {},
      required: [{ id: 'membership_header', anyOf: ['B8i creator membership plans'] }],
      sensitive: false,
      semanticMode: 'off',
      buildResponse: async () => 'F9C_WATERMARK earn big money fast with no plan.',
      env,
    });
    assert.equal(out.delivered, 'fallback');
    const dms = messagesFor(isolation.sentMessages, sender);
    assert.equal(dms.length, 1);
    assert.ok(!dms[0].message.text.includes('F9C_WATERMARK'));
  });

  it('[F9d] conversation-template rejection never delivers (final path)', async () => {
    const env = createSyntheticEnv();
    const sender = nextSender('f9d');
    const out = await deliverVerifiedAssistantResponse({
      senderId: sender,
      userText: 'hello',
      intent: 'greeting',
      lang: 'en',
      facts: {},
      replyIntent: 'greeting',
      sensitive: false,
      semanticMode: 'off',
      buildResponse: async () => 'F9D_WATERMARK this is not a greeting-template reply.',
      env,
    });
    assert.equal(out.delivered, 'fallback');
    const dms = messagesFor(isolation.sentMessages, sender);
    assert.equal(dms.length, 1);
    assert.ok(!dms[0].message.text.includes('F9D_WATERMARK'));
  });
});

describe('Verification — F7 final-payload validation', () => {
  it('[F7a] final payload matrix: valid augmentation passes, mutations fail', () => {
    const V = 'Verified greeting text.';
    const goodVendor = {
      text: `${V}\n\n📌 Pending creator reviews — use the buttons below.\n1. Soap Launch — creator abc123`,
      quick_replies: [{ content_type: 'text', title: 'Confirm 1', payload: 'CONFIRM:c:i' }],
    };
    assert.equal(verifyFinalOutboundPayload(goodVendor, { verifiedText: V }).verdict, 'pass');
    const goodInfluencer = {
      text: `${V}\n\n📌 Your pending B8i actions are available below.\n• Soap Launch: submit completed work`,
    };
    assert.equal(verifyFinalOutboundPayload(goodInfluencer, { verifiedText: V }).verdict, 'pass');
    assert.equal(verifyFinalOutboundPayload({ text: V }, { verifiedText: V }).verdict, 'pass');

    const bad = [
      [{ text: `X${V}` }, 'final_prefix_changed'],
      [{ text: V.slice(1) }, 'final_prefix_changed'],
      [{ text: `${V}\n\nSomething else` }, 'final_unknown_augmentation'],
      [{ text: `${V} tail` }, 'final_unknown_augmentation'],
      [{ text: `${V}\n\n📌 Pending creator reviews — use the buttons below.\n${Array(7).fill('1. X').join('\n')}` }, 'final_too_many_augment_lines'],
      [{ text: `${V}\n\n📌 Pending creator reviews — use the buttons below.\nHello world` }, 'final_bad_augment_line'],
      [{ text: `${V}\n\n📌 Pending creator reviews — use the buttons below.\n• Sale https://evil.example.com/x` }, 'final_bad_augment_line'],
      [{ text: `${V}\n\n📌 Pending creator reviews — use the buttons below.\n• Pick {{x}}` }, 'final_bad_augment_line'],
      [{ text: `${V}\n\n📌 Pending creator reviews — use the buttons below.\n• Value undefined here` }, 'final_bad_augment_line'],
      [{ text: 'A'.repeat(60) }, 'final_too_long', { verifiedText: 'A'.repeat(60), maxChars: 50 }],
      [{ text: V, quick_replies: Array(14).fill({ content_type: 'text', title: 'T', payload: 'P' }) }, 'final_bad_quick_replies'],
      [{ text: V, quick_replies: [{ content_type: 'text', title: 'T'.repeat(21), payload: 'P' }] }, 'final_bad_quick_replies'],
      [{ text: V, quick_replies: [{ content_type: 'text', title: 'T' }] }, 'final_bad_quick_replies'],
    ];
    for (const [message, code, ctx] of bad) {
      const r = verifyFinalOutboundPayload(message, ctx || { verifiedText: V });
      assert.equal(r.verdict, 'fail', code);
      assert.ok(r.reasonCodes.includes(code), code);
    }
    // Boundary: exactly 2000 passes, 2001 fails (documented outbound cap).
    assert.equal(B8I_VERIFY_MAX_OUTBOUND_CHARS, 2000);
    assert.equal(verifyFinalOutboundPayload({ text: 'B'.repeat(2000) }, { verifiedText: 'B'.repeat(2000) }).verdict, 'pass');
    assert.equal(verifyFinalOutboundPayload({ text: 'C'.repeat(2001) }, { verifiedText: 'C'.repeat(2001) }).verdict, 'fail');
    // Missing verified text fails closed.
    assert.equal(verifyFinalOutboundPayload({ text: V }, {}).verdict, 'fail');
  });

  it('[F7b] evil campaign title in augmentation is stripped, verified reply delivered', async () => {
    const env = createSyntheticEnv();
    const vendor = nextSender('f7b');
    await seedVendor(env, vendor, { b8i_pending_review_campaign_ids: ['f7evil'] });
    await seedCampaign(env, 'f7evil', {
      vendor_instagram_user_id: vendor,
      campaign_title: 'Sale https://evil.example.com/x {{pick}}',
      accepted_influencer_ids: ['f7inf'],
      influencer_work_statuses: { f7inf: { status: 'SUBMITTED' } },
    });
    const { dms } = await postTextAndDrain({
      text: 'thanks', env, tctx: createTestContext(), senderId: vendor,
    });
    assert.equal(dms.length, 1);
    assert.equal(dms[0].message.text, chatReply('thanks', 'en', 0));
    assert.ok(!dms[0].message.text.includes('📌'));
    assert.ok(!dms[0].message.text.includes('evil.example.com'));
    assert.ok(!dms[0].message.quick_replies);
  });

  it('[F7c] valid influencer augmentation passes final validation with buttons', async () => {
    const env = createSyntheticEnv();
    const creator = nextSender('f7c');
    await seedCreator(env, creator, { b8i_active_campaign_ids: ['f7act'] });
    await seedCampaign(env, 'f7act', {
      vendor_instagram_user_id: nextSender('f7cvendor'),
      campaign_title: 'F7 Active',
      accepted_influencer_ids: [creator],
    });
    const { dms } = await postTextAndDrain({
      text: 'thanks', env, tctx: createTestContext(), senderId: creator,
    });
    assert.equal(dms.length, 1);
    const text = dms[0].message.text;
    assert.ok(text.startsWith(chatReply('thanks', 'en', 0)));
    assert.ok(text.includes('📌 Your pending B8i actions are available below.'));
    assert.ok(text.includes('• F7 Active: submit completed work'));
    const payloads = (dms[0].message.quick_replies || []).map((q) => q.payload);
    assert.ok(payloads.includes('WORK_DONE:f7act'));
  });

  it('[F7d] overlong augmented payload is cut back to the verified text', async () => {
    const env = createSyntheticEnv();
    const vendor = nextSender('f7d');
    await seedVendor(env, vendor, { b8i_pending_review_campaign_ids: ['f7long'] });
    await seedCampaign(env, 'f7long', {
      vendor_instagram_user_id: vendor,
      campaign_title: 'T'.repeat(300),
      accepted_influencer_ids: ['f7linf'],
      influencer_work_statuses: { f7linf: { status: 'SUBMITTED' } },
    });
    const long = 'B'.repeat(1900);
    const out = await deliverVerifiedAssistantResponse({
      senderId: vendor,
      userText: 'hello',
      intent: 'greeting',
      lang: 'en',
      facts: {},
      required: [],
      semanticMode: 'off',
      buildResponse: async () => long,
      env,
    });
    assert.equal(out.delivered, 'verified');
    const dms = messagesFor(isolation.sentMessages, vendor);
    assert.equal(dms.length, 1);
    assert.equal(dms[0].message.text, long);
    assert.ok(!dms[0].message.text.includes('📌'));
  });
});

describe('Verification — N2 kind-scoped entity matching', () => {
  it('[N2a] cross-kind numeric collisions fail grounding', () => {
    // Follower-count evidence must not validate a money claim.
    const money = verifyResponseBeforeSend({
      userText: 'zxqv', intent: 'model', lang: 'en',
      responseText: 'Bonus of ₹200,000 approved.',
      facts: { trusted: [{ kind: 'bignum', value: '200000' }] },
      strictEntities: true, sensitive: true,
    });
    assert.equal(money.verdict, 'fail');
    assert.ok(money.reasonCodes.includes('unsupported_fact'));
    // Money evidence must not validate a bare-count claim.
    const count = verifyResponseBeforeSend({
      userText: 'zxqv', intent: 'model', lang: 'en',
      responseText: '200000 followers and counting.',
      facts: { trusted: [{ kind: 'money', value: '200000' }] },
      strictEntities: true, sensitive: true,
    });
    assert.equal(count.verdict, 'fail');
    assert.ok(count.reasonCodes.includes('unsupported_fact'));
    // Money evidence must not validate a percent claim.
    const pct = verifyResponseBeforeSend({
      userText: 'zxqv', intent: 'model', lang: 'en',
      responseText: 'The fee is 8%.',
      facts: { trusted: [{ kind: 'money', value: '8' }] },
      strictEntities: true, sensitive: true,
    });
    assert.equal(pct.verdict, 'fail');
    assert.ok(pct.reasonCodes.includes('unsupported_fact'));
  });

  it('[N2b] same-kind exact values ground correctly', () => {
    const cases = [
      ['Price is ₹199 today.', [{ kind: 'money', value: '199' }]],
      ['999 rupees total.', [{ kind: 'money', value: '999' }]],
      ['200000 followers and counting.', [{ kind: 'bignum', value: '200000' }]],
      ['The fee is 8%.', [{ kind: 'percent', value: '8%' }]],
      ['Contact @shop_now please.', [{ kind: 'handle', value: '@shop_now' }]],
      ['See https://www.instagram.com/shop_now/ for details.', [{ kind: 'url', value: 'https://www.instagram.com/shop_now/' }]],
      ['See CAMPAIGN:ord_9 please.', [{ kind: 'campaign_id', value: 'CAMPAIGN:ord_9' }]],
    ];
    for (const [responseText, trusted] of cases) {
      const r = verifyResponseBeforeSend({
        userText: 'zxqv', intent: 'model', lang: 'en', responseText,
        facts: { trusted }, strictEntities: true, sensitive: true,
      });
      assert.equal(r.verdict, 'pass', responseText);
    }
  });

  it('[N2c] malformed evidence fails loudly in both layers', async () => {
    for (const trusted of [
      ['199'], [{ kind: 'nope', value: 'x' }], [{ kind: 'money', value: 'abc' }],
      [{ kind: 'url', value: 'not a url' }], [null], [{ kind: 'handle' }],
    ]) {
      const r = verifyResponseBeforeSend({
        userText: 'zxqv', intent: 'model', lang: 'en',
        responseText: 'All good here.',
        facts: { trusted }, strictEntities: true, sensitive: true,
      });
      assert.equal(r.verdict, 'fail', JSON.stringify(trusted));
      assert.ok(r.reasonCodes.includes('invalid_evidence'), JSON.stringify(trusted));
    }
    // Layer 2 runner fails closed without invoking the evaluator.
    let calls = 0;
    const r = await semanticEvaluateResponse(
      { userText: 'q', intent: 'greeting', lang: 'en', responseText: 'hi', facts: { trusted: ['x'] } },
      { evaluator: async () => { calls += 1; return { verdict: 'pass', reasonCodes: [], unsupportedClaims: [], missingParts: [], corrections: [] }; } },
    );
    assert.equal(r.verdict, 'fail');
    assert.ok(r.reasonCodes.includes('invalid_evidence'));
    assert.equal(calls, 0);
    // Default evaluator fails closed on malformed allow entries.
    const direct = defaultSemanticEvaluator({
      userText: 'q', intent: 'greeting', lang: 'en', responseText: 'hi', allowEntities: ['x'],
    });
    assert.equal(direct.verdict, 'fail');
    assert.ok(direct.reasonCodes.includes('invalid_evidence'));
  });

  it('[N2d] shared normalization is exact per kind', () => {
    assert.equal(b8iNormalizeEntityValue('money', '₹5,000'), '5000');
    assert.equal(b8iNormalizeEntityValue('money', '999 rupees'), '999');
    assert.equal(b8iNormalizeEntityValue('money', 'abc'), null);
    assert.equal(b8iNormalizeEntityValue('percent', '8%'), '8%');
    assert.equal(b8iNormalizeEntityValue('percent', '8'), null);
    assert.equal(b8iNormalizeEntityValue('bignum', '12,000'), '12000');
    assert.equal(b8iNormalizeEntityValue('bignum', 'abc'), null);
    assert.equal(b8iNormalizeEntityValue('campaign_id', 'CAMPAIGN:X'), 'campaign:x');
    assert.equal(b8iNormalizeEntityValue('campaign_id', 'nope'), null);
    assert.equal(b8iNormalizeEntityValue('handle', '@Shop_X'), '@shop_x');
    assert.equal(b8iNormalizeEntityValue('handle', 'nope'), null);
    assert.equal(b8iNormalizeEntityValue('url', 'HTTPS://X.COM/a.'), 'https://x.com/a');
    assert.equal(b8iNormalizeEntityValue('url', 'nope'), null);
    assert.equal(b8iNormalizeEntityValue('status', 'PAID'), 'PAID');
    assert.equal(b8iNormalizeEntityValue('status', 'paid'), null);
    assert.equal(b8iNormalizeEntityValue('name', 'Starter'), 'starter');
    assert.equal(b8iNormalizeEntityValue('bogus', 'x'), null);
    assert.equal(b8iNormalizeEntityValue('money', ''), null);
  });
});

describe('Verification — N4 complete-response parsing', () => {
  it('[N4a] numbered and dash headline shapes must resolve to the allowlist', () => {
    const base = {
      userText: 'What is the status of my campaign?',
      intent: 'status', lang: 'en',
      required: STATUS_REQUIRED,
      mustContain: ['Soap Launch'],
      facts: { bulletAllowlist: ['Soap Launch'], urlAllowlist: [], trusted: [] },
      strictEntities: true, sensitive: true,
    };
    for (const smuggled of ['1. Evil Launch — finding creators.', '- Evil Launch', '* Evil Launch']) {
      const r = verifyResponseBeforeSend({
        ...base,
        responseText: `Your campaigns as a vendor:\n• Soap Launch — finding creators.\n${smuggled}`,
      });
      assert.equal(r.verdict, 'fail', smuggled);
      assert.ok(r.reasonCodes.includes('unauthorized_disclosure'), smuggled);
    }
    const ok = verifyResponseBeforeSend({
      ...base,
      responseText: 'Your campaigns as a vendor:\n• Soap Launch — finding creators.',
    });
    assert.equal(ok.verdict, 'pass');
  });

  it('[N4b] status entities ground against counts and title values end to end', async () => {
    const env = createSyntheticEnv();
    const vendor = nextSender('n4b');
    await seedVendor(env, vendor, { business_name: 'N4 Shop' });
    await seedCampaign(env, `n4num_${Date.now()}`, {
      vendor_instagram_user_id: vendor,
      campaign_title: 'Diwali 2024 Mega Sale ₹5000',
      payment_status: 'PENDING',
      status: 'AWAITING_PAYMENT',
    });
    const accepted = [];
    for (let i = 0; i < 1200; i += 1) accepted.push(`n4u${i}`);
    await seedCampaign(env, `n4big_${Date.now()}`, {
      vendor_instagram_user_id: vendor,
      campaign_title: 'N4 Big One',
      payment_status: 'CAPTURED',
      status: 'ACCEPTED',
      accepted_influencer_ids: accepted,
    });
    const { dms } = await postTextAndDrain({
      text: 'Where is my campaign?', env, tctx: createTestContext(), senderId: vendor,
    });
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /Your campaigns as a vendor:/);
    assert.match(dms[0].message.text, /Diwali 2024 Mega Sale ₹5000 — waiting for payment/);
    assert.match(dms[0].message.text, /1200 creators on board/);
  });

  it('[N4c] trailing-prose entity smuggling fails; authorized-value reuse is pinned', () => {
    const base = {
      userText: 'What is the status of my campaign?',
      intent: 'status', lang: 'en',
      required: STATUS_REQUIRED,
      mustContain: ['Soap Launch'],
      facts: { bulletAllowlist: ['Soap Launch'], urlAllowlist: [], trusted: [{ kind: 'bignum', value: '0' }] },
      strictEntities: true, sensitive: true,
    };
    const money = verifyResponseBeforeSend({
      ...base,
      responseText: 'Your campaigns as a vendor:\n• Soap Launch — finding creators.\nBonus ₹50,000 credited.',
    });
    assert.equal(money.verdict, 'fail');
    assert.ok(money.reasonCodes.includes('unsupported_fact'));
    const id = verifyResponseBeforeSend({
      ...base,
      responseText: 'Your campaigns as a vendor:\n• Soap Launch — finding creators.\nRef CAMPAIGN:evil.',
    });
    assert.equal(id.verdict, 'fail');
    assert.ok(id.reasonCodes.includes('unsupported_fact'));
    // Documented bag-of-entities limit: reusing an AUTHORIZED value from an
    // owned title in new prose still passes (positional binding is out of
    // scope; deterministic builders cannot smuggle prose).
    const reuse = verifyResponseBeforeSend({
      userText: 'What is the status of my campaign?',
      intent: 'status', lang: 'en',
      responseText: 'Your campaigns as a vendor:\n• 2024 Launch — finding creators.\nSince 2024 we grow.',
      required: STATUS_REQUIRED,
      mustContain: ['2024 Launch'],
      facts: {
        bulletAllowlist: ['2024 Launch'], urlAllowlist: [],
        trusted: b8iTrustedTitleEntities(['2024 Launch']),
      },
      strictEntities: true, sensitive: true,
    });
    assert.equal(reuse.verdict, 'pass');
  });

  it('[N4d] message shape pins: unknown fields ignored, malformed buttons fail', () => {
    assert.equal(verifyMessageShape({ text: 'hi', extra: 'junk', nested: { a: 1 } }), true);
    assert.equal(
      verifyMessageShape({ text: 'hi', quick_replies: Array(14).fill({ content_type: 'text', title: 'T', payload: 'P' }) }),
      false,
    );
    assert.equal(verifyMessageShape({ text: 'hi', quick_replies: [{ content_type: 'text', title: 'T' }] }), false);
    assert.equal(verifyMessageShape({ text: 'hi', quick_replies: 'nope' }), false);
  });
});

describe('Verification — A1 explicit forbidden cap, A2 compound coverage', () => {
  it('[A1] forbidden-PII bound is explicit and deterministic', () => {
    assert.equal(B8I_VERIFY_FORBIDDEN_MAX_ENTRIES, 2000);
    const recs = [];
    for (let i = 0; i < 500; i += 1) {
      recs.push({
        instagram_user_id: `a1_${i}`,
        full_name: `Name${i} Surname${i}`,
        instagram_username: `user_${i}`,
        phone: `+91-90000-${String(i).padStart(5, '0')}`,
        email: `u${i}@example.com`,
      });
    }
    const first = b8iRecommendForbiddenPii(recs, []);
    assert.equal(first.length, B8I_VERIFY_FORBIDDEN_MAX_ENTRIES);
    assert.deepEqual(b8iRecommendForbiddenPii(recs, []), first);
  });

  it('[A2] compound questions require every matched group', () => {
    const userText = 'suggest a fashion influencer and tell me where is my campaign';
    const statusOnly = 'Your campaigns as a vendor:\n• X — finding creators.';
    const partial = defaultSemanticEvaluator({
      userText, intent: 'model', lang: 'en', responseText: statusOnly, allowEntities: [],
    });
    assert.equal(partial.verdict, 'fail');
    assert.ok(partial.reasonCodes.includes('semantic_missing:recommend'));
    const full = defaultSemanticEvaluator({
      userText, intent: 'model', lang: 'en',
      responseText: `${statusOnly}\nI found 2 eligible creators. Profiles stay private. Suggestions only.`,
      allowEntities: [],
    });
    assert.equal(full.verdict, 'pass');
    // Semicolon splits clauses the same way.
    const semi = defaultSemanticEvaluator({
      userText: 'suggest an influencer; where is my campaign?',
      intent: 'model', lang: 'en', responseText: statusOnly, allowEntities: [],
    });
    assert.equal(semi.verdict, 'fail');
    assert.ok(semi.reasonCodes.includes('semantic_missing:recommend'));
    // Single-intent questions are unaffected.
    const single = defaultSemanticEvaluator({
      userText: 'suggest a fashion influencer', intent: 'model', lang: 'en',
      responseText: 'I found 2 eligible creators. Profiles stay private. Suggestions only.',
      allowEntities: [],
    });
    assert.equal(single.verdict, 'pass');
  });

  it('[A3a] core conversation keys are translated; fallbacks are explicit', () => {
    const coreKeys = [
      'brief_advice', 'brief_q_product', 'brief_q_niche', 'brief_q_budget',
      'reco_ask_niche', 'want_clarify', 'account_help', 'register_clarify', 'brief_cancelled',
    ];
    for (const key of coreKeys) {
      const en = chatFlow(key, 'en');
      assert.ok(en.length > 0, key);
      for (const lang of ['te', 'tenglish', 'hi', 'es', 'pt']) {
        assert.notEqual(chatFlow(key, lang), en, `${key}/${lang} must be translated, not English fallback`);
      }
    }
    // Intended English fallbacks, pinned explicitly (not gaps).
    assert.equal(chatFlow('marketing_content_tips', 'te'), chatFlow('marketing_content_tips', 'en'));
    assert.equal(chatFlow('marketing_engagement_tips', 'es'), chatFlow('marketing_engagement_tips', 'en'));
    assert.equal(chatReply('fun', 'te', 0), chatReply('fun', 'en', 0));
    assert.equal(chatReply('fun', 'pt', 1), chatReply('fun', 'en', 1));
  });
});

describe('Verification — A3 brief values verbatim in every language', () => {
  for (const [word, labels] of [
    ['telugu', ['Product:', 'Niche:', 'Budget:']],
    ['tenglish', ['Product:', 'Niche:', 'Budget:']],
    ['hindi', ['Product:', 'Niche:', 'Budget:']],
    ['spanish', ['Producto:', 'Nicho:', 'Presupuesto:']],
    ['portuguese', ['Produto:', 'Nicho:', 'Orçamento:']],
  ]) {
    it(`[A3b] brief slot values preserved verbatim in ${word}`, async () => {
      const env = createSyntheticEnv();
      const sender = nextSender(`a3${word}`);
      await postTextAndDrain({ text: word, env, tctx: createTestContext(), senderId: sender });
      await postQuickReplyAndDrain({ payload: 'PLAN_CAMPAIGN', text: 'Plan a Campaign', env, senderId: sender });
      await postTextAndDrain({ text: 'soap', env, tctx: createTestContext(), senderId: sender });
      await postTextAndDrain({ text: 'beauty', env, tctx: createTestContext(), senderId: sender });
      const { dms } = await postTextAndDrain({ text: '50000', env, tctx: createTestContext(), senderId: sender });
      assert.equal(dms.length, 5);
      const summary = dms[dms.length - 1].message.text;
      for (const label of labels) assert.ok(summary.includes(label), `${word} ${label}`);
      for (const value of ['soap', 'beauty', '50000']) assert.ok(summary.includes(value), `${word} ${value}`);
    });
  }

  it('[A4] model reply logging is accurate (sent only after verification)', async () => {
    const baseFetch = globalThis.fetch;
    const origLog = console.log;
    const origWarn = console.warn;
    const logs = [];
    console.log = (...args) => { logs.push(['log', ...args]); };
    console.warn = (...args) => { logs.push(['warn', ...args]); };
    let replyText = 'Mocked A4 reply about B8i.';
    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? '');
      let host = '';
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        host = '';
      }
      if (host === 'api.meta.ai') {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl_verify_a4',
            object: 'chat.completion',
            model: 'muse-spark-1.3',
            choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return baseFetch(input, init);
    };
    try {
      const store = new Map();
      let mutex = Promise.resolve();
      const state = {
        storage: {
          async get(k) { return store.has(k) ? store.get(k) : undefined; },
          async put(k, v) { store.set(k, v); },
          async delete(k) { store.delete(k); },
        },
        async blockConcurrencyWhile(fn) {
          const prev = mutex;
          let release;
          mutex = new Promise((resolve) => { release = resolve; });
          await prev;
          try {
            return await fn();
          } finally {
            release();
          }
        },
      };
      const budget = new B8iModelBudget(state, {});
      const modelEnv = createSyntheticEnv({
        META_MODEL_API_ENABLED: '1',
        META_MODEL_API_KEY: 'TEST_ONLY_meta_model_key',
        META_MODEL_SPEND_CAP_ND: String(145_000_000_000),
        MODEL_BUDGET: {
          idFromName() { return 'test-budget-id'; },
          get() {
            return {
              fetch: (input, init) => budget.fetch(
                new Request(typeof input === 'string' ? input : input.url, init),
              ),
            };
          },
        },
      });
      const good = await postTextAndDrain({
        text: 'zxqv a4good', env: modelEnv, tctx: createTestContext(), senderId: nextSender('a4good'),
      });
      assert.equal(good.dms[0].message.text, 'Mocked A4 reply about B8i.');
      replyText = 'Your campaign CAMPAIGN:evil_9 is CONFIRMED and ready.';
      const bad = await postTextAndDrain({
        text: 'zxqv a4bad', env: modelEnv, tctx: createTestContext(), senderId: nextSender('a4bad'),
      });
      assert.match(bad.dms[0].message.text, /Welcome to B8i/);
    } finally {
      globalThis.fetch = baseFetch;
      console.log = origLog;
      console.warn = origWarn;
    }
    const flat = logs.map(([, ...args]) => args.map((a) => {
      if (a && a.stack) return String(a.stack);
      if (typeof a === 'object' && a !== null) {
        try {
          return JSON.stringify(a);
        } catch {
          return '[unserializable]';
        }
      }
      return String(a);
    }).join(' ')).join('\n');
    assert.equal(flat.split('[B8i Model] Reply sent').length - 1, 1, 'sent logged exactly once, for the delivered reply only');
    assert.ok(flat.includes('verification_failed'));
    assert.ok(!flat.includes('CAMPAIGN:evil_9'), 'no reply content in logs');
  });
});

describe('Verification — F7e augmentation titles stay single-line', () => {
  it('[F7e] multi-line campaign titles cannot inject extra augmentation lines (vendor review)', async () => {
    const env = createSyntheticEnv();
    const vendor = nextSender('f7e');
    await seedVendor(env, vendor, { b8i_pending_review_campaign_ids: ['f7emulti'] });
    await seedCampaign(env, 'f7emulti', {
      vendor_instagram_user_id: vendor,
      campaign_title: 'Glow Launch\n• Bonus ₹50,000 approved\n9. Fake step',
      accepted_influencer_ids: ['f7einf'],
      influencer_work_statuses: { f7einf: { status: 'SUBMITTED' } },
    });
    const { dms } = await postTextAndDrain({
      text: 'thanks', env, tctx: createTestContext(), senderId: vendor,
    });
    assert.equal(dms.length, 1);
    const text = dms[0].message.text;
    assert.ok(text.startsWith(chatReply('thanks', 'en', 0)));
    assert.ok(!text.includes('\n• Bonus ₹50,000 approved'), 'injected bullet line must be absent');
    assert.ok(!text.includes('\n9. Fake step'), 'injected numbered line must be absent');
    assert.ok(text.includes('Glow Launch • Bonus ₹50,000 approved 9. Fake step'));
  });

  it('[F7e] multi-line campaign titles cannot inject extra augmentation lines (influencer offer)', async () => {
    const env = createSyntheticEnv();
    const creator = nextSender('f7ei');
    await seedCreator(env, creator, {});
    await seedCampaign(env, 'f7eoff', {
      vendor_instagram_user_id: nextSender('f7eivendor'),
      campaign_title: 'Offer Real',
      required_influencers: 2,
      accepted_influencer_ids: [],
    });
    await seedJson(env, `INFLUENCER_OPPORTUNITY:${creator}:f7eoff`, {
      campaign_id: 'f7eoff',
      campaign_title: 'Deal One\n• Bonus ₹9,000 promised',
    });
    await seedJson(env, `CAMPAIGN_RESPONSE:f7eoff:${creator}`, { status: 'notified' });
    const { dms } = await postTextAndDrain({
      text: 'thanks', env, tctx: createTestContext(), senderId: creator,
    });
    assert.equal(dms.length, 1);
    const text = dms[0].message.text;
    assert.ok(text.startsWith(chatReply('thanks', 'en', 0)));
    assert.ok(!text.includes('\n• Bonus ₹9,000 promised'), 'injected bullet line must be absent');
    assert.ok(text.includes('Deal One • Bonus ₹9,000 promised'));
  });
});

describe('Verification — F7f final-payload matrix extension', () => {
  it('[F7f] remaining post-verification mutation classes fail closed', () => {
    const V = 'Verified greeting text.';
    const H = '📌 Pending creator reviews — use the buttons below.';
    const bad = [
      [{ text: `${V}\n\n${H}\n• Pick \x01 here` }, 'final_bad_augment_line'],
      [{ text: `${V}\n\n${H}\n• Value null here` }, 'final_bad_augment_line'],
      [{ text: `${V}\n\n${H}\n• Value NaN here` }, 'final_bad_augment_line'],
      [{ text: `${V}\n\n${H}\n• Got [object Object]` }, 'final_bad_augment_line'],
      [{ text: `${V}\n\n${H}\n1. X\n` }, 'final_bad_augment_line'],
      [{ text: `${V}\n\n${H}\n1. X\n\n${H}\n1. Y` }, 'final_bad_augment_line'],
      [{ text: V, quick_replies: [{ content_type: 'text', title: 'T', payload: 'P'.repeat(1001) }] }, 'final_bad_quick_replies'],
      [{ text: V, quick_replies: [{ content_type: 'text', title: 'T', payload: 'P' }, null] }, 'final_bad_quick_replies'],
      [{ text: V, quick_replies: 'nope' }, 'final_bad_quick_replies'],
    ];
    for (const [message, code] of bad) {
      const r = verifyFinalOutboundPayload(message, { verifiedText: V });
      assert.equal(r.verdict, 'fail', code);
      assert.ok(r.reasonCodes.includes(code), code);
    }
    // Boundary values that must keep passing.
    const ok = verifyFinalOutboundPayload(
      { text: V, quick_replies: [{ content_type: 'text', title: 'T'.repeat(20), payload: 'P'.repeat(1000) }] },
      { verifiedText: V },
    );
    assert.equal(ok.verdict, 'pass');
  });
});

describe('Verification — N2e remaining entity kinds', () => {
  it('[N2e] date, campaign, handle, url, and status claims never cross-validate', () => {
    const fails = [
      ['Meeting on 2026-11-05 confirmed.', [{ kind: 'bignum', value: '2026' }]],
      ['Meeting on 2026-11-05 confirmed.', [{ kind: 'money', value: '2026' }]],
      ['Bonus of ₹200,000 approved.', [{ kind: 'date', value: '2026-11-05' }]],
      ['Ref CAMPAIGN:ord_9 ready.', [{ kind: 'bignum', value: '9' }]],
      ['Contact @shop_now please.', [{ kind: 'url', value: 'https://x.com/shop_now' }]],
      ['See https://www.instagram.com/shop_now/ for details.', [{ kind: 'handle', value: '@shop_now' }]],
      ['Status is PAID.', [{ kind: 'money', value: '1200' }]],
    ];
    for (const [responseText, trusted] of fails) {
      const r = verifyResponseBeforeSend({
        userText: 'zxqv', intent: 'model', lang: 'en', responseText,
        facts: { trusted }, strictEntities: true, sensitive: true,
      });
      assert.equal(r.verdict, 'fail', responseText);
      assert.ok(r.reasonCodes.includes('unsupported_fact'), responseText);
    }
    const passes = [
      ['Meeting on 2026-11-05 confirmed.', [{ kind: 'date', value: '2026-11-05' }]],
      ['Status is PAID.', [{ kind: 'status', value: 'PAID' }]],
    ];
    for (const [responseText, trusted] of passes) {
      const r = verifyResponseBeforeSend({
        userText: 'zxqv', intent: 'model', lang: 'en', responseText,
        facts: { trusted }, strictEntities: true, sensitive: true,
      });
      assert.equal(r.verdict, 'pass', responseText);
    }
  });
});

describe('Verification — N4e mixed bullets and links', () => {
  it('[N4e] mixed bullet shapes validate; unexpected links fail', () => {
    const mixed = verifyResponseBeforeSend({
      userText: 'What is the status of my campaign?',
      intent: 'status', lang: 'en',
      responseText: 'Your campaigns as a vendor:\n• Soap Launch — finding creators.\n2. Glow Line — waiting for payment.',
      required: STATUS_REQUIRED,
      mustContain: ['Soap Launch'],
      facts: { bulletAllowlist: ['Soap Launch', 'Glow Line'], urlAllowlist: [], trusted: [] },
      strictEntities: true, sensitive: true,
    });
    assert.equal(mixed.verdict, 'pass');
    const evilUrl = 'https://evil.example.com/x';
    const smuggled = verifyResponseBeforeSend({
      userText: 'What is the status of my campaign?',
      intent: 'status', lang: 'en',
      responseText: `Your campaigns as a vendor:\n• Soap Launch — finding creators.\nPay here: ${evilUrl}`,
      required: STATUS_REQUIRED,
      mustContain: ['Soap Launch'],
      facts: {
        bulletAllowlist: ['Soap Launch'], urlAllowlist: [],
        trusted: [{ kind: 'url', value: evilUrl }],
      },
      strictEntities: true, sensitive: true,
    });
    assert.equal(smuggled.verdict, 'fail');
    assert.ok(smuggled.reasonCodes.includes('unauthorized_disclosure'));
    const goodUrl = 'https://pay.b8i.example.com/x';
    const allowed = verifyResponseBeforeSend({
      userText: 'What is the status of my campaign?',
      intent: 'status', lang: 'en',
      responseText: `Your campaigns as a vendor:\n• Soap Launch — finding creators.\nPay here: ${goodUrl}`,
      required: STATUS_REQUIRED,
      mustContain: ['Soap Launch'],
      facts: {
        bulletAllowlist: ['Soap Launch'], urlAllowlist: [goodUrl],
        trusted: [{ kind: 'url', value: goodUrl }],
      },
      strictEntities: true, sensitive: true,
    });
    assert.equal(allowed.verdict, 'pass');
  });
});

describe('Verification — A4b reply-cap constant', () => {
  it('[A4b] message-shape reply cap tracks the documented outbound constant', () => {
    assert.equal(B8I_VERIFY_MAX_OUTBOUND_REPLIES, 13);
    const replies = (n) => Array(n).fill({ content_type: 'text', title: 'T', payload: 'P' });
    assert.equal(
      verifyMessageShape({ text: 'hi', quick_replies: replies(B8I_VERIFY_MAX_OUTBOUND_REPLIES) }),
      true,
    );
    assert.equal(
      verifyMessageShape({ text: 'hi', quick_replies: replies(B8I_VERIFY_MAX_OUTBOUND_REPLIES + 1) }),
      false,
    );
  });
});
