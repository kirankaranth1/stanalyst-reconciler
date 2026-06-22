import { createSql, hasColumn, loadSchemaInfo, type SchemaInfo, type Sql, withAdvisoryLock } from "./db.js"
import { loadEnv, type AppEnv } from "./env.js"
import { dispatchReportWorkflow, getGithubRun } from "./github.js"
import { logInfo, logWarn, redactId, safeErrorMessage } from "./log.js"
import { createRazorpay, findCapturedPayment, findFailedPayment, listOrderPayments } from "./razorpay.js"

const LOCK_KEY = 440120260622
const CREATED_PAYMENT_TIMEOUT_MINUTES = 30
const QUEUED_WITHOUT_RUN_TIMEOUT_MINUTES = 10
const RUNNING_STALE_HOURS = 8

type PaymentRow = {
  id: string
  user_id: string
  report_id: string | null
  razorpay_order_id: string | null
  razorpay_payment_id: string | null
  status: string
  created_at: string
  paid_at: string | null
  intent_symbol?: string | null
  intent_company_name?: string | null
  intent_report_type?: string | null
  intent_profile?: string | null
  symbol?: string | null
  company_name?: string | null
  report_type?: string | null
  profile?: string | null
  upgrade_from_report_id?: string | null
}

type ReportRow = {
  id: string
  user_id: string
  symbol: string
  company_name: string | null
  report_type: string
  profile: string
  status: string
  created_at: string
  started_at: string | null
  completed_at: string | null
  gha_run_id: string | number | null
  error: string | null
}

type Counters = {
  staleCreatedPayments: number
  abandonedPayments: number
  failedPayments: number
  capturedPayments: number
  paidWithoutReports: number
  paidTerminalReportsMarkedForReview: number
  legacyPendingReportsCancelled: number
  queuedWithoutRunFailed: number
  reportsSyncedFromGithub: number
  skipped: number
}

function emptyCounters(): Counters {
  return {
    staleCreatedPayments: 0,
    abandonedPayments: 0,
    failedPayments: 0,
    capturedPayments: 0,
    paidWithoutReports: 0,
    paidTerminalReportsMarkedForReview: 0,
    legacyPendingReportsCancelled: 0,
    queuedWithoutRunFailed: 0,
    reportsSyncedFromGithub: 0,
    skipped: 0,
  }
}

function supportsPaymentStatus(schema: SchemaInfo, status: string) {
  // Older app schemas only allowed created/paid/refunded. Detect the expanded
  // lifecycle before writing terminal attempt statuses.
  const hasExpandedLifecycle =
    hasColumn(schema, "payments", "refund_status") ||
    hasColumn(schema, "payments", "failure_reason")
  return hasExpandedLifecycle || status === "created" || status === "paid" || status === "refunded"
}

function paymentIntentColumnsAvailable(schema: SchemaInfo) {
  return (
    (hasColumn(schema, "payments", "intent_symbol") &&
      hasColumn(schema, "payments", "intent_report_type") &&
      hasColumn(schema, "payments", "intent_profile")) ||
    (hasColumn(schema, "payments", "symbol") &&
      hasColumn(schema, "payments", "report_type") &&
      hasColumn(schema, "payments", "profile"))
  )
}

async function markPaymentTerminal(
  sql: Sql,
  schema: SchemaInfo,
  env: AppEnv,
  paymentId: string,
  status: "failed" | "abandoned",
) {
  if (!supportsPaymentStatus(schema, status)) {
    logWarn("payment terminal status unsupported by current schema", {
      paymentId: redactId(paymentId),
      desiredStatus: status,
    })
    return false
  }

  if (env.dryRun) {
    logInfo("dry run: would mark payment terminal", {
      paymentId: redactId(paymentId),
      status,
    })
    return true
  }

  if (hasColumn(schema, "payments", "failure_reason")) {
    const timestampColumn = status === "failed" ? "failed_at" : "abandoned_at"
    const reason =
      status === "failed"
        ? "Payment failed before completion."
        : "Payment was abandoned before completion."
    await sql.query(
      `
        UPDATE payments
        SET status = $2,
            failure_reason = COALESCE(NULLIF(failure_reason, ''), $3),
            ${timestampColumn} = COALESCE(${timestampColumn}, NOW())
        WHERE id = $1
          AND status = 'created'
      `,
      [paymentId, status, reason],
    )
    return true
  }

  await sql.query(
    `
      UPDATE payments
      SET status = $2
      WHERE id = $1
        AND status = 'created'
    `,
    [paymentId, status],
  )
  return true
}

