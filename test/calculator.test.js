'use strict';

/**
 * test/calculator.test.js
 * Unit tests for calculator.js (node:test). All data is synthetic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../calculator');

const NOW = new Date('2026-06-01T00:00:00.000Z');
const cfg = (o) => C.loadConfig(Object.assign({ WEBHOOK_SECRET: 'test-only-split-secret-0000' }, o || {}));
const deal = (id, props) => ({ id: String(id), properties: Object.assign({ dealstage: 'closedwon', hubspot_owner_id: '901', deal_currency_code: 'USD' }, props) });
const partnerAssoc = (ids, label) => ({ results: ids.map((id) => ({ toObjectId: id, associationTypes: [{ category: 'USER_DEFINED', typeId: 42, label: label || 'Referral Partner' }] })) });
const expectCode = (fn, code) => assert.throws(fn, (e) => e.name === 'SplitValidationError' && e.code === code);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('config: safe defaults and every key declared', () => {
  const c = C.loadConfig({});
  assert.equal(c.sandboxMode, true);
  assert.equal(c.roundingMode, 'HALF_EVEN');
  assert.deepEqual(c.hubspot.closedWonStageIds, ['closedwon']);
  assert.equal(c.rates.AE, 100000n);
  Object.keys(C.DEFAULTS).forEach((k) => assert.ok(C.ENV_KEYS.includes(k), k));
  assert.ok(c.warnings.some((w) => w.includes('WEBHOOK_SECRET')));
});

test('config: endpoints are presence-checked only, never stored', () => {
  const c = cfg({ GOOGLE_SHEET_ID: 'synthetic-sheet-id-000000', ALERT_WEBHOOK_URL: 'https://alerts.example/hook', ANALYTICS_INGEST_URL: 'https://analytics.example/ingest' });
  const text = JSON.stringify(c, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  ['synthetic-sheet-id', 'alerts.example', 'analytics.example', 'test-only-split-secret'].forEach((s) => (s === 'test-only-split-secret' ? null : assert.ok(!text.includes(s), s)));
  assert.equal(c.sync.sheetConfigured, true);
  assert.equal(C.loadConfig({ GOOGLE_SHEET_ID: 'REPLACE_WITH_GOOGLE_SHEET_ID' }).sync.sheetConfigured, false);
});

test('config: fail fast with every problem listed; live requirements', () => {
  assert.throws(
    () =>
      C.loadConfig({
        SANDBOX_MODE: 'maybe',
        WEBHOOK_SECRET: 'short',
        ROUNDING_MODE: 'CEILING',
        DEFAULT_CURRENCY: 'DOLLARS',
        MAX_SPLIT_SLOTS: '0',
        PERCENT_TOLERANCE: '5',
        PARTNER_DEFAULT_PERCENT: '150',
        COMMISSION_RATES_JSON: '{"AE":"1.5"}',
        SPLIT_PROPERTY_PREFIX: 'Split-',
        ALERT_FORMAT: 'xml',
        CLOSED_WON_STAGE_IDS: 'REPLACE_WITH_STAGE_ID',
      }),
    (err) => {
      assert.ok(err instanceof C.ConfigError);
      const t = err.problems.join('\n');
      ['SANDBOX_MODE', 'WEBHOOK_SECRET', 'ROUNDING_MODE', 'DEFAULT_CURRENCY', 'MAX_SPLIT_SLOTS', 'PERCENT_TOLERANCE', 'PARTNER_DEFAULT_PERCENT', 'COMMISSION_RATES_JSON', 'SPLIT_PROPERTY_PREFIX', 'ALERT_FORMAT', 'CLOSED_WON_STAGE_IDS'].forEach((n) =>
        assert.ok(t.includes(n), n)
      );
      return true;
    }
  );
  assert.throws(() => cfg({ SANDBOX_MODE: 'false' }), /GOOGLE_SHEET_ID is required/);
  assert.throws(() => cfg({ SANDBOX_MODE: 'false', ENABLE_GOOGLE_SHEETS: 'false', ENABLE_ALERTS: 'false', ENABLE_HUBSPOT_WRITEBACK: 'false' }), /No sync target/);
});

// ---------------------------------------------------------------------------
// Exact arithmetic
// ---------------------------------------------------------------------------

test('parseDecimal: exact scaling, rounding modes and rejection of junk', () => {
  assert.equal(C.parseDecimal('12500.5', 2, 'HALF_EVEN'), 1250050n);
  assert.equal(C.parseDecimal('1.005', 2, 'HALF_EVEN'), 100n, 'banker rounding: half to even');
  assert.equal(C.parseDecimal('1.015', 2, 'HALF_EVEN'), 102n);
  assert.equal(C.parseDecimal('1.005', 2, 'HALF_UP'), 101n);
  assert.equal(C.parseDecimal('1.009', 2, 'DOWN'), 100n);
  assert.equal(C.parseDecimal('-2.5', 0, 'HALF_EVEN'), -2n);
  assert.equal(C.parseDecimal(19.99, 2, 'HALF_EVEN'), 1999n);
  assert.equal(C.parseDecimal('1e-7', 6, 'HALF_EVEN'), 0n);
  ['abc', '1.2.3', '', '1,000.00', '12345678901234567890'].forEach((v) => assert.throws(() => C.parseDecimal(v, 2, 'HALF_EVEN'), RangeError, v));
});

test('divRound and formatScaled', () => {
  assert.equal(C.divRound(5n, 2n, 'HALF_EVEN'), 2n);
  assert.equal(C.divRound(7n, 2n, 'HALF_EVEN'), 4n);
  assert.equal(C.divRound(5n, 2n, 'HALF_UP'), 3n);
  assert.equal(C.divRound(9n, 4n, 'DOWN'), 2n);
  assert.equal(C.divRound(-5n, 2n, 'HALF_UP'), -3n);
  assert.throws(() => C.divRound(1n, 0n, 'HALF_UP'), RangeError);
  assert.equal(C.formatScaled(123456n, 2), '1234.56');
  assert.equal(C.formatScaled(5n, 3), '0.005');
  assert.equal(C.formatScaled(-150n, 2), '-1.50');
  assert.equal(C.formatScaled(42n, 0), '42');
});

test('allocate: parts always sum exactly to the total (largest remainder)', () => {
  assert.deepEqual(C.allocate(100n, [1n, 1n, 1n]), [34n, 33n, 33n]);
  assert.deepEqual(C.allocate(1n, [1n, 1n]), [1n, 0n], 'ties go to the earlier participant');
  assert.deepEqual(C.allocate(0n, [3n, 7n]), [0n, 0n]);
  assert.deepEqual(C.allocate(-100n, [1n, 1n, 1n]), [-34n, -33n, -33n]);
  // Property check over many random cases.
  let seed = 7;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (let i = 0; i < 500; i += 1) {
    const total = BigInt(rand(10000000));
    const weights = Array.from({ length: 1 + rand(7) }, () => BigInt(1 + rand(1000000)));
    const parts = C.allocate(total, weights);
    assert.equal(parts.reduce((a, b) => a + b, 0n), total);
    parts.forEach((p) => assert.ok(p >= 0n));
  }
  assert.throws(() => C.allocate(10n, [0n, 0n]), (e) => e.code === 'PERCENT_TOTAL_ZERO');
});

test('minor units per currency', () => {
  assert.deepEqual([C.minorDigits('USD'), C.minorDigits('JPY'), C.minorDigits('KWD'), C.minorDigits('EUR')], [2, 0, 3, 2]);
});

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

test('extractParticipants: split slots, owner default and partner carve-out', () => {
  const c = cfg();
  const slots = C.extractParticipants(deal(1, { split_1_owner_id: '901', split_1_percent: '60', split_1_role: 'ae', split_2_partner_company_id: '7001', split_2_percent: '40' }), null, c);
  assert.deepEqual(slots.map((p) => [p.slot, p.type, p.id, p.role, p.source]), [
    [1, 'REP', '901', 'AE', 'SPLIT_PROPERTIES'],
    [2, 'PARTNER', '7001', 'PARTNER', 'SPLIT_PROPERTIES'],
  ]);
  const owner = C.extractParticipants(deal(2, {}), null, c);
  assert.deepEqual(owner.map((p) => [p.id, p.source, p.weight]), [['901', 'DEAL_OWNER_DEFAULT', 1000000n]]);
  const carved = C.extractParticipants(deal(3, {}), partnerAssoc([7001, 7002]), c);
  assert.deepEqual(carved.map((p) => [p.type, p.id, p.source]), [['REP', '901', 'DEAL_OWNER_DEFAULT'], ['PARTNER', '7001', 'PARTNER_ASSOCIATION'], ['PARTNER', '7002', 'PARTNER_ASSOCIATION']]);
  // An explicit partner slot is not carved out twice.
  const explicit = C.extractParticipants(deal(4, { split_1_owner_id: '901', split_1_percent: '90', split_2_partner_company_id: '7001', split_2_percent: '10' }), partnerAssoc([7001]), c);
  assert.equal(explicit.length, 2);
  assert.equal(C.extractParticipants(deal(5, {}), partnerAssoc([7001], 'Reseller'), c).length, 1, 'other labels ignored');
  assert.equal(C.extractParticipants(deal(6, {}), partnerAssoc([7001]), cfg({ ENABLE_PARTNER_ASSOCIATIONS: 'false' })).length, 1);
});

test('extractParticipants: structured validation errors', () => {
  const c = cfg();
  expectCode(() => C.extractParticipants(deal(1, { split_1_percent: '50' }), null, c), 'PARTICIPANT_MISSING');
  expectCode(() => C.extractParticipants(deal(1, { split_1_owner_id: '901' }), null, c), 'PERCENT_MISSING');
  expectCode(() => C.extractParticipants(deal(1, { split_1_owner_id: '901', split_1_partner_company_id: '7', split_1_percent: '50' }), null, c), 'PARTICIPANT_AMBIGUOUS');
  expectCode(() => C.extractParticipants(deal(1, { split_1_owner_id: '901', split_1_percent: '0' }), null, c), 'PERCENT_INVALID');
  expectCode(() => C.extractParticipants(deal(1, { split_1_owner_id: '901', split_1_percent: '120' }), null, c), 'PERCENT_INVALID');
  expectCode(() => C.extractParticipants(deal(1, { split_1_owner_id: '901', split_1_percent: 'half' }), null, c), 'PERCENT_INVALID');
  expectCode(() => C.extractParticipants(deal(1, { split_1_owner_id: 'abc', split_1_percent: '50' }), null, c), 'PARTICIPANT_INVALID');
  expectCode(() => C.extractParticipants(deal(1, { split_1_owner_id: '901', split_1_percent: '50', split_2_owner_id: '901', split_2_percent: '50' }), null, c), 'DUPLICATE_PARTICIPANT');
  expectCode(() => C.extractParticipants(deal(1, { split_1_owner_id: '901', split_1_percent: '50', split_1_role: 'sales rep!' }), null, c), 'ROLE_INVALID');
  expectCode(() => C.extractParticipants(deal(1, { hubspot_owner_id: '' }), null, c), 'NO_PARTICIPANTS');
  expectCode(() => C.extractParticipants(deal(1, {}), partnerAssoc([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), c), 'PARTNER_CARVE_OUT_INVALID');
});

// ---------------------------------------------------------------------------
// Calculation
// ---------------------------------------------------------------------------

test('calculateSplits: weighted credit and per-role commission', () => {
  const c = cfg();
  const d = deal(1001, { amount: '120000.00', split_1_owner_id: '901', split_1_percent: '50', split_1_role: 'AE', split_2_owner_id: '902', split_2_percent: '30', split_2_role: 'SDR', split_3_owner_id: '903', split_3_percent: '20', split_3_role: 'SE' });
  const calc = C.calculateSplits(d, C.extractParticipants(d, partnerAssoc([7001]), c), c);
  assert.deepEqual(calc.lines.map((l) => [l.participantId, l.role, l.percent, l.credit, l.commissionRate, l.commission]), [
    ['901', 'AE', '45.0000', '54000.00', '0.100000', '5400.00'],
    ['902', 'SDR', '27.0000', '32400.00', '0.050000', '1620.00'],
    ['903', 'SE', '18.0000', '21600.00', '0.020000', '432.00'],
    ['7001', 'PARTNER', '10.0000', '12000.00', '0.150000', '1800.00'],
  ]);
  assert.deepEqual(calc.totals, { credit: '120000.00', commission: '9252.00', participants: 4 });
  assert.equal(calc.partnerCarveOut, true);
  assert.match(calc.calculationId, /^[0-9a-f]{16}$/);
});

test('calculateSplits: thirds never lose or invent a cent', () => {
  const c = cfg();
  const d = deal(1, { amount: '100.00', split_1_owner_id: '1', split_1_percent: '33.3333', split_2_owner_id: '2', split_2_percent: '33.3333', split_3_owner_id: '3', split_3_percent: '33.3334' });
  const calc = C.calculateSplits(d, C.extractParticipants(d, null, c), c);
  assert.deepEqual(calc.lines.map((l) => l.credit), ['33.33', '33.33', '33.34']);
  assert.equal(calc.totals.credit, '100.00');
});

test('calculateSplits: currency minor units, tolerance, normalization and rounding modes', () => {
  const c = cfg();
  const jpy = deal(1, { amount: '1000000', deal_currency_code: 'JPY', split_1_owner_id: '1', split_1_percent: '33.33', split_2_owner_id: '2', split_2_percent: '66.67' });
  assert.deepEqual(C.calculateSplits(jpy, C.extractParticipants(jpy, null, c), c).lines.map((l) => [l.credit, l.commission]), [['333300', '33330'], ['666700', '66670']]);
  const kwd = deal(2, { amount: '10.0005', deal_currency_code: 'KWD' });
  assert.equal(C.calculateSplits(kwd, C.extractParticipants(kwd, null, c), c).amount, '10.000', 'half-even at 3 decimals');

  const nearly = deal(3, { amount: '1000', split_1_owner_id: '1', split_1_percent: '33.33', split_2_owner_id: '2', split_2_percent: '33.33', split_3_owner_id: '3', split_3_percent: '33.33' });
  const calc = C.calculateSplits(nearly, C.extractParticipants(nearly, null, c), c);
  assert.equal(calc.totals.credit, '1000.00', '99.99% is within tolerance and allocated exactly');
  assert.equal(calc.normalized, true);

  const off = deal(4, { amount: '1000', split_1_owner_id: '1', split_1_percent: '60', split_2_owner_id: '2', split_2_percent: '30' });
  expectCode(() => C.calculateSplits(off, C.extractParticipants(off, null, c), c), 'PERCENT_TOTAL_MISMATCH');
  const normalized = cfg({ NORMALIZE_WEIGHTS: 'true' });
  assert.deepEqual(C.calculateSplits(off, C.extractParticipants(off, null, normalized), normalized).lines.map((l) => [l.percent, l.credit]), [['66.6667', '666.67'], ['33.3333', '333.33']]);

  const half = deal(5, { amount: '0.25', split_1_owner_id: '1', split_1_percent: '100', split_1_role: 'X' });
  const rate = cfg({ COMMISSION_RATES_JSON: '{"X":"0.5"}' });
  assert.equal(C.calculateSplits(half, C.extractParticipants(half, null, rate), rate).lines[0].commission, '0.12', 'HALF_EVEN: 0.125 -> 0.12');
  const up = cfg({ COMMISSION_RATES_JSON: '{"X":"0.5"}', ROUNDING_MODE: 'HALF_UP' });
  assert.equal(C.calculateSplits(half, C.extractParticipants(half, null, up), up).lines[0].commission, '0.13');
  const unknownRole = deal(6, { amount: '100', split_1_owner_id: '1', split_1_percent: '100', split_1_role: 'INTERN' });
  assert.equal(C.calculateSplits(unknownRole, C.extractParticipants(unknownRole, null, c), c).lines[0].rateSource, 'DEFAULT_RATE');
});

test('calculateSplits: amount and currency validation', () => {
  const c = cfg();
  const run = (props) => {
    const d = deal(1, props);
    return () => C.calculateSplits(d, C.extractParticipants(d, null, c), c);
  };
  expectCode(run({}), 'AMOUNT_MISSING');
  expectCode(run({ amount: 'ten thousand' }), 'AMOUNT_INVALID');
  expectCode(run({ amount: '-5' }), 'AMOUNT_NEGATIVE');
  expectCode(run({ amount: '5', deal_currency_code: 'DOLLAR' }), 'CURRENCY_INVALID');
  assert.equal(run({ amount: '0' })().totals.credit, '0.00', 'zero-value deals are allowed');
});

test('calculationId is deterministic and changes with any input', () => {
  const c = cfg();
  const make = (amount, pct) => {
    const d = deal(9, { amount, split_1_owner_id: '1', split_1_percent: pct, split_2_owner_id: '2', split_2_percent: String(100 - Number(pct)) });
    return C.calculateSplits(d, C.extractParticipants(d, null, c), c).calculationId;
  };
  assert.equal(make('100', '50'), make('100', '50'));
  assert.notEqual(make('100', '50'), make('101', '50'));
  assert.notEqual(make('100', '50'), make('100', '60'));
});

// ---------------------------------------------------------------------------
// Pipeline, outputs, redaction
// ---------------------------------------------------------------------------

test('processDeal: result, idempotent skip, stage re-check and structured errors', () => {
  const c = cfg({ HUBSPOT_PORTAL_ID: '12345678' });
  const d = deal(1001, { amount: '1000', dealname: 'Synthetic Deal 1001', split_1_owner_id: '901', split_1_percent: '100', split_1_role: 'AE' });
  const r = C.processDeal(d, null, { dealId: '1001' }, c, NOW);
  assert.equal(r.kind, 'split_result');
  assert.equal(r.hubspotUpdate.path, '/crm/v3/objects/deals/1001');
  assert.deepEqual(r.hubspotUpdate.body.properties, {
    split_calculation_id: r.calculationId,
    split_calculation_status: 'CALCULATED',
    split_calculated_at: NOW.toISOString(),
    split_total_credit: '1000.00',
    split_total_commission: '100.00',
    split_participant_count: '1',
    split_error_code: '',
    split_1_credit_amount: '1000.00',
    split_1_commission_amount: '100.00',
  });
  assert.equal(r.sheetRows[0].deal_name, 'Synthetic Deal 1001');
  assert.equal(r.sheetRows[0].mode, 'SANDBOX');

  const again = C.processDeal(deal(1001, Object.assign({}, d.properties, { split_calculation_id: r.calculationId })), null, {}, c, NOW);
  assert.deepEqual([again.kind, again.reason], ['skipped', 'ALREADY_CALCULATED']);
  assert.equal(C.processDeal(deal(1001, Object.assign({}, d.properties, { split_calculation_id: r.calculationId })), null, {}, cfg({ FORCE_RECALCULATION: 'true' }), NOW).kind, 'split_result');
  assert.equal(C.processDeal(deal(1001, Object.assign({}, d.properties, { dealstage: 'contractsent' })), null, {}, c, NOW).reason, 'NO_LONGER_CLOSED_WON');

  const bad = C.processDeal(deal(1003, { amount: '10', split_1_owner_id: '1', split_1_percent: '60' }), null, { dealId: '1003' }, c, NOW);
  assert.equal(bad.kind, 'calc_error');
  assert.equal(bad.error.code, 'PERCENT_TOTAL_MISMATCH');
  assert.deepEqual(bad.hubspotUpdate.body.properties, { split_calculation_status: 'ERROR', split_error_code: 'PERCENT_TOTAL_MISMATCH', split_calculated_at: NOW.toISOString() });
  assert.match(JSON.stringify(bad.alert), /record\/0-3\/1003/);

  const fetchFailed = C.processDeal({ error: { message: 'Unauthorized: Bearer abc.def for ops@example.com' } }, null, { dealId: '1007' }, c, NOW);
  assert.equal(fetchFailed.error.code, 'DEAL_FETCH_FAILED');
  assert.ok(!JSON.stringify(fetchFailed).includes('abc.def') && !JSON.stringify(fetchFailed).includes('ops@example.com'));
});

test('slot properties can be disabled; write-back can be disabled', () => {
  const d = deal(1, { amount: '100', split_1_owner_id: '1', split_1_percent: '100' });
  const noSlots = C.processDeal(d, null, {}, cfg({ WRITE_SLOT_PROPERTIES: 'false' }), NOW);
  assert.equal('split_1_credit_amount' in noSlots.hubspotUpdate.body.properties, false);
  assert.equal(C.processDeal(d, null, {}, cfg({ ENABLE_HUBSPOT_WRITEBACK: 'false' }), NOW).hubspotUpdate, null);
});

test('normalizeEvents: stage filter, secret check, dedupe and limits', () => {
  const c = cfg({ CLOSED_WON_STAGE_IDS: 'closedwon,7654321' });
  const ev = (id, stage, extra) => Object.assign({ subscriptionType: 'deal.propertyChange', propertyName: 'dealstage', propertyValue: stage, objectId: id }, extra);
  const hook = (body, secret) => ({ headers: { 'X-Split-Secret': secret }, body });
  const out = C.normalizeEvents(
    [
      ev(1, 'closedwon'),
      ev(2, '7654321'),
      ev(1, 'closedwon'),
      ev(3, 'contractsent'),
      ev(4, 'closedwon', { propertyName: 'amount' }),
      ev(5, 'closedwon', { subscriptionType: 'contact.creation' }),
      { objectId: 'abc', propertyValue: 'closedwon' },
      hook({ objectId: 6, properties: { dealstage: { value: 'closedwon' } } }, 'test-only-split-secret-0000'),
      hook({ objectId: 7, properties: { dealstage: 'closedwon' } }, 'wrong-secret-000000000'),
      hook({ objectId: 8 }, undefined),
      null,
    ],
    c
  );
  assert.deepEqual(out.deals.map((d) => [d.dealId, d.source]), [['1', 'hubspot_trigger'], ['2', 'hubspot_trigger'], ['6', 'workflow_webhook']]);
  assert.deepEqual(out.rejected, { DUPLICATE: 1, NOT_CLOSED_WON: 1, NOT_DEALSTAGE_CHANGE: 1, UNSUPPORTED_SUBSCRIPTION: 1, MISSING_DEAL_ID: 1, SECRET_MISMATCH: 1, SECRET_MISSING: 1, INVALID_EVENT: 1 });
  const limited = C.normalizeEvents([ev(1, 'closedwon'), ev(2, 'closedwon')], cfg({ MAX_DEALS_PER_RUN: '1' }));
  assert.deepEqual(limited.rejected, { RUN_LIMIT_REACHED: 1 });
});

test('dealPropertiesToFetch includes every slot property without duplicates', () => {
  const props = C.dealPropertiesToFetch(cfg({ MAX_SPLIT_SLOTS: '3' }));
  ['amount', 'deal_currency_code', 'split_3_owner_id', 'split_3_partner_company_id', 'split_calculation_id'].forEach((p) => assert.ok(props.includes(p), p));
  assert.ok(!props.includes('split_4_owner_id'));
  assert.equal(new Set(props).size, props.length);
});

test('redact and sanitizeForLog scrub tokens, headers, PII and connection strings', () => {
  const text = C.redact('jane@example.com Bearer abc.def Basic dXNlcg== pat-na1-SYNTHETIC ya29.synthetic postgres://user:pw@db.example:5432/x ?hapikey=123 "password": "pw1"');
  ['jane@example.com', 'abc.def', 'dXNlcg==', 'pat-na1-SYNTHETIC', 'ya29.synthetic', 'user:pw', 'hapikey=123', 'pw1'].forEach((s) => assert.ok(!text.includes(s), s));
  const safe = C.sanitizeForLog({ headers: { Authorization: 'Bearer x', 'x-split-secret': 'y', 'content-type': 'json' }, email: 'jane@example.com', firstname: 'Jane', amount: 10n, nested: { note: 'contact jane@example.com' } });
  assert.deepEqual(safe, { headers: { Authorization: '[redacted]', 'x-split-secret': '[redacted]', 'content-type': 'json' }, email: '[redacted-pii]', firstname: '[redacted-pii]', amount: '10', nested: { note: 'contact [redacted-email]' } });
  assert.equal(C.sanitizeForLog({ a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } }).a.b.c.d.e.f.g, '[truncated]');
});

test('alerts: Slack and JSON formats are sanitized', () => {
  const info = { stage: 'CALCULATION', code: 'AMOUNT_INVALID', message: 'bad <amount> for jane@example.com', details: { token: 'abc', field: 'amount' } };
  const slack = C.buildAlert(info, { dealId: '1' }, cfg());
  const s = JSON.stringify(slack);
  assert.ok(!s.includes('jane@example.com') && !s.includes('"abc"'));
  assert.match(s, /&lt;amount&gt;/);
  const json = C.buildAlert(info, { dealId: '1' }, cfg({ ALERT_FORMAT: 'json' }));
  assert.equal(json.event, 'deal_split_error');
  assert.equal(json.error.details.token, '[redacted]');
  const sync = C.buildSyncErrorItem({ dealId: '5', calculationId: 'c1', error: { message: 'Bearer zzz rejected', httpCode: '401' } }, 'hubspot', cfg());
  assert.equal(sync.error.code, 'SYNC_HUBSPOT_FAILED');
  assert.equal(sync.error.details.httpStatus, 401);
  assert.ok(!JSON.stringify(sync).includes('zzz'));
});

test('buildDryRunReport', () => {
  const c = cfg();
  const ok = C.processDeal(deal(1, { amount: '100' }), null, {}, c, NOW);
  const err = C.processDeal(deal(2, {}), null, {}, c, NOW);
  const report = C.buildDryRunReport([ok, err, { kind: 'skipped', dealId: '3', reason: 'ALREADY_CALCULATED' }]);
  assert.deepEqual(report.totals, { deals: 3, calculated: 1, errors: 1, skipped: 1, sheetRows: 1 });
  assert.ok(report.lines[0].includes('REP:901(AE) 100.0000% credit=100.00 comm=10.00'));
});
