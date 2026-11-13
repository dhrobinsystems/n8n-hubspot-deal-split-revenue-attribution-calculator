'use strict';

/**
 * calculator.js
 * ---------------------------------------------------------------------------
 * Revenue attribution and commission split engine for
 * n8n-hubspot-deal-split-revenue-attribution-calculator.
 *
 *   HubSpot Closed-Won event ──► normalizeEvents()        stage filter, secret check, dedupe
 *   HubSpot deal + associations ──► extractParticipants() split slots, owner default, partner carve-out
 *                                   calculateSplits()     validation, exact allocation, commission
 *                                   buildOutputs()        HubSpot properties, sheet rows, analytics record
 *   any failure ──► SplitValidationError / redact() / sanitizeForLog() ──► alert payload
 *
 * Money is never handled as floating point. Amounts are parsed from decimal
 * strings into integer minor units (BigInt). Credit is allocated with the
 * largest-remainder method, so the split credits always sum EXACTLY to the deal
 * amount, and commissions are rounded per line with a configurable rounding mode.
 *
 * Zero dependencies and no require(): inlined into n8n Code nodes by
 * scripts/build-workflow.js and unit-tested directly in Node.js (>= 20).
 * Cross-realm safe (no instanceof checks on built-ins).
 *
 * DISCLAIMER: provided "AS IS", without warranty of any kind. Automated revenue
 * and commission figures must be reviewed before they are used for payroll,
 * compensation or financial reporting. See disclaimer.md.
 * ---------------------------------------------------------------------------
 */

const CALCULATOR_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ENV_KEYS = Object.freeze([
  'SANDBOX_MODE',
  'WEBHOOK_SECRET',
  'HUBSPOT_PORTAL_ID',
  'HUBSPOT_APP_BASE_URL',
  'CLOSED_WON_STAGE_IDS',
  'COMMISSION_BASE_PROPERTY',
  'CURRENCY_PROPERTY',
  'DEFAULT_CURRENCY',
  'ROUNDING_MODE',
  'PERCENT_TOLERANCE',
  'NORMALIZE_WEIGHTS',
  'MAX_SPLIT_SLOTS',
  'SPLIT_PROPERTY_PREFIX',
  'DEFAULT_OWNER_SPLIT',
  'DEFAULT_ROLE',
  'ENABLE_PARTNER_ASSOCIATIONS',
  'PARTNER_ASSOCIATION_LABEL',
  'PARTNER_DEFAULT_PERCENT',
  'COMMISSION_RATES_JSON',
  'DEFAULT_COMMISSION_RATE',
  'WRITE_SLOT_PROPERTIES',
  'FORCE_RECALCULATION',
  'MAX_DEALS_PER_RUN',
  'ENABLE_HUBSPOT_WRITEBACK',
  'ENABLE_GOOGLE_SHEETS',
  'GOOGLE_SHEET_ID',
  'GOOGLE_SHEET_TAB',
  'ENABLE_ANALYTICS_INGEST',
  'ANALYTICS_INGEST_URL',
  'ENABLE_ALERTS',
  'ALERT_WEBHOOK_URL',
  'ALERT_FORMAT',
]);

const DEFAULTS = Object.freeze({
  SANDBOX_MODE: 'true',
  WEBHOOK_SECRET: '',
  HUBSPOT_PORTAL_ID: '',
  HUBSPOT_APP_BASE_URL: 'https://app.hubspot.com',
  CLOSED_WON_STAGE_IDS: 'closedwon',
  COMMISSION_BASE_PROPERTY: 'amount',
  CURRENCY_PROPERTY: 'deal_currency_code',
  DEFAULT_CURRENCY: 'USD',
  ROUNDING_MODE: 'HALF_EVEN',
  PERCENT_TOLERANCE: '0.01',
  NORMALIZE_WEIGHTS: 'false',
  MAX_SPLIT_SLOTS: '5',
  SPLIT_PROPERTY_PREFIX: 'split_',
  DEFAULT_OWNER_SPLIT: 'true',
  DEFAULT_ROLE: 'AE',
  ENABLE_PARTNER_ASSOCIATIONS: 'true',
  PARTNER_ASSOCIATION_LABEL: 'Referral Partner',
  PARTNER_DEFAULT_PERCENT: '10',
  COMMISSION_RATES_JSON: '{"AE":"0.10","SDR":"0.05","CSM":"0.03","SE":"0.02","PARTNER":"0.15"}',
  DEFAULT_COMMISSION_RATE: '0',
  WRITE_SLOT_PROPERTIES: 'true',
  FORCE_RECALCULATION: 'false',
  MAX_DEALS_PER_RUN: '50',
  ENABLE_HUBSPOT_WRITEBACK: 'true',
  ENABLE_GOOGLE_SHEETS: 'true',
  GOOGLE_SHEET_ID: '',
  GOOGLE_SHEET_TAB: 'deal_splits',
  ENABLE_ANALYTICS_INGEST: 'false',
  ANALYTICS_INGEST_URL: '',
  ENABLE_ALERTS: 'true',
  ALERT_WEBHOOK_URL: '',
  ALERT_FORMAT: 'slack',
});

const PLACEHOLDER = /^\{\{.*\}\}$|^<?(your[-_]|YOUR_|REPLACE_)/;
const ROUNDING_MODES = Object.freeze(['HALF_EVEN', 'HALF_UP', 'DOWN']);
const MIN_SECRET_LENGTH = 16;
/** ISO 4217 currencies whose minor unit is not 2 digits. Everything else uses 2. */
const CURRENCY_MINOR_DIGITS = Object.freeze({
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
});
/** Percent and rate precision. Percents keep 4 decimals; rates keep 6. */
const PERCENT_SCALE = 4;
const RATE_SCALE = 6;

