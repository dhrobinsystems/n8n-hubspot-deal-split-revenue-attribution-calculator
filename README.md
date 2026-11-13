# n8n-hubspot-deal-split-revenue-attribution-calculator

A computational revenue engine for n8n. When a HubSpot deal reaches **Closed-Won**, it calculates weighted **revenue credit** and **commission** splits across multiple sales reps and partner channels, using exact decimal arithmetic. It then syncs a structured breakdown to:

1. **HubSpot**: totals, status and per-slot amounts written back to the deal.
2. **Google Sheets**: one row per participant, ready for finance review.
3. **A custom analytics database**: JSON records POSTed to your ingest endpoint (reference PostgreSQL schema included).

Any calculation or sync failure goes to an error branch. That branch **redacts PII, bearer tokens and sensitive headers** before anything is logged or sent to the alert webhook.

> Built by DH Robin (dhRobin Systems), https://dhrobinsystems.com. MIT licensed. Ships with `SANDBOX_MODE=true` and synthetic data only.

---

## Contents

| File | Purpose |
| --- | --- |
| `workflow.json` | Importable n8n workflow (21 nodes). Generated: do not hand-edit. |
| `calculator.js` | Zero-dependency engine: config, validation, exact split math, HubSpot, Sheets and DB payloads, redaction. Inlined into the workflow's Code nodes. |
| `scripts/build-workflow.js` | Builds `workflow.json` from `calculator.js`. `--check` fails on drift. |
| `sql/schema.sql` | Reference PostgreSQL table, indexes and a "latest calculation" view. |
| `.env.example` | Every configuration variable, with placeholders only. |
| `test/` | Unit tests, workflow replay tests against synthetic fixtures, and the repository security scan. |
| `disclaimer.md` | Full disclaimer and limitation of liability. |
| `LICENSE` | MIT. |

---

## Architecture

```
 HubSpot developer app                     HubSpot workflow ("Send a webhook")
 deal.propertyChange (dealstage)           POST + x-split-secret header
          │                                          │
 [HubSpot Deal Stage Changed]          [Closed-Won Workflow Webhook]
          └──────────────┬───────────────────────────┘
                         ▼
          [Normalize Closed-Won Events]   filter stage ∈ CLOSED_WON_STAGE_IDS, verify secret
                         │                (constant-time), dedupe, cap per run
                         ▼
          [HubSpot Get Deal]  GET /crm/v3/objects/deals/{id}?properties=…split slots…
                         ▼
          [HubSpot Get Partner Associations]  GET /crm/v4/objects/deals/{id}/associations/companies
                         ▼
          [Calculate Splits]   validate → weight → allocate (largest remainder) → commission
                         ▼
                  [Sandbox Mode?] ──true──► [Dry-Run Telemetry]  (log only, writes nothing)
                         │ false
                         ▼
                  [Route Results]
       ┌──────── Calculated ─────────┐            ┌──── Calculation Error ────┐
       ▼              ▼              ▼            ▼                           ▼
 [HubSpot Update] [Build Sheet  [Build Analytics  [HubSpot Flag      [Build Calculation
  PATCH deal       Rows] →       Records] →        Calculation        Alert]
                   [Google       [Analytics        Error]                   │
                   Sheets        Ingest]                                    │
                   Append]                                                  │
       │ error output   │ error        │ error         │ error              │
       └───────────────►[Sanitize Sync Error]◄─────────┘                    │
                                 │                                          │
                                 └──────────►[Send Redacted Alert]◄─────────┘
                                             POST $env.ALERT_WEBHOOK_URL
```

Design principles:

- **No hardcoding.** Endpoints, IDs, stage IDs, rates, percentages and toggles all come from `$env` or n8n parameters. Credentials are referenced by placeholder IDs.
- **Fail fast.** Every Code node runs `loadConfig()`, which collects *all* configuration problems into one error before any data moves.
- **Sandbox first.** With `SANDBOX_MODE=true`, nothing is written anywhere. You get a full dry-run report instead.
- **Idempotent.** Each calculation has a deterministic `calculationId` (a hash of every input). A deal whose `split_calculation_id` already matches is skipped. The database primary key `(calculation_id, line_number)` rejects duplicates, and the analytics request carries an `Idempotency-Key`.
- **Exact money.** All arithmetic is BigInt fixed-point. There are no floating-point amounts anywhere.

