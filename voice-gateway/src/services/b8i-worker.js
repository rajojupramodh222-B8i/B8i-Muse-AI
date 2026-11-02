import { KNOWLEDGE_PATH, validateKnowledge } from './knowledge.js';

/**
 * B8i backend HTTP client (server-side only).
 *
 * Thin, read-only bridge from the voice gateway to the existing B8i
 * Cloudflare Worker. It reuses the worker's real routes and never invents
 * endpoints:
 *
 * - GET /api/registration/profile?token=
 * - GET /api/influencer/subscription-status?instagram_user_id=
 * - GET /api/campaign/status?campaign_id=
 * - GET /api/b8i/knowledge
 *
 * Safety rules:
 * - All calls are disabled unless B8I_VOICE_ENABLED=true (default off).
 * - Base URL must be https, except localhost / 127.0.0.1 / *.test (tests).
 * - Secrets and personal details are never logged. Log redactUrl() only.
 * - Backend responses are strictly validated before use.
 * - A returned follower count is informational; the worker's approval gate
 *   (B8I_MIN_INFLUENCER_FOLLOWERS) stays authoritative.
 */

export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_MIN_FOLLOWERS = 3500;

export class B8iWorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'B8iWorkerError';
    this.code = code;
  }
}

export function isVoiceIntegrationEnabled(env = process.env) {
  return String(env.B8I_VOICE_ENABLED || '').toLowerCase() === 'true';
}

function cleanBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) throw new B8iWorkerError('not_configured', 'B8I_WORKER_URL is not set');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new B8iWorkerError('invalid_base_url', 'B8I_WORKER_URL is not a valid URL');
  }
  const host = parsed.hostname.toLowerCase();
  const isLocal =
    parsed.protocol === 'http:' &&
    (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.test'));
  if (parsed.protocol !== 'https:' && !isLocal) {
    throw new B8iWorkerError('invalid_base_url', 'B8I_WORKER_URL must use https');
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
}

export function workerConfigFromEnv(env = process.env) {
  const timeoutRaw = Number(env.B8I_WORKER_TIMEOUT_MS);
  return {
    enabled: isVoiceIntegrationEnabled(env),
    baseUrl: cleanBaseUrl(env.B8I_WORKER_URL),
    token: String(env.B8I_VOICE_API_TOKEN || ''),
    timeoutMs:
      Number.isFinite(timeoutRaw) && timeoutRaw > 0 && timeoutRaw <= 30000
        ? timeoutRaw
        : DEFAULT_TIMEOUT_MS
  };
}

/** Strip query strings (which may carry tokens) before any logging. */
export function redactUrl(url) {
  const s = String(url || '');
  const q = s.indexOf('?');
  const h = s.indexOf('#');
  const cut = q >= 0 ? q : h >= 0 ? h : -1;
  return cut >= 0 ? `${s.slice(0, cut)}?…` : s;
}

function safeDetail(value) {
  return String(value ?? '').slice(0, 120);
}

async function workerGet(client, path, params) {
  if (!client || client.enabled !== true) {
    throw new B8iWorkerError('disabled', 'B8i voice integration is disabled');
  }
  if (!client.baseUrl) throw new B8iWorkerError('not_configured', 'B8I worker client has no baseUrl');

  const url = new URL(path, `${client.baseUrl}/`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));

  const headers = { accept: 'application/json' };
  if (client.token) headers.authorization = `Bearer ${client.token}`;

  const timeoutMs = client.timeoutMs || DEFAULT_TIMEOUT_MS;
  let res;
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') {
      throw new B8iWorkerError('timeout', `B8i backend timed out after ${timeoutMs}ms`);
    }
    throw new B8iWorkerError('network', `B8i backend unreachable: ${safeDetail(err?.message)}`);
  }

  if (!res.ok) {
    throw new B8iWorkerError(`http_${res.status}`, `B8i backend returned HTTP ${res.status}`);
  }

  try {
    return await res.json();
  } catch {
    throw new B8iWorkerError('invalid_response', 'B8i backend returned invalid JSON');
  }
}

