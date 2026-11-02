// test/helpers.mjs
//
// B8i Phase 1 local testing helpers.
//
// Safety contract (do not weaken):
// - Synthetic credentials only. Every secret must start with TEST_ONLY_.
// - In-memory KV stub only. No Cloudflare, no network, no filesystem state.
// - Test-only origin: https://b8i-phase1.test (.test is RFC 2606 reserved
//   and never resolves on the public internet).
// - All outbound fetch() calls are intercepted. The two Instagram Graph
//   shapes the Phase 1 assistant needs (sender lookup + DM send) are
//   mocked in-process; EVERYTHING else throws NETWORK_ISOLATION_BLOCKED
//   (fail closed). The real fetch is never called.

import { createHmac } from 'node:crypto';

export const TEST_ORIGIN = 'https://b8i-phase1.test';
export const FAKE_INSTAGRAM_SENDER_ID = 'ig_test_sender_001';
export const SYNTHETIC_PREFIX = 'TEST_ONLY_';
export const ISOLATION_ERROR_PATTERN = 'NETWORK_ISOLATION_BLOCKED';

// Server-side outbound hosts observed in worker.js. The interceptor below
// denies all of them by default; the Instagram mock allowlist covers only
// the two Phase 1 shapes (sender identity GET, message send POST).
export const KNOWN_EXTERNAL_HOSTS = [
  'inference.baseten.co', // Baseten Muse Spark ranking (advisory AI match)
  'api.razorpay.com', // orders, plans, subscriptions, transfers
  'api.resend.com', // admin alert email
  'graph.instagram.com', // sender lookup + DM send (mocked shapes only)
];

// ---------------------------------------------------------------------------
// In-memory KV stub (Cloudflare KV surface used by worker.js)
// ---------------------------------------------------------------------------

export class InMemoryKV {
  constructor() {
    this.store = new Map(); // key -> { value: string, expiresAt: number|null }
  }

