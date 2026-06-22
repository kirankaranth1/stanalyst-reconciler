# Stanalyst Reconciler

Public GitHub Actions worker for reconciling Stanalyst payment and report-generation state.

Read the architecture and operating plan first:

```text
RECONCILIATION_PLAN.md
```

## Local Path

```text
/Users/kiran/Desktop/code/playground/stanalyst-reconciler
```

This repository is intentionally separate from:

```text
/Users/kiran/Desktop/code/playground/StockAnalysis
```

## Required GitHub Actions Secrets

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

## Run Locally

Create `.env.local` with the same secret names, then:

```bash
npm install
npm run typecheck
npm run reconcile
```

Dry run:

```bash
RECONCILE_DRY_RUN=true npm run reconcile
```

## cron-job.org Trigger

Configure cron-job.org to call the GitHub Actions workflow dispatch endpoint every 15 minutes:

```http
POST https://api.github.com/repos/<owner>/stanalyst-reconciler/actions/workflows/reconcile.yml/dispatches
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