---

## The split model

### Where participants come from

For each deal, participants are resolved in this order:

1. **Split slots.** These are deal properties `split_{n}_owner_id` (rep) **or** `split_{n}_partner_company_id` (partner), plus `split_{n}_percent` and an optional `split_{n}_role`, for `n = 1 … MAX_SPLIT_SLOTS`.
2. **Deal owner default.** If no slot is filled and `DEFAULT_OWNER_SPLIT=true`, the `hubspot_owner_id` receives 100 % with role `DEFAULT_ROLE`.
3. **Partner carve-out.** If `ENABLE_PARTNER_ASSOCIATIONS=true`, every company associated with the deal under the label `PARTNER_ASSOCIATION_LABEL` (and not already named in a slot) receives `PARTNER_DEFAULT_PERCENT` %. Reps are scaled down proportionally to share the remainder.

### Math

| Step | Rule |
| --- | --- |
| Amount | `COMMISSION_BASE_PROPERTY` parsed exactly, then rounded to the currency's minor units (JPY 0, KWD/BHD/OMR… 3, default 2) with `ROUNDING_MODE`. |
| Percent check | Split percents (scale 4) must total 100 within `PERCENT_TOLERANCE` points, or `NORMALIZE_WEIGHTS=true` rescales them. Otherwise the result is `PERCENT_TOTAL_MISMATCH`. |
| Credit | **Largest-remainder allocation** of the amount in minor units. The credits always sum *exactly* to the deal amount, and ties go to the earlier slot. |
| Commission | `credit × rate(role)`, rounded per line with `ROUNDING_MODE`. Rates come from `COMMISSION_RATES_JSON`, falling back to `DEFAULT_COMMISSION_RATE`. |
| Invariant | The sum of credits is re-checked against the amount. If it differs, the result is `ALLOCATION_INVARIANT_FAILED`. |

Worked example (fixture deal 1001: USD 120,000.00; AE 50 / SDR 30 / SE 20; one "Referral Partner" company):

| Participant | Role | Effective % | Credit | Rate | Commission |
| --- | --- | --- | --- | --- | --- |
| 901 | AE | 45.0000 | 54,000.00 | 0.10 | 5,400.00 |
| 902 | SDR | 27.0000 | 32,400.00 | 0.05 | 1,620.00 |
| 903 | SE | 18.0000 | 21,600.00 | 0.02 | 432.00 |
| 7001 | PARTNER | 10.0000 | 12,000.00 | 0.15 | 1,800.00 |
| **Total** | | 100.0000 | **120,000.00** | | **9,252.00** |

### Validation errors (structured)

Errors carry `{ stage, code, message, details }`. They are flagged on the deal (`split_calculation_status=ERROR`, `split_error_code`) and alerted.

`PARTICIPANT_AMBIGUOUS`, `PARTICIPANT_MISSING`, `PERCENT_MISSING`, `PARTICIPANT_INVALID`, `ROLE_INVALID`, `DUPLICATE_PARTICIPANT`, `PERCENT_INVALID`, `NO_PARTICIPANTS`, `PARTNER_CARVE_OUT_INVALID`, `CURRENCY_INVALID`, `AMOUNT_MISSING`, `AMOUNT_INVALID`, `AMOUNT_NEGATIVE`, `PERCENT_TOTAL_MISMATCH`, `PERCENT_TOTAL_ZERO`, `ALLOCATION_INVARIANT_FAILED`, `DEAL_FETCH_FAILED`, `UNEXPECTED_ERROR`. Sync failures become `SYNC_HUBSPOT_FAILED`, `SYNC_GOOGLE_SHEETS_FAILED` or `SYNC_ANALYTICS_FAILED`.

---

## Setup

### 1. Create HubSpot deal properties

Create these in **Settings → Properties → Deal properties**, in a group such as "Deal Splits". Repeat the slot properties for `n = 1 … MAX_SPLIT_SLOTS`.