async function markPaymentPaid(
  sql: Sql,
  env: AppEnv,
  paymentId: string,
  razorpayPaymentId: string,
) {
  if (env.dryRun) {
    logInfo("dry run: would mark payment paid", {
      paymentId: redactId(paymentId),
      razorpayPaymentId: redactId(razorpayPaymentId),
    })
    return
  }

  await sql.query(
    `
      UPDATE payments
      SET status = 'paid',
          razorpay_payment_id = COALESCE(razorpay_payment_id, $2),
          paid_at = COALESCE(paid_at, NOW())
      WHERE id = $1
        AND status != 'paid'
    `,
    [paymentId, razorpayPaymentId],
  )
}

async function markRefundNeedsReview(
  sql: Sql,
  schema: SchemaInfo,
  env: AppEnv,
  reportId: string,
  reason: string,
) {
  if (!hasColumn(schema, "payments", "refund_status")) return

  if (env.dryRun) {
    logInfo("dry run: would mark refund needs review", {
      reportId: redactId(reportId),
      reason,
    })
    return
  }

  await sql.query(
    `
      UPDATE payments
      SET refund_status = CASE
            WHEN COALESCE(refund_status, 'none') IN ('none', '') THEN 'needs_review'
            ELSE refund_status
          END,
          refund_reason = COALESCE(NULLIF(refund_reason, ''), $2)
      WHERE report_id = $1
        AND status = 'paid'
    `,
    [reportId, reason],
  )
}

async function markPaymentRefundNeedsReview(
  sql: Sql,
  schema: SchemaInfo,
  env: AppEnv,
  paymentId: string,
  reason: string,
) {
  if (!hasColumn(schema, "payments", "refund_status")) return

  if (env.dryRun) {
    logInfo("dry run: would mark payment refund needs review", {
      paymentId: redactId(paymentId),
      reason,
    })
    return
  }

  await sql.query(
    `
      UPDATE payments
      SET refund_status = CASE
            WHEN COALESCE(refund_status, 'none') IN ('none', '') THEN 'needs_review'
            ELSE refund_status
          END,
          refund_reason = COALESCE(NULLIF(refund_reason, ''), $2)
      WHERE id = $1
        AND status = 'paid'
    `,
    [paymentId, reason],
  )
}

async function reconcileStaleCreatedPayments(
  sql: Sql,
  schema: SchemaInfo,
  env: AppEnv,
  razorpay: ReturnType<typeof createRazorpay>,
  counters: Counters,
) {
  const rows = (await sql.query(
    `
      SELECT id, user_id, report_id, razorpay_order_id, razorpay_payment_id, status, created_at, paid_at
      FROM payments
      WHERE status = 'created'
        AND created_at < NOW() - ($1::int * INTERVAL '1 minute')
      ORDER BY created_at ASC
      LIMIT 50
    `,
    [CREATED_PAYMENT_TIMEOUT_MINUTES],
  )) as PaymentRow[]

  counters.staleCreatedPayments += rows.length

  for (const payment of rows) {
    if (!payment.razorpay_order_id) {
      counters.skipped += 1
      continue
    }

    try {
      const orderPayments = await listOrderPayments(razorpay, payment.razorpay_order_id)
      const captured = findCapturedPayment(orderPayments)
      if (captured) {
        await markPaymentPaid(sql, env, payment.id, captured.id)
        counters.capturedPayments += 1
        logInfo("stale payment captured on Razorpay", {
          paymentId: redactId(payment.id),
          orderId: redactId(payment.razorpay_order_id),
        })
        continue
      }

      const failed = findFailedPayment(orderPayments)
      if (failed) {
        const marked = await markPaymentTerminal(sql, schema, env, payment.id, "failed")
        if (marked) counters.failedPayments += 1
        continue
      }

      const marked = await markPaymentTerminal(sql, schema, env, payment.id, "abandoned")
      if (marked) counters.abandonedPayments += 1
    } catch (error) {
      counters.skipped += 1
      logWarn("failed to reconcile stale payment", {
        paymentId: redactId(payment.id),
        error: safeErrorMessage(error),
      })
    }
  }
}

