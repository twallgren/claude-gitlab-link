// The deployed condition: a finished deploy whose commit contains the MR's commit.
import type { EngineInterface } from 'claude-code'

import { api, contains, enc, type ApiResult } from './glab'

export type DeployTarget = { jobs: string[]; branch?: string; notes?: Record<string, string> }
export type DeployTargets = Record<string, Record<string, DeployTarget>>

/** The deploy outcome when one has finished; null while still waiting. */
export type DeployHit = { status: string; job: string; url: string; sha: string; note?: string; key: string }

// Not `created`: a deploy behind a manual gate can stay that way for good.
const IN_PROGRESS = new Set(['pending', 'running', 'waiting_for_resource', 'preparing'])

/**
 * Of the deploys containing the commit, oldest first: the first success. With none,
 * wait while the newest is on its way, else report the newest failure or
 * cancellation, unless it was reported already: then re-arming waits for the retry.
 */
function pick(found: (DeployHit | { status: string; key?: undefined })[], reported: string[]): DeployHit | null {
  const success = found.find(h => h.status === 'success')
  if (success) return success as DeployHit
  if (IN_PROGRESS.has(found.at(-1)?.status ?? '')) return null
  const last = found.filter(h => FINISHED.has(h.status)).at(-1) as DeployHit | undefined
  return last && !reported.includes(last.key) ? last : null
}

const JOB_PAGES = 5

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
 * Newest-first rows of `{ id, sha }`: keep those containing `commit`. Every row is
 * looked at: a newer one without it (a rollback, a re-run of an old pipeline) does
 * not undo an older one that had it. Returned oldest first, so the first deploy to
 * finish is the one reported. Containment is cached, so a later check costs little.
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
    if (isIn.data) keep.unshift(row)
  }
  return { ok: true, data: keep }
}

/** A configured target: named jobs in branch pipelines. */
async function byJobs($: EngineInterface, c: Ctx, commit: string, t: DeployTarget, reported: string[], only?: string): Promise<ApiResult<DeployHit | null>> {
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
  const found: Parameters<typeof pick>[0] = []
  for (const p of keep.data) {
    const mine: { name: string; status: string; web_url: string }[] = []
    for (let page = 1; page <= JOB_PAGES; page++) {
      const jobs = await api<typeof mine>(
        $, c.host, `projects/${enc(c.project)}/pipelines/${p.id}/jobs?per_page=100&page=${page}`, c.glabPath,
      )
      if (!jobs.ok) return jobs
      mine.push(...jobs.data.filter(j => names.includes(j.name)))
      if (jobs.data.length < 100) break
    }
    // One answer per pipeline: a job that deployed, else one on its way, else one that ended.
    const j = mine.find(x => x.status === 'success') ?? mine.find(x => IN_PROGRESS.has(x.status))
      ?? mine.find(x => FINISHED.has(x.status))
    if (!j) continue
    const hit = { status: j.status, job: j.name, url: j.web_url, sha: p.sha, note: t.notes?.[j.name], key: `${j.web_url} ${j.status}` }
    if (j.status === 'success') return { ok: true, data: hit }
    found.push(hit)
  }
  return { ok: true, data: pick(found, reported) }
}

/** Any other target: a GitLab environment, read from the deployments API. */
async function byEnvironment($: EngineInterface, c: Ctx, commit: string, env: string, reported: string[]): Promise<ApiResult<DeployHit | null>> {
  const deps = await api<{ id?: number; sha: string; status: string; deployable?: { name?: string; web_url?: string } }[]>(
    $, c.host,
    `projects/${enc(c.project)}/deployments?environment=${encodeURIComponent(env)}&order_by=id&sort=desc&per_page=${SCAN}`,
    c.glabPath,
  )
  if (!deps.ok) return deps
  const keep = await containing($, c, commit, deps.data)
  if (!keep.ok) return keep
  const found = keep.data.map(d => ({
    status: d.status, job: d.deployable?.name ?? env, url: d.deployable?.web_url ?? '', sha: d.sha,
    key: `${env} ${d.id ?? d.sha} ${d.status}`,
  }))
  return { ok: true, data: pick(found, reported) }
}

export async function checkDeployed(
  $: EngineInterface,
  c: Ctx,
  commit: string,
  targets: DeployTargets,
  target: string,
  only?: string,
  reported: string[] = [],
): Promise<ApiResult<DeployHit | null>> {
  const t = targets[c.project]?.[target]
  return t ? byJobs($, c, commit, t, reported, only) : byEnvironment($, c, commit, target, reported)
}