  async get(key, _opts) {
    const entry = this.store.get(String(key));
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(String(key));
      return null;
    }
    return entry.value;
  }

  async put(key, value, opts = {}) {
    let expiresAt = null;
    const ttl = Number(opts?.expirationTtl);
    if (Number.isFinite(ttl) && ttl > 0) {
      expiresAt = Date.now() + ttl * 1000;
    }
    this.store.set(String(key), { value: String(value), expiresAt });
  }

  async delete(key) {
    this.store.delete(String(key));
  }

  async list({ prefix = '', limit = 100, cursor } = {}) {
    const names = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort();
    let start = 0;
    if (cursor !== undefined) {
      const idx = names.indexOf(String(cursor));
      start = idx >= 0 ? idx + 1 : 0;
    }
    const slice = names.slice(start, start + Math.max(1, limit));
    const listComplete = start + slice.length >= names.length;
    const page = {
      keys: slice.map((name) => ({ name })),
      list_complete: listComplete,
    };
    if (!listComplete) {
      page.cursor = slice.length ? slice[slice.length - 1] : String(cursor);
    }
    return page;
  }

  // Test introspection (not part of the KV surface).
  keysWithPrefix(prefix) {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

// ---------------------------------------------------------------------------
// Synthetic env (no real credentials, no real hosts)
// ---------------------------------------------------------------------------

export function createSyntheticEnv(overrides = {}) {
  const kv =
    overrides.INSTAGRAM_CONVERSATIONS instanceof InMemoryKV
      ? overrides.INSTAGRAM_CONVERSATIONS
      : new InMemoryKV();
  return {
    INSTAGRAM_CONVERSATIONS: kv,
    INSTAGRAM_APP_SECRET: `${SYNTHETIC_PREFIX}app_secret_9f2c7a41_phase1_local`,
    INSTAGRAM_ACCESS_TOKEN: `${SYNTHETIC_PREFIX}ig_access_token_9f2c7a41_phase1_local`,
    INSTAGRAM_VERIFY_TOKEN: `${SYNTHETIC_PREFIX}verify_token_9f2c7a41_phase1_local`,
    INSTAGRAM_IG_USER_ID: '99000111222',
    INSTAGRAM_API_VERSION: 'v26.0',
    RAZORPAY_KEY_ID: `${SYNTHETIC_PREFIX}rzp_key_id`,
    RAZORPAY_KEY_SECRET: `${SYNTHETIC_PREFIX}rzp_key_secret`,
    RAZORPAY_WEBHOOK_SECRET: `${SYNTHETIC_PREFIX}rzp_webhook_secret`,
    BASETEN_API_KEY: `${SYNTHETIC_PREFIX}baseten_key`,
    RESEND_API_KEY: `${SYNTHETIC_PREFIX}resend_key`,
    RESEND_FROM_EMAIL: 'phase1-test@b8i-phase1.test',
    CUSTOMER_SUPPORT_PHONE: `${SYNTHETIC_PREFIX}+91-00000-00000`,
    THEVAL_CUSTOMER_SUPPORT_PHONE: '',
    APP_BASE_URL: TEST_ORIGIN,
    ...overrides,
    INSTAGRAM_CONVERSATIONS: kv,
  };
}

// Secrets that must never appear in outbound DM text or logs asserted here.
// The support phone is excluded by default because the support reply is
// *supposed* to carry the (synthetic) routing number.
export function syntheticSecrets(env, { includePhone = false } = {}) {
  const secrets = [
    env.INSTAGRAM_APP_SECRET,
    env.INSTAGRAM_ACCESS_TOKEN,
    env.INSTAGRAM_VERIFY_TOKEN,
    env.RAZORPAY_KEY_ID,
    env.RAZORPAY_KEY_SECRET,
    env.RAZORPAY_WEBHOOK_SECRET,
    env.BASETEN_API_KEY,
    env.RESEND_API_KEY,
  ].filter(Boolean);
  if (includePhone) {
    if (env.CUSTOMER_SUPPORT_PHONE) secrets.push(env.CUSTOMER_SUPPORT_PHONE);
    if (env.THEVAL_CUSTOMER_SUPPORT_PHONE) {
      secrets.push(env.THEVAL_CUSTOMER_SUPPORT_PHONE);
    }
  }
  return secrets;
}

// Throws when the env is not synthetic-only. Call before running tests.
export function assertSyntheticEnv(env) {
  const required = [
    'INSTAGRAM_APP_SECRET',
    'INSTAGRAM_ACCESS_TOKEN',
    'INSTAGRAM_VERIFY_TOKEN',
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'RAZORPAY_WEBHOOK_SECRET',
    'BASETEN_API_KEY',
    'RESEND_API_KEY',
    'CUSTOMER_SUPPORT_PHONE',
  ];
  for (const key of required) {
    const value = String(env[key] ?? '');
    if (!value.startsWith(SYNTHETIC_PREFIX)) {
      throw new Error(
        `UNSAFE_ENV: ${key} is not synthetic (must start with ${SYNTHETIC_PREFIX})`,
      );
    }
  }
  if (!(env.INSTAGRAM_CONVERSATIONS instanceof InMemoryKV)) {
    throw new Error('UNSAFE_ENV: INSTAGRAM_CONVERSATIONS must be InMemoryKV');
  }
  if (env.APP_BASE_URL !== TEST_ORIGIN) {
    throw new Error(`UNSAFE_ENV: APP_BASE_URL must be ${TEST_ORIGIN}`);
  }
  if (new URL(TEST_ORIGIN).hostname.endsWith('.test') === false) {
    throw new Error('UNSAFE_ENV: test origin must use a .test hostname');
  }
}

// ---------------------------------------------------------------------------
// Network isolation: intercept fetch, mock Instagram Phase 1 shapes only,
// fail closed on everything else. The original fetch is never called.
// ---------------------------------------------------------------------------

export function installNetworkIsolation({
  fakeSenderId = FAKE_INSTAGRAM_SENDER_ID,
} = {}) {
  if (globalThis.fetch?.__b8iIsolationHandle) {
    return globalThis.fetch.__b8iIsolationHandle;
  }
  const originalFetch = globalThis.fetch;
  const counters = {
    totalIntercepted: 0,
    instagramSenderLookups: 0,
    instagramSends: 0,
    blockedFailClosed: 0,
  };
  const attempts = [];
  const sentMessages = [];
  let sendSeq = 0;

  const mockJson = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const blocked = (method, url, reason) => {
    counters.blockedFailClosed += 1;
    attempts.push({ method, url, blocked: true, reason });
    throw new Error(
      `${ISOLATION_ERROR_PATTERN}: ${method} ${url} — outbound network disabled in Phase 1 local tests`,
    );
  };

  const stub = async (input, init = {}) => {
    counters.totalIntercepted += 1;
    const url = typeof input === 'string' ? input : String(input?.url ?? '');
    const method = String(
      init?.method ?? input?.method ?? 'GET',
    ).toUpperCase();

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return blocked(method, url || '(unparsable url)', 'unparsable-url');
    }
    const host = parsed.hostname.toLowerCase();
    const shortUrl = `${parsed.protocol}//${host}${parsed.pathname}`;

    // Mock 1: Instagram sender identity lookup.
    //   GET /{version}/me?fields=id&access_token=...
    //   GET /{version}/{configuredId}?fields=id&access_token=...
    const isSenderLookup =
      host === 'graph.instagram.com' &&
      method === 'GET' &&
      parsed.searchParams.get('fields') === 'id' &&
      parsed.searchParams.has('access_token') &&
      (parsed.pathname.endsWith('/me') ||
        /^\/v\d+\.\d+\/[^/]+$/.test(parsed.pathname));
    if (isSenderLookup) {
      counters.instagramSenderLookups += 1;
      attempts.push({ method, url: shortUrl, blocked: false, mock: 'sender-lookup' });
      return mockJson({ id: fakeSenderId });
    }

    // Mock 2: Instagram outbound DM send.
    //   POST /{version}/me/messages
    if (
      host === 'graph.instagram.com' &&
      method === 'POST' &&
      parsed.pathname.endsWith('/me/messages')
    ) {
      counters.instagramSends += 1;
      let body = null;
      try {
        body = JSON.parse(init?.body ?? 'null');
      } catch {
        body = null;
      }
      sendSeq += 1;
      sentMessages.push({
        url: shortUrl,
        recipient: body?.recipient?.id ?? null,
        message: body?.message ?? null,
        seq: sendSeq,
      });
      attempts.push({
        method,
        url: shortUrl,
        blocked: false,
        mock: 'dm-send',
        recipient: body?.recipient?.id ?? null,
      });
      return mockJson({
        recipient_id: body?.recipient?.id ?? null,
        message_id: `mid_test_${String(sendSeq).padStart(4, '0')}`,
      });
    }

    // Deny by default: Razorpay, Baseten, Resend, Instagram profile
    // lookups, the test origin itself via fetch(), and anything else.
    return blocked(method, shortUrl, 'deny-by-default');
  };

  const handle = {
    counters,
    attempts,
    sentMessages,
    originalFetch,
    snapshot() {
      return { ...counters };
    },
    restore() {
      if (globalThis.fetch === stub) {
        globalThis.fetch = originalFetch;
      }
    },
  };
  stub.__b8iIsolationHandle = handle;
  globalThis.fetch = stub;
  return handle;
}