async function reconcilePaidPaymentsWithoutReports(
  sql: Sql,
  schema: SchemaInfo,
  env: AppEnv,
  counters: Counters,
) {
  const rows = (await sql.query(
    `
      SELECT *
      FROM payments
      WHERE status = 'paid'
        AND report_id IS NULL
      ORDER BY paid_at ASC NULLS LAST, created_at ASC
      LIMIT 50
    `,
  )) as PaymentRow[]

  counters.paidWithoutReports += rows.length

  if (!paymentIntentColumnsAvailable(schema)) {
    if (rows.length > 0) {
      logWarn("paid payments without reports cannot be repaired before payment intent columns exist", {
        count: rows.length,
      })
    }
    counters.skipped += rows.length
    return
  }

  for (const payment of rows) {
    const symbol = payment.intent_symbol ?? payment.symbol
    const companyName = payment.intent_company_name ?? payment.company_name
    const reportType = payment.intent_report_type ?? payment.report_type
    const profile = payment.intent_profile ?? payment.profile

    if (!symbol || !reportType || !profile) {
      counters.skipped += 1
      logWarn("paid payment missing intent fields", { paymentId: redactId(payment.id) })
      continue
    }

    let createdReportId: string | null = null

    try {
      if (env.dryRun) {
        logInfo("dry run: would create report for paid payment", {
          paymentId: redactId(payment.id),
        })
        continue
      }

      const generationSource = payment.upgrade_from_report_id ? "upgrade" : "paid"
      const slug = `${symbol.toLowerCase()}-${reportType}-${payment.id.slice(0, 8)}`
      const hasGenerationSource = hasColumn(schema, "reports", "generation_source")

      const reportRows = hasGenerationSource
        ? ((await sql.query(
            `
              INSERT INTO reports (
                user_id,
                symbol,
                company_name,
                report_type,
                profile,
                status,
                slug,
                generation_source
              )
              VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
              RETURNING id
            `,
            [
              payment.user_id,
              symbol,
              companyName ?? null,
              reportType,
              profile,
              slug,
              generationSource,
            ],
          )) as { id: string }[])
        : ((await sql.query(
            `
              INSERT INTO reports (user_id, symbol, company_name, report_type, profile, status, slug)
              VALUES ($1, $2, $3, $4, $5, 'pending', $6)
              RETURNING id
            `,
            [
              payment.user_id,
              symbol,
              companyName ?? null,
              reportType,
              profile,
              slug,
            ],
          )) as { id: string }[])

      const reportId = reportRows[0]?.id
      if (!reportId) {
        counters.skipped += 1
        continue
      }
      createdReportId = reportId

      await sql.query("UPDATE payments SET report_id = $1 WHERE id = $2", [reportId, payment.id])
      if (payment.upgrade_from_report_id) {
        await sql.query("UPDATE reports SET upgraded_to = $1 WHERE id = $2", [
          reportId,
          payment.upgrade_from_report_id,
        ])
      }

      await dispatchReportWorkflow(env, {
        reportId,
        symbol,
        reportType,
        profile,
        companyName,
      })

      if (hasColumn(schema, "reports", "dispatch_attempts")) {
        await sql.query(
          `
            UPDATE reports
            SET status = 'queued',
                dispatch_attempts = dispatch_attempts + 1,
                last_dispatch_at = NOW(),
                dispatch_error = NULL
            WHERE id = $1
              AND status = 'pending'
          `,
          [reportId],
        )
      } else {
        await sql.query(
          "UPDATE reports SET status = 'queued' WHERE id = $1 AND status = 'pending'",
          [reportId],
        )
      }

      logInfo("created report for paid payment", {
        paymentId: redactId(payment.id),
        reportId: redactId(reportId),
      })
    } catch (error) {
      counters.skipped += 1
      if (!env.dryRun && createdReportId) {
        const message = safeErrorMessage(error)
        if (hasColumn(schema, "reports", "dispatch_error")) {
          await sql.query(
            `
              UPDATE reports
              SET status = 'failed',
                  error = COALESCE(NULLIF(error, ''), $2),
                  completed_at = COALESCE(completed_at, NOW()),
                  dispatch_attempts = dispatch_attempts + 1,
                  last_dispatch_at = NOW(),
                  dispatch_error = $2
              WHERE id = $1
                AND status = 'pending'
            `,
            [createdReportId, message],
          )
        } else {
          await sql.query(
            `
              UPDATE reports
              SET status = 'failed',
                  error = COALESCE(NULLIF(error, ''), $2),
                  completed_at = COALESCE(completed_at, NOW())
              WHERE id = $1
                AND status = 'pending'
            `,
            [createdReportId, message],
          )
        }
      }
      await markPaymentRefundNeedsReview(
        sql,
        schema,
        env,
        payment.id,
        "Report dispatch failed after payment",
      )
      logWarn("failed to create report for paid payment", {
        paymentId: redactId(payment.id),
        error: safeErrorMessage(error),
      })
    }
  }
}

