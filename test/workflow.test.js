'use strict';

/**
 * test/workflow.test.js
 * ---------------------------------------------------------------------------
 * 1. Structure: workflow.json is valid, matches a fresh build and wires the
 *    trigger → lookup → calculation → dual sync → error branch correctly.
 * 2. Execution: replays the generated Code nodes against synthetic fixtures in
 *    a VM that mimics the n8n runtime ($input, $env, $(...).itemMatching).
 * 3. Security scan: no live tokens, webhook URLs, sheet IDs or real emails.
 * ---------------------------------------------------------------------------
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildWorkflow, serialize } = require('../scripts/build-workflow');

const ROOT = path.resolve(__dirname, '..');
const workflow = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'));
const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
const SECRET = 'test-only-split-secret-0000';
const ENV = Object.freeze({ SANDBOX_MODE: 'true', WEBHOOK_SECRET: SECRET, HUBSPOT_PORTAL_ID: '12345678' });
const LIVE = Object.freeze(
  Object.assign({}, ENV, { SANDBOX_MODE: 'false', GOOGLE_SHEET_ID: 'synthetic-sheet-id-000000', ALERT_WEBHOOK_URL: 'https://alerts.example/hook' })
);
const node = (name) => {
  const n = workflow.nodes.find((x) => x.name === name);
  assert.ok(n, `missing node ${name}`);
  return n;
};

async function runCodeNode(name, inputJsons, opts) {
  const o = opts || {};
  const items = (inputJsons || []).map((json) => ({ json }));
  const logs = [];
  const paired = o.paired || {};
  const ctx = {
    $input: { all: () => items, first: () => items[0] },
    $execution: { id: 'test-exec-1' },
    $: (nodeName) => ({
      itemMatching: (i) => {
        if (!paired[nodeName] || paired[nodeName][i] === undefined) throw new Error(`no pairing for ${nodeName}`);
        return { json: paired[nodeName][i] };
      },
    }),
    console: { log: (...a) => logs.push(a.join(' ')), warn: () => {}, error: () => {} },
  };
  if (o.blockEnv) {
    Object.defineProperty(ctx, '$env', {
      get() {
        throw new Error('access to env vars denied');
      },
    });
  } else ctx.$env = o.env || ENV;
  const result = await vm.runInNewContext(`(async () => {\n${node(name).parameters.jsCode}\n})()`, ctx, { timeout: 10000 });
  return { output: JSON.parse(JSON.stringify(result || [])), logs };
}

/** Replay trigger → lookups → calculation using fixtures (no network). */
async function simulate(env) {
  const e = env || ENV;
  const events = await runCodeNode('Normalize Closed-Won Events', fx('hubspot-trigger-events.json').events, { env: e });
  const evs = events.output.map((i) => i.json);
  const deals = fx('hubspot-deals.json').deals;
  const assoc = fx('hubspot-associations.json').associations;
  const dealResponses = evs.map((ev) => deals[ev.dealId] || { error: { message: 'Request failed with status code 404', httpCode: '404' } });
  const assocResponses = evs.map((ev) => assoc[ev.dealId] || { results: [] });
  const calc = await runCodeNode('Calculate Splits', assocResponses, { env: e, paired: { 'Normalize Closed-Won Events': evs, 'HubSpot Get Deal': dealResponses } });
  return { events, evs, results: calc.output.map((i) => i.json) };
}

// ---------------------------------------------------------------------------
// 1. Structure
// ---------------------------------------------------------------------------

test('workflow.json is valid, imports inactive and matches a fresh build', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'), serialize(buildWorkflow()), 'run npm run build');
  assert.equal(workflow.active, false);
  assert.equal(new Set(workflow.nodes.map((n) => n.id)).size, workflow.nodes.length);
  assert.equal(new Set(workflow.nodes.map((n) => n.name)).size, workflow.nodes.length);
});

test('required nodes: trigger, lookups, calculation, dual sync and error branch', () => {
  const expected = {
    'HubSpot Deal Stage Changed': 'n8n-nodes-base.hubspotTrigger',
    'Closed-Won Workflow Webhook': 'n8n-nodes-base.webhook',
    'Normalize Closed-Won Events': 'n8n-nodes-base.code',
    'HubSpot Get Deal': 'n8n-nodes-base.httpRequest',
    'HubSpot Get Partner Associations': 'n8n-nodes-base.httpRequest',
    'Calculate Splits': 'n8n-nodes-base.code',
    'Sandbox Mode?': 'n8n-nodes-base.if',
    'Route Results': 'n8n-nodes-base.switch',
    'HubSpot Update Deal Split Properties': 'n8n-nodes-base.httpRequest',
    'Google Sheets Append Splits': 'n8n-nodes-base.googleSheets',
    'Analytics Ingest': 'n8n-nodes-base.httpRequest',
    'HubSpot Flag Calculation Error': 'n8n-nodes-base.httpRequest',
    'Sanitize Sync Error': 'n8n-nodes-base.code',
    'Send Redacted Alert': 'n8n-nodes-base.httpRequest',
  };
  Object.entries(expected).forEach(([name, type]) => assert.equal(node(name).type, type, name));
  assert.deepEqual(node('HubSpot Deal Stage Changed').parameters.eventsUi.eventValues[0], { name: 'deal.propertyChange', property: 'dealstage' });
});

