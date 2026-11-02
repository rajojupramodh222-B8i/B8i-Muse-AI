// test/model-api.test.mjs
//
// Meta Model API assistant path: gates (off by default), prompt assembly,
// red-list scrub, nanodollar ledger math, client behavior, and router
// fallbacks. Fully mocked: api.meta.ai is served only by an in-process
// mock for POST /v1/chat/completions; every other shape falls through to
// the base interceptor, which blocks it. No live calls are possible.

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, {
  B8iModelBudget,
  B8I_MODEL_API_BASE_URL,
  B8I_MODEL_DEFAULT_ID,
  B8I_MODEL_KB_VERSION,
  B8I_MODEL_KB_PLACEHOLDER,
  B8I_MODEL_RATE_INPUT_ND,
  B8I_MODEL_RATE_CACHED_ND,
  B8I_MODEL_RATE_OUTPUT_ND,
  B8I_MODEL_MAX_OUTPUT_TOKENS,
  B8I_MODEL_MAX_ANSWER_CHARS,
  B8I_MODEL_REASONING_EFFORT,
  B8I_MODEL_MAX_INPUT_CHARS,
  B8I_MODEL_MAX_USER_CHARS,
  B8I_MODEL_MAX_RECORDS_CHARS,
  B8I_MODEL_MAX_CALLS_PER_SENDER_PER_DAY,
  B8I_MODEL_CACHE_KEY,
  B8I_MODEL_TEMPLATE_V0_2,
  B8I_KB_V0_2,
  isModelApiEnabled,
  buildModelSystemPrompt,
  scrubModelFields,
  buildModelUserPayload,
  modelInputCharCount,
  estimateInputTokensForReservation,
  modelCostNd,
  worstCaseReservationNd,
  settleModelUsageNd,
  modelInputWithinBudget,
  validateModelReply,
  parseModelSpendCapNd,
  callModelApi,
  handleB8iModelAssistant,
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

// Base isolation first (denies everything except mocked Instagram shapes),
// then a wrapper that serves ONLY the Model API mock in-process.
const base = installNetworkIsolation();
const metaAttempts = [];
let metaMockHandler = null;
const baseFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? '');
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = '';
  }
  if (host === 'api.meta.ai') {
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    const path = new URL(url).pathname;
    metaAttempts.push({ method, path });
    if (method === 'POST' && path === '/v1/chat/completions' && metaMockHandler) {
      return metaMockHandler(url, init);
    }
    return baseFetch(input, init); // fail closed via base deny-by-default
  }
  return baseFetch(input, init);
};

// Real ledger class, in-memory Durable Object state.
function makeTestBudget() {
  const store = new Map();
  // Mutex serializes blockConcurrencyWhile like a real Durable Object, so
  // interleaved-reserve tests prove the code holds its critical section.
  let mutex = Promise.resolve();
  const state = {
    storage: {
      async get(k) {
        return store.has(k) ? store.get(k) : undefined;
      },
      async put(k, v) {
        store.set(k, v);
      },
      async delete(k) {
        store.delete(k);
      },
    },
    async blockConcurrencyWhile(fn) {
      const prev = mutex;
      let release;
      mutex = new Promise((resolve) => {
        release = resolve;
      });
      await prev;
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
  const instance = new B8iModelBudget(state, {});
  return {
    instance,
    store,
    get spent() {
      return store.get('spent_nd') ?? 0;
    },
    namespace: {
      idFromName() {
        return 'test-budget-id';
      },
      get() {
        return {
          fetch: (input, init) =>
            instance.fetch(
              new Request(typeof input === 'string' ? input : input.url, init),
            ),
        };
      },
    },
  };
}

const CAP_145_USD_ND = 145_000_000_000;

function modelEnv(overrides = {}) {
  const budget = makeTestBudget();
  const env = createSyntheticEnv({
    META_MODEL_API_ENABLED: '1',
    META_MODEL_API_KEY: 'TEST_ONLY_meta_model_key',
    META_MODEL_SPEND_CAP_ND: String(CAP_145_USD_ND),
    MODEL_BUDGET: budget.namespace,
    ...overrides,
  });
  return { env, budget };
}

const mockJson = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const successUsage = {
  prompt_tokens: 2400,
  completion_tokens: 900,
  total_tokens: 3300,
};
const successBody = {
  id: 'chatcmpl_test_1',
  object: 'chat.completion',
  model: 'muse-spark-1.3',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Mocked model reply about B8i.' },
      finish_reason: 'stop',
    },
  ],
  usage: successUsage,
};

let senderSeq = 0;
const nextSender = () => `model_sender_${Date.now()}_${(senderSeq += 1)}`;

beforeEach(() => {
  metaMockHandler = null;
  metaAttempts.length = 0;
});

