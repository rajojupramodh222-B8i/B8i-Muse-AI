/**
 * Versioned B8i knowledge shared by the Instagram chatbot and the voice gateway.
 *
 * The Cloudflare Worker owns the canonical facts and serves them at
 * GET /api/b8i/knowledge (see B8I_KNOWLEDGE_VERSION in worker.js). This module
 * validates, caches, and renders that payload for voice. It never invents
 * prices, limits, or support details: when a fact is absent the renderers say
 * so and route to the configured support channel.
 */

export const KNOWLEDGE_VERSION = 1;
export const KNOWLEDGE_PATH = '/api/b8i/knowledge';
export const DEFAULT_KNOWLEDGE_TTL_MS = 5 * 60 * 1000;

const isRecord = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function isPlan(p) {
  return (
    isRecord(p) &&
    typeof p.key === 'string' && p.key &&
    typeof p.name === 'string' && p.name &&
    typeof p.amount === 'number' && Number.isFinite(p.amount) && p.amount > 0 &&
    typeof p.currency === 'string' && p.currency &&
    typeof p.interval === 'string' && p.interval &&
    (p.request_limit === null || (typeof p.request_limit === 'number' && Number.isFinite(p.request_limit))) &&
    typeof p.description === 'string'
  );
}

/**
 * Strict shape check for the Worker knowledge payload. Unknown extra fields
 * are ignored; missing or mistyped required fields fail closed.
 * Returns { ok: true, knowledge } or { ok: false, error }.
 */
export function validateKnowledge(data) {
  if (!isRecord(data) || data.ok !== true) return { ok: false, error: 'bad envelope' };
  if (data.version !== KNOWLEDGE_VERSION) return { ok: false, error: 'unsupported version' };
  if (typeof data.updated_at !== 'string' || !data.updated_at) return { ok: false, error: 'bad updated_at' };

  const plans = data.influencer_membership?.plans;
  if (!Array.isArray(plans) || !plans.length || plans.length > 10 || !plans.every(isPlan)) {
    return { ok: false, error: 'bad plans' };
  }

  const vendor = data.vendor_campaigns;
  if (
    !isRecord(vendor) ||
    typeof vendor.platform_fee_percent !== 'number' || !Number.isFinite(vendor.platform_fee_percent) ||
    typeof vendor.min_creator_payout !== 'number' || !Number.isFinite(vendor.min_creator_payout) ||
    typeof vendor.currency !== 'string' || !vendor.currency ||
    !Array.isArray(vendor.product_for_post_tiers) || !vendor.product_for_post_tiers.length ||
    !vendor.product_for_post_tiers.every(t => isRecord(t) && Number.isFinite(Number(t.per_creator)))
  ) {
    return { ok: false, error: 'bad vendor_campaigns' };
  }

  if (!isRecord(data.eligibility) || !Number.isFinite(Number(data.eligibility.min_followers))) {
    return { ok: false, error: 'bad eligibility' };
  }
  if (!isRecord(data.support) || typeof data.support.text !== 'string' || !data.support.text) {
    return { ok: false, error: 'bad support' };
  }
  if (
    data.support.phone !== null && data.support.phone !== undefined &&
    typeof data.support.phone !== 'string'
  ) {
    return { ok: false, error: 'bad support phone' };
  }
  if (
    !isRecord(data.payments) ||
    typeof data.payments.provider !== 'string' || !data.payments.provider ||
    typeof data.payments.refund_policy !== 'string' || !data.payments.refund_policy ||
    typeof data.payments.escalation !== 'string' || !data.payments.escalation
  ) {
    return { ok: false, error: 'bad payments' };
  }
  if (!isRecord(data.marketplace) || typeof data.marketplace.summary !== 'string' || !data.marketplace.summary) {
    return { ok: false, error: 'bad marketplace' };
  }
  if (!isRecord(data.registration)) return { ok: false, error: 'bad registration' };
  if (!Array.isArray(data.content_niches)) return { ok: false, error: 'bad niches' };
  if (
    !isRecord(data.details) ||
    typeof data.details.membership_benefits !== 'string' || !data.details.membership_benefits ||
    typeof data.details.renewal !== 'string' || !data.details.renewal ||
    typeof data.details.cancellation !== 'string' || !data.details.cancellation ||
    typeof data.details.campaign_deliverables !== 'string' || !data.details.campaign_deliverables ||
    typeof data.details.payment_status !== 'string' || !data.details.payment_status ||
    typeof data.details.troubleshooting !== 'string' || !data.details.troubleshooting ||
    !Array.isArray(data.details.faqs) || !data.details.faqs.length ||
    !data.details.faqs.every(f => isRecord(f) && typeof f.q === 'string' && f.q && typeof f.a === 'string' && f.a)
  ) {
    return { ok: false, error: 'bad details' };
  }
  if (typeof data.fallback !== 'string' || !data.fallback) return { ok: false, error: 'bad fallback' };

  return { ok: true, knowledge: data };
}

