// One check of one linked MR: read GitLab, compare with the last snapshot, and
// sort what changed into wake lines (an armed condition or a default problem)
// and quiet lines (everything else, attached to the session's next turn).
import type { EngineInterface } from 'claude-code'

import type { Arm, Link, Snapshot } from '../types'
import { checkDeployed, type DeployTargets } from './deploy'
import { api, enc, selfName, type FailKind } from './glab'

export type CheckCfg = { glabPath: string; targets: DeployTargets }

export type CheckOutcome =
  | { ok: true; link: Link | null; wake: string[]; quiet: string[] }
  | { ok: false; kind: FailKind; detail: string; gone: boolean }

type MrJson = {
  state: string
  title: string
  web_url: string
  sha: string
  has_conflicts: boolean
  user_notes_count: number
  merge_commit_sha: string | null
  squash_commit_sha: string | null
  head_pipeline: { id: number; sha: string; status: string; web_url: string } | null
}

type Note = { body: string; system: boolean; created_at: string; author: { username: string }; id: number }

const PIPELINE_FINAL = new Set(['success', 'failed', 'canceled', 'skipped', 'manual'])
const JOB_FINAL = new Set(['success', 'failed', 'canceled', 'skipped'])
/** Conditions that can still fire on a merged MR. */
const AFTER_MERGE = new Set(['comment', 'deployed', 'pipeline', 'job', 'merged'])

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

export function toSnapshot(mr: MrJson): Snapshot {
  return {
    state: mr.state,
    title: mr.title,
    webUrl: mr.web_url,
    sha: mr.sha,
    pipelineId: mr.head_pipeline?.id ?? null,
    pipelineSha: mr.head_pipeline?.sha ?? null,
    pipelineStatus: mr.head_pipeline?.status ?? null,
    pipelineUrl: mr.head_pipeline?.web_url ?? null,
    hasConflicts: mr.has_conflicts,
    notesCount: mr.user_notes_count,
    deployCommit: mr.merge_commit_sha ?? mr.squash_commit_sha ?? (mr.state === 'merged' ? mr.sha : null),
  }
}

export const describeArm = (a: Arm) => {
  switch (a.kind) {
    case 'pipeline': return a.status === 'failed' ? 'pipeline (failed only)' : 'pipeline'
    case 'job': return `job ${a.jobId}`
    case 'comment': return a.from ? `comment from ${a.from}` : 'comment'
    case 'deployed': return `deployed ${a.target}${a.job ? ` (${a.job})` : ''}`
    default: return a.kind
  }
}

export async function checkLink(
  $: EngineInterface,
  link: Link,
  cfg: CheckCfg,
): Promise<CheckOutcome> {
  const { host, project, iid } = link
  const base = `projects/${enc(project)}/merge_requests/${iid}`
  const get = <T>(path: string) => api<T>($, host, path, cfg.glabPath)
  const fail = (r: { kind: FailKind; detail: string }): CheckOutcome =>
    ({ ok: false, kind: r.kind, detail: r.detail, gone: false })

  const mr = await get<MrJson>(base)
  if (!mr.ok) return { ok: false, kind: mr.kind, detail: mr.detail, gone: mr.kind === 'notfound' }
  const cur = toSnapshot(mr.data)
  const prev = link.snap
  const wake: string[] = []
  const quiet: string[] = []
  const fired = { ...link.fired }
  let arms = [...link.arms]

  // Default problems: each fires once per change, on the current head only.
  const headFailed = cur.pipelineStatus === 'failed' && cur.pipelineSha === cur.sha
  if (cur.state === 'opened' && headFailed && fired.pipelineId !== cur.pipelineId) {
    fired.pipelineId = cur.pipelineId ?? undefined
    if (prev && link.problems.includes('pipeline')) {
      const jobs = await get<{ name: string }[]>(
        `projects/${enc(project)}/pipelines/${cur.pipelineId}/jobs?scope[]=failed&per_page=100`,
      )
      const names = jobs.ok ? jobs.data.map(j => j.name).join(', ') : 'unknown'
      wake.push(`pipeline #${cur.pipelineId} failed (failed jobs: ${names}) ${cur.pipelineUrl}`)
    }
  }
  if (cur.state === 'opened' && cur.hasConflicts && !fired.conflict) {
    fired.conflict = true
    if (prev && link.problems.includes('conflict')) wake.push('merge conflict with the target branch')
  } else if (!cur.hasConflicts && fired.conflict) {
    fired.conflict = false
    quiet.push('merge conflict cleared')
  }
  if (prev?.state === 'opened' && cur.state === 'closed' && link.problems.includes('closed')) {
    wake.push('closed without merging')
  }

  // Quiet changes nobody armed for.
  if (prev && (prev.pipelineId !== cur.pipelineId || prev.pipelineStatus !== cur.pipelineStatus) && cur.pipelineId) {
    quiet.push(`pipeline #${cur.pipelineId}: ${cur.pipelineStatus}`)
  }
  if (prev && prev.state !== cur.state && !(cur.state === 'closed' && link.problems.includes('closed'))) {
    quiet.push(`state: ${prev.state} → ${cur.state}`)
  }

  // Comments: read only when the count moved or a comment wait is armed.
  let noteSince = link.noteSince
  const commentArms = arms.filter(a => a.kind === 'comment')
  if (!prev || prev.notesCount !== cur.notesCount || commentArms.length > 0) {
    const notes = await get<Note[]>(`${base}/notes?sort=desc&order_by=created_at&per_page=50`)
    const me = await selfName($, host, cfg.glabPath)
    if (notes.ok && me.ok) {
      const others = notes.data
        .filter(n => !n.system && n.author.username !== me.data)
        .reverse()
      const fresh = (since: string | null | undefined) =>
        others.filter(n => !since || n.created_at > since)
      const newest = notes.data.reduce((m, n) => (n.created_at > m ? n.created_at : m), noteSince ?? '')
      const told = new Set<number>()
      for (const arm of commentArms) {
        const hits = fresh(arm.since).filter(n => !arm.from || n.author.username === arm.from)
        if (hits.length === 0) continue
        for (const n of hits) told.add(n.id)
        wake.push(...hits.map(n => `comment by ${n.author.username}: ${clip(n.body, 1500)} ${cur.webUrl}#note_${n.id}`))
        arms = arms.filter(a => a.id !== arm.id)
      }
      if (prev) {
        for (const n of fresh(noteSince)) {
          if (!told.has(n.id)) quiet.push(`comment by ${n.author.username}: ${clip(n.body, 300)}`)
        }
      }
      noteSince = newest || noteSince
    }
  }

  // Armed conditions, one shot each.
  const keep: Arm[] = []
  const cannot: Arm[] = []
  for (const arm of arms) {
    if (arm.kind === 'comment') { keep.push(arm); continue }
    if (cur.state === 'closed' && arm.kind !== 'job') { cannot.push(arm); continue }
    if (cur.state === 'merged' && !AFTER_MERGE.has(arm.kind)) { cannot.push(arm); continue }
    const hit = await evalArm($, link, arm, cur, cfg)
    if (!hit.ok) return fail(hit)
    if (hit.line === null) keep.push(arm)
    else if (hit.line !== '') wake.push(hit.line)
    else quiet.push(`${describeArm(arm)} wait disarmed: ${hit.why}`)
  }
  if (cannot.length > 0) {
    wake.push(`MR is ${cur.state}; these waits can no longer fire and were disarmed: ${cannot.map(describeArm).join(', ')}`)
  }

  const next: Link = { ...link, snap: cur, fired, noteSince, arms: keep }
  const isDone = cur.state !== 'opened' && keep.length === 0
  if (isDone) quiet.push(`unlinked (${cur.state})`)
  return { ok: true, link: isDone ? null : next, wake: [...new Set(wake)], quiet }
}

