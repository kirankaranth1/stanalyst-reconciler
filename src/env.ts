export type RazorpayMode = "test" | "live"

export type AppEnv = {
  databaseUrl: string
  razorpayMode: RazorpayMode
  razorpayKeyId: string
  razorpayKeySecret: string
  appGithubPat: string
  appGithubOwner: string
  appGithubRepo: string
  appGithubWorkflowId: string
  appGithubRef: string
  dryRun: boolean
}

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name]?.trim()
  if (value) return value
  if (fallback !== undefined) return fallback
  throw new Error(`Missing required environment variable: ${name}`)
}

function readRazorpayMode(): RazorpayMode {
  const mode = readEnv("RAZORPAY_MODE", "live").toLowerCase()
  if (mode === "test" || mode === "live") return mode
  throw new Error("RAZORPAY_MODE must be test or live")
}

export function loadEnv(): AppEnv {
  const razorpayMode = readRazorpayMode()
  const prefix = razorpayMode === "live" ? "RAZORPAY_LIVE" : "RAZORPAY_TEST"
  const dryRun = readEnv("RECONCILE_DRY_RUN", "false").toLowerCase() === "true"

  return {
    databaseUrl: readEnv("DATABASE_URL"),
    razorpayMode,
    razorpayKeyId: readEnv(`${prefix}_KEY_ID`),
    razorpayKeySecret: readEnv(`${prefix}_KEY_SECRET`),
    appGithubPat: readEnv("APP_GITHUB_PAT"),
    appGithubOwner: readEnv("APP_GITHUB_OWNER", "kirankaranth1"),
    appGithubRepo: readEnv("APP_GITHUB_REPO", "stock-analyst"),
    appGithubWorkflowId: readEnv("APP_GITHUB_WORKFLOW_ID", "analyze.yml"),
    appGithubRef: readEnv("APP_GITHUB_REF", "v2"),
    dryRun,
  }
}
