// The checking loop, wake delivery and the actions behind the tools and commands.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

import type { Arm, HostHealth, Link, Problem } from '../types'
import { checkLink, describeArm, type CheckCfg, type CheckOutcome } from './check'
import { parseTargets } from './deploy'
import { linkDetail, outageLine, wakeText } from './format'
import { needsPerson, selfName, setupHelp, type FailKind } from './glab'
import { linkKey, parseMr, shortName } from './mr-ref'
import { diagLine, noteDiag, save } from './persist'

// The session's values (declared again, identically, in each file that reads them).
const links = atom({ plugin: 'gitlab-link', key: 'links' } as const, {}, { shape: 'links-1' })
const health = atom({ plugin: 'gitlab-link', key: 'health' } as const, {}, { shape: 'health-1' })
const pendingWake = atom({ plugin: 'gitlab-link', key: 'pendingWake' } as const, [], { shape: 'lines-1' })
const quiet = atom({ plugin: 'gitlab-link', key: 'quiet' } as const, [], { shape: 'lines-1' })

export const PROBLEMS: Problem[] = ['pipeline', 'conflict', 'closed']

export type Runtime = {
  intervalMs: number
  mergedMs: number
  maxBackoffMs: number
  outageMs: number
  glabPath: string
  defaultProblems: Problem[]
  targetsError: string | null
  cfg: CheckCfg
  /** Module values: lost on reload, which happens between turns. */
  isBusy: boolean
  mainTurn: string | null
  isSubmitting: boolean
  isTicking: boolean
  armCount: number
  /** The session's transcript path: the key its links are saved under. */
  sessionKey: string
}

export function makeRuntime(options: PluginOptions): Runtime {
  const num = (k: string, d: number) => (typeof options[k] === 'number' ? (options[k] as number) : d)
  const glabPath = String(options.glabPath ?? 'glab') || 'glab'
  const targets = parseTargets(String(options.deployTargets ?? '{}'))
  return {
    intervalMs: num('intervalSeconds', 60) * 1000,
    mergedMs: num('mergedIntervalSeconds', 300) * 1000,
    maxBackoffMs: num('maxBackoffSeconds', 600) * 1000,
    outageMs: num('outageWakeMinutes', 60) * 60_000,
    glabPath,
    defaultProblems: String(options.defaultProblems ?? 'pipeline,conflict,closed')
      .split(',').map(s => s.trim()).filter((s): s is Problem => PROBLEMS.includes(s as Problem)),
    targetsError: 'error' in targets ? String(targets.error) : null,
    cfg: { glabPath, targets: 'error' in targets ? {} : targets },
    isBusy: false,
    mainTurn: null,
    isSubmitting: false,
    isTicking: false,
    armCount: 0,
    sessionKey: '',
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

const nextDue = (rt: Runtime, link: Link, now: number) =>
  now + (link.snap && link.snap.state !== 'opened' ? rt.mergedMs : rt.intervalMs)

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
    return {
      ...all,
      [before.key]: { ...base, problems: nowLink.problems, arms: [...base.arms, ...added], nextCheckAt: nextDue(rt, base, now) },
    }
  })
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
    const hs = await read($, health)
    const due = Object.values(await read($, links)).filter(
      l => l.nextCheckAt <= now && (hs[l.host]?.nextTryAt ?? 0) <= now,
    )
    const downHosts = new Set<string>()
    for (const link of due) {
      if (downHosts.has(link.host)) continue
      const out = await checkLink($, link, rt.cfg)
      if (out.ok) {
        await hostOk($, link.host, now)
        await apply($, rt, link, out, now)
        await queue($, link, out.wake, out.quiet)
      } else if (out.gone) {
        await update($, links, all => without(all, link.key))
        const msg = 'MR not found (deleted, moved, or no access); unlinked'
        if (link.arms.length) await queue($, link, [`${msg}; disarmed: ${link.arms.map(describeArm).join(', ')}`], [])
        else await queue($, link, [], [msg])
      } else {
        downHosts.add(link.host)
        await hostFailed($, rt, link.host, out.kind, out.detail, now)
      }
    }
    await save($, rt.sessionKey)
    await deliver($, rt)
  }
}

/** One wake for everything pending, only while the session is idle. */
export async function deliver($: EngineInterface, rt: Runtime) {
  if (rt.isBusy || rt.isSubmitting) return
  const lines = await read($, pendingWake)
  if (lines.length === 0) return
  rt.isSubmitting = true
  try {
    await update($, pendingWake, () => [])
    await save($, rt.sessionKey)
    await $.prompt.submit({ text: wakeText(lines, Object.values(await read($, links))) })
  } finally {
    rt.isSubmitting = false
  }
}