describe('Model API — gates off by default', () => {
  it('is disabled without the flag, key, or binding', () => {
    const full = modelEnv().env;
    assert.equal(isModelApiEnabled(full), true);
    for (const overrides of [
      { META_MODEL_API_ENABLED: undefined },
      { META_MODEL_API_ENABLED: '' },
      { META_MODEL_API_ENABLED: '0' },
      { META_MODEL_API_ENABLED: 'false' },
      { META_MODEL_API_ENABLED: 'yes' },
      { META_MODEL_API_KEY: '' },
      { MODEL_BUDGET: undefined },
    ]) {
      const env = createSyntheticEnv({ ...overrides });
      if (overrides.MODEL_BUDGET === undefined && !('MODEL_BUDGET' in overrides)) {
        // createSyntheticEnv never sets MODEL_BUDGET; nothing to do
      } else if ('MODEL_BUDGET' in overrides) {
        delete env.MODEL_BUDGET;
      }
      assert.equal(
        isModelApiEnabled(env),
        false,
        `expected disabled for ${JSON.stringify(overrides)}`,
      );
    }
  });

  it('uses the documented endpoint, model, and request constants', () => {
    assert.equal(B8I_MODEL_API_BASE_URL, 'https://api.meta.ai/v1');
    assert.equal(B8I_MODEL_DEFAULT_ID, 'muse-spark-1.3');
    assert.equal(B8I_MODEL_KB_VERSION, 'v0.2');
    assert.equal(B8I_MODEL_KB_PLACEHOLDER, '{{B8I_KNOWLEDGE_V0_2}}');
    assert.equal(B8I_MODEL_MAX_OUTPUT_TOKENS, 1200);
    assert.equal(B8I_MODEL_REASONING_EFFORT, 'minimal');
    assert.equal(B8I_MODEL_CACHE_KEY, 'b8i-kb-v0.2');
    assert.equal(B8I_MODEL_MAX_CALLS_PER_SENDER_PER_DAY, 10);
  });
});

describe('Model API — pinned prompt fidelity', () => {
  const norm = (s) => String(s).replace(/\r\n/g, '\n');
  const docUrl = (name) => new URL(`../docs/${name}`, import.meta.url);

  it('embedded template is byte-identical to docs/assistant-system-prompt.md', () => {
    const onDisk = readFileSync(docUrl('assistant-system-prompt.md'), 'utf8');
    assert.equal(norm(B8I_MODEL_TEMPLATE_V0_2), norm(onDisk));
    assert.ok(B8I_MODEL_TEMPLATE_V0_2.includes(B8I_MODEL_KB_PLACEHOLDER));
  });

  it('embedded KB is byte-identical to docs/b8i-knowledge.md', () => {
    const onDisk = readFileSync(docUrl('b8i-knowledge.md'), 'utf8');
    assert.equal(norm(B8I_KB_V0_2), norm(onDisk));
    assert.ok(!B8I_KB_V0_2.includes(B8I_MODEL_KB_PLACEHOLDER));
  });

  it('assembles the system prompt with the KB pasted verbatim', () => {
    const system = buildModelSystemPrompt();
    assert.ok(!system.includes(B8I_MODEL_KB_PLACEHOLDER));
    assert.ok(system.includes('--- BEGIN B8i KNOWLEDGE BASE'));
    assert.ok(system.includes(B8I_KB_V0_2));
    assert.equal(
      system.length,
      B8I_MODEL_TEMPLATE_V0_2.length -
        B8I_MODEL_KB_PLACEHOLDER.length +
        B8I_KB_V0_2.length,
    );
  });
});

describe('Model API — red-list scrub and caps', () => {
  it('drops blocked keys and bare numeric identifiers', () => {
    const out = scrubModelFields({
      campaign_title: 'Diwali collab',
      niche: 'beauty',
      registration_token: 'abc123',
      phone: '+91-98765-43210',
      email: 'x@example.com',
      bank_account_number: '1234567890',
      payment_id: 'pay_123',
      influencer_instagram_user_id: '987654321098765',
      nested: { upi_id: 'x@upi', city: 'Jaipur' },
    });
    assert.equal(out.campaign_title, 'Diwali collab');
    assert.equal(out.niche, 'beauty');
    assert.equal(out.nested.city, 'Jaipur');
    for (const k of Object.keys(out)) {
      assert.ok(!/token|phone|email|bank|payment|upi|instagram_user_id/i.test(k));
    }
    assert.ok(!('upi_id' in out.nested));
    assert.ok(JSON.stringify(out).length < 500);
  });

  it('caps string lengths, array sizes, and depth', () => {
    const out = scrubModelFields({
      big: 'x'.repeat(5000),
      list: Array.from({ length: 100 }, (_, i) => `v${i}`),
      deep: { a: { b: { c: { d: 'too deep' } } } },
      n: Number.NaN,
      fn: () => 1,
    });
    assert.equal(out.big.length, 200);
    assert.equal(out.list.length, 20);
    assert.ok(!('fn' in out));
    assert.ok(!('n' in out));
  });

  it('builds a capped user payload or refuses', () => {
    assert.equal(buildModelUserPayload('   ', {}), null);
    const payload = buildModelUserPayload('hello b8i', { niche: 'tech' });
    assert.equal(payload.message, 'hello b8i');
    const long = buildModelUserPayload('y'.repeat(5000), {});
    assert.equal(long.message.length, B8I_MODEL_MAX_USER_CHARS);
    const manyKeys = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`k${i}`, 'z'.repeat(200)]),
    );
    const bigRecords = buildModelUserPayload('hi', manyKeys);
    assert.deepEqual(bigRecords.records, {});
    const system = buildModelSystemPrompt();
    assert.ok(
      modelInputCharCount(system, payload) < B8I_MODEL_MAX_INPUT_CHARS,
    );
  });
});