const inr = n => `\u20B9${Number(n).toLocaleString('en-IN')}`;
const num = n => Number(n).toLocaleString('en-IN');

function planLine(p) {
  const quota = p.request_limit === null ? 'unlimited campaign requests' : `${p.request_limit} campaign requests`;
  return `${p.name} ${inr(p.amount)}/${p.interval} \u2014 ${quota}`;
}

/** One line the assistant can speak when asked how to reach support. */
export function supportContactLine(knowledge) {
  if (!isRecord(knowledge) || !isRecord(knowledge.support)) {
    return 'Please contact B8i customer support for help with this.';
  }
  const phone = typeof knowledge.support.phone === 'string' ? knowledge.support.phone.trim() : '';
  if (phone) return `Please contact B8i customer support at ${phone}.`;
  return String(knowledge.support.text || 'Please contact B8i customer support for help with this.');
}

/**
 * Short spoken answer for a common business topic. Returns null when the
 * topic is not covered, so the caller falls back to the model or support.
 * Topics: plans, vendor_fee, product_for_post, eligibility, registration,
 * payments, refunds, support, marketplace, niches.
 */
export function answerFromKnowledge(knowledge, topic) {
  const v = validateKnowledge(knowledge);
  if (!v.ok) return null;
  const k = v.knowledge;
  switch (String(topic)) {
    case 'plans':
      return (
        `B8i creator memberships, for influencers: ${k.influencer_membership.plans.map(planLine).join(' ')} ` +
        'These are influencer memberships, not vendor charges.'
      );
    case 'vendor_fee':
      return (
        `Vendors pay per campaign: an ${k.vendor_campaigns.platform_fee_percent}% platform fee ` +
        `on the creator budget, with a minimum creator payout of ${inr(k.vendor_campaigns.min_creator_payout)} per influencer.`
      );
    case 'product_for_post': {
      const tiers = k.vendor_campaigns.product_for_post_tiers
        .map(t => `${t.label || `${t.max_creators} creators`}: ${inr(t.per_creator)} each`)
        .join('; ');
      return `Product-for-post campaigns carry no cash payout. The B8i activation fee per creator is ${tiers}.`;
    }
    case 'eligibility':
      return (
        `The creator guideline is ${num(k.eligibility.min_followers)} followers minimum. ` +
        `${k.eligibility.guideline || 'Admin review decides approval.'}`
      );
    case 'registration': {
      const r = k.registration;
      const parts = [];
      if (r.influencer) parts.push(`Influencers: ${r.influencer}`);
      if (r.vendor) parts.push(`Vendors: ${r.vendor}`);
      if (r.verification) parts.push(r.verification);
      return parts.join(' ') || null;
    }
    case 'payments':
      return (
        `Campaign and membership payments go through ${k.payments.provider}. ` +
        `I can't check or change any payment myself. ${k.payments.escalation}`
      );
    case 'refunds':
      return `${k.payments.refund_policy} ${k.payments.escalation}`;
    case 'support':
      return supportContactLine(k);
    case 'marketplace':
      return k.marketplace.summary;
    case 'niches':
      return k.content_niches.length
        ? `Content niches on B8i include ${k.content_niches.join(', ')}.`
        : null;
    case 'membership':
      return `${k.details.membership_benefits} ${k.details.renewal} ${k.details.cancellation}`;
    case 'campaigns':
      return k.details.campaign_deliverables;
    case 'troubleshooting':
      return k.details.troubleshooting;
    default:
      return null;
  }
}