async function reconcileLegacyPendingReports(
  sql: Sql,
  schema: SchemaInfo,
  env: AppEnv,
  counters: Counters,
) {
  const rows = (await sql.query(
    `
      SELECT r.*
      FROM reports r
      JOIN payments p ON p.report_id = r.id
      WHERE r.status = 'pending'
        AND p.status = 'created'
        AND p.razorpay_payment_id IS NULL
        AND r.started_at IS NULL
        AND r.gha_run_id IS NULL
        AND r.created_at < NOW() - ($1::int * INTERVAL '1 minute')
      ORDER BY r.created_at ASC
      LIMIT 50
    `,
    [CREATED_PAYMENT_TIMEOUT_MINUTES],
  )) as ReportRow[]

  for (const report of rows) {
    if (env.dryRun) {
      counters.legacyPendingReportsCancelled += 1
      logInfo("dry run: would cancel legacy unpaid pending report", {
        reportId: redactId(report.id),
      })
      continue
    }

    await sql.query(
      `
        UPDATE reports
        SET status = 'cancelled',
            error = COALESCE(NULLIF(error, ''), 'Payment was not completed.'),
            completed_at = COALESCE(completed_at, NOW()),
            stage_progress = COALESCE(stage_progress, '{}'::jsonb) || $2::jsonb
        WHERE id = $1
          AND status = 'pending'
      `,
      [
        report.id,
        JSON.stringify({
          step_label: "Payment not completed",
          detail: "Payment was not completed.",
        }),
      ],
    )

    if (supportsPaymentStatus(schema, "abandoned")) {
      await sql.query(
        `
          UPDATE payments
          SET status = 'abandoned'
          WHERE report_id = $1
            AND status = 'created'
        `,
        [report.id],
      )
    }

    counters.legacyPendingReportsCancelled += 1
    logInfo("cancelled legacy unpaid pending report", { reportId: redactId(report.id) })
  }
}