describe('Model API — nanodollar math', () => {
  it('uses exact integer rates (no float money)', () => {
    assert.equal(B8I_MODEL_RATE_INPUT_ND, 1250);
    assert.equal(B8I_MODEL_RATE_CACHED_ND, 150);
    assert.equal(B8I_MODEL_RATE_OUTPUT_ND, 4250);
    assert.equal(
      modelCostNd({ inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0 }),
      1_250_000_000,
    );
    // Cached subset bills at the cached rate, remainder at input rate.
    assert.equal(
      modelCostNd({ inputTokens: 1000, cachedTokens: 400, outputTokens: 0 }),
      600 * 1250 + 400 * 150,
    );
    assert.equal(
      modelCostNd({ inputTokens: 0, cachedTokens: 0, outputTokens: 1200 }),
      1200 * 4250,
    );
    // Garbage and over-claimed cache clamp safely.
    assert.equal(
      modelCostNd({ inputTokens: -5, cachedTokens: 999, outputTokens: NaN }),
      0,
    );
  });

  it('worst-case reservation is exact and consistent with the output cap', () => {
    const maxInput = estimateInputTokensForReservation(B8I_MODEL_MAX_INPUT_CHARS);
    assert.equal(maxInput, B8I_MODEL_MAX_INPUT_CHARS);
    assert.equal(maxInput, 12000);
    assert.equal(
      worstCaseReservationNd(),
      12000 * B8I_MODEL_RATE_INPUT_ND +
        B8I_MODEL_MAX_OUTPUT_TOKENS * B8I_MODEL_RATE_OUTPUT_ND,
    );
    assert.equal(worstCaseReservationNd(), 20_100_000);
  });

  it('settles actuals, and fail-safes to the full reservation', () => {
    const reservation = worstCaseReservationNd();
    const ok = settleModelUsageNd(
      { prompt_tokens: 2400, completion_tokens: 900 },
      reservation,
    );
    assert.equal(ok.failSafe, false);
    assert.equal(ok.actualNd, 2400 * 1250 + 900 * 4250);
    const cached = settleModelUsageNd(
      {
        input_tokens: 2400,
        completion_tokens: 900,
        prompt_tokens_details: { cached_tokens: 2000 },
      },
      reservation,
    );
    assert.equal(cached.actualNd, 400 * 1250 + 2000 * 150 + 900 * 4250);
    for (const bad of [null, undefined, {}, { completion_tokens: 'x' }]) {
      const failSafe = settleModelUsageNd(bad, reservation);
      assert.equal(failSafe.failSafe, true);
      assert.equal(failSafe.actualNd, reservation);
    }
    // Overruns settle truthfully (never clamped) and flag fail-closed.
    const overrun = settleModelUsageNd(
      { prompt_tokens: 10_000_000, completion_tokens: 10_000_000 },
      reservation,
    );
    assert.equal(overrun.failSafe, false);
    assert.equal(overrun.overrun, true);
    assert.equal(
      overrun.actualNd,
      10_000_000 * 1250 + 10_000_000 * 4250,
    );
    assert.ok(overrun.actualNd > reservation);
  });

  it('parses the spend cap strictly, defaulting to zero', () => {
    assert.equal(parseModelSpendCapNd('0'), 0);
    assert.equal(parseModelSpendCapNd(String(CAP_145_USD_ND)), CAP_145_USD_ND);
    for (const bad of ['', '  ', '-5', '12.5', '1e6', 'abc', '0x10', null, undefined]) {
      assert.equal(parseModelSpendCapNd(bad), 0);
    }
    assert.equal(parseModelSpendCapNd('9'.repeat(16)), 0);
  });
});

