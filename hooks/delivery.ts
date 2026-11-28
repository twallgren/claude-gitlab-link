// How each kind of change reaches the session: the defaults from the settings,
// a link's own choices over them, and whose changes are ignored.
import type { Arm, DeliveryChoice, EventName, IgnoreKey, IgnoredUsers, Link } from '../types'

export const EVENTS: EventName[] = [
  'comment', 'approved', 'merged', 'closed', 'reopened', 'conflict', 'pipeline_failed', 'pipeline_succeeded',
]
/** The changes a person makes, so the ones an ignored-user list can name. */
export const PERSON_EVENTS: IgnoreKey[] = ['all', 'comment', 'approved', 'merged', 'closed', 'reopened']
export const CHOICES: DeliveryChoice[] = ['always', 'quiet', 'off']

export const LABELS: Record<EventName, string> = {
  comment: 'comments',
  approved: 'approvals',
  merged: 'merged',
  closed: 'closed without merging',
  reopened: 'reopened',
  conflict: 'merge conflict',
  pipeline_failed: 'pipeline failed',
  pipeline_succeeded: 'pipeline succeeded',
}

export type Defaults = {
  delivery: Record<EventName, DeliveryChoice>
  ignored: IgnoredUsers
  unlinkWhenDone: boolean
}

const BUILT_IN: Record<EventName, DeliveryChoice> = {
  comment: 'always', approved: 'always', merged: 'always', closed: 'always', reopened: 'always',
  conflict: 'always', pipeline_failed: 'always', pipeline_succeeded: 'quiet',
}

/** The userConfig field that holds an event's default: pipeline_failed is deliveryPipelineFailed. */
const optionName = (e: EventName) =>
  `delivery${e.split('_').map(w => w[0]!.toUpperCase() + w.slice(1)).join('')}`

/** An ignored-users object as given in the settings or a tool call, or why it is wrong. */
export function checkIgnored(value: unknown): { ignored: IgnoredUsers } | { error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'it must be a JSON object' }
  const ignored: IgnoredUsers = {}
  for (const [key, users] of Object.entries(value)) {
    if (!PERSON_EVENTS.includes(key as IgnoreKey)) {
      return { error: `unknown key "${key}"; use ${PERSON_EVENTS.join(', ')} (pipelines and conflicts are never ignored)` }
    }
    if (!Array.isArray(users) || users.some(u => typeof u !== 'string')) return { error: `"${key}" must be a list of usernames` }
    ignored[key as IgnoreKey] = users as string[]
  }
  return { ignored }
}

export function readDefaults(options: Record<string, unknown>): Defaults & { errors: string[] } {
  const errors: string[] = []
  const delivery = { ...BUILT_IN }
  for (const e of EVENTS) {
    const v = options[optionName(e)]
    if (CHOICES.includes(v as DeliveryChoice)) delivery[e] = v as DeliveryChoice
  }
  let ignored: IgnoredUsers = { all: ['@me'] }
  const raw = String(options.ignoredUsers ?? '').trim()
  if (raw) {
    let parsed: { ignored: IgnoredUsers } | { error: string }
    try {
      parsed = checkIgnored(JSON.parse(raw))
    } catch {
      parsed = { error: 'it is not valid JSON' }
    }
    if ('error' in parsed) errors.push(`the ignoredUsers setting is not used (${parsed.error}); ignoring only your own changes`)
    else ignored = parsed.ignored
  }
  return { delivery, ignored, unlinkWhenDone: options.unlinkWhenDone !== false, errors }
}

/** The link's choice, else the default. Links saved before 0.4.0 carried `problems`. */
export function choiceFor(link: Link, e: EventName, d: Defaults): DeliveryChoice {
  const own = link.delivery?.[e]
  if (own) return own
  const old = e === 'pipeline_failed' ? 'pipeline' : e === 'conflict' || e === 'closed' ? e : null
  if (old && link.problems && !link.problems.includes(old)) return 'quiet'
  return d.delivery[e]
}

/** The events a wait reports. */
export function armEvents(arm: Arm): EventName[] {
  switch (arm.kind) {
    case 'pipeline':
      return arm.status === 'failed' ? ['pipeline_failed']
        : arm.status === 'success' ? ['pipeline_succeeded']
        : ['pipeline_failed', 'pipeline_succeeded']
    case 'job':
    case 'deployed':
      return []
    default:
      return [arm.kind]
  }
}

/** Whether a change of this kind can still happen on an MR in this state. */
export const canStillHappen = (e: EventName, state: string) =>
  state === 'opened' || e === 'comment' || (state === 'closed' && e === 'reopened')

/** The "once" choices still waiting for a change that can happen. */
export const pendingOnce = (link: Link, state: string) =>
  EVENTS.filter(e => link.once?.[e] && canStillHappen(e, state))

export const ignoredFor = (link: Link, key: IgnoreKey, d: Defaults) => link.ignored?.[key] ?? d.ignored[key] ?? []

/** Every name ignored for an event: the `all` list and the event's own. */
export const ignoreList = (link: Link, key: IgnoreKey, d: Defaults) =>
  [...ignoredFor(link, 'all', d), ...ignoredFor(link, key, d)]

/** Whether `user` is on the list; `@me` is glab's user. An unknown author is never ignored. */
export function isListed(list: string[], user: string | null | undefined, me: string | null): boolean {
  if (!user) return false
  const name = user.toLowerCase()
  return list.some(u => {
    const entry = u === '@me' ? me : u.replace(/^@/, '')
    return entry?.toLowerCase() === name
  })
}

export const unlinksWhenDone = (link: Link, d: Defaults) => link.unlinkWhenDone ?? d.unlinkWhenDone

/** What the person and the model read about how a link behaves. */
export function describeDelivery(link: Link, d: Defaults): string[] {
  const by = (c: DeliveryChoice) => {
    const names = EVENTS.filter(e => !link.once?.[e] && choiceFor(link, e, d) === c).map(e => LABELS[e])
    return names.length ? names.join(', ') : 'nothing'
  }
  const changed = EVENTS.filter(e => choiceFor(link, e, d) !== d.delivery[e])
    .map(e => `${LABELS[e]} (default ${d.delivery[e]})`)
  const ignored = PERSON_EVENTS
    .filter(k => ignoredFor(link, k, d).length > 0)
    .map(k => `${k}: ${ignoredFor(link, k, d).join(', ')}`)
  const once = EVENTS.filter(e => link.once?.[e])
    .map(e => `${LABELS[e]} (then ${choiceFor(link, e, d) === 'always' ? 'quiet' : choiceFor(link, e, d)})`)
  return [
    ...(once.length ? [`wakes you once more for: ${once.join(', ')}`] : []),
    `wakes you for: ${by('always')}`,
    `added to your next message: ${by('quiet')}`,
    `off: ${by('off')}`,
    ...(changed.length ? [`changed for this link: ${changed.join(', ')}`] : []),
    `ignored users (@me is glab's user): ${ignored.length ? ignored.join('; ') : 'none'}${link.ignored ? ' (changed for this link)' : ''}`,
    unlinksWhenDone(link, d)
      ? 'once merged or closed: unlinks when no one-time wait or "once" choice remains, and reports nothing after that'
      : 'once merged or closed: stays linked until you unlink it',
  ]
}