async function reconcileQueuedWithoutRun(
  sql: Sql,
  schema: SchemaInfo,
  env: AppEnv,
  counters: Counters,
) {
  const rows = (await sql.query(
    `
      SELECT *
      FROM reports
      WHERE status IN ('pending', 'queued')
        AND gha_run_id IS NULL
        AND created_at < NOW() - ($1::int * INTERVAL '1 minute')
      ORDER BY created_at ASC
      LIMIT 50
    `,
    [QUEUED_WITHOUT_RUN_TIMEOUT_MINUTES],
  )) as ReportRow[]

  for (const report of rows) {
    if (env.dryRun) {
      counters.queuedWithoutRunFailed += 1
      logInfo("dry run: would mark queued report without run as failed", {
        reportId: redactId(report.id),
      })
      continue
    }

    const progress = JSON.stringify({
      step_label: "Generation did not start",
      detail: "Report generation did not start. Payment, if any, will be reviewed.",
    })

    if (hasColumn(schema, "reports", "dispatch_error")) {
      await sql.query(
        `
          UPDATE reports
          SET status = 'failed',
              error = COALESCE(NULLIF(error, ''), 'Report generation did not start. Payment, if any, will be reviewed.'),
              completed_at = COALESCE(completed_at, NOW()),
              dispatch_error = COALESCE(NULLIF(dispatch_error, ''), 'Report generation did not start.'),
              stage_progress = COALESCE(stage_progress, '{}'::jsonb) || $2::jsonb
          WHERE id = $1
            AND status IN ('pending', 'queued')
            AND gha_run_id IS NULL
        `,
        [report.id, progress],
      )
    } else {
      await sql.query(
        `
          UPDATE reports
          SET status = 'failed',
              error = COALESCE(NULLIF(error, ''), 'Report generation did not start. Payment, if any, will be reviewed.'),
              completed_at = COALESCE(completed_at, NOW()),
              stage_progress = COALESCE(stage_progress, '{}'::jsonb) || $2::jsonb
          WHERE id = $1
            AND status IN ('pending', 'queued')
            AND gha_run_id IS NULL
        `,
        [report.id, progress],
      )
    }

    await markRefundNeedsReview(sql, schema, env, report.id, "Report generation did not start")
    counters.queuedWithoutRunFailed += 1
    logInfo("marked queued report without run as failed", { reportId: redactId(report.id) })
  }
}

function terminalFromConclusion(conclusion: string) {
  if (conclusion === "success") return null
  if (conclusion === "cancelled") {
    return {
      status: "cancelled",
      label: "Workflow cancelled",
      error: "Report generation was cancelled before it completed.",
    }
  }
  if (conclusion === "timed_out") {
    return {
      status: "failed",
      label: "Workflow timed out",
      error: "Report generation took too long and timed out before completion.",
    }
  }
  return {
    status: "failed",
    label: "Workflow stopped",
    error: "Report generation stopped unexpectedly before completion.",
  }
}

async function reconcileGithubTerminalRuns(
  sql: Sql,
  schema: SchemaInfo,
  env: AppEnv,
  counters: Counters,
) {
  const rows = (await sql.query(
    `
      SELECT *
      FROM reports
      WHERE status IN ('queued', 'running')
        AND gha_run_id IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 50
    `,
  )) as ReportRow[]

  for (const report of rows) {
    try {
      const run = await getGithubRun(env, report.gha_run_id as string | number)
      if (!run || run.status !== "completed" || !run.conclusion) continue

      const terminal = terminalFromConclusion(run.conclusion)
      if (!terminal) continue

      if (env.dryRun) {
        counters.reportsSyncedFromGithub += 1
        logInfo("dry run: would sync report terminal github state", {
          reportId: redactId(report.id),
          status: terminal.status,
        })
        continue
      }

      await sql.query(
        `
          UPDATE reports
          SET status = $2,
              error = COALESCE(NULLIF(error, ''), $3),
              completed_at = COALESCE(completed_at, NOW()),
              stage_progress = COALESCE(stage_progress, '{}'::jsonb) || $4::jsonb
          WHERE id = $1
            AND status IN ('queued', 'running')
        `,
        [
          report.id,
          terminal.status,
          terminal.error,
          JSON.stringify({
            step_label: terminal.label,
            detail: terminal.error,
          }),
        ],
      )

      await markRefundNeedsReview(sql, schema, env, report.id, terminal.error)
      counters.reportsSyncedFromGithub += 1
      logInfo("synced report terminal github state", {
        reportId: redactId(report.id),
        status: terminal.status,
      })
    } catch (error) {
      counters.skipped += 1
      logWarn("failed to sync github run", {
        reportId: redactId(report.id),
        error: safeErrorMessage(error),
      })
    }
  }
}