**Inputs (filled by reps or ops):**

| Internal name | Type |
| --- | --- |
| `split_{n}_owner_id` | HubSpot user (owner) or single-line text |
| `split_{n}_partner_company_id` | Single-line text (company record ID) |
| `split_{n}_percent` | Number (up to 4 decimals) |
| `split_{n}_role` | Dropdown: AE, SDR, CSM, SE, PARTNER (must match `COMMISSION_RATES_JSON` keys) |

**Outputs (written by the workflow; make them read-only for users):**

| Internal name | Type |
| --- | --- |
| `split_calculation_id` | Single-line text |
| `split_calculation_status` | Dropdown: CALCULATED, ERROR |
| `split_calculated_at` | Date-time (or text) |
| `split_total_credit`, `split_total_commission` | Number |
| `split_participant_count` | Number |
| `split_error_code` | Single-line text |
| `split_{n}_credit_amount`, `split_{n}_commission_amount` | Number (skip if `WRITE_SLOT_PROPERTIES=false`) |

If you use a different prefix, set `SPLIT_PROPERTY_PREFIX`. Partner channels need a **deal→company association label** matching `PARTNER_ASSOCIATION_LABEL` (default "Referral Partner"), created under **Settings → Objects → Deals → Associations**.

### 2. HubSpot authentication