// ---------------------------------------------------------------------------
// Instagram webhook request builders (HMAC-signed like Meta)
// ---------------------------------------------------------------------------

export function signInstagramPayload(rawBody, secret) {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

export function buildInstagramWebhookRequest({
  origin = TEST_ORIGIN,
  payload,
  secret,
  headers = {},
} = {}) {
  if (!secret) throw new Error('buildInstagramWebhookRequest requires secret');
  const rawBody =
    typeof payload === 'string' ? payload : JSON.stringify(payload);
  const hex = signInstagramPayload(rawBody, secret);
  return new Request(`${origin}/webhook/instagram`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': `sha256=${hex}`,
      ...headers,
    },
    body: rawBody,
  });
}

let b8iMidSeq = 0;

// Each built message gets a unique mid like real Meta deliveries, so the
// worker's redelivery guard treats distinct posts as distinct. Pass an
// explicit mid to simulate a duplicate delivery of the same event.
export function buildTextMessagePayload(senderId, text, mid = null) {
  b8iMidSeq += 1;
  return {
    object: 'instagram',
    entry: [
      {
        id: 'test_entry_1',
        messaging: [
          {
            sender: { id: String(senderId) },
            recipient: { id: 'test_page_1' },
            message: {
              mid: mid ?? `mid_in_${senderId}_${b8iMidSeq}`,
              text: String(text),
            },
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Worker ctx stub (captures ctx.waitUntil work so tests can drain it)
// ---------------------------------------------------------------------------

export function createTestContext() {
  const pending = [];
  return {
    pending,
    ctx: {
      waitUntil(promise) {
        pending.push(Promise.resolve(promise));
      },
    },
  };
}

export async function drainWaitUntil(tctx, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let guard = 0;
  while (tctx.pending.length) {
    guard += 1;
    if (Date.now() > deadline || guard > 1000) {
      throw new Error('drainWaitUntil timed out waiting for worker tasks');
    }
    const batch = tctx.pending.splice(0, tctx.pending.length);
    await Promise.all(batch);
  }
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

export function messagesFor(sentMessages, recipient) {
  return sentMessages.filter((m) => m.recipient === String(recipient));
}

export function assertNoSecretsInText(text, secrets, context) {
  for (const secret of secrets) {
    if (secret && String(text).includes(secret)) {
      throw new Error(
        `PRIVACY_VIOLATION[${context}]: outbound text contains a synthetic secret`,
      );
    }
  }
}

export function stripUrls(text) {
  return String(text).replace(/https?:\/\/\S+/g, '[URL]');
}
