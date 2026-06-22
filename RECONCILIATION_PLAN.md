# Stanalyst Reconciliation Worker Plan

## Goal

Run reconciliation outside the private application repository while keeping the runtime free:

- Public GitHub repository for the worker, so GitHub-hosted Actions minutes are free.
- External 15-minute trigger from cron-job.org because GitHub scheduled workflows are not reliable enough for payment recovery.
- No application source code or business logic copied into the worker beyond reconciliation.
- No secrets committed. All credentials live in GitHub Actions secrets.

## Local Project Location

The reconciler lives outside the current application repo:

```text
/Users/kiran/Desktop/code/playground/stanalyst-reconciler
```

The current app remains at:

```text
/Users/kiran/Desktop/code/playground/StockAnalysis
```

Do not place the reconciler under `StockAnalysis`, do not add it as a submodule, and do not add it to any workspace config in the app repo.

## Repositories

Recommended public repo:

```text
stanalyst-reconciler
```

The public repo contains only:

- Reconciliation workflow
- Reconciliation script
- Minimal database, Razorpay, and GitHub clients
- Operational documentation

## Trigger Model

cron-job.org runs every 15 minutes and dispatches the GitHub Actions workflow:

```http
POST https://api.github.com/repos/<owner>/stanalyst-reconciler/actions/workflows/reconcile.yml/dispatches
```

Headers:

```text
Authorization: Bearer <CRON_DISPATCH_PAT>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
Content-Type: application/json
```

Body:

```json
{
  "ref": "main",
  "inputs": {
    "source": "cron-job.org",
    "dry_run": "false"
  }
}
```

`CRON_DISPATCH_PAT` should be a dedicated fine-grained token with only:

```text
Repository: stanalyst-reconciler
Permission: Actions: write
```

## Secrets

Set these as GitHub Actions secrets on the public reconciler repo:

```text
DATABASE_URL
RAZORPAY_MODE
RAZORPAY_LIVE_KEY_ID
RAZORPAY_LIVE_KEY_SECRET
RAZORPAY_TEST_KEY_ID
RAZORPAY_TEST_KEY_SECRET
APP_GITHUB_PAT
APP_GITHUB_OWNER
APP_GITHUB_REPO
APP_GITHUB_WORKFLOW_ID
APP_GITHUB_REF
```

Recommended values:

```text
APP_GITHUB_OWNER=kirankaranth1
APP_GITHUB_REPO=stock-analyst
APP_GITHUB_WORKFLOW_ID=analyze.yml
APP_GITHUB_REF=v2
```

`APP_GITHUB_PAT` should be scoped to the private app repo and have only the permissions needed to dispatch/read Actions workflows.

## Logging Rules

This repo is public. GitHub Actions logs may be visible.

The worker must not log:

- Database URLs
- Tokens
- Full report IDs
- Full Razorpay order IDs
- Full Razorpay payment IDs
- User emails
- Raw provider errors that could contain secrets

Allowed logs:

- Aggregate counts
- Redacted IDs
- High-level status transitions

## Data Model Direction

Payment status and report generation status must remain separate.

### Payment Lifecycle

`payments.status` should track money state:

```text
created
paid
failed
abandoned
```

Refund state should be separate:

```text
refund_status: none | needs_review | pending | refunded | failed
refund_id
refund_reason
refund_error
```

### Report Lifecycle

`reports.status` should track generation only:

```text
queued
running
completed
failed
cancelled
```

Recommended report fields:

```text
generation_source: free | paid | admin | upgrade
dispatch_attempts
last_dispatch_at
dispatch_error
```

### Key Product Rule

Do not create a visible report row for a paid report until payment succeeds.

Free and admin reports bypass `payments` entirely and enter the report lifecycle directly.

## Runtime Flows

### Paid Report

```text
/api/payment/orders
  -> create Razorpay order
  -> insert payment status=created, report_id=null
  -> store payment intent fields: intent_symbol, intent_company_name, intent_report_type, intent_profile
  -> no report row yet

/api/payment/verify
  -> verify Razorpay signature
  -> mark payment paid
  -> create report status=queued, generation_source=paid
  -> link payment.report_id
  -> dispatch GitHub Actions analysis workflow
```

