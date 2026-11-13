# Disclaimer & Liability Limitation

**Project:** n8n-hubspot-deal-split-revenue-attribution-calculator
**Author:** DH Robin (dhRobin Systems) — https://dhrobinsystems.com
**License:** MIT (see [LICENSE](LICENSE))

## 1. Provided "as is"

This software, including the n8n workflow (`workflow.json`), the calculation engine (`calculator.js`), the SQL schema, the tests and all documentation, is provided **"as is" and "as available"**, without warranty of any kind, express or implied. That includes, without limitation, any warranty of merchantability, fitness for a particular purpose, accuracy, completeness, non-infringement, or uninterrupted or error-free operation.

## 2. Not a payroll, accounting or compensation system of record

This project calculates **indicative** revenue-credit and commission splits from data held in third-party systems. It is not a payroll system, an accounting system, a revenue-recognition system or a legally binding compensation plan.

- Outputs are **not** financial, tax, accounting, legal or employment advice.
- Commission rates, split percentages and partner carve-outs in this repository are **synthetic examples**. They do not reflect any real compensation plan.
- Every figure the software produces must be **reviewed and approved by a qualified person** (for example finance, revenue operations or payroll) before it is used to pay anyone, report revenue, settle partner fees or make any employment decision.
- Your signed compensation plans, partner agreements and applicable law take precedence over anything this software calculates.

## 3. Limitation of liability for financial and data discrepancies

To the maximum extent permitted by applicable law, DH Robin, dhRobin Systems and any contributors shall **not be liable** for any direct, indirect, incidental, special, consequential, exemplary or punitive damages, or any loss of profits, revenue, commissions, data, goodwill or business opportunity, arising from or related to the use of, or inability to use, this software. That includes, without limitation:

- incorrect, over-paid, under-paid, duplicated or missing commission or credit amounts;
- rounding, currency, minor-unit or precision differences;
- misattribution between sales representatives, roles, teams or partner channels;
- data written to, overwritten in, or deleted from HubSpot, Google Sheets, a database or any other system;
- disputes between employees, contractors, partners or customers;
- failed, delayed, duplicated or partial synchronisation or alerting;
- disclosure of data caused by misconfiguration, compromised credentials or third-party services.

This applies whether the claim is based in contract, tort (including negligence), strict liability or otherwise, even if advised of the possibility of such damages.

## 4. Production testing required

You are solely responsible for testing this software before production use. At a minimum:

1. Run it with `SANDBOX_MODE=true` against a HubSpot **sandbox or test portal**, a **test** Google Sheet and a **non-production** database.
2. Reconcile the dry-run output by hand against your compensation plan for a representative sample of deals, including multi-rep, partner, zero-value, non-USD and edge-rounding cases.
3. Keep a human approval step between this software's output and any payment.
4. Back up any HubSpot properties and spreadsheets the workflow will write to.

## 5. Third-party APIs, data protection and compliance

This software interacts with HubSpot, Google and any endpoint you configure. Their availability, behaviour, rate limits, pricing and terms may change without notice. You are responsible for:

- complying with each provider's terms of service and API policies;
- complying with data-protection law that applies to you (for example GDPR, UK GDPR, CCPA/CPRA) and with your employment and contractual obligations when processing compensation data;
- securing credentials, restricting access to output sheets and databases, and configuring retention.

The built-in redaction functions reduce, but cannot eliminate, the risk of sensitive data appearing in logs or alerts. They are a safeguard, not a guarantee.

## 6. No support obligation

No obligation exists to provide support, maintenance, updates or fixes. Any support provided is at the author's discretion and does not create a warranty.

## 7. Acceptance

By using, copying, modifying or deploying this software you acknowledge that you have read this disclaimer, accept these terms, and use the software **at your own risk**.

---

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](LICENSE).
