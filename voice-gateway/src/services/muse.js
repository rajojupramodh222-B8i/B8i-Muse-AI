import { buildMuseKnowledgeBlock } from './knowledge.js';

const BASE_SYSTEM = `You are B8i's phone registration assistant. Speak naturally and politely, usually in 1-3 short sentences, and ask exactly one question at a time. First identify what the caller wants: influencer registration, vendor registration, campaign information, or account support. Then follow only that workflow and collect only the details it needs. For influencer registration, collect the Instagram handle first, then the profile details the workflow needs, such as name, contact, city, and niche. Follower-count guidance and eligibility are checked against B8i's backend, and when they cannot be verified you must say verification is still required. For vendor registration, collect the business details the workflow needs, such as business name, contact, and city, and offer campaign requirements as a separate explicit step. Confirm important details such as handles, numbers, and names by repeating them back before they are used. Never claim a link was created, a message was sent, a form was submitted, a payment was verified, or an account was approved unless the confirmed result says so. Never ask for passwords, UPI PINs, card details, or one-time codes. For sensitive actions, direct the caller to the secure registration link. Never state a fee, price, or policy number unless it appears in the verified B8i facts below; if it is missing, say you cannot confirm the detail and direct the caller to B8i customer support. For payments, failed transactions, refunds, and billing disputes, explain you cannot check or change any payment, describe only the normal process, and route the caller to support. If you do not know, say so clearly.`;

/**
 * System prompt with live B8i facts. Pass the validated knowledge payload
 * from GET /api/b8i/knowledge when available; otherwise the prompt fails
 * closed and forbids stating any fee or policy number.
 */
export function buildSystemPrompt(knowledge = null) {
  return `${BASE_SYSTEM}\n\n${buildMuseKnowledgeBlock(knowledge)}`;
}

export async function answerWithMuse(messages, opts = {}) {
  const key = process.env.META_MODEL_API_KEY;
  if (!key) throw new Error('META_MODEL_API_KEY is not configured');

  const base = (process.env.META_BASE_URL || 'https://api.meta.ai')
    .replace(/\/+$/, '');

  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.META_MODEL_NAME || 'muse-spark-1.3',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system: buildSystemPrompt(opts.knowledge ?? null),
      messages
    }),
    signal: AbortSignal.timeout(25000)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Meta Model API HTTP ${response.status}: ${JSON.stringify(data).slice(0, 400)}`
    );
  }

  const text = Array.isArray(data.content)
    ? data.content
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n')
        .trim()
    : '';

  if (!text) {
    throw new Error(
      `Meta returned no text; stop_reason=${data.stop_reason || 'unknown'}`
    );
  }

  return text.slice(0, 1800);
}