test('connections: every sync node routes failures to the redaction branch', () => {
  const c = workflow.connections;
  const names = new Set(workflow.nodes.map((n) => n.name));
  Object.values(c).forEach((v) => v.main.forEach((b) => b.forEach((l) => assert.ok(names.has(l.node), l.node))));
  ['HubSpot Update Deal Split Properties', 'Google Sheets Append Splits', 'Analytics Ingest', 'HubSpot Flag Calculation Error'].forEach((n) => {
    assert.equal(node(n).onError, 'continueErrorOutput', n);
    assert.equal(c[n].main[1][0].node, 'Sanitize Sync Error', n);
  });
  assert.deepEqual(c['Route Results'].main[0].map((l) => l.node), ['HubSpot Write-back Enabled?', 'Build Sheet Rows', 'Build Analytics Records']);
  assert.deepEqual(c['Route Results'].main[1].map((l) => l.node), ['Flag Error on Deal?', 'Build Calculation Alert']);
  assert.equal(c['Sanitize Sync Error'].main[0][0].node, 'Send Redacted Alert');
});

test('no hardcoded endpoints or credentials', () => {
  workflow.nodes.filter((n) => n.credentials).forEach((n) => Object.values(n.credentials).forEach((cr) => {
    assert.match(cr.id, /^REPLACE_WITH_/, n.name);
    assert.match(cr.name, /REPLACE_WITH_/, n.name);
  }));
  assert.equal(node('Send Redacted Alert').parameters.url, '={{ $env.ALERT_WEBHOOK_URL }}');
  assert.equal(node('Analytics Ingest').parameters.url, '={{ $env.ANALYTICS_INGEST_URL }}');
  assert.equal(node('Google Sheets Append Splits').parameters.documentId.value, '={{ $env.GOOGLE_SHEET_ID }}');
  workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest').forEach((n) => assert.equal(n.retryOnFail, true, n.name));
});

// ---------------------------------------------------------------------------
// 2. Execution against fixtures
// ---------------------------------------------------------------------------

test('events: Closed-Won only, duplicates dropped, lookup URLs built', async () => {
  const { events, evs } = await simulate();
  assert.deepEqual(evs.map((e) => e.dealId), ['1001', '1002', '1003', '1005', '1006', '1007']);
  assert.ok(events.logs.some((l) => l.includes('"DUPLICATE":1') && l.includes('"NOT_CLOSED_WON":1')));
  assert.match(evs[0].dealUrl, /^https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/deals\/1001\?properties=.*split_1_percent/);
  assert.equal(evs[0].associationsUrl, 'https://api.hubapi.com/crm/v4/objects/deals/1001/associations/companies');
});

test('calculation results for every fixture deal', async () => {
  const { results } = await simulate();
  const byId = Object.fromEntries(results.map((r) => [r.dealId, r]));
  const d1 = byId['1001'].calculation;
  assert.deepEqual(d1.lines.map((l) => [l.participantId, l.percent, l.credit, l.commission]), [
    ['901', '45.0000', '54000.00', '5400.00'],
    ['902', '27.0000', '32400.00', '1620.00'],
    ['903', '18.0000', '21600.00', '432.00'],
    ['7001', '10.0000', '12000.00', '1800.00'],
  ]);
  assert.deepEqual(byId['1002'].calculation.totals, { credit: '45000.00', commission: '4500.00', participants: 1 });
  assert.equal(byId['1002'].calculation.currency, 'EUR');
  assert.deepEqual(byId['1006'].calculation.lines.map((l) => l.credit), ['333300', '666700']);
  assert.deepEqual([byId['1003'].kind, byId['1003'].error.code], ['calc_error', 'PERCENT_TOTAL_MISMATCH']);
  assert.equal(byId['1005'].error.code, 'AMOUNT_MISSING');
  assert.equal(byId['1007'].error.code, 'DEAL_FETCH_FAILED');
  assert.ok(results.every((r) => r.sandbox === true));
});

test('sandbox dry run summarizes and writes nothing', async () => {
  const { results } = await simulate();
  const dry = await runCodeNode('Dry-Run Telemetry', results);
  assert.deepEqual(dry.output[0].json.totals, { deals: 6, calculated: 3, errors: 3, skipped: 0, sheetRows: 7 });
  assert.ok(dry.logs.some((l) => l.includes('deal=1003 ERROR PERCENT_TOTAL_MISMATCH')));
});

