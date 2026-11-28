// The checking loop, wake delivery and the actions behind the tools and commands.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

import type { Arm, DeliveryChoice, EventName, HostHealth, IgnoreKey, IgnoredUsers, Link } from '../types'
import { checkLink, describeArm, type CheckCfg, type CheckOutcome } from './check'
import { parseTargets } from './deploy'
import { choiceFor, pendingOnce, readDefaults, unlinksWhenDone, type Defaults } from './delivery'
import { linkDetail, outageLine, wakeText } from './format'
import { api, needsPerson, selfName, setupHelp, type FailKind } from './glab'
import { linkKey, parseMr, shortName } from './mr-ref'
import { diagLine, noteDiag, save } from './persist'

// The session's values (declared again, identically, in each file that reads them).
const links = atom({ plugin: 'gitlab-link', key: 'links' } as const, {}, { shape: 'links-1' })
const health = atom({ plugin: 'gitlab-link', key: 'health' } as const, {}, { shape: 'health-1' })
const pendingWake = atom({ plugin: 'gitlab-link', key: 'pendingWake' } as const, [], { shape: 'lines-1' })
const quiet = atom({ plugin: 'gitlab-link', key: 'quiet' } as const, [], { shape: 'lines-1' })
const reported = atom({ plugin: 'gitlab-link', key: 'reportedDeploys' } as const, {}, { shape: 'reported-1' })

export type Runtime = {
  intervalMs: number
  mergedMs: number
  maxBackoffMs: number
  outageMs: number
  glabPath: string
  defaults: Defaults
  settingsErrors: string[]
  cfg: CheckCfg
  /** Module values: lost on reload, which happens between turns. */
  isBusy: boolean
  mainTurn: string | null
  isSubmitting: boolean
  isTicking: boolean
  armCount: number
  /** The end of the queue of work on links: see `inTurn`. */
  queueTail: Promise<unknown>
  /** A wake the engine would not take is retried no sooner than this. */
  wakeRetryAt: number
  wakeDrops: number
  /** The session's transcript path: the key its links are saved under. */
  sessionKey: string
}