async function reconcileStaleRunningReports(
  sql: Sql,
  schema: SchemaInfo,
  env: AppEnv,
  counters: Counters,
) {
  const rows = (await sql.query(
    `
      SELECT *
      FROM reports
      WHERE status = 'running'
        AND started_at < NOW() - ($1::int * INTERVAL '1 hour')
      ORDER BY started_at ASC
      LIMIT 50
    `,
    [RUNNING_STALE_HOURS],
  )) as ReportRow[]

  for (const report of rows) {
    if (env.dryRun) {
      counters.reportsSyncedFromGithub += 1
      logInfo("dry run: would mark stale running report as failed", {
        reportId: redactId(report.id),
      })
      continue
    }

    await sql.query(
      `
        UPDATE reports
        SET status = 'failed',
            error = COALESCE(NULLIF(error, ''), 'Report generation exceeded the maximum expected runtime.'),
            completed_at = COALESCE(completed_at, NOW()),
            stage_progress = COALESCE(stage_progress, '{}'::jsonb) || $2::jsonb
        WHERE id = $1
          AND status = 'running'
      `,
      [
        report.id,
        JSON.stringify({
          step_label: "Generation timed out",
          detail: "Report generation exceeded the maximum expected runtime.",
        }),
      ],
    )

    await markRefundNeedsReview(sql, schema, env, report.id, "Report generation timed out")
    counters.reportsSyncedFromGithub += 1
    logInfo("marked stale running report as failed", { reportId: redactId(report.id) })
  }
}

async function reconcilePaidTerminalReportsForRefundReview(
  sql: Sql,
  schema: SchemaInfo,
  env: AppEnv,
  counters: Counters,
) {
  if (!hasColumn(schema, "payments", "refund_status")) return

  const rows = (await sql.query(
    `
      SELECT r.*
      FROM reports r
      JOIN payments p ON p.report_id = r.id
      WHERE r.status IN ('failed', 'cancelled')
        AND p.status = 'paid'
        AND COALESCE(p.refund_status, 'none') = 'none'
      ORDER BY r.completed_at ASC NULLS LAST, r.created_at ASC
      LIMIT 50
    `,
  )) as ReportRow[]

  for (const report of rows) {
    const reason =
      report.status === "cancelled"
        ? "Report generation was cancelled after payment"
        : "Report generation failed after payment"

    await markRefundNeedsReview(sql, schema, env, report.id, reason)
    counters.paidTerminalReportsMarkedForReview += 1
    logInfo("marked paid terminal report for refund review", {
      reportId: redactId(report.id),
      status: report.status,
    })
  }
}

async function runReconciliation() {
  const env = loadEnv()
  const sql = createSql(env.databaseUrl)
  const razorpay = createRazorpay(env)
  const counters = emptyCounters()

  logInfo("reconciliation starting", {
    triggerSource: process.env.TRIGGER_SOURCE || "unknown",
    razorpayMode: env.razorpayMode,
    dryRun: env.dryRun,
  })

  const result = await withAdvisoryLock(sql, LOCK_KEY, async () => {
    const schema = await loadSchemaInfo(sql)
    await reconcileStaleCreatedPayments(sql, schema, env, razorpay, counters)
    await reconcilePaidPaymentsWithoutReports(sql, schema, env, counters)
    await reconcileLegacyPendingReports(sql, schema, env, counters)
    await reconcileQueuedWithoutRun(sql, schema, env, counters)
    await reconcileGithubTerminalRuns(sql, schema, env, counters)
    await reconcileStaleRunningReports(sql, schema, env, counters)
    await reconcilePaidTerminalReportsForRefundReview(sql, schema, env, counters)
    return counters
  })

  if (!result.acquired) {
    logInfo("another reconciliation run is already active")
    return
  }

  logInfo("reconciliation completed", result.result)
}

runReconciliation().catch((error) => {
  logWarn("reconciliation failed", { error: safeErrorMessage(error) })
  process.exitCode = 1
})
