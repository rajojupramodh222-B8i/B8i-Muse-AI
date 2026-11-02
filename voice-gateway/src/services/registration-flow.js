/**
 * B8i voice registration state machine.
 *
 * Keeps registration deterministic while Muse handles general conversation.
 * Returns { speak } when the flow owns the turn, and null when Muse should
 * answer. Caller-provided Instagram handles are unverified hints until linked
 * from the caller's own Instagram account.
 *
 * Canonical registration fields (see getRegistrationState):
 * role, firstName, lastName, instagramHandle, phoneNumber, city, state,
 * country, niche, consent, registrationCode, registrationStatus,
 * registrationLinkStatus (+ vendor business fields).
 *
 * Safety rules:
 * - Collect one field at a time; ask only for missing or uncertain fields.
 * - Never store a person's full name in the Instagram handle.
 * - Never guess ambiguous handle characters: ask for spelling, then confirm
 *   the exact candidate before accepting it.
 * - Phone numbers are confirmed before use. Provider caller ID is used only
 *   when supplied by the provider and confirmed by the caller.
 * - City, state, and country are stored independently; the country is never
 *   inferred from a city.
 * - Confirmed values are never overwritten with empty or lower-confidence
 *   values; corrections change one field without losing the others.
 * - Never call the backend before explicit consent.
 * - Only describe backend results that were actually returned.
 */

export const INTENTS = Object.freeze({
  INFLUENCER: 'influencer',
  VENDOR: 'vendor',
  CAMPAIGN_INFO: 'campaign_info',
  ACCOUNT_SUPPORT: 'account_support',
  UNKNOWN: 'unknown',
});

const norm = value =>
  String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const hasWord = (text, words) => {
  const normalized = ` ${norm(text)} `;
  return words.some(word => normalized.includes(` ${norm(word)} `));
};

export function detectIntent(text) {
  const t = norm(text);
  if (!t) return INTENTS.UNKNOWN;

  const vendorAction =
    hasWord(t, ['vendor', 'business', 'seller', 'merchant', 'brand', 'shop', 'company', 'store']) ||
    (hasWord(t, ['campaign']) && hasWord(t, ['create', 'start', 'run', 'launch', 'new', 'post']));

  const wantsInfo =
    hasWord(t, ['status', 'track', 'information', 'info', 'about', 'price', 'pricing', 'cost', 'plan']) &&
    hasWord(t, ['campaign']);

  const influencer =
    hasWord(t, ['influencer', 'creator', 'instagram', 'insta', 'reel', 'follower', 'collaboration', 'collaborate']);

  const support =
    hasWord(t, ['support', 'help', 'account', 'login', 'existing', 'refund', 'payment']) &&
    !vendorAction &&
    !influencer;

  if (vendorAction && influencer) return INTENTS.UNKNOWN;
  if (wantsInfo) return INTENTS.CAMPAIGN_INFO;
  if (vendorAction) return INTENTS.VENDOR;
  if (influencer) return INTENTS.INFLUENCER;
  if (support || hasWord(t, ['help'])) return INTENTS.ACCOUNT_SUPPORT;
  return INTENTS.UNKNOWN;
}

const HANDLE_RE = /^[A-Za-z0-9._]{2,30}$/;
const AMBIGUITY_MARKERS = /\b(um+|uh+|er+|like|maybe|perhaps|probably|i think|not sure)\b/i;

