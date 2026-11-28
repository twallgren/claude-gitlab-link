// One check of one linked MR: read GitLab, compare with the last snapshot, and
// sort what changed into wake lines (a one-time wait, or a change set to always
// wake) and quiet lines (attached to the session's next turn).
import type { EngineInterface } from 'claude-code'

import type { Arm, DeliveryChoice, EventName, IgnoreKey, Link, Snapshot } from '../types'
import { checkDeployed, type DeployTargets } from './deploy'
import { armEvents, choiceFor, ignoreList, isListed, pendingOnce, unlinksWhenDone, type Defaults } from './delivery'
import { api, enc, selfName, type ApiResult, type FailKind } from './glab'

export type CheckCfg = { glabPath: string; targets: DeployTargets; defaults: Defaults }

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
  merge_user?: { username: string } | null
  merged_by?: { username: string } | null
  closed_by?: { username: string } | null
  head_pipeline: { id: number; sha: string; status: string; web_url: string; ref?: string } | null
}

type Note = { body: string; system: boolean; created_at: string; author: { username: string }; id: number }

const NOTE_PAGE = 50
const NOTE_PAGES = 10
/** How many checks wait for a failed read before going on without it. */
const RETRIES = 5
const PIPELINE_FINAL = new Set(['success', 'failed', 'canceled', 'skipped', 'manual'])
const JOB_FINAL = new Set(['success', 'failed', 'canceled', 'skipped'])
/** Conditions that can still fire on a merged MR, and on a closed one (which may reopen). */
const AFTER_MERGE = new Set(['comment', 'deployed', 'pipeline', 'job', 'merged'])
const AFTER_CLOSE = new Set(['comment', 'job', 'closed', 'reopened'])

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
    case 'pipeline': return a.status === 'failed' ? 'pipeline (failed only)' : a.status === 'success' ? 'pipeline (success only)' : 'pipeline'
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

  // Waits first (comments, then the rest): a change a wait reports is not reported again.
  const handled = new Set<EventName>()
  /** "once" choices that have had their wake. */
  const spent = new Set<EventName>()
  const fire = (arm: Arm) => {
    for (const e of armEvents(arm)) handled.add(e)
  }
  /** A transient failure, as against GitLab refusing the read: worth reading again. */
  const isPassing = (kind: FailKind) => kind !== 'forbidden' && kind !== 'notfound'
  const owes: NonNullable<Link['owes']> = { ...link.owes }
  /** What this check could not read and will try again. */
  const unread: string[] = []
  /** One read per check, so the wait and the delivery see the same approvers. */
  let approvals: Promise<ApiResult<Approvals>> | undefined
  const readApprovals = () => (approvals ??= get<Approvals>(`${base}/approvals`))
  let meName: string | null = null
  /** glab's user, read only when an ignored list or a comment needs it. */
  const whoAmI = async () => {
    const me = await selfName($, host, cfg.glabPath)
    if (me.ok) meName = me.data
    return me
  }
  const isIgnored = async (key: IgnoreKey, user: string | null | undefined) => {
    const list = ignoreList(link, key, cfg.defaults)
    if (list.includes('@me')) {
      const me = await whoAmI()
      if (!me.ok) return { ok: false as const, kind: me.kind, detail: me.detail }
    }
    return { ok: true as const, data: isListed(list, user, meName) }
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
    const me = await whoAmI()
    if (!failed && !me.ok) failed = me
    // A failed read must not move the snapshot on, or the comment would be missed. With a
    // comment wait armed the check fails; without one the rest carries on and this is retried.
    if (failed && commentArms.length > 0) return fail(failed)
    if (failed && isPassing(failed.kind)) unread.push('comments')
    if (failed) cur.notesCount = -1
    if (failed && !prev) isNotesUnread = true
    if (!failed) isNotesUnread = false
    if (!failed && me.ok) {
      const people = all.filter(n => !n.system).reverse()
      const ignored = ignoreList(link, 'comment', cfg.defaults)
      const heard = (n: Note) => !isListed(ignored, n.author.username, me.data)
      const fresh = (list: Note[], since: string | null | undefined) =>
        list.filter(n => !since || isAfter(n.created_at, since))
      const newest = all.reduce((m, n) => (!m || isAfter(n.created_at, m) ? n.created_at : m), noteSince ?? '')
      const told = new Set<number>()
      const line = (n: Note, size: number) => `comment by ${n.author.username}: ${quoted(n.body, size)}`
      const wakeWith = (n: Note) => {
        told.add(n.id)
        wake.push(`${line(n, 1500)} ${cur.webUrl}#note_${n.id}`)
      }
      for (const arm of commentArms) {
        // A wait naming its author hears them even if they are ignored.
        const from = arm.from === '@me' ? me.data : arm.from?.replace(/^@/, '')
        const wanted = from
          ? people.filter(n => n.author.username.toLowerCase() === from.toLowerCase())
          : people.filter(heard)
        const hits = fresh(wanted, arm.since)
        if (hits.length === 0) continue
        hits.filter(n => !told.has(n.id)).forEach(wakeWith)
        arms = arms.filter(a => a.id !== arm.id)
      }
      if (prev) {
        const choice = choiceFor(link, 'comment', cfg.defaults)
        const news = fresh(people.filter(heard), noteSince ?? (link.isNotesUnread ? link.linkedAt : null))
        const untold = news.filter(n => !told.has(n.id))
        if (link.once?.comment && news.length > 0) {
          // New comments you'd hear use it up, though a wait may have reported them already.
          // The one wake carries everything this check found.
          untold.forEach(wakeWith)
          spent.add('comment')
        } else for (const n of untold) {
          if (choice === 'off') continue
          if (choice === 'always' && !link.once?.comment) wakeWith(n)
          else quiet.push(line(n, 300))
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
    // An approval may have arrived in the same interval as the merge or close.
    const isLastLook = arm.kind === 'approved' && prev?.state === 'opened'
    const isOver = (cur.state === 'closed' && !AFTER_CLOSE.has(arm.kind)) || (cur.state === 'merged' && !AFTER_MERGE.has(arm.kind))
    if (isOver && !isLastLook) { cannot.push(arm); continue }
    const hit = await evalArm($, link, arm, cur, cfg, readApprovals)
    if (isOver && hit.ok && hit.line === null) { cannot.push(arm); continue }
    if (!hit.ok) {
      // GitLab refusing this one read is about this wait, not about the host: retrying cannot help.
      if (hit.kind !== 'notfound' && hit.kind !== 'forbidden') return fail(hit)
      const why = hit.kind === 'notfound' ? 'GitLab has no such thing (404)' : "glab's user is not allowed to read it (403)"
      broken.push(`${describeArm(arm)} wait disarmed: ${why}`)
      continue
    }
    if (hit.reported) reportedDeploys = [...new Set([...reportedDeploys, hit.reported])].slice(-50)
    if (hit.line === null) keep.push(arm)
    else if (hit.line !== '') {
      wake.push(hit.line)
      fire(arm)
    } else quiet.push(`${describeArm(arm)} wait disarmed: ${hit.why}`)
  }
  if (cannot.length > 0) {
    wake.push(`MR is ${cur.state}; these waits can no longer fire and were disarmed: ${cannot.map(describeArm).join(', ')}`)
  }

  // Then each change, delivered as the link chooses. A pending "once" stands in for the choice.
  const choose = (e: EventName): DeliveryChoice | 'once' =>
    spent.has(e) ? (choiceFor(link, e, cfg.defaults) === 'off' ? 'off' : 'quiet')
      : link.once?.[e] ? 'once'
      : choiceFor(link, e, cfg.defaults)
  const isWake = (c: DeliveryChoice | 'once') => c === 'always' || c === 'once'
  /** Several changes of one kind found together share a "once" wake: it is spent after them all. */
  const waking = new Set<EventName>()
  /**
   * A change of kind `e`. `urgent`: the line to wake with; `calm`: the one to add to
   * the next message. One a wait already reported is not repeated, but uses up "once".
   */
  const send = (e: EventName, urgent: string, calm = urgent) => {
    const c = choose(e)
    if (c === 'once') waking.add(e)
    if (handled.has(e)) return
    if (isWake(c)) wake.push(urgent)
    else if (c === 'quiet') quiet.push(calm)
  }
  /** A change a person made: left out when they are ignored for it. */
  const sendBy = async (e: EventName & IgnoreKey, user: string | null | undefined, text: string) => {
    if (choose(e) === 'off') return null
    const skip = await isIgnored(e, user)
    if (!skip.ok) return skip
    if (!skip.data) send(e, user ? `${text} by ${user}` : text)
    return null
  }

  // Pipelines and conflicts, on the open MR's current head only.
  const headFailed = cur.pipelineStatus === 'failed' && cur.pipelineSha === cur.sha
  // The same pipeline seen running again (a retried job) may fail again: report that too.
  if (fired.pipelineId === cur.pipelineId && cur.pipelineStatus !== 'failed') fired.pipelineId = undefined
  const hasMoved = !!prev && (prev.pipelineId !== cur.pipelineId || prev.pipelineStatus !== cur.pipelineStatus)
  /** A wait's wake already says how this pipeline stands. */
  const isPipelineTold = wake.some(w => w.startsWith(`pipeline #${cur.pipelineId} `))
  let isNewFailure = false
  if (cur.state === 'opened' && headFailed && fired.pipelineId !== cur.pipelineId) {
    fired.pipelineId = cur.pipelineId ?? undefined
    if (prev) {
      isNewFailure = true
      if (!handled.has('pipeline_failed') && isWake(choose('pipeline_failed'))) {
        const jobs = await get<{ name: string }[]>(
          `projects/${enc(project)}/pipelines/${cur.pipelineId}/jobs?scope[]=failed&per_page=100`,
        )
        const names = jobs.ok ? jobs.data.map(j => j.name).join(', ') : 'unknown'
        send('pipeline_failed', `pipeline #${cur.pipelineId} failed${names ? ` (failed jobs: ${names})` : ''} ${cur.pipelineUrl}`)
      } else send('pipeline_failed', `pipeline #${cur.pipelineId}: failed`)
    }
  }
  if (hasMoved && cur.pipelineId && !isNewFailure) {
    const calm = `pipeline #${cur.pipelineId}: ${cur.pipelineStatus}`
    const isHead = cur.state === 'opened' && cur.pipelineSha === cur.sha
    if (cur.pipelineStatus === 'success' && isHead) {
      send('pipeline_succeeded', `pipeline #${cur.pipelineId} succeeded ${cur.pipelineUrl}`, calm)
    } else if (!isPipelineTold) {
      // A failure seen again, or on an older commit, never wakes; nor do other statuses.
      const of: EventName[] = cur.pipelineStatus === 'success' ? ['pipeline_succeeded']
        : cur.pipelineStatus === 'failed' ? ['pipeline_failed'] : ['pipeline_failed', 'pipeline_succeeded']
      if (of.some(e => choose(e) !== 'off')) quiet.push(calm)
    }
  }
  if (cur.state === 'opened' && cur.hasConflicts && !fired.conflict) {
    fired.conflict = true
    // The first settled read of a conflict that may have been there at link time is not news.
    if (prev && !prev.isConflictUnknown) send('conflict', 'merge conflict with the target branch')
  } else if (!cur.hasConflicts && fired.conflict) {
    fired.conflict = false
    if (choose('conflict') !== 'off') quiet.push('merge conflict cleared')
  }

  // Approvals are read while the MR is open, once more as it stops being, and after a failed read.
  if (choose('approved') === 'off') delete owes.approvals
  else if (cur.state === 'opened' || prev?.state === 'opened' || owes.approvals) {
    const ap = await readApprovals()
    const before = prev?.approvedBy
    if (!ap.ok) {
      // Keep the last list, so the next good read still shows what is new.
      cur.approvedBy = before
      if (isPassing(ap.kind)) {
        // On an open MR with a list to compare with, the next ordinary read catches up.
        if (!before || cur.state !== 'opened') {
          owes.approvals = true
          unread.push('approvals')
        }
      }
    } else {
      cur.approvedBy = ap.data.approved_by.map(a => a.user.username)
      if (before) {
        for (const user of cur.approvedBy.filter(u => !before.includes(u))) {
          const failed = await sendBy('approved', user, 'approved')
          if (failed) return fail(failed)
        }
      } else if (owes.approvals) {
        // Nothing to compare with: say who has approved, without claiming it is new.
        const names: string[] = []
        for (const user of cur.approvedBy) {
          const skip = await isIgnored('approved', user)
          if (!skip.ok) return fail(skip)
          if (!skip.data) names.push(user)
        }
        if (names.length && !handled.has('approved')) quiet.push(`approvals could not be read for a while; approved so far by ${names.join(', ')}`)
      }
      delete owes.approvals
    }
  } else cur.approvedBy = prev?.approvedBy

  const hasReopened = !!prev && prev.state === 'closed' && cur.state === 'opened'
  if (cur.state !== 'opened' || choose('reopened') === 'off') {
    delete owes.reopen
    delete owes.isReopenTold
  }
  if (prev && prev.state !== cur.state && (cur.state === 'merged' || cur.state === 'closed')) {
    const failed = cur.state === 'merged'
      ? await sendBy('merged', (mr.data.merge_user ?? mr.data.merged_by)?.username, 'merged')
      : await sendBy('closed', mr.data.closed_by?.username, 'closed without merging')
    if (failed) return fail(failed)
  } else if (cur.state === 'opened' && (hasReopened || owes.reopen !== undefined) && choose('reopened') !== 'off') {
    // The MR itself does not say who reopened it; its state history does.
    type StateEvent = { state: string; user: { username: string } | null }
    let last: StateEvent | undefined
    let isLater = false
    // Oldest first: the latest reopening is on the last page that has one.
    for (let page = 1; page <= NOTE_PAGES; page++) {
      const history = await get<StateEvent[]>(`${base}/resource_state_events?per_page=100&page=${page}`)
      if (!history.ok) {
        isLater = isPassing(history.kind) && (owes.reopen ?? 0) < RETRIES
        last = undefined
        break
      }
      last = [...history.data].reverse().find(h => h.state === 'reopened') ?? last
      if (history.data.length < 100) break
    }
    if (isLater) {
      owes.reopen = (owes.reopen ?? 0) + 1
      if (handled.has('reopened')) owes.isReopenTold = true
    } else {
      if (owes.isReopenTold) handled.add('reopened')
      delete owes.reopen
      delete owes.isReopenTold
      const failed = await sendBy('reopened', last?.user?.username, 'reopened')
      if (failed) return fail(failed)
    }
  }

  // A "once" choice that has had its wake leaves "always" quiet from here on.
  for (const e of waking) spent.add(e)
  // A change a wait reported in this check has had its wake too.
  const once = { ...link.once }
  const delivery = { ...link.delivery }
  for (const e of spent) {
    delete once[e]
    if (choiceFor(link, e, cfg.defaults) === 'always') delivery[e] = 'quiet'
  }

  const next: Link = {
    ...link, ...(spent.size ? { delivery, once } : {}),
    snap: cur, fired, noteSince, arms: keep, reportedDeploys, isNotesUnread, owes, held: undefined,
    isForbidden: false, failing: undefined,
  }
  const isFinished = cur.state !== 'opened' && keep.length === 0 && pendingOnce(next, cur.state).length === 0
    && unlinksWhenDone(link, cfg.defaults)
  // A finished MR stays for a few more checks while something on it is still unread.
  const held = (link.held ?? 0) + 1
  const isHeld = isFinished && unread.length > 0 && held <= RETRIES
  if (isHeld) next.held = held
  const isDone = isFinished && !isHeld
  if (isDone && unread.length > 0) {
    const line = `could not read its ${unread.join(' and ')}, so some may be missing`
    ;(wake.length ? wake : quiet).push(line)
  }
  if (isDone) quiet.push(`unlinked (${cur.state}); nothing later on it will be reported`)
  return { ok: true, link: isDone ? null : next, wake: [...new Set(wake)], quiet, broken, reportedDeploys }
}

type Approvals = { approved: boolean; approved_by: { user: { username: string } }[] }

type ArmHit =
  | { ok: true; line: string | null; why?: string; reported?: string }
  | { ok: false; kind: FailKind; detail: string }

/** `line` null: still waiting; '' : disarmed quietly (`why`); else the wake line. */
async function evalArm(
  $: EngineInterface, link: Link, arm: Arm, cur: Snapshot, cfg: CheckCfg,
  readApprovals: () => Promise<ApiResult<Approvals>>,
): Promise<ArmHit> {
  const get = <T>(path: string) => api<T>($, link.host, path, cfg.glabPath)
  const p = enc(link.project)
  switch (arm.kind) {
    case 'pipeline': {
      const isCurrent = cur.pipelineId !== null && cur.pipelineSha === cur.sha
      if (!isCurrent || !PIPELINE_FINAL.has(cur.pipelineStatus ?? '')) return { ok: true, line: null }
      if (arm.status && arm.status !== 'any' && cur.pipelineStatus !== arm.status) {
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
      const ap = await readApprovals()
      if (!ap.ok) return ap
      // With no approvals required (gitlab.com free), GitLab reports approved with nobody in
      // approved_by; the wait is for a person's approval, so it needs a name either way.
      const by = ap.data.approved_by.map(a => a.user.username)
      if (!ap.data.approved || by.length === 0) return { ok: true, line: null }
      return { ok: true, line: `approved by ${by.join(', ')}` }
    }
    case 'merged':
      return { ok: true, line: cur.state === 'merged' ? 'merged' : null }
    case 'closed':
      return { ok: true, line: cur.state === 'closed' ? 'closed without merging' : null }
    case 'reopened':
      return { ok: true, line: link.snap?.state === 'closed' && cur.state === 'opened' ? 'reopened' : null }
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