async function workerPost(client, path, payload) {
  if (!client || client.enabled !== true) {
    throw new B8iWorkerError('disabled', 'B8i voice integration is disabled');
  }
  if (!client.baseUrl) throw new B8iWorkerError('not_configured', 'B8i worker client has no baseUrl');
  if (!client.token) throw new B8iWorkerError('not_configured', 'B8I voice token is not set');

  const url = new URL(path, `${client.baseUrl}/`);
  const timeoutMs = client.timeoutMs || DEFAULT_TIMEOUT_MS;
  let res;
  try {
    res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${client.token}`
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') {
      throw new B8iWorkerError('timeout', `B8i backend timed out after ${timeoutMs}ms`);
    }
    throw new B8iWorkerError('network', `B8i backend unreachable: ${safeDetail(err?.message)}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new B8iWorkerError('unauthorized', 'B8i backend rejected the voice credentials');
  }
  if (res.status === 429) {
    throw new B8iWorkerError('rate_limited', 'B8i backend rate limit reached, retry later');
  }
  if (!res.ok) {
    throw new B8iWorkerError(`http_${res.status}`, `B8i backend returned HTTP ${res.status}`);
  }

  try {
    return await res.json();
  } catch {
    throw new B8iWorkerError('invalid_response', 'B8i backend returned invalid JSON');
  }
}

const isRecord = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Prefill lookup. Returns { username, followers, instagramUserId, editable }.
 * Throws B8iWorkerError on any transport or shape problem.
 */
export async function getRegistrationProfile(client, regToken) {
  const token = String(regToken || '').trim();
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(token)) {
    throw new B8iWorkerError('invalid_token', 'Registration token is malformed');
  }
  const data = await workerGet(client, '/api/registration/profile', { token });
  if (
    !isRecord(data) ||
    data.ok !== true ||
    typeof data.username !== 'string' ||
    !data.username ||
    !Number.isFinite(Number(data.followers)) ||
    typeof data.instagram_user_id !== 'string' ||
    !data.instagram_user_id
  ) {
    throw new B8iWorkerError('invalid_response', 'Registration profile has an unexpected shape');
  }
  return {
    username: data.username,
    followers: Number(data.followers),
    instagramUserId: data.instagram_user_id,
    editable: data.editable === true
  };
}

/**
 * Subscription / verification / admin-review status for an influencer.
 * Returns the worker payload after a minimal shape check.
 */
export async function getInfluencerSubscriptionStatus(client, instagramUserId) {
  const id = String(instagramUserId || '').trim();
  if (!id || id.length > 128) {
    throw new B8iWorkerError('invalid_id', 'Instagram user id is malformed');
  }
  const data = await workerGet(client, '/api/influencer/subscription-status', {
    instagram_user_id: id
  });
  if (!isRecord(data) || data.ok !== true) {
    throw new B8iWorkerError('invalid_response', 'Subscription status has an unexpected shape');
  }
  return data;
}

/**
 * Public campaign status for a vendor's campaign.
 */
export async function getCampaignStatus(client, campaignId) {
  const id = String(campaignId || '').trim();
  if (!id || id.length > 128) {
    throw new B8iWorkerError('invalid_id', 'Campaign id is malformed');
  }
  const data = await workerGet(client, '/api/campaign/status', { campaign_id: id });
  if (!isRecord(data) || data.ok !== true) {
    throw new B8iWorkerError('invalid_response', 'Campaign status has an unexpected shape');
  }
  return data;
}

/**
 * Versioned B8i knowledge: the same canonical facts the Instagram chatbot
 * answers from (plans, fees, eligibility, support). Prices and limits always
 * come from this endpoint; they are never hard-coded in voice prompts.
 * Throws B8iWorkerError on any transport or shape problem.
 */
export async function getB8iKnowledge(client) {
  const data = await workerGet(client, KNOWLEDGE_PATH, {});
  const checked = validateKnowledge(data);
  if (!checked.ok) {
    throw new B8iWorkerError('invalid_response', `B8i knowledge has an unexpected shape (${checked.error})`);
  }
  return checked.knowledge;
}

const VOICE_DETAIL_KEYS = new Set([
  'full_name',
  'phone',
  'city',
  'state',
  'country',
  'niche',
  'business_name',
  'contact_name',
  'campaign_title',
  'target_location'
]);

const VOICE_PHONE_RE = /^[+\d][\d\s-]{5,18}\d$/;

