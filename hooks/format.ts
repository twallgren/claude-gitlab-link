// The text the session and the person read.
import type { HostHealth, Link } from '../types'
import { describeArm } from './check'
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
  return `GitLab ${host} unreachable for ${mins} min (${h.kind}: ${h.detail})`
}

export function wakeText(lines: string[], links: Link[]): string {
  const still = links
    .filter(l => l.arms.length > 0)
    .map(l => `${shortName(l)}: ${l.arms.map(describeArm).join(', ')}`)
  return [
    '<gitlab-mr-event>',
    'From the gitlab-link mod: a condition you armed fired, or a linked MR hit a blocking problem.',
    ...lines.map(l => `- ${l}`),
    still.length ? `Still armed: ${still.join('; ')}` : 'Nothing else is armed.',
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