class ConfigError extends Error {
  constructor(problems) {
    super('Invalid split calculator configuration:\n  - ' + problems.join('\n  - '));
    this.name = 'ConfigError';
    this.problems = problems.slice();
  }
}

/** Structured, user-facing validation failure for one deal. */
class SplitValidationError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SplitValidationError';
    this.code = code;
    this.details = details || {};
  }
}

function isPlaceholder(value) {
  return typeof value === 'string' && PLACEHOLDER.test(value.trim());
}

function deepFreeze(obj) {
  Object.keys(obj).forEach((k) => {
    if (obj[k] && typeof obj[k] === 'object' && !Object.isFrozen(obj[k])) deepFreeze(obj[k]);
  });
  return Object.freeze(obj);
}

/**
 * Parse and validate configuration. Every problem is reported in one ConfigError.
 * Webhook, sheet and ingest endpoints are only checked for presence; their values
 * are not kept in the returned object (the HTTP nodes read them from $env).
 */
function loadConfig(env) {
  const source = env !== undefined ? env : typeof process !== 'undefined' && process.env ? process.env : {};
  const problems = [];
  const warnings = [];
  const raw = (key) => {
    let v;
    try {
      v = source[key];
    } catch (err) {
      v = undefined; // n8n may block $env access
    }
    if (v === undefined || v === null || String(v).trim() === '') return DEFAULTS[key] || '';
    return String(v).trim();
  };
  const str = (key) => (isPlaceholder(raw(key)) ? '' : raw(key));
  const bool = (key) => {
    const v = raw(key).toLowerCase();
    if (['true', '1', 'yes', 'on'].indexOf(v) !== -1) return true;
    if (['false', '0', 'no', 'off'].indexOf(v) !== -1) return false;
    problems.push(`${key} must be true or false, received "${v}"`);
    return DEFAULTS[key] === 'true';
  };
  const int = (key, min, max) => {
    const n = Number(raw(key));
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${key} must be an integer between ${min} and ${max}, received "${raw(key)}"`);
      return Number(DEFAULTS[key]);
    }
    return n;
  };
  const decimal = (key, scale, min, max) => {
    try {
      const v = parseDecimal(raw(key), scale, 'HALF_EVEN');
      const lo = parseDecimal(String(min), scale, 'HALF_EVEN');
      const hi = parseDecimal(String(max), scale, 'HALF_EVEN');
      if (v < lo || v > hi) throw new Error('range');
      return v;
    } catch (err) {
      problems.push(`${key} must be a decimal between ${min} and ${max}, received "${raw(key)}"`);
      return 0n;
    }
  };

  const sandboxMode = bool('SANDBOX_MODE');
  const secret = str('WEBHOOK_SECRET');
  if (secret && secret.length < MIN_SECRET_LENGTH) problems.push(`WEBHOOK_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);

  const hubspot = {
    portalId: str('HUBSPOT_PORTAL_ID'),
    appBaseUrl: raw('HUBSPOT_APP_BASE_URL').replace(/\/+$/, ''),
    closedWonStageIds: raw('CLOSED_WON_STAGE_IDS').split(',').map((s) => s.trim()).filter((s) => s && !isPlaceholder(s)),
    amountProperty: raw('COMMISSION_BASE_PROPERTY'),
    currencyProperty: raw('CURRENCY_PROPERTY'),
  };
  if (hubspot.portalId && !/^\d+$/.test(hubspot.portalId)) problems.push('HUBSPOT_PORTAL_ID must be numeric');
  if (!/^https:\/\/\S+$/.test(hubspot.appBaseUrl)) problems.push('HUBSPOT_APP_BASE_URL must be an https:// URL');
  if (hubspot.closedWonStageIds.length === 0) problems.push('CLOSED_WON_STAGE_IDS must list at least one deal stage ID');
  ['amountProperty', 'currencyProperty'].forEach((k) => {
    if (!/^[a-z][a-z0-9_]{0,99}$/.test(hubspot[k])) problems.push(`${k === 'amountProperty' ? 'COMMISSION_BASE_PROPERTY' : 'CURRENCY_PROPERTY'} must be a HubSpot property internal name`);
  });

  const defaultCurrency = raw('DEFAULT_CURRENCY').toUpperCase();
  if (!/^[A-Z]{3}$/.test(defaultCurrency)) problems.push('DEFAULT_CURRENCY must be a 3-letter ISO 4217 code');
  const roundingMode = raw('ROUNDING_MODE').toUpperCase();
  if (ROUNDING_MODES.indexOf(roundingMode) === -1) problems.push(`ROUNDING_MODE must be one of ${ROUNDING_MODES.join(', ')}`);

  const splits = {
    prefix: raw('SPLIT_PROPERTY_PREFIX'),
    maxSlots: int('MAX_SPLIT_SLOTS', 1, 20),
    toleranceScaled: decimal('PERCENT_TOLERANCE', PERCENT_SCALE, 0, 1),
    normalizeWeights: bool('NORMALIZE_WEIGHTS'),
    defaultOwnerSplit: bool('DEFAULT_OWNER_SPLIT'),
    defaultRole: raw('DEFAULT_ROLE').toUpperCase(),
    partnerAssociationsEnabled: bool('ENABLE_PARTNER_ASSOCIATIONS'),
    partnerLabel: raw('PARTNER_ASSOCIATION_LABEL'),
    partnerPercentScaled: decimal('PARTNER_DEFAULT_PERCENT', PERCENT_SCALE, 0, 99),
    writeSlotProperties: bool('WRITE_SLOT_PROPERTIES'),
    forceRecalculation: bool('FORCE_RECALCULATION'),
    maxDealsPerRun: int('MAX_DEALS_PER_RUN', 1, 500),
  };
  if (!/^[a-z][a-z0-9_]{0,40}_$/.test(splits.prefix)) problems.push('SPLIT_PROPERTY_PREFIX must be lowercase snake_case ending in "_" (e.g. split_)');
  if (!/^[A-Z][A-Z0-9_]{0,30}$/.test(splits.defaultRole)) problems.push('DEFAULT_ROLE must be an uppercase role code such as AE');

  const rates = {};
  try {
    const parsed = JSON.parse(raw('COMMISSION_RATES_JSON'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    Object.keys(parsed).forEach((role) => {
      try {
        const r = parseDecimal(String(parsed[role]), RATE_SCALE, 'HALF_EVEN');
        if (r < 0n || r > 10n ** BigInt(RATE_SCALE)) throw new Error('range');
        rates[role.toUpperCase()] = r;
      } catch (err) {
        problems.push(`COMMISSION_RATES_JSON rate for "${role}" must be a decimal between 0 and 1 (e.g. "0.10")`);
      }
    });
  } catch (err) {
    problems.push('COMMISSION_RATES_JSON must be a JSON object such as {"AE":"0.10","PARTNER":"0.15"}');
  }
  const defaultRate = decimal('DEFAULT_COMMISSION_RATE', RATE_SCALE, 0, 1);

  const sync = {
    hubspotWriteback: bool('ENABLE_HUBSPOT_WRITEBACK'),
    sheetsEnabled: bool('ENABLE_GOOGLE_SHEETS'),
    sheetConfigured: Boolean(str('GOOGLE_SHEET_ID')),
    sheetTab: raw('GOOGLE_SHEET_TAB'),
    analyticsEnabled: bool('ENABLE_ANALYTICS_INGEST'),
    analyticsConfigured: Boolean(str('ANALYTICS_INGEST_URL')),
    alertsEnabled: bool('ENABLE_ALERTS'),
    alertConfigured: Boolean(str('ALERT_WEBHOOK_URL')),
    alertFormat: raw('ALERT_FORMAT').toLowerCase(),
  };
  if (['slack', 'json'].indexOf(sync.alertFormat) === -1) problems.push('ALERT_FORMAT must be "slack" or "json"');
  ['ANALYTICS_INGEST_URL', 'ALERT_WEBHOOK_URL'].forEach((k) => {
    if (str(k) && !/^https:\/\/\S+$/.test(str(k))) problems.push(`${k} must be an https:// URL`);
  });

  const live = [];
  if (!secret) live.push('WEBHOOK_SECRET is required to accept the alternative workflow-webhook entry point');
  if (sync.sheetsEnabled && !sync.sheetConfigured) live.push('GOOGLE_SHEET_ID is required when ENABLE_GOOGLE_SHEETS=true');
  if (sync.analyticsEnabled && !sync.analyticsConfigured) live.push('ANALYTICS_INGEST_URL is required when ENABLE_ANALYTICS_INGEST=true');
  if (sync.alertsEnabled && !sync.alertConfigured) live.push('ALERT_WEBHOOK_URL is required when ENABLE_ALERTS=true');
  if (!sync.hubspotWriteback && !sync.sheetsEnabled && !sync.analyticsEnabled) live.push('No sync target is enabled (HubSpot write-back, Google Sheets or analytics ingest)');
  if (sandboxMode) live.forEach((i) => warnings.push(`[sandbox] ${i}`));
  else live.forEach((i) => problems.push(i));

  if (problems.length > 0) throw new ConfigError(problems);
  return deepFreeze({ sandboxMode, secret, hubspot, defaultCurrency, roundingMode, splits, rates, defaultRate, sync, warnings });
}

// ---------------------------------------------------------------------------
// Exact decimal arithmetic (BigInt)
// ---------------------------------------------------------------------------

/** Divide two non-negative BigInts and round with the given mode. */
function divRound(numerator, denominator, mode) {
  if (denominator <= 0n) throw new RangeError('denominator must be positive');
  if (numerator < 0n) return -divRound(-numerator, denominator, mode);
  const q = numerator / denominator;
  const r = numerator % denominator;
  if (r === 0n || mode === 'DOWN') return q;
  const twice = r * 2n;
  if (twice > denominator) return q + 1n;
  if (twice < denominator) return q;
  // Exactly half.
  if (mode === 'HALF_UP') return q + 1n;
  return q % 2n === 0n ? q : q + 1n; // HALF_EVEN (banker's rounding)
}

/**
 * Parse a decimal string ("12500.505", "-3", "1e3" is rejected) into an integer
 * scaled by 10^scale, rounding extra digits with `mode`.
 * @throws {SplitValidationError} AMOUNT_INVALID style errors are raised by callers
 */
function parseDecimal(value, scale, mode) {
  if (value === null || value === undefined) throw new RangeError('empty');
  let s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value).trim();
  s = s.replace(/[\s_]/g, '');
  if (/^-?\d+(\.\d+)?e[+-]?\d+$/i.test(s)) {
    // Expand small-exponent numbers from JS Number formatting (e.g. 1e-7) safely.
    const n = Number(s);
    if (!Number.isFinite(n) || Math.abs(n) > 1e15) throw new RangeError('out of range');
    s = n.toFixed(Math.min(20, scale + 6));
  }
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError(`not a decimal: ${String(value).slice(0, 40)}`);
  const negative = Boolean(m[1]);
  const intPart = m[2];
  const frac = m[3] || '';
  if (intPart.length > 18) throw new RangeError('too large');
  const keep = frac.slice(0, scale).padEnd(scale, '0');
  let result = BigInt(intPart + keep);
  const rest = frac.slice(scale);
  if (rest && /[1-9]/.test(rest)) {
    const extra = BigInt(rest);
    const denom = 10n ** BigInt(rest.length);
    const rounded = divRound(result * denom + extra, denom, mode);
    result = rounded;
  }
  return negative ? -result : result;
}

/** Format an integer scaled by 10^scale as a decimal string. */
function formatScaled(value, scale) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const s = abs.toString().padStart(scale + 1, '0');
  const out = scale > 0 ? `${s.slice(0, -scale)}.${s.slice(-scale)}` : s;
  return negative ? `-${out}` : out;
}

