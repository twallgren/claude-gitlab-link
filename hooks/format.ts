// The text the session and the person read.
import type { HostHealth, Link } from '../types'
import { clip, describeArm } from './check'
import { setupHint, type FailKind } from './glab'
import { shortName } from './mr-ref'

export function linkStatus(link: Link): string {
  const s = link.snap
  const parts: string[] = []
  if (!s) parts.push('not read yet')
  else {
    parts.push(s.state)
    if (s.pipelineId) {
      const stale = s.pipelineSha !== s.sha ? ' (older commit)' : ''
      parts.push(`pipeline ${s.pipelineStatus}${stale}`)
    }
    if (s.hasConflicts) parts.push('conflicts')
  }
  if (link.arms.length > 0) parts.push(`waiting: ${link.arms.map(describeArm).join(', ')}`)
  return `${shortName(link)} · ${parts.join(' · ')}`
}

export function linkDetail(link: Link): string {
  const lines = [linkStatus(link)]
  if (link.snap) lines.push(`  ${link.snap.title} ${link.snap.webUrl}`)
  lines.push(`  default wakes: ${link.problems.length ? link.problems.join(', ') : 'none'}`)
  for (const a of link.arms) lines.push(`  armed ${a.id}: ${describeArm(a)} (since ${a.armedAt})`)
  return lines.join('\n')
}

export function outageLine(host: string, h: HostHealth, now: number): string {
  const mins = Math.round((now - h.since) / 60000)
  const hint = setupHint(h.kind as FailKind, host)
  const state = hint ? 'checks paused' : 'unreachable'
  return `GitLab ${host} ${state} for ${mins} min (${h.kind}: ${h.detail})${hint ? ` — ${hint}` : ''}`
}

export function wakeText(lines: string[], links: Link[], also: string[] = []): string {
  const still = links
    .filter(l => l.arms.length > 0)
    .map(l => `${shortName(l)}: ${l.arms.map(describeArm).join(', ')}`)
  const first = lines[0]!.replace(/\s+https?:\/\/\S+$/, '')
  const more = lines.length > 1 ? ` (and ${lines.length - 1} more)` : ''
  const shown = also.slice(-50)
  return [
    `Automatic GitLab update, not typed by you: ${clip(first, 120)}${more}.`,
    '',
    '<gitlab-mr-event>',
    'From the gitlab-link mod: a condition you armed fired, or a linked MR hit a blocking problem.',
    ...lines.map(l => `- ${l}`),
    still.length ? `Still armed: ${still.join('; ')}` : 'Nothing else is armed.',
    ...(shown.length ? ['Other changes since your last turn that nothing was armed for:', ...shown.map(l => `- ${l}`)] : []),
    ...(also.length > shown.length ? [`(${also.length - shown.length} earlier lines left out)`] : []),
    '</gitlab-mr-event>',
  ].join('\n')
}

export function quietText(lines: string[]): string {
  const shown = lines.slice(-50)
  const cut = lines.length - shown.length
  return [
    '<gitlab-mr-updates>',
    'Changes on linked MRs since your last turn that nothing was armed for (from the gitlab-link mod):',
    ...shown.map(l => `- ${l}`),
    ...(cut > 0 ? [`(${cut} earlier lines left out)`] : []),
    '</gitlab-mr-updates>',
  ].join('\n')
}