### Payment Failed Or Dismissed

```text
frontend calls /api/payment/events
  -> update payment status
  -> no report row exists
  -> nothing appears as fetching in report history
```

### Free Report

```text
/api/generate
  -> validate free allowance
  -> create report status=queued, generation_source=free
  -> dispatch analysis workflow
```

### Admin Report

```text
/api/admin/trigger
  -> validate admin
  -> create report status=queued, generation_source=admin
  -> dispatch analysis workflow
```

## Reconciler Responsibilities

The worker runs every 15 minutes.

### 1. Acquire Lock

Use a Postgres advisory lock so overlapping workflow runs cannot process the same rows.

If the lock is unavailable, exit successfully.

### 2. Reconcile Stale Created Payments

Find payments:

```text
status = created
report_id IS NULL
created_at older than 30 minutes
```

For each:

- Fetch Razorpay order payments.
- If captured/paid exists: mark payment paid, create/link report if the app schema supports it, dispatch report.
- If failed payment exists: mark payment failed.
- If no payment exists after cutoff: mark payment abandoned.

### 3. Reconcile Paid Payments Without Reports

Find payments:

```text
status = paid
report_id IS NULL
```

For each:

- Create report idempotently if payment intent fields exist.
- Link `payments.report_id`.
- Dispatch GitHub Actions workflow.

If the current schema does not yet contain payment intent fields, log a redacted warning and skip. Do not guess report details.

### 4. Reconcile Queued Reports Without GitHub Run IDs

Find reports:

```text
status = queued
gha_run_id IS NULL
created_at older than 10 minutes
```

For each:

- If dispatch attempt tracking exists and attempts are below the limit, re-dispatch.
- Otherwise mark report failed with a clear user-facing error.
- If a paid payment is linked, mark `refund_status = needs_review` if the column exists.

### 5. Reconcile Reports With GitHub Run IDs

Find reports:

```text
status IN (queued, running)
gha_run_id IS NOT NULL
```

For each:

- Fetch GitHub run.
- If active, leave unchanged.
- If success but report not completed, leave to pipeline unless it is stale beyond a configurable cutoff.
- If cancelled, mark report cancelled.
- If failed/timed out, mark report failed.
- If linked paid payment exists, mark refund review when terminal failure is confirmed.

### 6. Reconcile Legacy Pending Report Rows

The existing app has legacy rows where:

```text
reports.status = pending
payments.status = created
payments.razorpay_payment_id IS NULL
```

Those represent unpaid payment attempts that currently appear as fetching.

For these rows:

- If older than 30 minutes, mark report `cancelled` with error `Payment was not completed.`
- Keep payment as `abandoned` if the schema supports it; otherwise leave it as `created`.

## Safety Rules

- Reconciler must be idempotent.
- Manual runs can set `RECONCILE_DRY_RUN=true` / workflow input `dry_run=true` to inspect actions without writes.
- No automatic refunds in the first version.
- Failed paid reports are marked for manual refund review.
- Missing optional schema columns must not crash the worker.
- Use transactions when creating/linking reports.
- Use advisory locks to avoid overlapping runs.
- Exit zero when no work is needed.

## Phase 1 Implementation

The first worker version supports both current schema and future schema:

- Detects available columns at runtime.
- Handles current stuck rows safely.
- Does not require immediate app schema migration.
- Does not create paid report rows without required intent fields.
- Does not process refunds automatically.

## Phase 2 App Refactor

After the worker is deployed, update the main app:

- Make `payments.report_id` nullable.
- Add payment intent fields.
- Add `payments.status` values: `failed`, `abandoned`.
- Add refund status fields.
- Add report source/dispatch fields.
- Stop creating report rows during paid order creation.
- Create report only after verified/captured payment.
- Add frontend abandon/failure endpoint calls.