function stripHandleLeadIn(raw) {
  return raw
    .replace(/^[\s,.:;!?-]*(?:my)?(?:instagram)?(?:handle|username|usernam)e?(?:is|equals|wouldbe)/i, '')
    .replace(/^[\s,.:;!?-]*(?:my\s*)?(?:instagram\s*)?(?:handle|username|user\s*name)\s*(?:is|equals|would\s*be)?\s*/i, '')
    .replace(/^[\s,.:;!?-]*(?:it\s*is|it's|its|the\s*handle\s*is)\s*/i, '')
    .trim();
}

/** Remove an explicitly spoken leading "at" (@) before a handle candidate. */
function stripLeadingAt(raw) {
  const m = /^(?:at|at the rate|attherate)\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : raw;
}

function spokenSeparatorsToSymbols(raw) {
  return raw
    .replace(/\b(?:under\s*score|underscore|under\s*scored)\b/gi, '_')
    .replace(/\b(?:dot|period|full\s*stop|point)\b/gi, '.')
    .replace(/\b(?:at\s*sign|at\s*symbol)\b/gi, '@');
}

const hadHandleLeadIn = original =>
  /^(?:\s|[\s,.:;!?-])*(?:my\s*)?(?:instagram\s*)?(?:handle|username|user\s*name)\s*(?:is|equals|would\s*be)\b/i.test(original) ||
  /^(?:my)?(?:instagram)?(?:handle|username|usernam)e?(?:is|equals|wouldbe)/i.test(original);

/**
 * Plain personal names read as names, not handles: two or more capitalized
 * words ("Priya Sharma"), or an explicit naming phrase ("my name is ...").
 * Lowercase ambiguous pairs ("priya creates") stay ambiguous so the caller is
 * asked to spell instead of being misread either way.
 */
function looksLikeFullName(raw) {
  const text = String(raw).trim();
  if (/[@_.]/.test(text)) return false;
  if (/\b(?:underscore|under\s*score|dot|period|full\s*stop|point|at\s*sign)\b/i.test(text)) return false;
  if (/\bmy name is\b|\bname is\b|\bi am\b|\bi'm\b|\bthis is\b|\bcalled\b/i.test(text)) {
    const words = text.split(/\s+/).filter(Boolean);
    return words.length >= 2 && words.length <= 8;
  }
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  if (!words.every(w => /^[A-Za-z][A-Za-z.'-]{1,29}$/.test(w))) return false;
  return words.filter(w => /^[A-Z]/.test(w)).length >= 2;
}

/**
 * Analyze a handle utterance without guessing.
 * Returns { handle|null, confidence: 'high'|'low'|'none', reason }.
 * - high: explicit @mention, lead-in + single token, or explicit separators.
 * - low: handle-plausible but ambiguous (inner spaces, invalid characters,
 *   hesitation) — the caller must spell it and confirm the exact candidate.
 * - none: no handle present (names, prose, too short).
 */
export function analyzeHandle(text) {
  const original = String(text ?? '').normalize('NFKC').trim();
  if (!original) return { handle: null, confidence: 'none', reason: 'empty' };

  const withLeadIn = hadHandleLeadIn(original);
  const raw = stripHandleLeadIn(stripLeadingAt(original));
  const signaledHandle = withLeadIn || raw !== original;
  if (!signaledHandle && looksLikeFullName(original)) {
    return { handle: null, confidence: 'none', reason: 'looks_like_name' };
  }

  const mention = raw.match(/@([A-Za-z0-9._]{2,30})/);
  if (mention) return { handle: mention[1], confidence: 'high', reason: 'mention' };

  const converted = spokenSeparatorsToSymbols(raw);
  const hasSpokenPunctuation = converted !== raw;
  let candidate = converted.replace(/[\s,;:!?]+/g, '');
  candidate = candidate.replace(/^@/, '');

  if (HANDLE_RE.test(candidate) && (!/\s/.test(raw) || hasSpokenPunctuation || withLeadIn)) {
    const value = withLeadIn ? candidate.toLowerCase() : candidate;
    if (AMBIGUITY_MARKERS.test(original)) {
      return { handle: value, confidence: 'low', reason: 'hesitation' };
    }
    return { handle: value, confidence: 'high', reason: withLeadIn ? 'lead_in' : hasSpokenPunctuation ? 'spoken_separators' : 'token' };
  }

  // Letter-by-letter dictation ("p r i y a underscore c ...").
  const spellingWords = raw.split(/[\s-]+/).filter(Boolean);
  const looksSpelled =
    spellingWords.length >= 2 &&
    spellingWords.every(word => /^[A-Za-z0-9]$/.test(word) || /^(?:underscore|under\s*score|dot|period|full\s*stop|point)$/i.test(word));
  const spelling = spokenSeparatorsToSymbols(raw)
    .replace(/\b(?:letter|dash)\b/gi, '')
    .replace(/[\s,-]+/g, '');
  if (looksSpelled && HANDLE_RE.test(spelling)) {
    return { handle: spelling.toLowerCase(), confidence: 'high', reason: 'spelling' };
  }

  // Handle-plausible but ambiguous: inner spaces without explicit separators,
  // invalid characters (Instagram allows letters, digits, periods, underscores
  // only), or hesitation. Never glue or guess: ask for a spelling.
  const compact = converted.replace(/[\s,;:!?-]+/g, '');
  if (compact.length >= 2 && /[A-Za-z0-9]/.test(compact)) {
    if (/\s/.test(raw.trim()) || /[^A-Za-z0-9._@\s,;:!?-]/.test(raw) || /-/.test(compact) || AMBIGUITY_MARKERS.test(original)) {
      return { handle: null, confidence: 'low', reason: 'ambiguous' };
    }
  }
  return { handle: null, confidence: 'none', reason: 'no_handle' };
}

/**
 * Parse a handle from ordinary text or dictated speech.
 * Preserve the casing supplied by the caller; Instagram treats handles
 * case-insensitively, but preserving it is useful for read-back and tests.
 * Returns null for ambiguous input so the caller is asked to spell it.
 */
export function extractHandle(text) {
  const found = analyzeHandle(text);
  return found.confidence === 'high' ? found.handle : null;
}

/** Character-by-character spoken form: "p r i y a underscore c ...". */
export function spellForSpeech(handle) {
  return String(handle ?? '')
    .split('')
    .map(ch => (ch === '_' ? 'underscore' : ch === '.' ? 'dot' : ch === '-' ? 'dash' : ch))
    .join(' ');
}

const spellCode = code => String(code ?? '').split('').join(' ');

const NUMBER_WORDS = {
  zero: '0', o: '0', oh: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9'
};

/**
 * Parse a spoken phone number. Accepts digit runs ("98765 43210",
 * "+91-98765-43210") and number words ("nine eight seven ...").
 * Returns { digits, display } or null. Digits only, 7-15 long; the country
 * is never inferred — only digits the caller actually said are kept.
 */
export function extractPhoneDigits(text) {
  const original = String(text ?? '').normalize('NFKC').trim();
  if (!original || original.length > 200) return null;
  if (/^(what|why|how|when|repeat|pardon|sorry|huh|excuse me)\b[?.!]*$/i.test(original)) return null;
  if (/^(yes|yeah|yep|no|nope|ok|okay|sure)[.!?]*$/i.test(original)) return null;
  if (isSideQuestion(original)) return null;

  let s = ` ${original.toLowerCase()} `;
  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    s = s.replace(new RegExp(`\\b${word}\\b`, 'g'), digit);
  }
  s = s.replace(/\bplus\b/g, '+');
  const hasPlus = s.includes('+');
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (!/\d/.test(original) && digits.length < 7) return null;
  const display = `${hasPlus ? '+' : ''}${digits}`;
  return { digits, display };
}

/** Grouped spoken readback: "+ 9 1, 9 8 7 6 5, 4 3 2 1 0". */
export function formatPhoneForSpeech(display) {
  const s = String(display ?? '').trim();
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  let groups;
  if (digits.length === 10) {
    groups = [digits.slice(0, 5), digits.slice(5)];
  } else if (digits.length > 10) {
    const cc = digits.slice(0, digits.length - 10);
    groups = [cc, digits.slice(-10, -5), digits.slice(-5)];
  } else {
    groups = digits.match(/.{1,4}/g) || [digits];
  }
  const spoken = groups.map(g => g.split('').join(' ')).join(', ');
  return plus ? `plus ${spoken}` : spoken;
}

export function lastDigits(display, n = 4) {
  return String(display ?? '').replace(/\D/g, '').slice(-n);
}

/**
 * Return true only for likely interruptions/questions, not short repair
 * utterances such as "what?" or "sorry" which should trigger a reprompt.
 */
export function isSideQuestion(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;

  if (/\b(subscription|pricing|price|plans?|fees?|charges?|payment|cost|features|benefits|eligibility|followers?)\b/i.test(s)) {
    return true;
  }

  if (/\b(can you explain|could you explain|tell me about|before answering|before that|i have a question|quick question)\b/i.test(s)) {
    return true;
  }

  // Question-like phrases without punctuation are common in speech transcripts.
  if (/^(?:how\s+(?:do|can|could|does|would)\s+i\b|what\s+(?:do|does|is|are|can|should)\b|why\s+(?:do|does|is|should|can)\b|can\s+you\b|could\s+you\b|do\s+i\b|how\s+to\b)/i.test(s)) return true;
  // Generic questions need meaningful content; short repair utterances stay retries.
  return /\b(what|why|how|when|where|who|which|do|does|is|are|can|could|would)\b.{3,}\?/i.test(s);
}

export function extractFreeText(text) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (s.length < 2) return null;
  if (/^(what|why|how|when|repeat|pardon|sorry|huh|excuse me)\b[?.!]*$/i.test(s)) return null;
  if (/^(yes|yeah|yep|no|nope|ok|okay|sure)[.!?]*$/i.test(s)) return null;
  if (isSideQuestion(s)) return null;
  return s;
}

/** A single personal name part: letters plus a small allowlist, 1-3 words. */
export function extractNamePart(text) {
  const s = extractFreeText(text);
  if (!s || s.length > 40) return null;
  if (!/^[A-Za-z][A-Za-z .'-]*$/.test(s)) return null;
  if (s.split(' ').length > 3) return null;
  if (/\b(instagram|handle|username|my name is)\b/i.test(s) && s.split(' ').length > 3) return null;
  return s;
}

export function isAffirmative(text) {
  return /^(yes|yeah|yep|sure|correct|right|ok(ay)?|confirm(ed)?|do it|go ahead|please do|sounds good)\b/i.test(norm(text));
}

export function isNegative(text) {
  return /^(no|nope|not|wrong|incorrect|cancel|stop|don't|dont|never mind)\b/i.test(norm(text));
}

const isSkip = text =>
  /^(skip|dont have one|do not have one|not now|later|no idea|pass)\b/i.test(String(text ?? '').trim());

const SLOTS = Object.freeze({
  influencer: [
    { key: 'instagram_username', label: 'Instagram handle', kind: 'handle', required: true, ask: "What's your Instagram handle — for example, @yourname?" },
    { key: 'first_name', label: 'first name', kind: 'name', required: true, ask: 'Thanks. What is your first name?' },
    { key: 'last_name', label: 'last name', kind: 'name', required: false, ask: 'And your last name? You can say skip if you prefer.' },
    { key: 'phone', label: 'phone number', kind: 'phone', required: true, ask: 'What is your phone number? Please say it slowly.' },
    { key: 'city', label: 'city', kind: 'text', required: false, ask: 'Which city are you based in?' },
    { key: 'state', label: 'state', kind: 'text', required: false, ask: 'And which state?' },
    { key: 'country', label: 'country', kind: 'text', required: false, ask: 'And which country?' },
    { key: 'niche', label: 'niche', kind: 'text', required: false, ask: 'What is your content niche — for example, fashion, food, or fitness?' },
  ],
  vendor: [
    { key: 'business_name', label: 'business name', kind: 'text', required: true, ask: "What's your business name?" },
    { key: 'contact_name', label: 'contact person', kind: 'text', required: false, ask: 'Who should we list as the contact person?' },
    { key: 'phone', label: 'business phone number', kind: 'phone', required: true, ask: 'What is your business phone number? Please say it slowly.' },
    { key: 'city', label: 'city', kind: 'text', required: false, ask: 'Which city is the business based in?' },
    { key: 'state', label: 'state', kind: 'text', required: false, ask: 'And which state?' },
    { key: 'country', label: 'country', kind: 'text', required: false, ask: 'And which country?' },
  ],
});

const CAMPAIGN_SLOTS = Object.freeze([
  { key: 'campaign_title', label: 'campaign name', kind: 'text', required: true, ask: 'What should we call the campaign?' },
  { key: 'niche', label: 'influencer niche', kind: 'text', required: false, ask: 'Which influencer niche should the campaign target — for example, fashion or food?' },
  { key: 'target_location', label: 'target location', kind: 'text', required: false, ask: 'Which city or area should the campaign target?' },
]);

const CAMPAIGN_OFFER = 'Would you like to add campaign requirements now, or fill those in on the form later?';
const MAX_RETRIES = 2;

export function createFlow() {
  return {
    state: 'intent',
    intent: INTENTS.UNKNOWN,
    fields: {},
    heard: {},
    slotIndex: 0,
    retries: 0,
    action: null,
    consent: false,
    flags: {},
    pending: null,
    correctKey: null,
  };
}

const newAttemptId = () =>
  `vc-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;

function fullNameOf(fields) {
  return [fields.first_name, fields.last_name].filter(Boolean).join(' ').trim();
}

function summarizeFields(intent, fields, flags = {}) {
  if (intent === INTENTS.INFLUENCER) {
    const parts = [`Instagram handle @${fields.instagram_username}`];
    if (flags.handleSpelled && fields.instagram_username) {
      parts.push(`spelled ${spellForSpeech(fields.instagram_username)}`);
    }
    const name = fullNameOf(fields);
    if (name) parts.push(`name ${name}`);
    if (fields.phone) parts.push(`phone ${formatPhoneForSpeech(fields.phone)}`);
    if (fields.city) parts.push(`city ${fields.city}`);
    if (fields.state) parts.push(`state ${fields.state}`);
    if (fields.country) parts.push(`country ${fields.country}`);
    if (fields.niche) parts.push(`niche ${fields.niche}`);
    return `Just to confirm: ${parts.join(', ')}. Is that correct?`;
  }

  const parts = [`business ${fields.business_name}`];
  if (fields.contact_name) parts.push(`contact ${fields.contact_name}`);
  if (fields.phone) parts.push(`phone ${formatPhoneForSpeech(fields.phone)}`);
  if (fields.city) parts.push(`city ${fields.city}`);
  if (fields.state) parts.push(`state ${fields.state}`);
  if (fields.country) parts.push(`country ${fields.country}`);
  if (fields.campaign_title) {
    const campaign = [`campaign ${fields.campaign_title}`];
    if (fields.niche) campaign.push(`niche ${fields.niche}`);
    if (fields.target_location) campaign.push(`target ${fields.target_location}`);
    parts.push(campaign.join(', '));
  }
  return `Just to confirm: ${parts.join(', ')}. Is that correct?`;
}

/**
 * Validated mapping from flow fields to Worker detail keys. Returns
 * { details, errors } where errors is [{ field, message }]. Empty errors
 * means the payload is safe to submit.
 */
export function validateRegistrationDetails(intent, fields) {
  const errors = [];
  const details = {};
  const src = fields && typeof fields === 'object' ? fields : {};

  const takeText = (from, to, { required = false, label = to } = {}) => {
    const v = String(src[from] ?? '').trim().slice(0, 120);
    if (!v) {
      if (required) errors.push({ field: from, message: `${label} is required.` });
      return;
    }
    details[to] = v;
  };

  if (intent === INTENTS.INFLUENCER) {
    const handle = String(src.instagram_username ?? '').trim();
    if (!HANDLE_RE.test(handle)) {
      errors.push({ field: 'instagram_username', message: 'A valid Instagram handle is required.' });
    }
    const name = fullNameOf(src);
    if (!name) errors.push({ field: 'first_name', message: 'First name is required.' });
    else details.full_name = name.slice(0, 120);
    takeText('phone', 'phone', { required: true, label: 'Phone number' });
    if (details.phone && (details.phone.replace(/\D/g, '').length < 7 || details.phone.replace(/\D/g, '').length > 15)) {
      errors.push({ field: 'phone', message: 'Phone number must hold 7 to 15 digits.' });
      delete details.phone;
    }
    takeText('city', 'city');
    takeText('state', 'state');
    takeText('country', 'country');
    takeText('niche', 'niche');
    return { details, errors, instagramUsername: HANDLE_RE.test(handle) ? handle : null };
  }

  if (intent === INTENTS.VENDOR) {
    takeText('business_name', 'business_name', { required: true, label: 'Business name' });
    takeText('contact_name', 'contact_name');
    takeText('phone', 'phone', { required: true, label: 'Phone number' });
    if (details.phone && (details.phone.replace(/\D/g, '').length < 7 || details.phone.replace(/\D/g, '').length > 15)) {
      errors.push({ field: 'phone', message: 'Phone number must hold 7 to 15 digits.' });
      delete details.phone;
    }
    takeText('city', 'city');
    takeText('state', 'state');
    takeText('country', 'country');
    takeText('campaign_title', 'campaign_title');
    takeText('niche', 'niche');
    takeText('target_location', 'target_location');
    return { details, errors, instagramUsername: null };
  }

  return { details: {}, errors: [{ field: 'role', message: 'Registration role is unknown.' }], instagramUsername: null };
}

/**
 * Canonical structured registration state for logging-safe handoff and
 * frontend prefill. Validation errors are included so each form field can be
 * populated or flagged correctly.
 */
export function getRegistrationState(flow) {
  const f = flow && typeof flow === 'object' ? flow : {};
  const fields = f.fields && typeof f.fields === 'object' ? f.fields : {};
  const role = f.intent === INTENTS.INFLUENCER || f.intent === INTENTS.VENDOR ? f.intent : null;
  const { errors } = role ? validateRegistrationDetails(f.intent, fields) : { errors: [] };
  const action = f.action && typeof f.action === 'object' ? f.action : null;
  return {
    role,
    firstName: fields.first_name || null,
    lastName: fields.last_name || null,
    instagramHandle: fields.instagram_username || null,
    phoneNumber: fields.phone || null,
    city: fields.city || null,
    state: fields.state || null,
    country: fields.country || null,
    niche: fields.niche || null,
    businessName: fields.business_name || null,
    contactName: fields.contact_name || null,
    campaignTitle: fields.campaign_title || null,
    targetLocation: fields.target_location || null,
    consent: f.consent === true,
    registrationCode: action?.linkCode || null,
    registrationStatus: action?.registrationStatus || 'none',
    registrationLinkStatus: action?.registrationLinkStatus || 'none',
    errors,
  };
}

function slotValue(slot, text) {
  if (slot.kind === 'handle') return extractHandle(text);
  if (slot.kind === 'phone') return extractPhoneDigits(text)?.display || null;
  if (slot.kind === 'name') return extractNamePart(text);
  return extractFreeText(text);
}

const CORRECTABLE = [
  { key: 'instagram_username', names: ['handle', 'instagram', 'username', 'user name'] },
  { key: 'first_name', names: ['first name', 'firstname', 'first'] },
  { key: 'last_name', names: ['last name', 'lastname', 'last', 'surname', 'family name'] },
  { key: 'phone', names: ['phone', 'number', 'mobile', 'contact number'] },
  { key: 'city', names: ['city'] },
  { key: 'state', names: ['state'] },
  { key: 'country', names: ['country'] },
  { key: 'niche', names: ['niche'] },
  { key: 'business_name', names: ['business', 'business name', 'brand', 'shop', 'store', 'company'] },
  { key: 'contact_name', names: ['contact', 'contact person', 'contact name'] },
  { key: 'campaign_title', names: ['campaign', 'campaign name', 'campaign title'] },
  { key: 'target_location', names: ['target', 'target location', 'location'] },
];

function matchCorrectable(text, intent) {
  const t = ` ${norm(text)} `;
  const allowed = new Set(
    [...(SLOTS[intent] || []), ...(intent === INTENTS.VENDOR ? CAMPAIGN_SLOTS : [])].map(s => s.key)
  );
  for (const entry of CORRECTABLE) {
    if (!allowed.has(entry.key)) continue;
    if (entry.names.some(n => t.includes(` ${norm(n)} `) || t.trim() === norm(n))) return entry.key;
  }
  return null;
}

function correctMenu(intent) {
  const keys = [...(SLOTS[intent] || [])].map(s => s.label);
  return `Which detail should I change — ${keys.join(', ')}?`;
}

function findSlot(intent, key) {
  return [...(SLOTS[intent] || []), ...CAMPAIGN_SLOTS].find(s => s.key === key) || null;
}

export async function stepFlow(flow, transcript, ctx = {}) {
  if (!ctx.enabled) return null;
  if (!flow || flow.state === 'done' || flow.state === 'idle') return null;

  const text = String(transcript ?? '').trim();
  if (!text) return null;

  // Keep side questions with Muse before interpreting them as field values.
  // This block intentionally appears once, before the collection branch.
  if ((flow.state === 'collect' || flow.state === 'collect_campaign') && isSideQuestion(text)) {
    return null;
  }

  if (flow.state === 'intent') {
    const intent = detectIntent(text);
    if (intent !== INTENTS.INFLUENCER && intent !== INTENTS.VENDOR) return null;
    flow.intent = intent;
    flow.state = 'collect';
    flow.slotIndex = 0;
    flow.retries = 0;
    return { speak: SLOTS[intent][0].ask };
  }

  if (flow.state === 'collect' || flow.state === 'collect_campaign') {
    const slots = flow.state === 'collect' ? SLOTS[flow.intent] : CAMPAIGN_SLOTS;
    const finish = () => {
      flow.retries = 0;
      flow.pending = null;
      if (flow.state === 'collect' && flow.intent === INTENTS.VENDOR) {
        flow.state = 'campaign_offer';
        return { speak: CAMPAIGN_OFFER };
      }
      flow.state = 'confirm';
      return { speak: summarizeFields(flow.intent, flow.fields, flow.flags) };
    };

    const slot = slots?.[flow.slotIndex];
    if (!slot) return finish();

    // A pending phone/handle confirmation takes precedence over new input.
    if (flow.pending) {
      const pending = flow.pending;
      if (pending.slotKey !== slot.key) flow.pending = null;
      else if (pending.callerId && !isAffirmative(text) && !isNegative(text)) {
        // The caller spoke a different number instead of answering yes/no.
        const spoken = extractPhoneDigits(text);
        if (spoken && spoken.digits !== String(pending.value).replace(/\D/g, '')) {
          const prompt = `I heard ${formatPhoneForSpeech(spoken.display)}. Is that correct?`;
          flow.pending = { slotKey: slot.key, value: spoken.display, heard: text.slice(0, 120), prompt };
          return { speak: prompt };
        }
        return { speak: `Please answer yes or no, or say your phone number slowly. ${pending.prompt}` };
      } else if (isAffirmative(text)) {
        flow.fields[slot.key] = pending.value;
        flow.heard[slot.key] = pending.heard;
        if (pending.spelling) flow.flags.handleSpelled = true;
        flow.pending = null;
        flow.slotIndex += 1;
        flow.retries = 0;
        const next = slots[flow.slotIndex];
        if (!next) return finish();
        return { speak: next.ask };
      } else if (isNegative(text)) {
        flow.pending = null;
        flow.retries = 0;
        return { speak: `No problem. ${slot.ask}` };
      } else {
        return { speak: `Please answer yes or no. ${pending.prompt}` };
      }
    }

    // A pending spelling request: interpret this turn as the spelled value,
    // then confirm the exact candidate before accepting it.
    if (flow.flags.spellingSlot === slot.key) {
      const spelled = slotValue(slot, text) || compactSpelling(text);
      if (spelled && (slot.kind !== 'handle' || HANDLE_RE.test(spelled))) {
        flow.flags.spellingSlot = null;
        const prompt =
          slot.kind === 'handle'
            ? `I heard @${spelled}, spelled ${spellForSpeech(spelled)}. Is that correct?`
            : `I heard ${spelled}. Is that correct?`;
        flow.pending = { slotKey: slot.key, value: spelled, heard: text.slice(0, 120), prompt, spelling: true };
        return { speak: prompt };
      }
      return { speak: `Sorry, I still didn't catch that. Please spell your ${slot.label} slowly, one character at a time.` };
    }

    // Provider caller ID is offered once, and used only when confirmed.
    if (slot.kind === 'phone' && !flow.flags.callerIdOffered) {
      flow.flags.callerIdOffered = true;
      const callerId = String(ctx.callerId || '').replace(/\D/g, '');
      if (callerId.length >= 7 && callerId.length <= 15) {
        flow.pending = {
          slotKey: slot.key,
          value: (String(ctx.callerId).trim().startsWith('+') ? '+' : '') + callerId,
          heard: 'provider caller id (confirmed)',
          prompt: `Can I use your calling number ending in ${callerId.slice(-4)}?`,
          callerId: true,
        };
        return { speak: `Can I use your calling number ending in ${callerId.slice(-4)}, or would you like to give a different number?` };
      }
    }
    // Ambiguous handles are never guessed: request a spelling.
    if (slot.kind === 'handle') {
      const analysis = analyzeHandle(text);
      if (analysis.confidence === 'low') {
        flow.flags.spellingSlot = slot.key;
        flow.retries = 0;
        return { speak: 'I want to get that exactly right. Could you spell your handle slowly, letter by letter?' };
      }
    }

    // Explicit skip for optional slots comes before value parsing so the
    // word "skip" itself is never stored as a field value.
    if (!slot.required && isSkip(text)) {
      flow.slotIndex += 1;
      flow.retries = 0;
      const next = slots[flow.slotIndex];
      if (!next) return finish();
      return { speak: `No problem, we can skip that. ${next.ask}` };
    }

    const value = slotValue(slot, text);
    if (value) {
      // Phone numbers are always confirmed by readback before use.
      if (slot.kind === 'phone') {
        const prompt = `I heard ${formatPhoneForSpeech(value)}. Is that correct?`;
        flow.pending = { slotKey: slot.key, value, heard: text.slice(0, 120), prompt };
        return { speak: prompt };
      }
      flow.fields[slot.key] = value;
      flow.heard[slot.key] = text.slice(0, 120);
      flow.slotIndex += 1;
      flow.retries = 0;
      const next = slots[flow.slotIndex];
      if (!next) return finish();
      return { speak: next.ask };
    }

    flow.retries += 1;
    if (!slot.required && flow.retries > MAX_RETRIES) {
      flow.slotIndex += 1;
      flow.retries = 0;
      const next = slots[flow.slotIndex];
      if (!next) return finish();
      return { speak: `No problem, we can skip that. ${next.ask}` };
    }

    // Required fields must never be silently skipped or abandon collection
    // just because ASR misses several times.
    if (slot.required && flow.retries > MAX_RETRIES + 1) {
      flow.retries = 0;
      return { speak: `I still need your ${slot.label} to continue. ${slot.ask}` };
    }

    const hint = slot.kind === 'handle'
      ? ' Please say just the handle, slowly — for example, @yourname.'
      : slot.kind === 'phone'
        ? ' Please say the digits slowly.'
        : '';
    return { speak: `Sorry, I didn't catch your ${slot.label}.${hint} ${slot.ask}` };
  }

  if (flow.state === 'campaign_offer') {
    if (isAffirmative(text)) {
      flow.state = 'collect_campaign';
      flow.slotIndex = 0;
      flow.retries = 0;
      return { speak: CAMPAIGN_SLOTS[0].ask };
    }
    if (isNegative(text)) {
      flow.state = 'confirm';
      flow.retries = 0;
      return { speak: summarizeFields(flow.intent, flow.fields, flow.flags) };
    }
    flow.retries += 1;
    if (flow.retries > 1) {
      flow.state = 'confirm';
      return { speak: `No problem — you can add campaign details on the form. ${summarizeFields(flow.intent, flow.fields, flow.flags)}` };
    }
    return { speak: `Please answer yes or no. ${CAMPAIGN_OFFER}` };
  }

  if (flow.state === 'confirm') {
    if (isAffirmative(text)) {
      flow.state = 'consent';
      flow.retries = 0;
      if (!flow.attemptId) flow.attemptId = newAttemptId();
      return { speak: 'May I use these details to create your secure registration code?' };
    }
    if (isNegative(text)) {
      // Correct one field without losing the others.
      flow.state = 'correct';
      flow.retries = 0;
      return { speak: `No problem. ${correctMenu(flow.intent)}` };
    }
    flow.retries += 1;
    if (flow.retries > 1) {
      flow.state = 'idle';
      return null;
    }
    return { speak: `Please answer yes or no. ${summarizeFields(flow.intent, flow.fields, flow.flags)}` };
  }

  if (flow.state === 'correct') {
    const key = matchCorrectable(text, flow.intent);
    if (!key) {
      flow.retries += 1;
      if (flow.retries > 1) {
        flow.state = 'confirm';
        flow.retries = 0;
        return { speak: summarizeFields(flow.intent, flow.fields, flow.flags) };
      }
      return { speak: `Sorry, I didn't catch which detail. ${correctMenu(flow.intent)}` };
    }
    const slot = findSlot(flow.intent, key);
    flow.correctKey = key;
    flow.state = 'correct_collect';
    flow.retries = 0;
    flow.pending = null;
    flow.flags.spellingSlot = null;
    return { speak: `What should your ${slot.label} be?` };
  }

  if (flow.state === 'correct_collect') {
    const slot = findSlot(flow.intent, flow.correctKey);
    if (!slot) {
      flow.state = 'confirm';
      return { speak: summarizeFields(flow.intent, flow.fields, flow.flags) };
    }
    if (isSideQuestion(text)) return null;

    if (flow.pending) {
      const pending = flow.pending;
      if (isAffirmative(text)) {
        flow.fields[slot.key] = pending.value;
        flow.heard[slot.key] = pending.heard;
        if (pending.spelling) flow.flags.handleSpelled = true;
        flow.pending = null;
        flow.correctKey = null;
        flow.state = 'confirm';
        flow.retries = 0;
        return { speak: summarizeFields(flow.intent, flow.fields, flow.flags) };
      }
      if (isNegative(text)) {
        // Keep the previously confirmed value; nothing is overwritten.
        flow.pending = null;
        flow.correctKey = null;
        flow.state = 'confirm';
        flow.retries = 0;
        return { speak: `Kept your previous ${slot.label}. ${summarizeFields(flow.intent, flow.fields, flow.flags)}` };
      }
      return { speak: `Please answer yes or no. ${pending.prompt}` };
    }

    if (flow.flags.spellingSlot === slot.key) {
      const spelled = slotValue(slot, text) || compactSpelling(text);
      if (spelled && (slot.kind !== 'handle' || HANDLE_RE.test(spelled))) {
        flow.flags.spellingSlot = null;
        const prompt =
          slot.kind === 'handle'
            ? `I heard @${spelled}, spelled ${spellForSpeech(spelled)}. Is that correct?`
            : `I heard ${spelled}. Is that correct?`;
        flow.pending = { slotKey: slot.key, value: spelled, heard: text.slice(0, 120), prompt, spelling: true };
        return { speak: prompt };
      }
      return { speak: `Sorry, I still didn't catch that. Please spell your ${slot.label} slowly, one character at a time.` };
    }

    if (slot.kind === 'handle' && analyzeHandle(text).confidence === 'low') {
      flow.flags.spellingSlot = slot.key;
      return { speak: 'I want to get that exactly right. Could you spell your handle slowly, letter by letter?' };
    }

    const value = slotValue(slot, text);
    // A confirmed value is never overwritten with an empty value.
    if (!value) {
      flow.retries += 1;
      if (flow.retries > MAX_RETRIES) {
        flow.correctKey = null;
        flow.state = 'confirm';
        flow.retries = 0;
        return { speak: `Kept your previous ${slot.label}. ${summarizeFields(flow.intent, flow.fields, flow.flags)}` };
      }
      return { speak: `Sorry, I didn't catch that. What should your ${slot.label} be?` };
    }
    if (slot.kind === 'phone') {
      const prompt = `I heard ${formatPhoneForSpeech(value)}. Is that correct?`;
      flow.pending = { slotKey: slot.key, value, heard: text.slice(0, 120), prompt };
      return { speak: prompt };
    }
    flow.fields[slot.key] = value;
    flow.heard[slot.key] = text.slice(0, 120);
    flow.correctKey = null;
    flow.state = 'confirm';
    flow.retries = 0;
    return { speak: summarizeFields(flow.intent, flow.fields, flow.flags) };
  }

  if (flow.state === 'consent') {
    if (isNegative(text)) {
      flow.state = 'done';
      flow.consent = false;
      return { speak: "Understood — I won't use your details. Is there anything else I can help with?" };
    }
    if (!isAffirmative(text)) {
      flow.retries += 1;
      if (flow.retries > 1) {
        flow.state = 'idle';
        return null;
      }
      return { speak: 'Please answer yes or no. May I use these details to create your secure registration code?' };
    }
    flow.consent = true;

    if (typeof ctx.actions?.createVoiceSession !== 'function') {
      flow.state = 'consent';
      flow.retries = 0;
      return { speak: "I can't reach the registration service right now. Nothing was submitted. Please try again later, or say no to stop." };
    }

    const checked = validateRegistrationDetails(flow.intent, flow.fields);
    if (checked.errors.length || (flow.intent === INTENTS.INFLUENCER && !checked.instagramUsername)) {
      flow.state = 'correct';
      flow.retries = 0;
      return { speak: `I still need a valid ${checked.errors[0]?.field.replace(/_/g, ' ') || 'detail'} before I can continue. ${correctMenu(flow.intent)}` };
    }

    // Stable idempotency key per consent round: retries replay it so the
    // backend returns the same session instead of minting duplicate codes.
    if (!flow.attemptId) flow.attemptId = newAttemptId();

    try {
      const result = await ctx.actions.createVoiceSession({
        purpose: flow.intent,
        instagramUsername: checked.instagramUsername,
        details: checked.details,
        clientRequestId: flow.attemptId,
      });

      if (!result?.sessionId || !result?.linkCode) {
        throw new Error('Malformed voice session response');
      }

      flow.state = 'awaiting_link';
      flow.action = {
        sessionId: result.sessionId,
        linkCode: result.linkCode,
        repeatsLeft: 1,
        registrationStatus: 'pending',
        registrationLinkStatus: 'waiting',
      };
      const where = ctx.igHandle ? `to @${ctx.igHandle}` : 'to our B8i Instagram account';
      return {
        speak:
          `Your code is ready. It is ${spellCode(result.linkCode)}. ` +
          `Open Instagram and send the message LINK ${result.linkCode} ${where} to get your registration link. ` +
          'Eligibility, including the follower guideline, will be verified when you complete your registration there.',
      };
    } catch {
      flow.state = 'consent';
      flow.retries = 0;
      return {
        speak:
          "I'm sorry, I couldn't create your code because the registration service isn't responding. " +
          'Nothing was submitted. Please say yes to try again, or no to stop.',
      };
    }
  }

  if (flow.state === 'awaiting_link') {
    const statusWords = /\b(status|links?|codes?|redeem|resend|resent|sent|check|expir\w*|receiv\w*|arriv\w*|deliver\w*)\b/i;
    const statusPhrases = /send.{0,15}again|didn.?t\s+(get|receive|arrive)|not\s+(received|working|arrived|sent)|where.{0,15}(link|code)|did you send/i;
    const newCodeIntent = /\bnew code\b|\b(create|make|give).{0,20}(fresh|new|another).{0,10}code\b/i;
    if (!statusWords.test(text) && !statusPhrases.test(text) && !newCodeIntent.test(text)) return null;

    if (typeof ctx.actions?.getVoiceSessionStatus !== 'function') {
      return { speak: "I can't check the registration status right now. Please try again in a moment." };
    }

    try {
      const status = await ctx.actions.getVoiceSessionStatus(flow.action?.sessionId);
      if (status?.used) {
        flow.state = 'done';
        flow.action.registrationStatus = 'used';
        flow.action.registrationLinkStatus = 'delivered';
        return {
          speak:
            'Good news — your code has been used. Please continue in Instagram, where your registration link is waiting. ' +
            'After you submit the form there, any payment, verification, and admin review steps will follow in order.',
        };
      }

      if (status?.expired) {
        flow.state = 'consent';
        flow.action.registrationStatus = 'expired';
        flow.action.registrationLinkStatus = 'expired';
        flow.attemptId = newAttemptId();
        flow.retries = 0;
        return { speak: 'That code has expired. May I create a fresh code with the same details?' };
      }

      // Still pending. The code may be repeated once in a controlled way;
      // afterwards the caller is routed to support or offered a fresh code.
      // A fresh code needs fresh consent and a fresh idempotency key.
      if (newCodeIntent.test(text)) {
        flow.state = 'consent';
        flow.attemptId = newAttemptId();
        flow.retries = 0;
        return { speak: 'Of course. May I create a fresh code with the same details?' };
      }

      flow.action.registrationStatus = 'pending';
      flow.action.registrationLinkStatus = 'waiting';
      const where = ctx.igHandle ? `to @${ctx.igHandle}` : 'to our B8i Instagram account';
      if (flow.action.repeatsLeft > 0) {
        flow.action.repeatsLeft -= 1;
        return {
          speak:
            `Your code ${spellCode(flow.action?.linkCode)} is still waiting to be used. ` +
            `Send LINK ${flow.action?.linkCode} ${where} to get your registration link.`,
        };
      }
      return {
        speak:
          'Your code is still waiting to be used. If you missed it, say "new code" and I can create a fresh one, ' +
          'or contact B8i support for help.',
      };
    } catch {
      if (flow.action) {
        flow.action.registrationStatus = 'unknown';
        flow.action.registrationLinkStatus = 'unknown';
      }
      return { speak: "I couldn't reach the registration service just now. Please try asking again in a moment." };
    }
  }

  return null;
}

/** Compact a spelled turn ("p r i y a") into a single token. */
function compactSpelling(text) {
  const words = String(text ?? '').trim().split(/[\s-]+/).filter(Boolean);
  if (!words.length) return null;
  const mapped = [];
  for (const w of words) {
    if (/^[A-Za-z0-9]$/.test(w)) mapped.push(w);
    else if (/^(?:underscore|under\s*score)$/i.test(w)) mapped.push('_');
    else if (/^(?:dot|period|full\s*stop|point)$/i.test(w)) mapped.push('.');
    else if (/^(?:at|at\s*sign)$/i.test(w)) continue;
    else return null;
  }
  const out = mapped.join('');
  return out.length >= 2 && out.length <= 30 ? out : null;
}