function minorDigits(currency) {
  return CURRENCY_MINOR_DIGITS[currency] !== undefined ? CURRENCY_MINOR_DIGITS[currency] : 2;
}

/**
 * Allocate `total` (integer minor units) across integer `weights` so the parts
 * sum exactly to `total` (largest-remainder / Hamilton method; ties go to the
 * earlier participant, keeping results deterministic).
 */
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum <= 0n) throw new SplitValidationError('PERCENT_TOTAL_ZERO', 'Split weights sum to zero.');
  const sign = total < 0n ? -1n : 1n;
  const abs = total * sign;
  const parts = weights.map((w) => (abs * w) / sum);
  const remainders = weights.map((w, i) => ({ i, r: (abs * w) % sum }));
  let leftover = abs - parts.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (let k = 0; leftover > 0n; k += 1, leftover -= 1n) parts[remainders[k % remainders.length].i] += 1n;
  return parts.map((p) => p * sign);
}

// ---------------------------------------------------------------------------
// Redaction and sanitization
// ---------------------------------------------------------------------------

const SENSITIVE_KEY = /authorization|cookie|token|secret|password|passwd|api[-_]?key|signature|credential|private[-_]?key|x-hubspot-signature|x-split-secret/i;
const PII_KEY = /^(email|e-mail|phone|mobilephone|mobile_phone|firstname|first_name|lastname|last_name|address|street|ssn|tax_id|date_of_birth|dob)$/i;