export function makeRuntime(options: PluginOptions): Runtime {
  const num = (k: string, d: number) => (typeof options[k] === 'number' ? (options[k] as number) : d)
  const glabPath = String(options.glabPath ?? 'glab') || 'glab'
  const targets = parseTargets(String(options.deployTargets ?? '{}'))
  const { errors, ...defaults } = readDefaults(options as Record<string, unknown>)
  return {
    intervalMs: num('intervalSeconds', 60) * 1000,
    mergedMs: num('mergedIntervalSeconds', 300) * 1000,
    maxBackoffMs: num('maxBackoffSeconds', 600) * 1000,
    outageMs: num('outageWakeMinutes', 60) * 60_000,
    glabPath,
    defaults,
    settingsErrors: [...errors, ...('error' in targets ? [String(targets.error)] : [])],
    cfg: { glabPath, targets: 'error' in targets ? {} : targets, defaults },
    isBusy: false,
    mainTurn: null,
    isSubmitting: false,
    isTicking: false,
    armCount: 0,
    queueTail: Promise.resolve(),
    wakeRetryAt: 0,
    wakeDrops: 0,
    sessionKey: '',
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

/**
 * Runs work on the links one piece at a time. A timer check overlapping a tool
 * call could otherwise report a wait twice, or bring back one just disarmed.
 */
function inTurn<T>(rt: Runtime, work: () => Promise<T>): Promise<T> {
  const run = rt.queueTail.then(work, work)
  rt.queueTail = run.then(() => undefined, () => undefined)
  return run
}

// A merged or closed MR is checked less often, unless a deploy wait is armed: that one is time-sensitive.
const nextDue = (rt: Runtime, link: Link, now: number) =>
  now + (link.snap && link.snap.state !== 'opened' && !link.arms.some(a => a.kind === 'deployed') ? rt.mergedMs : rt.intervalMs)

const without = <T>(all: Record<string, T>, key: string) => {
  const copy = { ...all }
  delete copy[key]
  return copy
}

/** Apply a check to the link as it stands now: arms added meanwhile are kept. */
async function apply($: EngineInterface, rt: Runtime, before: Link, out: CheckOutcome & { ok: true }, now: number) {
  await update($, links, all => {
    const nowLink = all[before.key]
    if (!nowLink) return all
    const added = nowLink.arms.filter(a => !before.arms.some(b => b.id === a.id))
    if (out.link === null && added.length === 0) return without(all, before.key)
    const base = out.link ?? nowLink
    const kept = (out.link?.arms ?? []).filter(a => nowLink.arms.some(b => b.id === a.id))
    return {
      ...all,
      [before.key]: { ...base, arms: [...kept, ...added], nextCheckAt: nextDue(rt, base, now) },
    }
  })
}

async function remember($: EngineInterface, key: string, deploys: string[]) {
  if (deploys.length) await update($, reported, all => ({ ...all, [key]: deploys }))
}

async function queue($: EngineInterface, link: Link, wake: string[], q: string[]) {
  const name = shortName(link)
  if (q.length) await update($, quiet, l => [...l, ...q.map(x => `${name}: ${x}`)].slice(-200))
  if (wake.length) await update($, pendingWake, l => [...l, ...wake.map(x => `${name}: ${x}`)])
}

async function hostFailed($: EngineInterface, rt: Runtime, host: string, kind: string, detail: string, now: number) {
  const hasArmed = Object.values(await read($, links)).some(l => l.host === host && l.arms.length > 0)
  const old = (await read($, health))[host]
  const failures = (old?.failures ?? 0) + 1
  const since = old?.since ?? now
  const backoff = now + Math.min(60_000 * 2 ** (failures - 1), rt.maxBackoffMs)
  // Retry at the outage-wake mark too, so that wake is not a whole backoff late.
  const mark = since + rt.outageMs
  const h: HostHealth = {
    since, kind, detail, failures,
    nextTryAt: mark > now && mark < backoff ? mark : backoff,
    hasWoken: old?.hasWoken ?? false, hasNotified: old?.hasNotified ?? false,
  }
  const isPersonal = needsPerson(kind as FailKind)
  if (isPersonal && !h.hasNotified) {
    h.hasNotified = true
    const what = kind === 'auth' ? `glab's login to ${host} was rejected` : 'glab could not be started'
    void $.ui.notify(`${what}. Checks resume once a call succeeds.`, { title: 'gitlab-link' })
    // The desktop app shows no notification from a mod: tell the model on its next turn too.
    const help = setupHelp(kind as FailKind, host)
    if (help) await update($, quiet, l => [...l, `GitLab ${host}: checks are paused. ${help}`])
  }
  if (!isPersonal && hasArmed && !h.hasWoken && now - h.since >= rt.outageMs) {
    h.hasWoken = true
    await update($, pendingWake, l => [...l, outageLine(host, h, now)])
  }
  await update($, health, m => ({ ...m, [host]: h }))
}

async function hostOk($: EngineInterface, host: string, now: number) {
  const h = (await read($, health))[host]
  if (!h) return
  await update($, quiet, l => [...l, `GitLab ${host} reachable again after ${Math.round((now - h.since) / 60000)} min`])
  await update($, health, all => without(all, host))
}

async function checkDue($: EngineInterface, rt: Runtime, key: string, now: number, downHosts: Set<string>) {
  // Read again: a tool call ahead in the queue may have changed or checked it.
  const link = (await read($, links))[key]
  if (!link || link.nextCheckAt > now) return
  const out = await checkLink($, link, rt.cfg)
  // Unlinked while the check ran: nothing it found is wanted.
  if (!(await read($, links))[key]) return
  if (out.ok) {
    await hostOk($, link.host, now)
    await apply($, rt, link, out, now)
    await remember($, key, out.reportedDeploys)
    await queue($, link, [...out.wake, ...out.broken], out.quiet)
  } else {
    await checkFailed($, rt, link, out, now, downHosts)
  }
}

/**
 * Whether the trouble is the host's or this MR's. A fresh request for glab's own
 * user (not the cached name) tells: a lost login shows up here, where a private
 * MR only answers 404, and a host that answers it is not down.
 */
async function checkFailed(
  $: EngineInterface, rt: Runtime, link: Link, out: CheckOutcome & { ok: false }, now: number, downHosts: Set<string>,
) {
  // A timeout can be one slow request, so network failures are probed too.
  const probe = needsPerson(out.kind) ? null : await api<unknown>($, link.host, 'user', rt.glabPath)
  // Unlinked while we asked: say nothing about it.
  if (probe && !(await read($, links))[link.key]) return
  if (!probe || !probe.ok) {
    // A 404 from the probe too means this login cannot be trusted: never unlink on it.
    const cause = probe && !probe.ok && (needsPerson(probe.kind) || probe.kind === 'network') ? probe : out
    downHosts.add(link.host)
    await patch($, link.key, { failing: undefined })
    await hostFailed($, rt, link.host, cause.kind === 'notfound' ? 'other' : cause.kind, cause.detail, now)
    return
  }
  await hostOk($, link.host, now)
  if (out.gone) {
    await update($, links, all => without(all, link.key))
    const msg = 'MR not found (deleted, moved, or no access); unlinked'
    if (link.arms.length) await queue($, link, [`${msg}; disarmed: ${link.arms.map(describeArm).join(', ')}`], [])
    else await queue($, link, [], [msg])
    return
  }
  if (out.kind === 'forbidden') {
    // It may be passing: keep the link, say so once, try again later.
    if (!link.isForbidden) {
      const msg = "glab's user is not allowed to read this MR (403); still trying"
      await queue($, link, link.arms.length ? [msg] : [], link.arms.length ? [] : [msg])
    }
    await patch($, link.key, { isForbidden: true, failing: undefined, nextCheckAt: now + rt.maxBackoffMs })
    return
  }
  // Only this MR is failing: back it off alone, and wake once if that lasts.
  const old = link.failing
  const failing = { since: old?.since ?? now, count: (old?.count ?? 0) + 1, isTold: old?.isTold ?? false }
  if (!failing.isTold && link.arms.length > 0 && now - failing.since >= rt.outageMs) {
    failing.isTold = true
    await queue($, link, [`checks of this MR have failed for ${Math.round((now - failing.since) / 60000)} min (${out.kind}: ${out.detail}); still trying`], [])
  }
  await patch($, link.key, { failing, nextCheckAt: now + Math.min(60_000 * 2 ** (failing.count - 1), rt.maxBackoffMs) })
}

async function patch($: EngineInterface, key: string, values: Partial<Link>) {
  await update($, links, all => {
    const l = all[key]
    return l ? { ...all, [key]: { ...l, ...values } } : all
  })
}

/** Every 15 s: check the links that are due, on hosts not backing off. */
export async function tick($: EngineInterface, rt: Runtime) {
  if (rt.isTicking) return
  rt.isTicking = true
  try {
    await tickOnce($, rt)
  } catch (err) {
    const at = await $.clock.now()
    await noteDiag($, rt.sessionKey, d => ({ ...d, lastError: String(err).slice(0, 300), lastErrorAt: at }))
  } finally {
    rt.isTicking = false
  }
}

async function tickOnce($: EngineInterface, rt: Runtime) {
  {
    const now = await $.clock.now()
    await noteDiag($, rt.sessionKey, d => ({ ...d, ticks: d.ticks + 1, lastTickAt: now }))
    const hosts = new Set(Object.values(await read($, links)).map(l => l.host))
    for (const host of Object.keys(await read($, health))) {
      if (!hosts.has(host)) await update($, health, all => without(all, host))
    }
    const hs = await read($, health)
    const due = Object.values(await read($, links)).filter(
      l => l.nextCheckAt <= now && (hs[l.host]?.nextTryAt ?? 0) <= now,
    )
    const downHosts = new Set<string>()
    for (const queued of due) {
      if (downHosts.has(queued.host)) continue
      try {
        await inTurn(rt, () => checkDue($, rt, queued.key, now, downHosts))
      } catch (err) {
        // One link's surprise must not stop the others being checked.
        await noteDiag($, rt.sessionKey, d => ({ ...d, lastError: `${queued.key}: ${String(err)}`.slice(0, 300), lastErrorAt: now }))
      }
    }
    await save($, rt.sessionKey)
    await deliver($, rt)
  }
}

/** One wake for everything pending, only while the session is idle. */
export async function deliver($: EngineInterface, rt: Runtime) {
  if (rt.isBusy || rt.isSubmitting) return
  if ((await read($, pendingWake)).length === 0 || (await $.clock.now()) < rt.wakeRetryAt) return
  if (rt.isSubmitting) return
  rt.isSubmitting = true
  try {
    // Read and clear in one step, so a line queued meanwhile is not erased.
    let lines: string[] = []
    await update($, pendingWake, l => {
      lines = l
      return []
    })
    // A plugin's own submit skips its prompt.submit hook, so quiet lines ride in the wake text.
    let also: string[] = []
    await update($, quiet, l => {
      also = l
      return []
    })
    await save($, rt.sessionKey)
    let refused: string | null = null
    try {
      const sent = await $.prompt.submit({ text: wakeText(lines, Object.values(await read($, links)), also) })
      if (sent?.drop !== undefined) refused = String(sent.drop)
    } catch (err) {
      refused = String(err)
    }
    if (refused === null) {
      rt.wakeDrops = 0
      return
    }
    // The prompt did not get in: put everything back and try again, backing off.
    const at = await $.clock.now()
    rt.wakeRetryAt = at + Math.min(15_000 * 2 ** rt.wakeDrops++, rt.maxBackoffMs)
    await update($, pendingWake, l => [...lines, ...l])
    await update($, quiet, l => [...also, ...l])
    await save($, rt.sessionKey)
    await noteDiag($, rt.sessionKey, d => ({ ...d, lastError: `wake not submitted: ${refused}`.slice(0, 300), lastErrorAt: at }))
  } finally {
    rt.isSubmitting = false
  }
}

export type ArmSpec = Omit<Arm, 'id' | 'armedAt'>

/** What a call changes about one link. 'default' goes back to the settings. */
export type LinkChanges = {
  delivery?: Partial<Record<EventName, DeliveryChoice | 'once' | 'default'>>
  ignored?: Partial<Record<IgnoreKey, string[] | 'default'>>
  unlinkWhenDone?: boolean | 'default'
}

function withChanges(link: Link, changes: LinkChanges, d: Defaults, now: number): Link {
  let { delivery, once, ignored, unlinkWhenDone, problems, noteSince, snap } = link
  const before = (e: EventName) => (link.once?.[e] ? 'once' : choiceFor(link, e, d))
  for (const [name, choice] of Object.entries(changes.delivery ?? {})) {
    const e = name as EventName
    // A choice for one of the old problems overrides what a link saved before 0.4.0 said.
    const old = e === 'pipeline_failed' ? 'pipeline' : e
    if (problems && !problems.includes(old) && (old === 'pipeline' || old === 'conflict' || old === 'closed')) {
      problems = [...problems, old]
      if (!delivery?.[e]) delivery = { ...delivery, [e]: 'quiet' }
    }
    const pending = { ...once }
    delete pending[e]
    if (choice === 'once') once = { ...pending, [e]: true }
    else {
      once = pending
      const copy = { ...delivery }
      if (choice === 'default') delete copy[e]
      else copy[e] = choice
      delivery = copy
    }
  }
  const next: Link = { ...link, delivery, once, problems }
  // What happened while a kind was off is not news once it is heard again.
  const isBack = (e: EventName) => before(e) === 'off' && (next.once?.[e] ? 'once' : choiceFor(next, e, d)) !== 'off'
  if (link.snap && isBack('comment')) noteSince = iso(now)
  if (snap && isBack('approved')) snap = { ...snap, approvedBy: undefined }
  if (changes.ignored) {
    const copy: IgnoredUsers = { ...ignored }
    for (const [key, users] of Object.entries(changes.ignored)) {
      if (users === 'default') delete copy[key as IgnoreKey]
      else copy[key as IgnoreKey] = users
    }
    ignored = Object.keys(copy).length ? copy : undefined
  }
  if (changes.unlinkWhenDone !== undefined) {
    unlinkWhenDone = changes.unlinkWhenDone === 'default' ? undefined : changes.unlinkWhenDone
  }
  return { ...next, ignored, unlinkWhenDone, noteSince, snap }
}

/** Link (or re-read) an MR, apply changes, optionally arm a condition, and check it now. What it finds goes in the answer, not a wake. */
async function linkAndCheckInner(
  $: EngineInterface,
  rt: Runtime,
  mrText: string,
  changes: LinkChanges,
  arm?: ArmSpec,
  isFromPerson = false,
): Promise<{ error: string } | { text: string }> {
  const ref = await parseMr($, mrText, rt.glabPath)
  if ('error' in ref) return ref
  const now = await $.clock.now()
  const key = linkKey(ref)
  const existing = (await read($, links))[key]
  const makeArm = (spec: ArmSpec): Arm => {
    const made: Arm = { ...spec, id: `a${++rt.armCount}${now.toString(36).slice(-4)}`, armedAt: iso(now) }
    if (made.kind === 'comment' && !made.since) made.since = made.armedAt
    return made
  }
  const link: Link = existing ?? {
    key, ...ref, arms: [], snap: null,
    fired: {}, noteSince: null, nextCheckAt: now + rt.intervalMs, linkedAt: iso(now),
    reportedDeploys: (await read($, reported))[key],
  }
  const changed = withChanges(link, changes, rt.defaults, now)
  const withArm: Link = { ...changed, arms: arm ? [...changed.arms, makeArm(arm)] : changed.arms }
  await update($, links, all => ({ ...all, [key]: withArm }))
  const out = await checkLink($, withArm, rt.cfg)
  if (!out.ok) {
    // Put the link back as it was: nothing new stays linked or armed on a failure the person must fix.
    const undo = () => update($, links, all => (!all[key] ? all : existing ? { ...all, [key]: existing } : without(all, key)))
    if (out.kind === 'forbidden') {
      await undo()
      return { error: `glab's user on ${ref.host} is not allowed to read what ${shortName(ref)} needs (403); nothing was ${arm ? 'armed' : existing ? 'changed' : 'linked'}.` }
    }
    if (needsPerson(out.kind)) {
      await undo()
      return { error: `Could not reach ${ref.host} for ${shortName(ref)}; nothing was ${arm ? 'armed' : existing ? 'changed' : 'linked'}. ${setupHelp(out.kind, ref.host)}` }
    }
    if (out.gone) {
      await undo()
      // A private project answers 404, not 401, to a request with no login: check the login first.
      const me = await selfName($, ref.host, rt.glabPath)
      if (!me.ok && needsPerson(me.kind)) {
        return { error: `Could not read ${shortName(ref)}; nothing was ${arm ? 'armed' : existing ? 'changed' : 'linked'}. ${setupHelp(me.kind, ref.host)}` }
      }
      return { error: `${shortName(ref)} was not found on ${ref.host}, or glab's user (${me.ok ? me.data : 'unknown'}) has no access to it.` }
    }
    if (!(await read($, links))[key]) return { text: `${shortName(ref)}: unlinked while it was being checked.` }
    return { text: `${shortName(ref)} linked, but GitLab could not be read (${out.kind}: ${out.detail}). It will be retried.\n${linkDetail(withArm, rt.defaults)}` }
  }
  await hostOk($, ref.host, now)
  // Unlinked while the check ran: nothing it found is wanted.
  if (!(await read($, links))[key]) return { text: `${shortName(ref)}: unlinked while it was being checked.` }
  await apply($, rt, withArm, out, now)
  await remember($, key, out.reportedDeploys)
  // A command's answer goes to the person: what it used up still has to reach the model.
  if (isFromPerson) await queue($, withArm, [...out.wake, ...out.broken], out.quiet)
  const after = (await read($, links))[key]
  const found = [...out.wake.map(w => `met now: ${w}`), ...out.broken, ...out.quiet]
  return {
    text: [
      after ? linkDetail(after, rt.defaults) : `${shortName(ref)}: no longer linked`,
      ...(found.length ? ['', ...found] : []),
    ].join('\n'),
  }
}

async function unlinkInner($: EngineInterface, rt: Runtime, mrText: string): Promise<string> {
  const ref = await parseMr($, mrText, rt.glabPath)
  if ('error' in ref) return ref.error
  const key = linkKey(ref)
  const had = (await read($, links))[key]
  await update($, links, all => without(all, key))
  return had ? `${shortName(ref)} unlinked.` : `${shortName(ref)} was not linked.`
}

async function unarmInner($: EngineInterface, rt: Runtime, mrText: string, armId?: string, condition?: string): Promise<string> {
  const ref = await parseMr($, mrText, rt.glabPath)
  if ('error' in ref) return ref.error
  const key = linkKey(ref)
  const l = (await read($, links))[key]
  if (!l) return `${shortName(ref)} is not linked.`
  const removed = l.arms.filter(a => (armId ? a.id === armId : condition ? a.kind === condition : true))
  await update($, links, all => {
    const cur = all[key]
    if (!cur) return all
    const arms = cur.arms.filter(a => !removed.some(r => r.id === a.id))
    const isDone = !!cur.snap && cur.snap.state !== 'opened' && arms.length === 0 && pendingOnce(cur, cur.snap.state).length === 0
    if (isDone && unlinksWhenDone(cur, rt.defaults)) return without(all, key)
    return { ...all, [key]: { ...cur, arms } }
  })
  return removed.length
    ? `Disarmed on ${shortName(ref)}: ${removed.map(describeArm).join(', ')}`
    : `Nothing matching was armed on ${shortName(ref)}.`
}

export async function listText($: EngineInterface, rt: Runtime): Promise<string> {
  const all = Object.values(await read($, links))
  const hs = await read($, health)
  const now = await $.clock.now()
  const lines = all.map(l => linkDetail(l, rt.defaults))
  for (const [host, h] of Object.entries(hs)) lines.push(outageLine(host, h, now))
  for (const problem of rt.settingsErrors) lines.push(`Settings problem: ${problem}`)
  const diag = await diagLine($, rt.sessionKey)
  return [lines.length ? lines.join('\n') : 'No MRs are linked to this session.', diag].join('\n')
}

/** The actions behind the tools: each saves the session's values when done. */
export async function linkAndCheck(
  $: EngineInterface, rt: Runtime, mrText: string, changes: LinkChanges = {}, arm?: ArmSpec, isFromPerson = false,
): Promise<{ error: string } | { text: string }> {
  return inTurn(rt, async () => {
    const r = await linkAndCheckInner($, rt, mrText, changes, arm, isFromPerson)
    await save($, rt.sessionKey)
    if ('text' in r && rt.settingsErrors.length) {
      return { text: [r.text, ...rt.settingsErrors.map(p => `Settings problem: ${p}`)].join('\n') }
    }
    return r
  })
}

export async function unlink($: EngineInterface, rt: Runtime, mrText: string): Promise<string> {
  const r = await unlinkInner($, rt, mrText)
  await save($, rt.sessionKey)
  return r
}

export async function unarm($: EngineInterface, rt: Runtime, mrText: string, armId?: string, condition?: string): Promise<string> {
  return inTurn(rt, async () => {
    const r = await unarmInner($, rt, mrText, armId, condition)
    await save($, rt.sessionKey)
    return r
  })
}