export type ArmSpec = Omit<Arm, 'id' | 'armedAt'>

/** Link (or re-read) an MR, optionally arm a condition, and check it now. What it finds goes in the answer, not a wake. */
async function linkAndCheckInner(
  $: EngineInterface,
  rt: Runtime,
  mrText: string,
  problems: Problem[] | undefined,
  arm?: ArmSpec,
): Promise<{ error: string } | { text: string }> {
  const ref = await parseMr($, mrText, rt.glabPath)
  if ('error' in ref) return ref
  const now = await $.clock.now()
  const key = linkKey(ref)
  const existing = (await read($, links))[key]
  let newArm: Arm | undefined
  if (arm) {
    newArm = { ...arm, id: `a${++rt.armCount}${now.toString(36).slice(-4)}`, armedAt: iso(now) }
    if (newArm.kind === 'comment' && !newArm.since) newArm.since = newArm.armedAt
  }
  const link: Link = existing ?? {
    key, ...ref, problems: problems ?? rt.defaultProblems, arms: [], snap: null,
    fired: {}, noteSince: null, nextCheckAt: now + rt.intervalMs, linkedAt: iso(now),
  }
  const withArm: Link = {
    ...link,
    problems: problems ?? link.problems,
    arms: newArm ? [...link.arms, newArm] : link.arms,
  }
  await update($, links, all => ({ ...all, [key]: withArm }))
  const out = await checkLink($, withArm, rt.cfg)
  if (!out.ok) {
    // Put the link back as it was: nothing new stays linked or armed on a failure the person must fix.
    const undo = () => update($, links, all => (existing ? { ...all, [key]: existing } : without(all, key)))
    if (needsPerson(out.kind)) {
      await undo()
      return { error: `Could not reach ${ref.host} for ${shortName(ref)}; nothing was ${arm ? 'armed' : 'linked'}. ${setupHelp(out.kind, ref.host)}` }
    }
    if (out.gone) {
      await undo()
      // A private project answers 404, not 401, to a request with no login: check the login first.
      const me = await selfName($, ref.host, rt.glabPath)
      if (!me.ok && needsPerson(me.kind)) {
        return { error: `Could not read ${shortName(ref)}; nothing was ${arm ? 'armed' : 'linked'}. ${setupHelp(me.kind, ref.host)}` }
      }
      return { error: `${shortName(ref)} was not found on ${ref.host}, or glab's user (${me.ok ? me.data : 'unknown'}) has no access to it.` }
    }
    return { text: `${shortName(ref)} linked, but GitLab could not be read (${out.kind}: ${out.detail}). It will be retried.\n${linkDetail(withArm)}` }
  }
  await hostOk($, ref.host, now)
  await apply($, rt, withArm, out, now)
  const after = (await read($, links))[key]
  const found = [...out.wake.map(w => `met now: ${w}`), ...out.quiet]
  return {
    text: [
      after ? linkDetail(after) : `${shortName(ref)}: no longer linked`,
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
    if (arms.length === 0 && cur.snap && cur.snap.state !== 'opened') return without(all, key)
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
  const lines = all.map(linkDetail)
  for (const [host, h] of Object.entries(hs)) lines.push(outageLine(host, h, now))
  if (rt.targetsError) lines.push(`Settings problem: ${rt.targetsError}`)
  const diag = await diagLine($, rt.sessionKey)
  return [lines.length ? lines.join('\n') : 'No MRs are linked to this session.', diag].join('\n')
}

/** The actions behind the tools: each saves the session's values when done. */
export async function linkAndCheck(
  $: EngineInterface, rt: Runtime, mrText: string, problems: Problem[] | undefined, arm?: ArmSpec,
): Promise<{ error: string } | { text: string }> {
  const r = await linkAndCheckInner($, rt, mrText, problems, arm)
  await save($, rt.sessionKey)
  return r
}

export async function unlink($: EngineInterface, rt: Runtime, mrText: string): Promise<string> {
  const r = await unlinkInner($, rt, mrText)
  await save($, rt.sessionKey)
  return r
}

export async function unarm($: EngineInterface, rt: Runtime, mrText: string, armId?: string, condition?: string): Promise<string> {
  const r = await unarmInner($, rt, mrText, armId, condition)
  await save($, rt.sessionKey)
  return r
}
