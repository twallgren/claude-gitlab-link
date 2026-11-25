// The deployed condition: a finished deploy whose commit contains the MR's commit.
import type { EngineInterface } from 'claude-code'

import { api, contains, enc, type ApiResult } from './glab'

export type DeployTarget = { jobs: string[]; branch?: string; notes?: Record<string, string> }
export type DeployTargets = Record<string, Record<string, DeployTarget>>

/** The deploy outcome when one has finished; null while still waiting. */
export type DeployHit = { status: string; job: string; url: string; sha: string; note?: string }

const FINISHED = new Set(['success', 'failed', 'canceled'])
const SCAN = 20

export function parseTargets(json: string): DeployTargets | { error: string } {
  try {
    const v = JSON.parse(json || '{}')
    return v && typeof v === 'object' ? (v as DeployTargets) : { error: 'deployTargets is not an object' }
  } catch (err) {
    return { error: `deployTargets is not valid JSON: ${String(err).slice(0, 120)}` }
  }
}

type Ctx = { host: string; project: string; glabPath: string }

/**
 * Newest-first rows of `{ id, sha }`: keep those containing `commit`, stopping at
 * the first that does not (the branch is linear, so older ones cannot either).
 * Returned oldest first, so the first deploy to finish is the one reported.
 */
async function containing<T extends { sha: string }>(
  $: EngineInterface,
  c: Ctx,
  commit: string,
  rows: T[],
): Promise<ApiResult<T[]>> {
  const keep: T[] = []
  for (const row of rows) {
    const isIn = await contains($, c.host, c.project, commit, row.sha, c.glabPath)
    if (!isIn.ok) return isIn
    if (!isIn.data) break
    keep.unshift(row)
  }
  return { ok: true, data: keep }
}

/** A configured target: named jobs in branch pipelines. */
async function byJobs($: EngineInterface, c: Ctx, commit: string, t: DeployTarget, only?: string): Promise<ApiResult<DeployHit | null>> {
  const branch = t.branch ?? 'main'
  const names = only ? [only] : t.jobs
  const pls = await api<{ id: number; sha: string }[]>(
    $, c.host,
    `projects/${enc(c.project)}/pipelines?ref=${encodeURIComponent(branch)}&order_by=id&sort=desc&per_page=${SCAN}`,
    c.glabPath,
  )
  if (!pls.ok) return pls
  const keep = await containing($, c, commit, pls.data)
  if (!keep.ok) return keep
  for (const p of keep.data) {
    const jobs = await api<{ name: string; status: string; web_url: string }[]>(
      $, c.host, `projects/${enc(c.project)}/pipelines/${p.id}/jobs?per_page=100`, c.glabPath,
    )
    if (!jobs.ok) return jobs
    const done = jobs.data.find(j => names.includes(j.name) && FINISHED.has(j.status))
    if (done) {
      return { ok: true, data: { status: done.status, job: done.name, url: done.web_url, sha: p.sha, note: t.notes?.[done.name] } }
    }
  }
  return { ok: true, data: null }
}

/** Any other target: a GitLab environment, read from the deployments API. */
async function byEnvironment($: EngineInterface, c: Ctx, commit: string, env: string): Promise<ApiResult<DeployHit | null>> {
  const deps = await api<{ sha: string; status: string; deployable?: { name?: string; web_url?: string } }[]>(
    $, c.host,
    `projects/${enc(c.project)}/deployments?environment=${encodeURIComponent(env)}&order_by=id&sort=desc&per_page=${SCAN}`,
    c.glabPath,
  )
  if (!deps.ok) return deps
  const keep = await containing($, c, commit, deps.data)
  if (!keep.ok) return keep
  const done = keep.data.find(d => FINISHED.has(d.status))
  if (!done) return { ok: true, data: null }
  return {
    ok: true,
    data: { status: done.status, job: done.deployable?.name ?? env, url: done.deployable?.web_url ?? '', sha: done.sha },
  }
}

export async function checkDeployed(
  $: EngineInterface,
  c: Ctx,
  commit: string,
  targets: DeployTargets,
  target: string,
  only?: string,
): Promise<ApiResult<DeployHit | null>> {
  const t = targets[c.project]?.[target]
  return t ? byJobs($, c, commit, t, only) : byEnvironment($, c, commit, target)
}
