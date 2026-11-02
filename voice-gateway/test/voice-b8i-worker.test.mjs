// Maintained tests for the gateway's B8i worker client.
// Network isolation: global fetch is stubbed in-process; no sockets opened,
// no external requests, no real credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  B8iWorkerError,
  createVoiceSession,
  followerEligibility,
  getCampaignStatus,
  getVoiceSessionStatus,
  getInfluencerSubscriptionStatus,
  getRegistrationProfile,
  isVoiceIntegrationEnabled,
  redactUrl,
  workerConfigFromEnv
} from '../src/services/b8i-worker.js';

const BASE = 'https://worker.test';

const clientFor = (overrides = {}) => ({
  enabled: true,
  baseUrl: BASE,
  token: 'TEST_ONLY_voice_token',
  timeoutMs: 2000,
  ...overrides
});

const asCode = code => err => {
  assert.ok(err instanceof B8iWorkerError, `expected B8iWorkerError, got ${err}`);
  assert.equal(err.code, code);
  return true;
};

function installFetchMock(handler) {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({
      url: String(url),
      method: init.method || 'GET',
      auth: init.headers?.authorization || null
    });
    return handler(String(url), init);
  };
  return { seen, restore: () => { globalThis.fetch = orig; } };
}

const jsonRes = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });

const timeoutRejection = () => {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  return err;
};

test('voice integration flag defaults to off', () => {
  assert.equal(isVoiceIntegrationEnabled({}), false);
  assert.equal(isVoiceIntegrationEnabled({ B8I_VOICE_ENABLED: 'false' }), false);
  assert.equal(isVoiceIntegrationEnabled({ B8I_VOICE_ENABLED: 'true' }), true);
  assert.equal(isVoiceIntegrationEnabled({ B8I_VOICE_ENABLED: 'TRUE' }), true);
});

test('worker config requires https except local/test hosts', () => {
  assert.throws(() => workerConfigFromEnv({}), asCode('not_configured'));
  assert.throws(
    () => workerConfigFromEnv({ B8I_WORKER_URL: 'http://example.com' }),
    asCode('invalid_base_url')
  );
  assert.throws(
    () => workerConfigFromEnv({ B8I_WORKER_URL: 'notaurl' }),
    asCode('invalid_base_url')
  );
  const local = workerConfigFromEnv({ B8I_WORKER_URL: 'http://127.0.0.1:8787/' });
  assert.equal(local.baseUrl, 'http://127.0.0.1:8787');
  assert.equal(local.enabled, false);
  const remote = workerConfigFromEnv({
    B8I_WORKER_URL: 'https://worker.example/',
    B8I_VOICE_ENABLED: 'true',
    B8I_VOICE_API_TOKEN: 'TEST_ONLY_x'
  });
  assert.equal(remote.baseUrl, 'https://worker.example');
  assert.equal(remote.enabled, true);
});

test('disabled client refuses every call', async () => {
  const client = { enabled: false, baseUrl: BASE };
  await assert.rejects(getRegistrationProfile(client, 'valid-token-123'), asCode('disabled'));
  await assert.rejects(getInfluencerSubscriptionStatus(client, 'u1'), asCode('disabled'));
  await assert.rejects(getCampaignStatus(client, 'c1'), asCode('disabled'));
});

test('registration profile returns normalized fields + Bearer auth', async () => {
  const mock = installFetchMock(url => {
    assert.match(url, /\/api\/registration\/profile\?token=/);
    return jsonRes(200, {
      ok: true,
      username: 'creator_handle',
      followers: 4200,
      instagram_user_id: 'ig_123',
      editable: false
    });
  });
  try {
    const out = await getRegistrationProfile(clientFor(), 'valid-token-123');
    assert.deepEqual(out, {
      username: 'creator_handle',
      followers: 4200,
      instagramUserId: 'ig_123',
      editable: false
    });
    assert.equal(mock.seen.length, 1);
    assert.equal(mock.seen[0].auth, 'Bearer TEST_ONLY_voice_token');
  } finally {
    mock.restore();
  }
});

test('registration profile rejects malformed tokens without network use', async () => {
  const mock = installFetchMock(() => jsonRes(200, { ok: true }));
  try {
    await assert.rejects(getRegistrationProfile(clientFor(), 'short'), asCode('invalid_token'));
    await assert.rejects(
      getRegistrationProfile(clientFor(), 'has space in it'),
      asCode('invalid_token')
    );
    assert.equal(mock.seen.length, 0);
  } finally {
    mock.restore();
  }
});

test('registration profile maps HTTP errors and bad shapes', async () => {
  const gone = installFetchMock(() => jsonRes(410, { error: 'gone' }));
  try {
    await assert.rejects(
      getRegistrationProfile(clientFor(), 'valid-token-123'),
      asCode('http_410')
    );
  } finally {
    gone.restore();
  }

  const bad = installFetchMock(() => jsonRes(200, { ok: true, username: 'x' }));
  try {
    await assert.rejects(
      getRegistrationProfile(clientFor(), 'valid-token-123'),
      asCode('invalid_response')
    );
  } finally {
    bad.restore();
  }
});

test('backend timeout surfaces as timeout error', async () => {
  const slow = installFetchMock(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        if (init.signal?.aborted) return reject(timeoutRejection());
        init.signal?.addEventListener('abort', () => reject(timeoutRejection()), { once: true });
      })
  );
  try {
    const client = clientFor({ timeoutMs: 30 });
    await assert.rejects(getRegistrationProfile(client, 'valid-token-123'), asCode('timeout'));
  } finally {
    slow.restore();
  }
});