type ArmHit =
  | { ok: true; line: string | null; why?: string }
  | { ok: false; kind: FailKind; detail: string }

/** `line` null: still waiting; '' : disarmed quietly (`why`); else the wake line. */
async function evalArm($: EngineInterface, link: Link, arm: Arm, cur: Snapshot, cfg: CheckCfg): Promise<ArmHit> {
  const get = <T>(path: string) => api<T>($, link.host, path, cfg.glabPath)
  const p = enc(link.project)
  switch (arm.kind) {
    case 'pipeline': {
      const isCurrent = cur.pipelineId !== null && cur.pipelineSha === cur.sha
      if (!isCurrent || !PIPELINE_FINAL.has(cur.pipelineStatus ?? '')) return { ok: true, line: null }
      if (arm.status === 'failed' && cur.pipelineStatus !== 'failed') {
        return { ok: true, line: '', why: `pipeline #${cur.pipelineId} ${cur.pipelineStatus}` }
      }
      let failed = ''
      if (cur.pipelineStatus === 'failed') {
        const jobs = await get<{ name: string }[]>(`projects/${p}/pipelines/${cur.pipelineId}/jobs?scope[]=failed&per_page=100`)
        if (jobs.ok) failed = ` (failed jobs: ${jobs.data.map(j => j.name).join(', ')})`
      }
      return { ok: true, line: `pipeline #${cur.pipelineId} ${cur.pipelineStatus}${failed} ${cur.pipelineUrl}` }
    }
    case 'job': {
      const job = await get<{ name: string; status: string; web_url: string }>(`projects/${p}/jobs/${arm.jobId}`)
      if (!job.ok) return job
      if (!JOB_FINAL.has(job.data.status)) return { ok: true, line: null }
      return { ok: true, line: `job ${job.data.name} #${arm.jobId} ${job.data.status} ${job.data.web_url}` }
    }
    case 'approved': {
      const ap = await get<{ approved: boolean; approved_by: { user: { username: string } }[] }>(
        `projects/${p}/merge_requests/${link.iid}/approvals`,
      )
      if (!ap.ok) return ap
      if (!ap.data.approved) return { ok: true, line: null }
      return { ok: true, line: `approved by ${ap.data.approved_by.map(a => a.user.username).join(', ') || 'rule'}` }
    }
    case 'merged':
      return { ok: true, line: cur.state === 'merged' ? 'merged' : null }
    case 'conflict':
      return { ok: true, line: cur.state === 'opened' && cur.hasConflicts ? 'merge conflict with the target branch' : null }
    case 'deployed': {
      if (cur.state !== 'merged' || !cur.deployCommit) return { ok: true, line: null }
      const hit = await checkDeployed(
        $,
        { host: link.host, project: link.project, glabPath: cfg.glabPath },
        cur.deployCommit, cfg.targets, arm.target ?? '', arm.job,
      )
      if (!hit.ok) return hit
      if (!hit.data) return { ok: true, line: null }
      const d = hit.data
      return {
        ok: true,
        line: `deployed ${arm.target}: ${d.job} ${d.status} at ${d.sha.slice(0, 8)}${d.note ? ` (${d.note})` : ''} ${d.url}`,
      }
    }
    default:
      return { ok: true, line: null }
  }
}