/**
 * Verified-facts block appended to the voice system prompt. When knowledge is
 * missing or invalid the block forbids stating any fee or policy number.
 */
export function buildMuseKnowledgeBlock(knowledge) {
  const v = knowledge ? validateKnowledge(knowledge) : { ok: false };
  if (!v.ok) {
    return (
      'Live B8i facts are unavailable right now. Do not state any fee, price, ' +
      'follower threshold, request limit, or policy number. Say verification is ' +
      'still required, or that you cannot confirm the detail, and direct payment ' +
      'or billing questions to B8i customer support.'
    );
  }
  const k = v.knowledge;
  const tiers = k.vendor_campaigns.product_for_post_tiers
    .map(t => `${t.label || `${t.max_creators} creators`}: ${inr(t.per_creator)} each`)
    .join('; ');
  return (
    `Verified B8i facts (knowledge v${k.version}, updated ${k.updated_at}). ` +
    'Use these exact figures; never invent fees, limits, or support details.\n' +
    `- What B8i is: ${k.marketplace.summary}\n` +
    `- Creator memberships (influencers only): ${k.influencer_membership.plans.map(planLine).join(' ')} ` +
    `${(k.influencer_membership.notes || []).join(' ')}\n` +
    `- Vendors pay per campaign: ${k.vendor_campaigns.platform_fee_percent}% platform fee on the creator budget; ` +
    `minimum creator payout ${inr(k.vendor_campaigns.min_creator_payout)} per influencer. ` +
    `Product-for-post/barter: no cash payout; activation fee per creator (${tiers}).\n` +
    `- Creator eligibility guideline: ${num(k.eligibility.min_followers)} followers minimum. ` +
    `${k.eligibility.guideline || ''} Admin review decides; when eligibility cannot be verified say verification is still required.\n` +
    `- Registration: ${k.registration.influencer || ''} ${k.registration.vendor || ''} ${k.registration.verification || ''}\n` +
    `- Payments go through ${k.payments.provider}. ${k.payments.refund_policy} ` +
    'You cannot check, change, approve, or resolve any payment; describe only the normal process.\n' +
    `- Support: ${k.support.text} ${k.payments.escalation}\n` +
    `- Membership: ${k.details.membership_benefits} ${k.details.renewal} ${k.details.cancellation}\n` +
    `- Campaign deliverables: ${k.details.campaign_deliverables}\n` +
    `- Payment status: ${k.details.payment_status}\n` +
    `- Troubleshooting: ${k.details.troubleshooting}\n` +
    'If asked about a fee or policy not listed here, say you cannot confirm the detail and direct the caller to B8i customer support.'
  );
}

/** Tiny TTL cache so a call fetches knowledge once. load() must return validated knowledge. */
export function createKnowledgeCache({ load, ttlMs = DEFAULT_KNOWLEDGE_TTL_MS } = {}) {
  if (typeof load !== 'function') throw new Error('knowledge cache needs a load function');
  let cached = null;
  let expiresAt = 0;
  let inflight = null;
  return {
    async get(force = false) {
      const now = Date.now();
      if (!force && cached && now < expiresAt) return cached;
      if (inflight) return inflight;
      inflight = load()
        .then(value => {
          if (value) {
            cached = value;
            expiresAt = Date.now() + ttlMs;
          }
          return value;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    peek() {
      return cached && Date.now() < expiresAt ? cached : null;
    },
    clear() {
      cached = null;
      expiresAt = 0;
    }
  };
}