function cleanVoiceDetailValue(key, value) {
  const s = String(value ?? '').trim().slice(0, 120);
  if (!s) return '';
  if (key === 'phone') {
    const digits = s.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15 || !VOICE_PHONE_RE.test(s)) return '';
    return s;
  }
  return s;
}

/**
 * Create a voice registration session in the worker.
 *
 * The worker stores the consented details under a speakable LINK code. The
 * caller redeems the code from their own Instagram account, which is the only
 * supported way to bind voice-collected details to a verified IG identity.
 * The claimed username is carried as an unverified hint only.
 *
 * Pass a stable clientRequestId per consent round: the worker returns the
 * same session when a retry replays it, so at-most-once creation holds even
 * when the first response was lost.
 *
 * Returns { sessionId, linkCode, expiresAt }.
 */
export async function createVoiceSession(client, { purpose, instagramUsername, details, clientRequestId }) {
  if (purpose !== 'influencer' && purpose !== 'vendor') {
    throw new B8iWorkerError('invalid_input', 'Voice session purpose must be influencer or vendor');
  }
  const username = String(instagramUsername || '').trim();
  if (username && !/^[A-Za-z0-9._]{1,30}$/.test(username)) {
    throw new B8iWorkerError('invalid_input', 'Instagram username is malformed');
  }
  const cleanDetails = {};
  if (isRecord(details)) {
    for (const [k, v] of Object.entries(details)) {
      if (!VOICE_DETAIL_KEYS.has(k)) continue;
      const s = cleanVoiceDetailValue(k, v);
      if (s) cleanDetails[k] = s;
    }
  }
  const payload = {
    purpose,
    instagram_username: username || null,
    details: cleanDetails
  };
  const requestId = String(clientRequestId || '').trim();
  if (requestId) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) {
      throw new B8iWorkerError('invalid_input', 'Client request id is malformed');
    }
    payload.client_request_id = requestId;
  }
  const data = await workerPost(client, '/api/voice/registration-session', payload);
  if (
    !isRecord(data) ||
    data.ok !== true ||
    typeof data.session_id !== 'string' ||
    !data.session_id ||
    typeof data.link_code !== 'string' ||
    !/^[A-Z2-9-]{4,12}$/.test(data.link_code) ||
    typeof data.expires_at !== 'string' ||
    !data.expires_at
  ) {
    throw new B8iWorkerError('invalid_response', 'Voice session has an unexpected shape');
  }
  return { sessionId: data.session_id, linkCode: data.link_code, expiresAt: data.expires_at };
}

/**
 * Redemption state for a spoken LINK code. The worker returns state only
 * (used / expired / purpose) — no personal details cross this call.
 */
export async function getVoiceSessionStatus(client, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id || id.length > 256) {
    throw new B8iWorkerError('invalid_id', 'Voice session id is malformed');
  }
  const data = await workerGet(client, '/api/voice/registration-session/status', {
    session_id: id
  });
  if (!isRecord(data) || data.ok !== true || typeof data.used !== 'boolean') {
    throw new B8iWorkerError('invalid_response', 'Voice session status has an unexpected shape');
  }
  return {
    used: data.used,
    expired: data.expired === true,
    purpose: typeof data.purpose === 'string' ? data.purpose : null
  };
}

/**
 * Pure eligibility helper for the spoken guideline check.
 * The worker's approval gate stays authoritative; this never approves.
 */
export function followerEligibility(followers, minFollowers = DEFAULT_MIN_FOLLOWERS) {
  const count = Number(followers);
  const min = Number(minFollowers);
  if (!Number.isFinite(count) || !Number.isFinite(min)) {
    throw new B8iWorkerError('invalid_input', 'Follower inputs must be numbers');
  }
  return { eligible: count >= min, followers: count, minFollowers: min };
}

const VOICE_QUEUE_MAX_ITEMS = 10;
const VOICE_QUEUE_MAX_TEXT = 2000;

function cleanQueueSessionId(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id || id.length > 256) {
    throw new B8iWorkerError('invalid_id', 'Voice session id is malformed');
  }
  return id;
}