test('live mode: sheet rows, analytics toggle and alerts', async () => {
  const { results } = await simulate(LIVE);
  const ok = results.filter((r) => r.kind === 'split_result');
  const rows = await runCodeNode('Build Sheet Rows', ok, { env: LIVE });
  assert.equal(rows.output.length, 7);
  assert.equal(rows.output[0].json.mode, 'LIVE');
  assert.deepEqual((await runCodeNode('Build Analytics Records', ok, { env: LIVE })).output, [], 'analytics disabled by default');
  const analyticsEnv = Object.assign({}, LIVE, { ENABLE_ANALYTICS_INGEST: 'true', ANALYTICS_INGEST_URL: 'https://analytics.example/ingest' });
  const records = await runCodeNode('Build Analytics Records', ok, { env: analyticsEnv });
  assert.equal(records.output.length, 3);
  assert.equal(records.output[0].json.body.records[0].calculation.dealId, '1001');
  const errors = results.filter((r) => r.kind === 'calc_error');
  const alerts = await runCodeNode('Build Calculation Alert', errors, { env: LIVE });
  assert.deepEqual(alerts.output.map((a) => a.json.code), ['PERCENT_TOTAL_MISMATCH', 'AMOUNT_MISSING', 'DEAL_FETCH_FAILED']);
  assert.ok(Array.isArray(alerts.output[0].json.alert.blocks));
});

test('error branch: sync failures are redacted before alerting', async () => {
  const failed = [
    { dealId: '1001', calculationId: 'abc', hubspotUpdate: { path: '/x', body: {} }, error: { message: 'Authorization: Bearer secret-token-value for ops@example.com', httpCode: '401' } },
    { deal_id: '1002', calculation_id: 'def', error: { message: 'The caller does not have permission' } },
  ];
  const { output, logs } = await runCodeNode('Sanitize Sync Error', failed, { env: LIVE });
  assert.deepEqual(output.map((o) => o.json.error.code), ['SYNC_HUBSPOT_FAILED', 'SYNC_GOOGLE_SHEETS_FAILED']);
  const text = JSON.stringify(output) + logs.join('\n');
  assert.ok(!text.includes('secret-token-value') && !text.includes('ops@example.com'));
});

test('fail fast on bad config; blocked $env keeps sandbox defaults', async () => {
  await assert.rejects(() => runCodeNode('Normalize Closed-Won Events', [], { env: { ROUNDING_MODE: 'SOMETIMES' } }), /ROUNDING_MODE/);
  const blocked = await runCodeNode('Normalize Closed-Won Events', [{ objectId: 1, propertyName: 'dealstage', propertyValue: 'closedwon' }], { blockEnv: true });
  assert.equal(blocked.output[0].json.sandbox, true);
});

// ---------------------------------------------------------------------------
// 3. Security scan
// ---------------------------------------------------------------------------

test('security scan: no live tokens, webhook URLs, keys or real email addresses', () => {
  const files = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      if (['node_modules', '.git', 'coverage'].includes(e.name)) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|json|md|yml|sql|txt)$|^\.env\.example$|^\.gitignore$|^LICENSE$/.test(e.name)) files.push(full);
    });
  })(ROOT);
  assert.ok(files.length >= 13, `expected repository files, found ${files.length}`);
  const forbidden = [
    ['HubSpot private app token', /pat-(?:na|eu|ap)\d-[0-9a-f]{8}-[0-9a-f]{4}-/i],
    ['Slack webhook', /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{12,}/],
    ['Slack token', /xox[abposr]-\d{6,}-/],
    ['Google OAuth token', /ya29\.[A-Za-z0-9_-]{20,}/],
    ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
    ['Bearer token', /Bearer\s+[A-Za-z0-9._-]{30,}/],
    ['AWS access key', /AKIA[0-9A-Z]{16}/],
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['database URL with password', /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s"'/]+:[^@\s"']+@(?!db\.example)/],
  ];
  const allowedEmail = /@([a-z0-9-]+\.)*(example\.(?:com|org|net)|[a-z0-9-]+\.example)$/i;
  files.forEach((file) => {
    if (file === __filename) return;
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    forbidden.forEach(([label, re]) => assert.ok(!re.test(text), `${label} found in ${rel}`));
    (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).forEach((a) => assert.match(a, allowedEmail, `email ${a} in ${rel}`));
  });
  const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  ['WEBHOOK_SECRET', 'GOOGLE_SHEET_ID', 'ALERT_WEBHOOK_URL', 'ANALYTICS_INGEST_URL'].forEach((k) => assert.match(env, new RegExp(`^${k}=REPLACE_WITH_`, 'm'), k));
});