test('subscription status requires ok:true payload', async () => {
  const okMock = installFetchMock(url => {
    assert.match(url, /subscription-status\?instagram_user_id=ig_1/);
    return jsonRes(200, { ok: true, verification_status: 'UNDER_REVIEW' });
  });
  try {
    const out = await getInfluencerSubscriptionStatus(clientFor(), 'ig_1');
    assert.equal(out.verification_status, 'UNDER_REVIEW');
  } finally {
    okMock.restore();
  }

  const bad = installFetchMock(() => jsonRes(200, { ok: false }));
  try {
    await assert.rejects(
      getInfluencerSubscriptionStatus(clientFor(), 'ig_1'),
      asCode('invalid_response')
    );
    await assert.rejects(getInfluencerSubscriptionStatus(clientFor(), ''), asCode('invalid_id'));
  } finally {
    bad.restore();
  }
});

test('campaign status passes through ok payloads', async () => {
  const mock = installFetchMock(() =>
    jsonRes(200, { ok: true, status: 'AWAITING_PAYMENT' })
  );
  try {
    const out = await getCampaignStatus(clientFor(), 'CAM-1');
    assert.equal(out.status, 'AWAITING_PAYMENT');
    await assert.rejects(getCampaignStatus(clientFor(), ''), asCode('invalid_id'));
  } finally {
    mock.restore();
  }
});

test('follower eligibility honors the 3500 threshold', () => {
  assert.deepEqual(followerEligibility(3499), {
    eligible: false,
    followers: 3499,
    minFollowers: 3500
  });
  assert.deepEqual(followerEligibility(3500), {
    eligible: true,
    followers: 3500,
    minFollowers: 3500
  });
  assert.deepEqual(followerEligibility(0), { eligible: false, followers: 0, minFollowers: 3500 });
  assert.throws(() => followerEligibility('many'), asCode('invalid_input'));
});

test('createVoiceSession posts purpose, username, and allowlisted details', async () => {
  const mock = installFetchMock((url, init) => {
    assert.match(url, /\/api\/voice\/registration-session$/);
    assert.equal(init.method, 'POST');
    const payload = JSON.parse(init.body);
    assert.deepEqual(payload, {
      purpose: 'influencer',
      instagram_username: 'priya.creates',
      details: { full_name: 'Priya', city: 'Mumbai', campaign_title: 'Launch', target_location: 'Goa' }
    });
    return jsonRes(200, {
      ok: true,
      session_id: 'vs_1',
      link_code: 'K7P-2MD',
      expires_at: '2030-01-01T00:00:00.000Z'
    });
  });
  try {
    const out = await createVoiceSession(clientFor(), {
      purpose: 'influencer',
      instagramUsername: 'priya.creates',
      details: { full_name: 'Priya', city: 'Mumbai', campaign_title: 'Launch', target_location: 'Goa', password: 'drop-me', x: 'y' }
    });
    assert.deepEqual(out, {
      sessionId: 'vs_1',
      linkCode: 'K7P-2MD',
      expiresAt: '2030-01-01T00:00:00.000Z'
    });
    assert.equal(mock.seen[0].auth, 'Bearer TEST_ONLY_voice_token');
  } finally {
    mock.restore();
  }
});

test('createVoiceSession validates input and backend responses', async () => {
  const mock = installFetchMock(() => jsonRes(200, { ok: true }));
  try {
    await assert.rejects(
      createVoiceSession(clientFor(), { purpose: 'other', details: {} }),
      asCode('invalid_input')
    );
    await assert.rejects(
      createVoiceSession(clientFor(), { purpose: 'vendor', instagramUsername: 'bad name!' }),
      asCode('invalid_input')
    );
    await assert.rejects(
      createVoiceSession({ enabled: false, baseUrl: BASE }, { purpose: 'vendor' }),
      asCode('disabled')
    );
    await assert.rejects(
      createVoiceSession(clientFor(), { purpose: 'vendor' }),
      asCode('invalid_response')
    );
    assert.equal(mock.seen.length, 1);
  } finally {
    mock.restore();
  }
});

test('createVoiceSession maps auth and rate-limit failures', async () => {
  const denied = installFetchMock(() => jsonRes(401, { error: 'unauthorized' }));
  try {
    await assert.rejects(
      createVoiceSession(clientFor(), { purpose: 'vendor' }),
      asCode('unauthorized')
    );
  } finally {
    denied.restore();
  }
  const limited = installFetchMock(() => jsonRes(429, { error: 'slow down' }));
  try {
    await assert.rejects(
      createVoiceSession(clientFor(), { purpose: 'vendor' }),
      asCode('rate_limited')
    );
  } finally {
    limited.restore();
  }
});

test('voice session status returns redemption state only', async () => {
  const mock = installFetchMock(url => {
    assert.match(url, /\/api\/voice\/registration-session\/status\?session_id=sess_1/);
    return jsonRes(200, { ok: true, used: true, expired: false, purpose: 'influencer' });
  });
  try {
    const out = await getVoiceSessionStatus(clientFor(), 'sess_1');
    assert.deepEqual(out, { used: true, expired: false, purpose: 'influencer' });
  } finally {
    mock.restore();
  }

  const bad = installFetchMock(() => jsonRes(200, { ok: true }));
  try {
    await assert.rejects(getVoiceSessionStatus(clientFor(), 'sess_1'), asCode('invalid_response'));
    await assert.rejects(getVoiceSessionStatus(clientFor(), ''), asCode('invalid_id'));
  } finally {
    bad.restore();
  }
});

test('redactUrl strips tokens from loggable URLs', () => {
  assert.equal(
    redactUrl('https://worker.example/api/registration/profile?token=secret123'),
    'https://worker.example/api/registration/profile?…'
  );
  assert.equal(redactUrl('https://worker.example/healthz'), 'https://worker.example/healthz');
});