function validateQueueItem(item) {
  if (
    !isRecord(item) ||
    typeof item.id !== 'string' ||
    !item.id ||
    item.id.length > 128 ||
    typeof item.text !== 'string' ||
    !item.text ||
    item.text.length > VOICE_QUEUE_MAX_TEXT
  ) {
    throw new B8iWorkerError('invalid_response', 'Voice queue item has an unexpected shape');
  }
  return {
    id: item.id,
    text: item.text,
    at: typeof item.at === 'string' ? item.at : null,
    expiresAt: typeof item.expires_at === 'string' ? item.expires_at : null,
    leaseExpiresAt: typeof item.lease_expires_at === 'string' ? item.lease_expires_at : null
  };
}

/**
 * Claim speakable Instagram replies for a linked voice call.
 *
 * The worker returns items only when the voice session is bound to a
 * verified, unexpired, unrevoked Instagram link (LINK-code redemption).
 * Otherwise it returns { linked: false, items: [] } and the call continues
 * Muse-only. Items carry 60s claim leases: a crashed claim is redelivered
 * with the SAME id, so the caller must deduplicate by id and ack only
 * after the reply has been spoken.
 *
 * Returns { linked, sessionId, items[], context|null }. Throws
 * B8iWorkerError on transport/shape problems; 'http_503' covers the
 * worker kill-switch (B8I_VOICE_ENABLED=false).
 */
export async function claimVoiceQueue(client, sessionId, max) {
  const id = cleanQueueSessionId(sessionId);
  const count = max === undefined ? VOICE_QUEUE_MAX_ITEMS : max;
  if (!Number.isInteger(count) || count < 1 || count > VOICE_QUEUE_MAX_ITEMS) {
    throw new B8iWorkerError('invalid_input', 'Voice queue claim max must be 1-10');
  }
  const data = await workerPost(client, '/api/voice/ig-queue/claim', { session_id: id, max: count });
  if (
    !isRecord(data) ||
    data.ok !== true ||
    typeof data.linked !== 'boolean' ||
    !Array.isArray(data.items)
  ) {
    throw new B8iWorkerError('invalid_response', 'Voice queue claim has an unexpected shape');
  }
  const items = data.items.slice(0, VOICE_QUEUE_MAX_ITEMS).map(validateQueueItem);
  let context = null;
  if (data.context !== null && data.context !== undefined) {
    if (!isRecord(data.context) || !Array.isArray(data.context.recent)) {
      throw new B8iWorkerError('invalid_response', 'Voice queue context has an unexpected shape');
    }
    context = {
      purpose: typeof data.context.purpose === 'string' ? data.context.purpose : null,
      linkExpiresAt: typeof data.context.link_expires_at === 'string' ? data.context.link_expires_at : null,
      summary: typeof data.context.summary === 'string' ? data.context.summary.slice(0, 2000) : '',
      recent: data.context.recent.slice(0, 20).map(entry => ({
        src: entry?.src === 'ig_in' || entry?.src === 'ig_out' ? entry.src : 'unknown',
        at: typeof entry?.at === 'string' ? entry.at : null,
        text: String(entry?.text || '').slice(0, 2000)
      }))
    };
  }
  return {
    linked: data.linked,
    sessionId: typeof data.session_id === 'string' ? data.session_id : id,
    items,
    context
  };
}

/**
 * Acknowledge spoken queue items so they are never redelivered. Ack is
 * idempotent server-side; unknown or foreign ids are ignored (acked: 0).
 * Returns { linked, acked }.
 */
export async function ackVoiceQueue(client, sessionId, ids) {
  const id = cleanQueueSessionId(sessionId);
  if (!Array.isArray(ids) || !ids.length || ids.length > VOICE_QUEUE_MAX_ITEMS) {
    throw new B8iWorkerError('invalid_input', 'Voice queue ack needs 1-10 item ids');
  }
  const cleanIds = ids
    .map(value => String(value || '').trim())
    .filter(value => value && value.length <= 128 && /^[A-Za-z0-9:_-]+$/.test(value));
  if (!cleanIds.length) {
    throw new B8iWorkerError('invalid_input', 'Voice queue ack ids are malformed');
  }
  const data = await workerPost(client, '/api/voice/ig-queue/ack', { session_id: id, ids: cleanIds });
  if (
    !isRecord(data) ||
    data.ok !== true ||
    typeof data.linked !== 'boolean' ||
    !Number.isInteger(data.acked)
  ) {
    throw new B8iWorkerError('invalid_response', 'Voice queue ack has an unexpected shape');
  }
  return { linked: data.linked, acked: data.acked };
}
