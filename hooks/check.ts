// One check of one linked MR: read GitLab, compare with the last snapshot, and
// sort what changed into wake lines (an armed condition or a default problem)
// and quiet lines (everything else, attached to the session's next turn).
import type { EngineInterface } from 'claude-code'

import type { Arm, Link, Snapshot } from '../types'
import { checkDeployed, type DeployTargets } from './deploy'
import { api, enc, selfName, type FailKind } from './glab'

export type CheckCfg = { glabPath: string; targets: DeployTargets }

export type CheckOutcome =
  /** broken: waits GitLab refused outright (a wrong job id, no access); disarmed. */
  | { ok: true; link: Link | null; wake: string[]; quiet: string[]; broken: string[]; reportedDeploys: string[] }
  | { ok: false; kind: FailKind; detail: string; gone: boolean }

type MrJson = {
  state: string
  title: string
  web_url: string
  sha: string
  has_conflicts: boolean
  merge_status?: string
  user_notes_count: number
  merge_commit_sha: string | null
  squash_commit_sha: string | null
  head_pipeline: { id: number; sha: string; status: string; web_url: string; ref?: string } | null
}

type Note = { body: string; system: boolean; created_at: string; author: { username: string }; id: number }

const NOTE_PAGE = 50
const NOTE_PAGES = 10
const PIPELINE_FINAL = new Set(['success', 'failed', 'canceled', 'skipped', 'manual'])
const JOB_FINAL = new Set(['success', 'failed', 'canceled', 'skipped'])
/** Conditions that can still fire on a merged MR. */
const AFTER_MERGE = new Set(['comment', 'deployed', 'pipeline', 'job', 'merged'])

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
/** Someone else's text, kept to one line so it cannot pose as more of the mod's own lines. */
const quoted = (s: string, n: number) => clip(s.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ⏎ '), n)
/** Compares as times: GitLab may write them with an offset, and so may a `since` argument. */
const isAfter = (a: string, b: string) => Date.parse(a) > Date.parse(b)
/** While GitLab is working out mergeability, has_conflicts reads false whatever is true. */
const RECHECKING = new Set(['unchecked', 'checking', 'cannot_be_merged_recheck', 'cannot_be_merged_rechecking'])

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
  // `locked` lasts only while a merge is being made, and may fall back to opened.
  if (cur.state === 'locked') cur.state = prev?.state ?? 'opened'
  if (!cur.hasConflicts && RECHECKING.has(mr.data.merge_status ?? '')) {
    cur.hasConflicts = prev?.hasConflicts ?? false
    cur.isConflictUnknown = prev ? prev.isConflictUnknown : true
  }
  // A merged-results or merge-train pipeline runs on a temporary merge commit: it is
  // the head's pipeline when the head is a parent of that commit.
  const head = mr.data.head_pipeline
  if (head && head.sha !== cur.sha && new RegExp(`^refs/merge-requests/${iid}/(merge|train)$`).test(head.ref ?? '')) {
    if (prev?.pipelineId === head.id && prev.sha === cur.sha && prev.pipelineSha === cur.sha) cur.pipelineSha = cur.sha
    else {
      const commit = await get<{ parent_ids?: string[] }>(`projects/${enc(project)}/repository/commits/${head.sha}`)
      if (!commit.ok && commit.kind !== 'notfound') return fail(commit)
      if (commit.ok && commit.data.parent_ids?.includes(cur.sha)) cur.pipelineSha = cur.sha
    }
  }
  const wake: string[] = []
  const quiet: string[] = []
  const fired = { ...link.fired }
  let arms = [...link.arms]

  // Default problems: each fires once per change, on the current head only.
  const headFailed = cur.pipelineStatus === 'failed' && cur.pipelineSha === cur.sha
  // The same pipeline seen running again (a retried job) may fail again: report that too.
  if (fired.pipelineId === cur.pipelineId && cur.pipelineStatus !== 'failed') fired.pipelineId = undefined
  if (cur.state === 'opened' && headFailed && fired.pipelineId !== cur.pipelineId) {
    fired.pipelineId = cur.pipelineId ?? undefined
    if (prev && link.problems.includes('pipeline')) {
      const jobs = await get<{ name: string }[]>(
        `projects/${enc(project)}/pipelines/${cur.pipelineId}/jobs?scope[]=failed&per_page=100`,
      )
      const names = jobs.ok ? jobs.data.map(j => j.name).join(', ') : 'unknown'
      wake.push(`pipeline #${cur.pipelineId} failed${names ? ` (failed jobs: ${names})` : ''} ${cur.pipelineUrl}`)
    }
  }
  if (cur.state === 'opened' && cur.hasConflicts && !fired.conflict) {
    fired.conflict = true
    // The first settled read of a conflict that may have been there at link time is not news.
    if (prev && !prev.isConflictUnknown && link.problems.includes('conflict')) wake.push('merge conflict with the target branch')
  } else if (!cur.hasConflicts && fired.conflict) {
    fired.conflict = false
    quiet.push('merge conflict cleared')
  }
  if (prev?.state === 'opened' && cur.state === 'closed' && link.problems.includes('closed')) {
    wake.push('closed without merging')
  }


  // Comments: read only when the count moved or a comment wait is armed.
  let noteSince = link.noteSince
  let isNotesUnread = link.isNotesUnread ?? false
  const commentArms = arms.filter(a => a.kind === 'comment')
  if (!prev || prev.notesCount !== cur.notesCount || commentArms.length > 0) {
    // Page back far enough to reach what has not been read: a long gap can hold many notes.
    const marks = [noteSince, ...commentArms.map(x => x.since)].filter((x): x is string => !!x)
    const oldest = marks.reduce((m, x) => (!m || isAfter(m, x) ? x : m), '')
    const all: Note[] = []
    let failed: { kind: FailKind; detail: string } | null = null
    for (let page = 1; page <= NOTE_PAGES; page++) {
      const got = await get<Note[]>(`${base}/notes?sort=desc&order_by=created_at&per_page=${NOTE_PAGE}&page=${page}`)
      if (!got.ok) { failed = got; break }
      all.push(...got.data)
      const last = got.data.at(-1)
      if (got.data.length < NOTE_PAGE || !oldest || !last || !isAfter(last.created_at, oldest)) break
    }
    const me = await selfName($, host, cfg.glabPath)
    if (!failed && !me.ok) failed = me
    // A failed read must not move the snapshot on, or the comment would be missed. With a
    // comment wait armed the check fails; without one the rest carries on and this is retried.
    if (failed && commentArms.length > 0) return fail(failed)
    if (failed) cur.notesCount = -1
    const notes = { data: all }
    if (failed && !prev) isNotesUnread = true
    if (!failed) isNotesUnread = false
    if (!failed && me.ok)
    {
      const others = notes.data
        .filter(n => !n.system && n.author.username !== me.data)
        .reverse()
      const fresh = (since: string | null | undefined) =>
        others.filter(n => !since || isAfter(n.created_at, since))
      const newest = notes.data.reduce((m, n) => (!m || isAfter(n.created_at, m) ? n.created_at : m), noteSince ?? '')
      const told = new Set<number>()
      for (const arm of commentArms) {
        const hits = fresh(arm.since).filter(n => !arm.from || n.author.username === arm.from)
        if (hits.length === 0) continue
        for (const n of hits) told.add(n.id)
        wake.push(...hits.map(n => `comment by ${n.author.username}: ${quoted(n.body, 1500)} ${cur.webUrl}#note_${n.id}`))
        arms = arms.filter(a => a.id !== arm.id)
      }
      if (prev) {
        for (const n of fresh(noteSince ?? (link.isNotesUnread ? link.linkedAt : null))) {
          if (!told.has(n.id)) quiet.push(`comment by ${n.author.username}: ${quoted(n.body, 300)}`)
        }
      }
      noteSince = newest || noteSince
    }
  }

  // Armed conditions, one shot each.
  const keep: Arm[] = []
  const cannot: Arm[] = []
  const broken: string[] = []
  let reportedDeploys = link.reportedDeploys ?? []
  for (const arm of arms) {
    if (arm.kind === 'comment') { keep.push(arm); continue }
    if (cur.state === 'closed' && arm.kind !== 'job') { cannot.push(arm); continue }
    if (cur.state === 'merged' && !AFTER_MERGE.has(arm.kind)) { cannot.push(arm); continue }
    const hit = await evalArm($, link, arm, cur, cfg)
    if (!hit.ok) {
      // GitLab refusing this one read is about this wait, not about the host: retrying cannot help.
      if (hit.kind !== 'notfound' && hit.kind !== 'forbidden') return fail(hit)
      const why = hit.kind === 'notfound' ? 'GitLab has no such thing (404)' : "glab's user is not allowed to read it (403)"
      broken.push(`${describeArm(arm)} wait disarmed: ${why}`)
      continue
    }
    if (hit.reported) reportedDeploys = [...new Set([...reportedDeploys, hit.reported])].slice(-50)
    if (hit.line === null) keep.push(arm)
    else if (hit.line !== '') wake.push(hit.line)
    else quiet.push(`${describeArm(arm)} wait disarmed: ${hit.why}`)
  }
  if (cannot.length > 0) {
    wake.push(`MR is ${cur.state}; these waits can no longer fire and were disarmed: ${cannot.map(describeArm).join(', ')}`)
  }

  // Quiet changes nobody armed for, left out when this check's wake already says them.
  const pipelineWoke = wake.some(w => w.startsWith(`pipeline #${cur.pipelineId} `))
  if (prev && (prev.pipelineId !== cur.pipelineId || prev.pipelineStatus !== cur.pipelineStatus) && cur.pipelineId && !pipelineWoke) {
    quiet.push(`pipeline #${cur.pipelineId}: ${cur.pipelineStatus}`)
  }
  const stateWoke = wake.some(w => w === 'merged' || w === 'closed without merging' || w.startsWith('MR is '))
  if (prev && prev.state !== cur.state && !stateWoke) {
    quiet.push(`state: ${prev.state} → ${cur.state}`)
  }

  const next: Link = { ...link, snap: cur, fired, noteSince, arms: keep, reportedDeploys, isNotesUnread, isForbidden: false, failing: undefined }
  const isDone = cur.state !== 'opened' && keep.length === 0
  if (isDone) quiet.push(`unlinked (${cur.state})`)
  return { ok: true, link: isDone ? null : next, wake: [...new Set(wake)], quiet, broken, reportedDeploys }
}

type ArmHit =
  | { ok: true; line: string | null; why?: string; reported?: string }
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
        if (jobs.ok && jobs.data.length) failed = ` (failed jobs: ${jobs.data.map(j => j.name).join(', ')})`
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
      // With no approvals required (gitlab.com free), GitLab reports approved with nobody in
      // approved_by; the wait is for a person's approval, so it needs a name either way.
      const by = ap.data.approved_by.map(a => a.user.username)
      if (!ap.data.approved || by.length === 0) return { ok: true, line: null }
      return { ok: true, line: `approved by ${by.join(', ')}` }
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
        cur.deployCommit, cfg.targets, arm.target ?? '', arm.job, link.reportedDeploys,
      )
      if (!hit.ok) return hit
      if (!hit.data) return { ok: true, line: null }
      const d = hit.data
      return {
        ok: true,
        reported: d.status === 'success' ? undefined : d.key,
        line: [
          `deployed ${arm.target}:`, d.job === arm.target ? '' : d.job, d.status, `at ${d.sha.slice(0, 8)}`,
          d.note ? `(${d.note})` : '', d.url,
        ].filter(Boolean).join(' '),
      }
    }
    default:
      return { ok: true, line: null }
  }
}