describe('Model API — real ledger class behavior', () => {
  const post = (instance, path, body) =>
    instance.fetch(
      new Request(`https://b8i-model-budget.internal${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  it('grants within cap and tracks spend', async () => {
    const { instance, namespace } = makeTestBudget();
    assert.ok(namespace);
    const res = await post(instance, '/reserve', {
      reservation_id: 'aa01',
      cap_nd: CAP_145_USD_ND,
      amount_nd: 20_100_000,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.granted, true);
    assert.equal(data.spent_nd, 20_100_000);
  });

  it('denies over cap and settles refunds to actuals', async () => {
    const budget = makeTestBudget();
    const cap = 30_000_000;
    const r1 = await (
      await post(budget.instance, '/reserve', { reservation_id: 'bb02', cap_nd: cap, amount_nd: 20_100_000 })
    ).json();
    assert.equal(r1.granted, true);
    const r2 = await (
      await post(budget.instance, '/reserve', { reservation_id: 'cc03', cap_nd: cap, amount_nd: 20_100_000 })
    ).json();
    assert.equal(r2.granted, false);
    assert.equal(r2.reason, 'cap_reached');
    const s = await (
      await post(budget.instance, '/settle', {
        reservation_id: 'bb02',
        reservation_nd: 20_100_000,
        actual_nd: 6_825_000,
      })
    ).json();
    assert.equal(s.spent_nd, 6_825_000);
    assert.equal(budget.spent, 6_825_000);
    // Freed budget grants again.
    const r3 = await (
      await post(budget.instance, '/reserve', { reservation_id: 'dd04', cap_nd: cap, amount_nd: 20_100_000 })
    ).json();
    assert.equal(r3.granted, true);
  });

  it('rejects invalid money, methods, and paths', async () => {
    const { instance } = makeTestBudget();
    for (const bad of [
      { reservation_id: 'ee05', cap_nd: -1, amount_nd: 5 },
      { reservation_id: 'ee05', cap_nd: 10, amount_nd: 1.5 },
      { reservation_id: 'ee05', cap_nd: 'x', amount_nd: 5 },
      { reservation_id: 'ee05', cap_nd: 10 },
      { cap_nd: 10, amount_nd: 5 },
      { reservation_id: 'not valid!!', cap_nd: 10, amount_nd: 5 },
      { reservation_id: '', cap_nd: 10, amount_nd: 5 },
    ]) {
      assert.equal((await post(instance, '/reserve', bad)).status, 400);
    }
    assert.equal(
      (await post(instance, '/settle', { reservation_id: 'ee05', reservation_nd: 5, actual_nd: -1 })).status,
      400,
    );
    assert.equal(
      (await post(instance, '/settle', { reservation_nd: 5, actual_nd: 5 })).status,
      400,
    );
    // Zero cap denies everything; zero amount is denied.
    assert.equal(
      (await (await post(instance, '/reserve', { reservation_id: 'ff06', cap_nd: 0, amount_nd: 5 })).json()).granted,
      false,
    );
    assert.equal(
      (await (await post(instance, '/reserve', { reservation_id: 'ff07', cap_nd: 5, amount_nd: 0 })).json()).granted,
      false,
    );
    assert.equal(
      (await instance.fetch(new Request('https://b8i-model-budget.internal/reserve'))).status,
      405,
    );
    assert.equal(
      (await post(instance, '/status', {})).status,
      404,
    );
  });
});

describe('Model API — client request shape and failures', () => {
  const callOk = (env, body = successBody) => {
    metaMockHandler = async () => mockJson(body, 200);
    return callModelApi(env, {
      system: 'sys',
      userPayload: { message: 'hi', records: {} },
      safetyId: '0'.repeat(64),
    });
  };

  it('sends the verified request shape, single attempt', async () => {
    const { env } = modelEnv();
    let seen = null;
    let count = 0;
    metaMockHandler = async (url, init) => {
      count += 1;
      seen = { url, headers: init.headers, body: JSON.parse(init.body) };
      return mockJson(successBody, 200);
    };
    const result = await callModelApi(env, {
      system: 'sys',
      userPayload: { message: 'hi', records: {} },
      safetyId: 'ab'.repeat(32),
    });
    assert.equal(result.ok, true);
    assert.equal(count, 1);
    assert.equal(seen.url, 'https://api.meta.ai/v1/chat/completions');
    assert.equal(seen.headers.Authorization, 'Bearer TEST_ONLY_meta_model_key');
    assert.equal(seen.body.model, 'muse-spark-1.3');
    assert.equal(seen.body.max_completion_tokens, B8I_MODEL_MAX_OUTPUT_TOKENS);
    assert.equal(seen.body.reasoning_effort, 'minimal');
    assert.equal(seen.body.safety_identifier, 'ab'.repeat(32));
    assert.equal(seen.body.prompt_cache_key, B8I_MODEL_CACHE_KEY);
    assert.ok(!('max_tokens' in seen.body));
    assert.ok(!('max_output_tokens' in seen.body));
    assert.ok(!('temperature' in seen.body));
    assert.ok(!('tools' in seen.body));
    assert.equal(result.text, 'Mocked model reply about B8i.');
  });

  it('maps provider failures to error classes without retrying', async () => {
    const { env } = modelEnv();
    for (const [status, body, expected] of [
      [401, { error: { message: 'bad key' } }, 'http_401'],
      [429, { error: { message: 'slow down' } }, 'http_429'],
      [500, { error: { message: 'boom' } }, 'http_500'],
      [200, { choices: [], usage: null }, 'empty_completion'],
    ]) {
      let count = 0;
      metaMockHandler = async () => {
        count += 1;
        return mockJson(body, status);
      };
      const result = await callModelApi(env, {
        system: 'sys',
        userPayload: { message: 'hi', records: {} },
        safetyId: '0'.repeat(64),
      });
      assert.equal(result.ok, false);
      assert.equal(result.errorClass, expected);
      assert.equal(count, 1);
    }
  });

  it('classifies timeouts via AbortSignal', async () => {
    const { env } = modelEnv({ META_MODEL_TIMEOUT_MS: '1000' });
    metaMockHandler = (url, init) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'TimeoutError';
          reject(error);
        });
      });
    const result = await callModelApi(env, {
      system: 'sys',
      userPayload: { message: 'hi', records: {} },
      safetyId: '0'.repeat(64),
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorClass, 'timeout');
  });
});

describe('Model API — router integration', () => {
  async function postText({ text, env, senderId }) {
    const sender = senderId ?? nextSender();
    const tctx = createTestContext();
    const req = buildInstagramWebhookRequest({
      payload: buildTextMessagePayload(sender, text),
      secret: env.INSTAGRAM_APP_SECRET,
    });
    const res = await worker.fetch(req, env, tctx.ctx);
    assert.equal(res.status, 200);
    await drainWaitUntil(tctx);
    return { sender, dms: messagesFor(base.sentMessages, sender) };
  }

  it('enabled path sends the model reply and settles actuals', async () => {
    const { env, budget } = modelEnv();
    metaMockHandler = async () => mockJson(successBody, 200);
    const { sender, dms } = await postText({
      text: 'zxqv blorp snork',
      env,
      senderId: nextSender(),
    });
    assert.equal(metaAttempts.length, 1);
    assert.equal(dms.length, 1);
    assert.equal(dms[0].message.text, 'Mocked model reply about B8i.');
    assert.equal(budget.spent, 2400 * 1250 + 900 * 4250);
    assert.ok(sender);
  });

  it('disabled path falls back with zero Model API attempts', async () => {
    const { env, budget } = modelEnv({ META_MODEL_API_ENABLED: '0' });
    metaMockHandler = async () => mockJson(successBody, 200);
    const { dms } = await postText({ text: 'zxqv blorp snork', env });
    assert.equal(metaAttempts.length, 0);
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /Welcome to B8i/);
    assert.equal(budget.spent, 0);
  });

  it('zero cap denies without calling the model', async () => {
    const { env, budget } = modelEnv({ META_MODEL_SPEND_CAP_ND: '0' });
    metaMockHandler = async () => mockJson(successBody, 200);
    const { dms } = await postText({ text: 'zxqv blorp snork', env });
    assert.equal(metaAttempts.length, 0);
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /Welcome to B8i/);
    assert.equal(budget.spent, 0);
  });

  it('provider failure falls back and fail-safe settles the reservation', async () => {
    const { env, budget } = modelEnv();
    metaMockHandler = async () => mockJson({ error: {} }, 500);
    const { dms } = await postText({ text: 'zxqv blorp snork', env });
    assert.equal(metaAttempts.length, 1);
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /Welcome to B8i/);
    assert.equal(budget.spent, worstCaseReservationNd());
  });

  it('sender cap blocks before any Model API attempt', async () => {
    const { env, budget } = modelEnv();
    const sender = nextSender();
    const today = new Date().toISOString().slice(0, 10);
    await env.INSTAGRAM_CONVERSATIONS.put(
      `MODEL_API_USE:${sender}`,
      JSON.stringify({
        day: today,
        count: B8I_MODEL_MAX_CALLS_PER_SENDER_PER_DAY,
      }),
    );
    metaMockHandler = async () => mockJson(successBody, 200);
    const { dms } = await postText({ text: 'zxqv blorp snork', env, senderId: sender });
    assert.equal(metaAttempts.length, 0);
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /Welcome to B8i/);
    assert.equal(budget.spent, 0);
  });

  it('direct handler call never throws and honors gates', async () => {
    const { env } = modelEnv({ META_MODEL_API_ENABLED: '' });
    assert.equal(await handleB8iModelAssistant('s1', 'hello', env), false);
    assert.equal(await handleB8iModelAssistant('', 'hello', env), false);
    assert.equal(await handleB8iModelAssistant('s1', '   ', env), false);
  });
});

describe('Model API — network-block evidence', () => {
  it('blocks non-mocked api.meta.ai shapes fail-closed', async () => {
    const { env } = modelEnv();
    assert.ok(env);
    metaMockHandler = async () => mockJson(successBody, 200);
    await assert.rejects(
      () => fetch('https://api.meta.ai/v1/models', { method: 'GET' }),
      new RegExp(ISOLATION_ERROR_PATTERN),
    );
    await assert.rejects(
      () =>
        fetch('https://api.meta.ai/v1/responses', {
          method: 'POST',
          body: '{}',
        }),
      new RegExp(ISOLATION_ERROR_PATTERN),
    );
    await assert.rejects(
      () => fetch('https://api.razorpay.com/v1/orders', { method: 'POST' }),
      new RegExp(ISOLATION_ERROR_PATTERN),
    );
  });

  it('base counters reconcile; wrapper reports Meta mock counts', () => {
    const c = base.counters;
    assert.equal(
      c.totalIntercepted,
      c.instagramSenderLookups + c.instagramSends + c.blockedFailClosed,
    );
    console.log(
      `[model-api-tests] base=${JSON.stringify(c)} metaAttempts=${metaAttempts.length}`,
    );
  });
});

describe('Model API — settlement idempotency', () => {
  const post = (instance, path, body) =>
    instance.fetch(
      new Request(`https://b8i-model-budget.internal${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  it('rejects duplicate settlement without a second refund', async () => {
    const budget = makeTestBudget();
    const cap = 145_000_000_000;
    const grant = await (
      await post(budget.instance, '/reserve', {
        reservation_id: '1d01',
        cap_nd: cap,
        amount_nd: 20_100_000,
      })
    ).json();
    assert.equal(grant.granted, true);
    const first = await post(budget.instance, '/settle', {
      reservation_id: '1d01',
      reservation_nd: 20_100_000,
      actual_nd: 6_825_000,
    });
    assert.equal(first.status, 200);
    assert.equal(budget.spent, 6_825_000);
    const dup = await post(budget.instance, '/settle', {
      reservation_id: '1d01',
      reservation_nd: 20_100_000,
      actual_nd: 6_825_000,
    });
    assert.equal(dup.status, 404);
    assert.equal(budget.spent, 6_825_000);
  });

  it('rejects unknown and mismatched reservations without state change', async () => {
    const budget = makeTestBudget();
    const cap = 145_000_000_000;
    const unknown = await post(budget.instance, '/settle', {
      reservation_id: '9e99',
      reservation_nd: 20_100_000,
      actual_nd: 1_000_000,
    });
    assert.equal(unknown.status, 404);
    assert.equal(budget.spent, 0);
    await post(budget.instance, '/reserve', {
      reservation_id: '1d02',
      cap_nd: cap,
      amount_nd: 20_100_000,
    });
    const mismatch = await post(budget.instance, '/settle', {
      reservation_id: '1d02',
      reservation_nd: 1_000_000,
      actual_nd: 1_000_000,
    });
    assert.equal(mismatch.status, 404);
    // Record retained: the correct settle still succeeds exactly once.
    const correct = await post(budget.instance, '/settle', {
      reservation_id: '1d02',
      reservation_nd: 20_100_000,
      actual_nd: 6_825_000,
    });
    assert.equal(correct.status, 200);
    assert.equal(budget.spent, 6_825_000);
  });

  it('rejects duplicate reservation IDs without double-charging', async () => {
    const budget = makeTestBudget();
    const cap = 145_000_000_000;
    const first = await (
      await post(budget.instance, '/reserve', {
        reservation_id: '1d03',
        cap_nd: cap,
        amount_nd: 20_100_000,
      })
    ).json();
    assert.equal(first.granted, true);
    const dup = await (
      await post(budget.instance, '/reserve', {
        reservation_id: '1d03',
        cap_nd: cap,
        amount_nd: 20_100_000,
      })
    ).json();
    assert.equal(dup.granted, false);
    assert.equal(dup.reason, 'duplicate_reservation');
    assert.equal(budget.spent, 20_100_000);
  });

  it('fails closed on corrupt ledger state', async () => {
    const budget = makeTestBudget();
    budget.store.set('spent_nd', { evil: 'not-a-number' });
    const reserve = await post(budget.instance, '/reserve', {
      reservation_id: 'c001',
      cap_nd: 145_000_000_000,
      amount_nd: 20_100_000,
    });
    assert.equal(reserve.status, 500);
    // Repair the corruption out-of-band, then prove no state was damaged.
    budget.store.set('spent_nd', 0);
    const ok = await (
      await post(budget.instance, '/reserve', {
        reservation_id: 'c002',
        cap_nd: 145_000_000_000,
        amount_nd: 20_100_000,
      })
    ).json();
    assert.equal(ok.granted, true);
    budget.store.set('spent_nd', 'garbage');
    const settle = await post(budget.instance, '/settle', {
      reservation_id: 'c002',
      reservation_nd: 20_100_000,
      actual_nd: 6_825_000,
    });
    assert.equal(settle.status, 500);
    assert.ok(budget.store.has('res:c002'));
  });

  it('serializes concurrent reservations under the cap', async () => {
    const budget = makeTestBudget();
    const cap = 50_000_000; // fits exactly two 20_100_000 grants
    const ids = ['cc10', 'cc11', 'cc12', 'cc13', 'cc14'];
    const results = await Promise.all(
      ids.map(async (id) =>
        (
          await post(budget.instance, '/reserve', {
            reservation_id: id,
            cap_nd: cap,
            amount_nd: 20_100_000,
          })
        ).json(),
      ),
    );
    const granted = results.filter((r) => r.granted);
    assert.equal(granted.length, 2);
    assert.equal(budget.spent, 2 * 20_100_000);
    assert.ok(budget.spent <= cap);
  });
});