Create a **private app** (or use a developer app's OAuth). Grant these scopes: `crm.objects.deals.read`, `crm.objects.deals.write`, `crm.objects.companies.read`. Store the token **only** in n8n as a *HubSpot App Token* credential (`REPLACE_WITH_HUBSPOT_PAT`). Never put it in an environment variable.

### 3. HubSpot webhook configuration (choose one)

**Option A: developer app subscription (node "HubSpot Deal Stage Changed")**
1. In your HubSpot developer account, open the app and go to **Webhooks**.
2. Add the subscription **Deal → Property change → `dealstage`**.
3. In n8n, attach a *HubSpot Developer API* credential (`REPLACE_WITH_HUBSPOT_DEVELOPER_API_KEY`) to the trigger node. Activating the workflow registers the target URL.
4. HubSpot batches events. The normalizer filters to `CLOSED_WON_STAGE_IDS`, dedupes, and caps at `MAX_DEALS_PER_RUN`.

**Option B: HubSpot workflow webhook (node "Closed-Won Workflow Webhook")**
1. Create a deal-based HubSpot workflow. Enrollment trigger: *Deal stage is any of* your Closed-Won stages.
2. Add the action **Send a webhook**: `POST` to the n8n production URL for path `deal-split/closed-won`.
3. Add the request header `x-split-secret: <your WEBHOOK_SECRET>` (needs Operations Hub Pro or higher for custom headers; otherwise use Option A).
4. Include at least `hs_object_id` (or `objectId`) and `dealstage` in the body. The secret is checked in constant time, and mismatches are rejected and counted.

Find stage IDs under **Settings → Objects → Deals → Pipelines** (the internal value, for example `closedwon` or a numeric ID). List every pipeline's Closed-Won stage in `CLOSED_WON_STAGE_IDS`.

### 4. Google Sheets

Create a sheet with a tab named `GOOGLE_SHEET_TAB` (default `deal_splits`). Put this header row in row 1, in this order:

```
calculation_id,line_number,deal_id,deal_name,pipeline,close_date,currency,deal_amount,participant_type,participant_id,role,split_source,split_percent,credit_amount,commission_rate,commission_amount,rounding_mode,calculated_at,mode,calculator_version
```

Attach a *Google Sheets OAuth2* credential (`REPLACE_WITH_GOOGLE_OAUTH_CLIENT`) to "Google Sheets Append Splits". Set `GOOGLE_SHEET_ID` to the ID in the sheet URL. Restrict sharing on the sheet, because it contains compensation data.

### 5. Analytics database (optional)

1. Load `sql/schema.sql` into your analytics PostgreSQL (or adapt it for your warehouse).
2. Expose an ingest endpoint that accepts `POST { records: [...] }` and inserts with `ON CONFLICT (calculation_id, line_number) DO NOTHING`.
3. Set `ENABLE_ANALYTICS_INGEST=true` and `ANALYTICS_INGEST_URL`, and attach a *Header Auth* credential (`REPLACE_WITH_ANALYTICS_API_TOKEN`) to "Analytics Ingest".
4. As an alternative, replace "Analytics Ingest" with an n8n **Postgres** node fed from "Build Sheet Rows". Keep the connection string in the n8n Postgres credential, never in the workflow.

### 6. Alerts

Set `ALERT_WEBHOOK_URL` to a Slack incoming webhook (`ALERT_FORMAT=slack`) or any JSON endpoint (`ALERT_FORMAT=json`). Every alert payload goes through `sanitizeForLog()` first.

---

## n8n deployment

1. **Host requirements:** n8n 1.x, Node ≥ 20. Set `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` so Code nodes can read `$env`.
2. **Environment:** copy `.env.example` into your deployment's environment or secret manager and replace every `REPLACE_WITH_…` value. Keep `SANDBOX_MODE=true`.
3. **Import:** go to **Workflows → Import from file** and select `workflow.json`. It imports **inactive**.
4. **Credentials:** open each node with a `REPLACE_WITH_…` credential and select your real credential. The JSON is never edited.
5. **Activate** in sandbox mode and close a test deal. Check the "Dry-Run Telemetry" output.
6. Follow the validation protocol below, then set `SANDBOX_MODE=false` and restart n8n.

Changing the engine:

```bash
npm run build         # regenerate workflow.json from calculator.js
npm run ci            # lint + drift check + all tests
```

### Environment reference

| Variable | Default | Notes |
| --- | --- | --- |
| `SANDBOX_MODE` | `true` | `false` enables writes. |
| `WEBHOOK_SECRET` | none | ≥ 16 chars. Required live. |
| `HUBSPOT_PORTAL_ID` | none | Links in alerts only. |
| `HUBSPOT_APP_BASE_URL` | `https://app.hubspot.com` | EU portals: `https://app-eu1.hubspot.com`. |
| `CLOSED_WON_STAGE_IDS` | `closedwon` | Comma-separated. |
| `COMMISSION_BASE_PROPERTY` | `amount` | For example `hs_tcv` or a custom ACV property. |
| `CURRENCY_PROPERTY` / `DEFAULT_CURRENCY` | `deal_currency_code` / `USD` | ISO 4217. |
| `ROUNDING_MODE` | `HALF_EVEN` | `HALF_UP`, `DOWN`. |
| `PERCENT_TOLERANCE` | `0.01` | Percentage points (0–1). |
| `NORMALIZE_WEIGHTS` | `false` | Rescale instead of erroring. |
| `MAX_SPLIT_SLOTS` | `5` | 1–20. |
| `SPLIT_PROPERTY_PREFIX` | `split_` | Lowercase internal names. |
| `DEFAULT_OWNER_SPLIT` / `DEFAULT_ROLE` | `true` / `AE` | |
| `ENABLE_PARTNER_ASSOCIATIONS` | `true` | |
| `PARTNER_ASSOCIATION_LABEL` | `Referral Partner` | |
| `PARTNER_DEFAULT_PERCENT` | `10` | Per partner. |
| `COMMISSION_RATES_JSON` | synthetic example | Role → decimal rate. |
| `DEFAULT_COMMISSION_RATE` | `0` | |
| `WRITE_SLOT_PROPERTIES` | `true` | |
| `FORCE_RECALCULATION` | `false` | Ignore `split_calculation_id` match. |
| `MAX_DEALS_PER_RUN` | `50` | |
| `ENABLE_HUBSPOT_WRITEBACK` | `true` | |
| `ENABLE_GOOGLE_SHEETS` / `GOOGLE_SHEET_ID` / `GOOGLE_SHEET_TAB` | `true` / none / `deal_splits` | |
| `ENABLE_ANALYTICS_INGEST` / `ANALYTICS_INGEST_URL` | `false` / none | |
| `ENABLE_ALERTS` / `ALERT_WEBHOOK_URL` / `ALERT_FORMAT` | `true` / none / `slack` | |

---

## Test validation protocol

### Offline (no credentials needed)

```bash
npm run ci
```

This covers:

- config fail-fast;
- exact decimal parsing and rounding in every mode;
- largest-remainder allocation (a 500-case property test that credits always sum exactly);
- currency minor units;
- every validation code;
- idempotency;
- redaction;
- the full workflow replayed in a VM against synthetic fixtures (multi-rep plus partner, owner default, 90 % mismatch, missing amount, JPY, 404 fetch);
- a **repository security scan** that fails on live-looking tokens, webhook URLs, keys or non-example email addresses.

### Staging (HubSpot test portal, test sheet, `SANDBOX_MODE=true`)

| # | Scenario | Expected |
| --- | --- | --- |
| 1 | 3 reps 50/30/20, no partner | 3 lines; credits sum to amount. |
| 2 | Same plus "Referral Partner" company | Partner gets 10 %; reps 45/27/18. |
| 3 | No slots, owner set | 1 line, 100 % owner. |
| 4 | Slots totalling 90 % | `PERCENT_TOTAL_MISMATCH` in dry run. |
| 5 | Thirds (33.3333 ×2 + 33.3334) on 100.00 | 33.33 / 33.33 / 33.34. |
| 6 | JPY deal | No decimals. |
| 7 | Move deal to a non-won stage | Not processed. |
| 8 | Re-deliver same event | Second run skipped (`ALREADY_CALCULATED` once live). |
| 9 | Webhook with wrong `x-split-secret` | Rejected, `SECRET_MISMATCH` counted. |

Reconcile scenarios 1–6 by hand against your compensation plan. Then set `SANDBOX_MODE=false` **in the test portal** and confirm:

- deal properties are written;
- sheet rows are appended with `mode=LIVE`;
- DB rows are inserted once;
- breaking the Sheets credential produces a `SYNC_GOOGLE_SHEETS_FAILED` alert with no token, email or header values in it.

Only then promote to production.

---

## Security & privacy

- No real keys, tokens, portal IDs, emails or webhook URLs are in this repository. All test data is synthetic, using `example.com` domains and numeric IDs.
- Credentials live in n8n's encrypted store and are referenced by placeholder IDs.
- Secret endpoints are checked for *presence* only. Their values are never copied into config objects, logs or alerts.
- `redact()` scrubs emails, `Bearer` and `Basic` credentials, HubSpot `pat-` tokens, Google `ya29.` tokens, Slack tokens and webhook paths, `hapikey`, database connection strings and `key=value` secrets. `sanitizeForLog()` deep-redacts sensitive headers and keys (authorization, cookie, secret, token…) and PII keys (email, phone, name, address…) with depth and size limits.
- Records store HubSpot owner and company **IDs**, not names or emails.

---

## ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** This software is provided "as is", without warranty of any kind. It calculates *indicative* revenue-credit and commission splits; it is **not** a payroll, accounting or compensation system of record. Every figure must be reviewed and approved by a qualified person before anyone is paid or revenue is reported.

**No Liability.** In no event shall DH Robin, dhRobin Systems or contributors be liable for any claim, damages or other liability arising from the use of this software. That includes incorrect, duplicated or missing commission or credit amounts, rounding or currency discrepancies, misattribution between reps or partners, data written to or lost from HubSpot, Google Sheets or any database, or failed or delayed synchronisation.

**No Warranty.** No warranty is given as to accuracy, reliability, fitness for a particular purpose or uninterrupted operation. The commission rates and split percentages in this repository are synthetic examples only.

**Production Testing Required.** Test thoroughly against a HubSpot sandbox, a test spreadsheet and a non-production database with `SANDBOX_MODE=true` before going live. Reconcile the output by hand against your compensation plan, and keep a human approval step before any payment.

**Third-Party APIs & Compliance.** HubSpot, Google and any endpoint you configure may change their APIs, limits or terms without notice. You are responsible for complying with their terms, with data-protection law (for example GDPR and CCPA) and with your employment and partner agreements when processing compensation data.

The full disclaimer is also available in [disclaimer.md](disclaimer.md).

**License:** Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](LICENSE).