/** Remove secrets and common PII from free text. */
function redact(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 [redacted-token]')
    .replace(/\bpat-[a-z0-9]{2,4}-[A-Za-z0-9-]+/g, '[redacted-token]')
    .replace(/\bya29\.[\w-]+/g, '[redacted-token]')
    .replace(/\bxox[abposr]-[A-Za-z0-9-]+/g, '[redacted-token]')
    .replace(/https:\/\/hooks\.slack\.com\/\S+/gi, '[redacted-webhook]')
    .replace(/([?&](?:hapikey|api_?key|access_token|token|secret|key)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/)[^\s"']+/gi, '$1[redacted-connection-string]')
    .replace(/(["']?(?:authorization|x-api-key|api[_-]?key|secret|password|token)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1[redacted]');
}

/**
 * Deep-copy an object for logging: sensitive headers / keys become "[redacted]",
 * PII fields become "[redacted-pii]", strings are passed through redact().
 * Depth and size are bounded so hostile payloads cannot blow up logs.
 */
function sanitizeForLog(value, depth) {
  const d = depth || 0;
  if (d > 6) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return redact(value).slice(0, 2000);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeForLog(v, d + 1));
  const out = {};
  Object.keys(value)
    .slice(0, 100)
    .forEach((k) => {
      if (SENSITIVE_KEY.test(k)) out[k] = '[redacted]';
      else if (PII_KEY.test(k)) out[k] = '[redacted-pii]';
      else out[k] = sanitizeForLog(value[k], d + 1);
    });
  return out;
}

function constantTimeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

/** Deterministic 64-bit FNV-1a hash as 16 hex characters (idempotency key, not security). */
function hash64(text) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Normalize HubSpot Trigger events (deal.propertyChange) and workflow-webhook calls
 * into a de-duplicated list of Closed-Won deal IDs.
 */
function normalizeEvents(itemJsons, config) {
  const deals = [];
  const rejected = {};
  const seen = {};
  const reject = (r) => (rejected[r] = (rejected[r] || 0) + 1);
  const accept = (event, source) => {
    if (!isPlainObject(event)) return reject('INVALID_EVENT');
    const props = isPlainObject(event.properties) ? event.properties : {};
    const unwrap = (v) => (isPlainObject(v) && 'value' in v ? v.value : v);
    const subscription = event.subscriptionType ? String(event.subscriptionType) : null;
    if (subscription && subscription !== 'deal.propertyChange' && subscription !== 'deal.creation') return reject('UNSUPPORTED_SUBSCRIPTION');
    if (event.propertyName && event.propertyName !== 'dealstage') return reject('NOT_DEALSTAGE_CHANGE');
    const stage = String(unwrap(event.propertyValue !== undefined ? event.propertyValue : props.dealstage !== undefined ? props.dealstage : event.dealstage) || '');
    if (config.hubspot.closedWonStageIds.indexOf(stage) === -1) return reject('NOT_CLOSED_WON');
    const id = String(unwrap(event.objectId !== undefined ? event.objectId : event.dealId !== undefined ? event.dealId : props.hs_object_id) || '').trim();
    if (!/^\d{1,20}$/.test(id)) return reject('MISSING_DEAL_ID');
    if (seen[id]) return reject('DUPLICATE');
    if (deals.length >= config.splits.maxDealsPerRun) return reject('RUN_LIMIT_REACHED');
    seen[id] = true;
    deals.push({ kind: 'deal_event', dealId: id, stage, source, occurredAt: event.occurredAt || null });
  };

  (Array.isArray(itemJsons) ? itemJsons : []).forEach((item) => {
    if (!isPlainObject(item)) return reject('INVALID_EVENT');
    const isWebhook = isPlainObject(item.headers) && 'body' in item;
    if (!isWebhook) return accept(item, 'hubspot_trigger');
    const key = Object.keys(item.headers).find((k) => k.toLowerCase() === 'x-split-secret');
    const provided = key ? item.headers[key] : undefined;
    if (config.secret) {
      if (!provided) return reject('SECRET_MISSING');
      if (!constantTimeEqual(Array.isArray(provided) ? provided[0] : provided, config.secret)) return reject('SECRET_MISMATCH');
    } else if (!config.sandboxMode) {
      return reject('SECRET_NOT_CONFIGURED');
    }
    const body = item.body;
    (Array.isArray(body) ? body : [body]).forEach((ev) => accept(ev, 'workflow_webhook'));
  });
  return { deals, rejected };
}

/** Deal properties to request from GET /crm/v3/objects/deals/{id}. */
function dealPropertiesToFetch(config) {
  const p = config.splits.prefix;
  const props = ['dealname', 'dealstage', 'closedate', 'hubspot_owner_id', 'pipeline', config.hubspot.amountProperty, config.hubspot.currencyProperty, 'split_calculation_id', 'split_calculation_status'];
  for (let n = 1; n <= config.splits.maxSlots; n += 1) {
    props.push(`${p}${n}_owner_id`, `${p}${n}_percent`, `${p}${n}_role`, `${p}${n}_partner_company_id`);
  }
  return props.filter((v, i) => props.indexOf(v) === i);
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

function parsePercent(value, field) {
  try {
    const v = parseDecimal(value, PERCENT_SCALE, 'HALF_EVEN');
    if (v <= 0n || v > 100n * 10n ** BigInt(PERCENT_SCALE)) throw new Error('range');
    return v;
  } catch (err) {
    throw new SplitValidationError('PERCENT_INVALID', `${field} must be a number greater than 0 and at most 100.`, { field, value: String(value).slice(0, 40) });
  }
}

/** Partner companies associated with the deal through the configured association label. */
function partnerCompaniesFromAssociations(associationsJson, config) {
  if (!config.splits.partnerAssociationsEnabled || !isPlainObject(associationsJson) || associationsJson.error) return [];
  const label = config.splits.partnerLabel.toLowerCase();
  const results = Array.isArray(associationsJson.results) ? associationsJson.results : [];
  return results
    .filter((r) => isPlainObject(r) && Array.isArray(r.associationTypes) && r.associationTypes.some((t) => isPlainObject(t) && String(t.label || '').toLowerCase() === label))
    .map((r) => String(r.toObjectId))
    .filter((id, i, all) => /^\d+$/.test(id) && all.indexOf(id) === i);
}

/**
 * Build the participant list from split slots, the owner default and partner associations.
 * Each participant: { slot, type: 'REP'|'PARTNER', id, role, weight (BigInt, percent × 10^4), source }
 */
function extractParticipants(deal, associationsJson, config) {
  const props = isPlainObject(deal.properties) ? deal.properties : {};
  const p = config.splits.prefix;
  const participants = [];
  for (let n = 1; n <= config.splits.maxSlots; n += 1) {
    const ownerId = String(props[`${p}${n}_owner_id`] || '').trim();
    const partnerId = String(props[`${p}${n}_partner_company_id`] || '').trim();
    const percentRaw = props[`${p}${n}_percent`];
    const hasPercent = percentRaw !== undefined && percentRaw !== null && String(percentRaw).trim() !== '';
    if (!ownerId && !partnerId && !hasPercent) continue;
    if (ownerId && partnerId) throw new SplitValidationError('PARTICIPANT_AMBIGUOUS', `Slot ${n} has both an owner and a partner company.`, { slot: n });
    if (!ownerId && !partnerId) throw new SplitValidationError('PARTICIPANT_MISSING', `Slot ${n} has a percent but no owner or partner company.`, { slot: n });
    if (!hasPercent) throw new SplitValidationError('PERCENT_MISSING', `Slot ${n} has a participant but no percent.`, { slot: n });
    const id = ownerId || partnerId;
    if (!/^\d{1,20}$/.test(id)) throw new SplitValidationError('PARTICIPANT_INVALID', `Slot ${n} participant ID must be numeric.`, { slot: n });
    const type = partnerId ? 'PARTNER' : 'REP';
    const role = String(props[`${p}${n}_role`] || (type === 'PARTNER' ? 'PARTNER' : config.splits.defaultRole)).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,30}$/.test(role)) throw new SplitValidationError('ROLE_INVALID', `Slot ${n} role must be a code such as AE or SDR.`, { slot: n });
    if (participants.some((x) => x.type === type && x.id === id)) throw new SplitValidationError('DUPLICATE_PARTICIPANT', `Participant ${type} ${id} appears in more than one slot.`, { slot: n, id });
    participants.push({ slot: n, type, id, role, weight: parsePercent(percentRaw, `${p}${n}_percent`), source: 'SPLIT_PROPERTIES' });
  }

  if (participants.length === 0 && config.splits.defaultOwnerSplit) {
    const owner = String(props.hubspot_owner_id || '').trim();
    if (/^\d{1,20}$/.test(owner)) {
      participants.push({ slot: 1, type: 'REP', id: owner, role: config.splits.defaultRole, weight: 100n * 10n ** BigInt(PERCENT_SCALE), source: 'DEAL_OWNER_DEFAULT' });
    }
  }
  if (participants.length === 0) throw new SplitValidationError('NO_PARTICIPANTS', 'No split participants: set split slot properties or a deal owner.', {});

  // Partner carve-out: associated partners without an explicit slot get PARTNER_DEFAULT_PERCENT each;
  // existing weights are scaled down proportionally so attribution still totals 100 %.
  const explicitPartners = participants.filter((x) => x.type === 'PARTNER').map((x) => x.id);
  const carveOuts = partnerCompaniesFromAssociations(associationsJson, config).filter((id) => explicitPartners.indexOf(id) === -1);
  if (carveOuts.length > 0 && config.splits.partnerPercentScaled > 0n) {
    const full = 100n * 10n ** BigInt(PERCENT_SCALE);
    const carveTotal = config.splits.partnerPercentScaled * BigInt(carveOuts.length);
    if (carveTotal >= full) throw new SplitValidationError('PARTNER_CARVE_OUT_INVALID', 'Partner carve-outs would take 100% or more of the deal.', { partners: carveOuts.length });
    const sumExisting = participants.reduce((a, x) => a + x.weight, 0n);
    // Weights are relative: existing × (100% − carve) and each partner × sumExisting keep exact proportions.
    participants.forEach((x) => (x.weight = x.weight * (full - carveTotal)));
    carveOuts.forEach((id, i) =>
      participants.push({ slot: null, type: 'PARTNER', id, role: 'PARTNER', weight: config.splits.partnerPercentScaled * sumExisting, source: 'PARTNER_ASSOCIATION', carveIndex: i })
    );
    participants.forEach((x) => (x.carvedOut = true));
  }
  return participants;
}

// ---------------------------------------------------------------------------
// Calculation
// ---------------------------------------------------------------------------

/**
 * Validate weights and compute credit and commission per participant.
 * @returns {object} calculation (all money as decimal strings; *Minor fields are integer strings)
 * @throws {SplitValidationError}
 */
function calculateSplits(deal, participants, config) {
  const props = isPlainObject(deal.properties) ? deal.properties : {};
  const currency = String(props[config.hubspot.currencyProperty] || config.defaultCurrency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new SplitValidationError('CURRENCY_INVALID', 'Deal currency must be a 3-letter ISO 4217 code.', { currency: currency.slice(0, 10) });
  const digits = minorDigits(currency);

  const amountRaw = props[config.hubspot.amountProperty];
  if (amountRaw === undefined || amountRaw === null || String(amountRaw).trim() === '') {
    throw new SplitValidationError('AMOUNT_MISSING', `Deal has no ${config.hubspot.amountProperty}.`, { property: config.hubspot.amountProperty });
  }
  let amountMinor;
  try {
    amountMinor = parseDecimal(amountRaw, digits, config.roundingMode);
  } catch (err) {
    throw new SplitValidationError('AMOUNT_INVALID', `Deal ${config.hubspot.amountProperty} is not a valid decimal number.`, { property: config.hubspot.amountProperty });
  }
  if (amountMinor < 0n) throw new SplitValidationError('AMOUNT_NEGATIVE', 'Deal amount is negative.', {});

  // Percent total check (only for explicit weights; carve-outs are constructed to total 100 %).
  const full = 100n * 10n ** BigInt(PERCENT_SCALE);
  const sumWeights = participants.reduce((a, x) => a + x.weight, 0n);
  const carved = participants.some((x) => x.carvedOut);
  const declaredTotal = carved ? null : sumWeights;
  if (!carved && !config.splits.normalizeWeights) {
    const diff = declaredTotal > full ? declaredTotal - full : full - declaredTotal;
    if (diff > config.splits.toleranceScaled) {
      throw new SplitValidationError('PERCENT_TOTAL_MISMATCH', `Split percentages total ${formatScaled(declaredTotal, PERCENT_SCALE)}%, expected 100%.`, {
        total: formatScaled(declaredTotal, PERCENT_SCALE),
        tolerance: formatScaled(config.splits.toleranceScaled, PERCENT_SCALE),
      });
    }
  }

  // Exact allocation: weights are used relative to their sum, so credits always total the amount.
  const credits = allocate(amountMinor, participants.map((x) => x.weight));
  const lines = participants.map((x, i) => {
    const rate = config.rates[x.role] !== undefined ? config.rates[x.role] : config.defaultRate;
    const commissionMinor = divRound(credits[i] * rate, 10n ** BigInt(RATE_SCALE), config.roundingMode);
    const effectivePercent = divRound(x.weight * full, sumWeights, 'HALF_EVEN'); // percent × 10^4
    return {
      slot: x.slot,
      participantType: x.type,
      participantId: x.id,
      role: x.role,
      source: x.source,
      percent: formatScaled(effectivePercent, PERCENT_SCALE),
      creditMinor: credits[i].toString(),
      credit: formatScaled(credits[i], digits),
      commissionRate: formatScaled(rate, RATE_SCALE),
      commissionMinor: commissionMinor.toString(),
      commission: formatScaled(commissionMinor, digits),
      rateSource: config.rates[x.role] !== undefined ? 'ROLE_RATE' : 'DEFAULT_RATE',
    };
  });

  const creditTotal = credits.reduce((a, b) => a + b, 0n);
  if (creditTotal !== amountMinor) {
    // Defensive invariant: allocate() guarantees this; never write inconsistent numbers.
    throw new SplitValidationError('ALLOCATION_INVARIANT_FAILED', 'Allocated credit does not equal the deal amount.', {});
  }
  const commissionTotal = lines.reduce((a, l) => a + BigInt(l.commissionMinor), 0n);
  const fingerprintInput = JSON.stringify([String(deal.id), currency, amountMinor.toString(), config.roundingMode, lines.map((l) => [l.participantType, l.participantId, l.role, l.percent, l.commissionRate])]);
  return {
    calculationId: hash64(fingerprintInput),
    dealId: String(deal.id),
    currency,
    minorDigits: digits,
    amountMinor: amountMinor.toString(),
    amount: formatScaled(amountMinor, digits),
    roundingMode: config.roundingMode,
    declaredPercentTotal: declaredTotal === null ? null : formatScaled(declaredTotal, PERCENT_SCALE),
    normalized: !carved && declaredTotal !== full,
    partnerCarveOut: carved,
    lines,
    totals: { credit: formatScaled(creditTotal, digits), commission: formatScaled(commissionTotal, digits), participants: lines.length },
  };
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

function dealUrl(dealId, config) {
  return config.hubspot.portalId ? `${config.hubspot.appBaseUrl}/contacts/${config.hubspot.portalId}/record/0-3/${encodeURIComponent(dealId)}` : null;
}

/** PATCH body for the deal: summary + optional per-slot credit / commission properties. */
function buildHubSpotUpdate(calc, config, now) {
  const p = config.splits.prefix;
  const properties = {
    split_calculation_id: calc.calculationId,
    split_calculation_status: 'CALCULATED',
    split_calculated_at: now.toISOString(),
    split_total_credit: calc.totals.credit,
    split_total_commission: calc.totals.commission,
    split_participant_count: String(calc.totals.participants),
    split_error_code: '',
  };
  if (config.splits.writeSlotProperties) {
    calc.lines.forEach((l) => {
      if (l.slot) {
        properties[`${p}${l.slot}_credit_amount`] = l.credit;
        properties[`${p}${l.slot}_commission_amount`] = l.commission;
      }
    });
  }
  return { path: `/crm/v3/objects/deals/${encodeURIComponent(calc.dealId)}`, body: { properties } };
}

/** One flat row per participant for Google Sheets / analytics tables. */
function buildSheetRows(calc, deal, config, now) {
  const props = isPlainObject(deal.properties) ? deal.properties : {};
  return calc.lines.map((l, i) => ({
    calculation_id: calc.calculationId,
    line_number: i + 1,
    deal_id: calc.dealId,
    deal_name: String(props.dealname || '').slice(0, 200),
    pipeline: String(props.pipeline || ''),
    close_date: String(props.closedate || '').slice(0, 10),
    currency: calc.currency,
    deal_amount: calc.amount,
    participant_type: l.participantType,
    participant_id: l.participantId,
    role: l.role,
    split_source: l.source,
    split_percent: l.percent,
    credit_amount: l.credit,
    commission_rate: l.commissionRate,
    commission_amount: l.commission,
    rounding_mode: calc.roundingMode,
    calculated_at: now.toISOString(),
    mode: config.sandboxMode ? 'SANDBOX' : 'LIVE',
    calculator_version: CALCULATOR_VERSION,
  }));
}

/** Error payload for the alert webhook (Slack or generic JSON). Always sanitized. */
function buildAlert(errorInfo, context, config) {
  const safe = sanitizeForLog({ error: errorInfo, context: context || {} });
  const title = `Deal split calculation ${errorInfo.stage === 'SYNC' ? 'sync failure' : 'failed'}: ${errorInfo.code}`;
  if (config.sync.alertFormat === 'json') {
    return Object.assign({ event: 'deal_split_error', title, calculatorVersion: CALCULATOR_VERSION, mode: config.sandboxMode ? 'SANDBOX' : 'LIVE' }, safe);
  }
  const url = context && context.dealId ? dealUrl(context.dealId, config) : null;
  const lines = [
    `*Deal:* ${url ? `<${url}|${safe.context.dealId}>` : safe.context.dealId || 'unknown'}`,
    `*Code:* \`${safe.error.code}\``,
    `*Message:* ${String(safe.error.message).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}`,
  ];
  if (safe.error.details && Object.keys(safe.error.details).length) lines.push('```' + JSON.stringify(safe.error.details).slice(0, 1500) + '```');
  return {
    text: title,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `🧮 ${title}`.slice(0, 150), emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 2900) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${config.sandboxMode ? 'SANDBOX · ' : ''}split calculator v${CALCULATOR_VERSION} · details redacted` }] },
    ],
  };
}

/**
 * Full per-deal pipeline used by the "Calculate Splits" Code node.
 * @returns {object} item JSON: kind 'split_result' | 'calc_error' | 'skipped'
 */
function processDeal(dealJson, associationsJson, eventJson, config, now) {
  const at = now && typeof now.toISOString === 'function' ? now : new Date();
  const event = isPlainObject(eventJson) ? eventJson : {};
  const base = { sandbox: Boolean(config.sandboxMode), dealId: event.dealId || null };
  try {
    if (!isPlainObject(dealJson) || dealJson.error || !isPlainObject(dealJson.properties)) {
      const msg = isPlainObject(dealJson) && dealJson.error ? (isPlainObject(dealJson.error) ? dealJson.error.message : dealJson.error) : 'Deal record missing';
      throw new SplitValidationError('DEAL_FETCH_FAILED', 'Could not read the deal from HubSpot.', { reason: redact(String(msg)).slice(0, 300) });
    }
    const deal = { id: String(dealJson.id || event.dealId), properties: dealJson.properties };
    base.dealId = deal.id;
    if (config.hubspot.closedWonStageIds.indexOf(String(deal.properties.dealstage || '')) === -1) {
      return Object.assign(base, { kind: 'skipped', reason: 'NO_LONGER_CLOSED_WON' });
    }
    const participants = extractParticipants(deal, associationsJson, config);
    const calc = calculateSplits(deal, participants, config);
    if (!config.splits.forceRecalculation && deal.properties.split_calculation_id === calc.calculationId) {
      return Object.assign(base, { kind: 'skipped', reason: 'ALREADY_CALCULATED', calculationId: calc.calculationId });
    }
    return Object.assign(base, {
      kind: 'split_result',
      calculationId: calc.calculationId,
      calculation: calc,
      hubspotUpdate: config.sync.hubspotWriteback ? buildHubSpotUpdate(calc, config, at) : null,
      sheetRows: buildSheetRows(calc, deal, config, at),
      analyticsRecord: { calculation: calc, deal: { id: deal.id, pipeline: deal.properties.pipeline || null, closeDate: deal.properties.closedate || null }, calculatedAt: at.toISOString(), mode: config.sandboxMode ? 'SANDBOX' : 'LIVE' },
    });
  } catch (err) {
    const structured = err && err.name === 'SplitValidationError';
    const errorInfo = {
      stage: 'CALCULATION',
      code: structured ? err.code : 'UNEXPECTED_ERROR',
      message: redact(err && err.message ? err.message : String(err)).slice(0, 500),
      details: structured ? sanitizeForLog(err.details) : {},
    };
    return Object.assign(base, {
      kind: 'calc_error',
      error: errorInfo,
      hubspotUpdate:
        config.sync.hubspotWriteback && base.dealId
          ? { path: `/crm/v3/objects/deals/${encodeURIComponent(base.dealId)}`, body: { properties: { split_calculation_status: 'ERROR', split_error_code: errorInfo.code, split_calculated_at: at.toISOString() } } }
          : null,
      alert: config.sync.alertsEnabled ? buildAlert(errorInfo, { dealId: base.dealId }, config) : null,
    });
  }
}

/** Turn a failed sync request (n8n error output item) into a sanitized alert item. */
function buildSyncErrorItem(itemJson, target, config) {
  const j = isPlainObject(itemJson) ? itemJson : {};
  const err = isPlainObject(j.error) ? j.error : { message: j.error ? String(j.error) : 'Unknown sync error' };
  const status = Number(err.httpCode || err.statusCode || err.status) || null;
  const errorInfo = {
    stage: 'SYNC',
    code: `SYNC_${String(target || 'UNKNOWN').toUpperCase()}_FAILED`,
    message: redact(err.message || err.description || 'Request failed').slice(0, 500),
    details: sanitizeForLog({ target, httpStatus: status, calculationId: j.calculationId || j.calculation_id || null }),
  };
  return { kind: 'sync_error', sandbox: Boolean(config.sandboxMode), dealId: j.dealId || j.deal_id || null, error: errorInfo, alert: config.sync.alertsEnabled ? buildAlert(errorInfo, { dealId: j.dealId || j.deal_id || null }, config) : null };
}

/** Sanitized summary for SANDBOX_MODE. */
function buildDryRunReport(items) {
  const list = (Array.isArray(items) ? items : []).filter(isPlainObject);
  const lines = list.map((i) => {
    if (i.kind === 'split_result') {
      const c = i.calculation;
      return `[splits] DRY RUN deal=${i.dealId} ${c.currency} ${c.amount} → ${c.lines.map((l) => `${l.participantType}:${l.participantId}(${l.role}) ${l.percent}% credit=${l.credit} comm=${l.commission}`).join(' | ')} id=${i.calculationId}`;
    }
    if (i.kind === 'calc_error') return `[splits] DRY RUN deal=${i.dealId} ERROR ${i.error.code}: ${i.error.message}`;
    return `[splits] DRY RUN deal=${i.dealId} skipped (${i.reason || i.kind})`;
  });
  return {
    kind: 'dry_run_report',
    mode: 'SANDBOX',
    totals: {
      deals: list.length,
      calculated: list.filter((i) => i.kind === 'split_result').length,
      errors: list.filter((i) => i.kind === 'calc_error').length,
      skipped: list.filter((i) => i.kind === 'skipped').length,
      sheetRows: list.filter((i) => i.kind === 'split_result').reduce((n, i) => n + i.sheetRows.length, 0),
    },
    lines: lines.map(redact),
  };
}

module.exports = {
  CALCULATOR_VERSION,
  ENV_KEYS,
  DEFAULTS,
  PERCENT_SCALE,
  RATE_SCALE,
  ConfigError,
  SplitValidationError,
  isPlaceholder,
  loadConfig,
  divRound,
  parseDecimal,
  formatScaled,
  minorDigits,
  allocate,
  redact,
  sanitizeForLog,
  constantTimeEqual,
  hash64,
  normalizeEvents,
  dealPropertiesToFetch,
  partnerCompaniesFromAssociations,
  extractParticipants,
  calculateSplits,
  buildHubSpotUpdate,
  buildSheetRows,
  buildAlert,
  processDeal,
  buildSyncErrorItem,
  buildDryRunReport,
};