describe('Model API — overrun accounting', () => {
  const post = (instance, path, body) =>
    instance.fetch(
      new Request(`https://b8i-model-budget.internal${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  it('records truthful overruns and denies further calls', async () => {
    const budget = makeTestBudget();
    const cap = 25_000_000;
    const grant = await (
      await post(budget.instance, '/reserve', {
        reservation_id: '0e01',
        cap_nd: cap,
        amount_nd: 20_100_000,
      })
    ).json();
    assert.equal(grant.granted, true);
    const settle = await (
      await post(budget.instance, '/settle', {
        reservation_id: '0e01',
        reservation_nd: 20_100_000,
        actual_nd: 24_250_000,
      })
    ).json();
    assert.equal(settle.spent_nd, 24_250_000);
    assert.equal(settle.overrun, true);
    assert.equal(budget.spent, 24_250_000);
    const next = await (
      await post(budget.instance, '/reserve', {
        reservation_id: '0e02',
        cap_nd: cap,
        amount_nd: 20_100_000,
      })
    ).json();
    assert.equal(next.granted, false);
    assert.equal(next.reason, 'cap_reached');
  });

  it('worker settles overruns and blocks the next caller end to end', async () => {
    const { env, budget } = modelEnv({ META_MODEL_SPEND_CAP_ND: '25000000' });
    const bigUsage = { prompt_tokens: 2400, completion_tokens: 5000 };
    metaMockHandler = async () =>
      mockJson({ ...successBody, usage: bigUsage }, 200);
    const tctx = createTestContext();
    const senderA = nextSender();
    const resA = await worker.fetch(
      buildInstagramWebhookRequest({
        payload: buildTextMessagePayload(senderA, 'zxqv blorp snork'),
        secret: env.INSTAGRAM_APP_SECRET,
      }),
      env,
      tctx.ctx,
    );
    assert.equal(resA.status, 200);
    await drainWaitUntil(tctx);
    assert.equal(budget.spent, 2400 * 1250 + 5000 * 4250);
    assert.equal(budget.spent, 24_250_000);
    const attemptsAfterFirst = metaAttempts.length;
    assert.equal(attemptsAfterFirst, 1);
    const senderB = nextSender();
    const tctxB = createTestContext();
    const resB = await worker.fetch(
      buildInstagramWebhookRequest({
        payload: buildTextMessagePayload(senderB, 'zxqv blorp snork'),
        secret: env.INSTAGRAM_APP_SECRET,
      }),
      env,
      tctxB.ctx,
    );
    assert.equal(resB.status, 200);
    await drainWaitUntil(tctxB);
    assert.equal(metaAttempts.length, 1);
    const dmsB = messagesFor(base.sentMessages, senderB);
    assert.equal(dmsB.length, 1);
    assert.match(dmsB[0].message.text, /Welcome to B8i/);
  });
});

describe('Model API — input budget guard', () => {
  it('current maximum input fits the enforced budget', () => {
    const system = buildModelSystemPrompt();
    const payload = buildModelUserPayload('m'.repeat(5000), {
      blob: 'r'.repeat(10000),
    });
    // Builder caps the message; scrub keeps the 200-char string.
    assert.equal(payload.message.length, B8I_MODEL_MAX_USER_CHARS);
    assert.equal(payload.records.blob.length, 200);
    assert.equal(modelInputWithinBudget(system, payload), true);
    assert.ok(
      modelInputCharCount(system, payload) < B8I_MODEL_MAX_INPUT_CHARS,
    );
  });

  it('rejects input that cannot fit the budget', () => {
    const system = buildModelSystemPrompt();
    assert.equal(
      modelInputWithinBudget(system, {
        message: 'x',
        records: { blob: 'y'.repeat(B8I_MODEL_MAX_INPUT_CHARS) },
      }),
      false,
    );
    assert.equal(
      modelInputWithinBudget(system, { message: 'hi', records: {} }),
      true,
    );
  });
});

describe('Model API — reply validation', () => {
  it('strips fabricated URLs', () => {
    const stripped = validateModelReply(
      'See https://evil.example.com/steal for details.',
    );
    assert.ok(stripped.includes('[link removed]'));
    assert.ok(!stripped.includes('evil.example.com'));
    const www = validateModelReply('Visit www.evil.example/x now.');
    assert.ok(!www.includes('evil.example'));
    const clean = validateModelReply('Mocked model reply about B8i.');
    assert.equal(clean, 'Mocked model reply about B8i.');
  });

  it('rejects action claims but keeps ordinary helpful replies', () => {
    for (const claim of [
      'Your payment has been processed successfully.',
      'I have completed your registration.',
      'Payout of ₹5000 sent to your account.',
      'Payment successful, enjoy!',
      'We just paid your invoice.',
      'A campaign was created for you.',
    ]) {
      assert.equal(validateModelReply(claim), null, claim);
    }
    for (const fine of [
      'Mocked model reply about B8i.',
      'Here is how payouts work: the vendor reviews and confirms it.',
      'Reply vendor to get your registration link.',
      'I cannot check any payment status myself.',
    ]) {
      assert.ok(validateModelReply(fine), fine);
    }
  });

  it('rejects empty and non-string completions', () => {
    assert.equal(validateModelReply(''), null);
    assert.equal(validateModelReply('   '), null);
    assert.equal(validateModelReply(12345), null);
    assert.equal(validateModelReply(null), null);
  });

  it('end to end: unsafe reply falls back to welcome', async () => {
    const { env, budget } = modelEnv();
    metaMockHandler = async () =>
      mockJson(
        {
          ...successBody,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Your payment has been processed successfully.',
              },
              finish_reason: 'stop',
            },
          ],
        },
        200,
      );
    const sender = nextSender();
    const tctx = createTestContext();
    const res = await worker.fetch(
      buildInstagramWebhookRequest({
        payload: buildTextMessagePayload(sender, 'zxqv blorp snork'),
        secret: env.INSTAGRAM_APP_SECRET,
      }),
      env,
      tctx.ctx,
    );
    assert.equal(res.status, 200);
    await drainWaitUntil(tctx);
    assert.equal(metaAttempts.length, 1);
    const dms = messagesFor(base.sentMessages, sender);
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /Welcome to B8i/);
    assert.equal(budget.spent, 2400 * 1250 + 900 * 4250);
  });

  it('end to end: stripped reply still sends without the URL', async () => {
    const { env } = modelEnv();
    metaMockHandler = async () =>
      mockJson(
        {
          ...successBody,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'See https://evil.example.com/a for B8i info.',
              },
              finish_reason: 'stop',
            },
          ],
        },
        200,
      );
    const sender = nextSender();
    const tctx = createTestContext();
    const res = await worker.fetch(
      buildInstagramWebhookRequest({
        payload: buildTextMessagePayload(sender, 'zxqv blorp snork'),
        secret: env.INSTAGRAM_APP_SECRET,
      }),
      env,
      tctx.ctx,
    );
    assert.equal(res.status, 200);
    await drainWaitUntil(tctx);
    const dms = messagesFor(base.sentMessages, sender);
    assert.equal(dms.length, 1);
    assert.ok(dms[0].message.text.includes('[link removed]'));
    assert.ok(!dms[0].message.text.includes('evil.example.com'));
  });
});

describe('Model API — request capture', () => {
  it('sends empty records with redirect error and hashed safety id', async () => {
    const { env } = modelEnv();
    let seen = null;
    metaMockHandler = async (url, init) => {
      seen = { init, body: JSON.parse(init.body) };
      return mockJson(successBody, 200);
    };
    const sender = nextSender();
    const handled = await handleB8iModelAssistant(sender, 'zxqv blorp', env);
    assert.equal(handled, true);
    assert.equal(seen.init.redirect, 'error');
    const userContent = JSON.parse(seen.body.messages[1].content);
    assert.deepEqual(userContent.records, {});
    assert.match(seen.body.safety_identifier, /^[0-9a-f]{64}$/);
    assert.ok(!seen.body.safety_identifier.includes(sender));
    assert.ok(JSON.stringify(seen.body).length < 20000);
  });
});

describe('Model API — Phase 1 short-circuit', () => {
  it('never calls the model when Phase 1 handles the message', async () => {
    const { env } = modelEnv();
    metaMockHandler = async () => mockJson(successBody, 200);
    const sender = nextSender();
    const tctx = createTestContext();
    const res = await worker.fetch(
      buildInstagramWebhookRequest({
        payload: buildTextMessagePayload(sender, 'vendor'),
        secret: env.INSTAGRAM_APP_SECRET,
      }),
      env,
      tctx.ctx,
    );
    assert.equal(res.status, 200);
    await drainWaitUntil(tctx);
    assert.equal(metaAttempts.length, 0);
    const dms = messagesFor(base.sentMessages, sender);
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /\/register\/vendor\?token=/);
  });
});

describe('Model API — solicitation rejection', () => {
  it('rejects credential and payment solicitation', () => {
    for (const bad of [
      'Share your OTP to continue.',
      'Enter your UPI PIN here.',
      'Send your password for verification.',
      'Provide your bank account number to proceed.',
      'DM your CVV to confirm booking.',
      'Type your Aadhaar number below.',
      'Upload a screenshot of your payment.',
      'Please verify with your one-time passcode.',
      'Give us your card expiry to finish.',
    ]) {
      assert.equal(validateModelReply(bad), null, bad);
    }
  });

  it('allows negated safety warnings and ordinary replies', () => {
    for (const fine of [
      'Never share your OTP with anyone.',
      'Do not enter your password anywhere.',
      'B8i helps brands. In most cases vendors pay per campaign.',
      'Complete your profile, verification, and membership to become eligible.',
      'See version v0.2 notes above.',
      'UPI payments are settled after vendor confirmation.',
    ]) {
      assert.ok(validateModelReply(fine), fine);
    }
  });
});

describe('Model API — suspicious domain rejection', () => {
  it('rejects bare domains and obfuscated links', () => {
    for (const bad of [
      'See updates at news.b8i-club.xyz today.',
      'Visit bit.ly/abc123 for more.',
      'Contact helpdesk.example.in urgently.',
      'Go to hxxp://evil.com/x now.',
      'Visit evil[.]com now.',
      'Open example dot com today.',
      'See //evil.com/x here.',
    ]) {
      assert.equal(validateModelReply(bad), null, bad);
    }
  });

  it('end to end: solicitation falls back to welcome with spend recorded', async () => {
    const { env, budget } = modelEnv();
    metaMockHandler = async () =>
      mockJson(
        {
          ...successBody,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Share your OTP to verify your account.',
              },
              finish_reason: 'stop',
            },
          ],
        },
        200,
      );
    const sender = nextSender();
    const tctx = createTestContext();
    const res = await worker.fetch(
      buildInstagramWebhookRequest({
        payload: buildTextMessagePayload(sender, 'zxqv blorp snork'),
        secret: env.INSTAGRAM_APP_SECRET,
      }),
      env,
      tctx.ctx,
    );
    assert.equal(res.status, 200);
    await drainWaitUntil(tctx);
    assert.equal(metaAttempts.length, 1);
    const dms = messagesFor(base.sentMessages, sender);
    assert.equal(dms.length, 1);
    assert.match(dms[0].message.text, /Welcome to B8i/);
    assert.equal(budget.spent, 2400 * 1250 + 900 * 4250);
  });
});

describe('Model API — recovery runbook', () => {
  it('documents overrun, orphan, and reconciliation handling', () => {
    const runbook = readFileSync(
      new URL('../docs/model-api-recovery-runbook.md', import.meta.url),
      'utf8',
    ).toLowerCase();
    for (const term of [
      'overrun',
      'abandoned',
      'reconcil',
      'raising the cap',
      'automatic refund',
      'meta_model_spend_cap_nd',
      'deny-all',
      'welcome',
    ]) {
      assert.ok(runbook.includes(term), `runbook must cover: ${term}`);
    }
  });
});

after(() => {
  globalThis.fetch = baseFetch;
  base.restore();
});
