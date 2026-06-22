import type { AppEnv } from "./env.js"

export type GithubRun = {
  id: number
  status?: string
  conclusion?: string | null
}

function githubHeaders(env: AppEnv) {
  return {
    Authorization: `Bearer ${env.appGithubPat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }
}

export async function dispatchReportWorkflow(
  env: AppEnv,
  input: {
    reportId: string
    symbol: string
    reportType: string
    profile: string
    companyName?: string | null
  },
) {
  const url =
    `https://api.github.com/repos/${env.appGithubOwner}/${env.appGithubRepo}` +
    `/actions/workflows/${env.appGithubWorkflowId}/dispatches`

  const response = await fetch(url, {
    method: "POST",
    headers: githubHeaders(env),
    body: JSON.stringify({
      ref: env.appGithubRef,
      inputs: {
        symbol: input.symbol,
        job_id: input.reportId,
        report_type: input.reportType,
        profile: input.profile,
        company_name: input.companyName || "",
      },
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`GitHub dispatch failed (${response.status}): ${text.slice(0, 180)}`)
  }
}

export async function getGithubRun(env: AppEnv, runId: string | number): Promise<GithubRun | null> {
  const url =
    `https://api.github.com/repos/${env.appGithubOwner}/${env.appGithubRepo}` +
    `/actions/runs/${runId}`

  const response = await fetch(url, {
    method: "GET",
    headers: githubHeaders(env),
  })

  if (response.status === 404) return null
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`GitHub run lookup failed (${response.status}): ${text.slice(0, 180)}`)
  }

  return (await response.json()) as GithubRun
}

