// gitlab-link: link GitLab MRs to a session. Each kind of change wakes it, rides
// along on its next turn or is dropped, as the settings or the link say.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ArmKind, DeliveryChoice, EventName } from '../types'
import { CHOICES, checkIgnored, EVENTS, PERSON_EVENTS } from './delivery'
import { linkStatus, outageLine, quietText, wakeRow } from './format'
import { restore, save } from './persist'
import { deliver, linkAndCheck, listText, makeRuntime, tick, unarm, unlink, type LinkChanges } from './runtime'

const P = 'gitlab-link'
const links = atom({ plugin: 'gitlab-link', key: 'links' } as const, {}, { shape: 'links-1' })
const health = atom({ plugin: 'gitlab-link', key: 'health' } as const, {}, { shape: 'health-1' })
const quiet = atom({ plugin: 'gitlab-link', key: 'quiet' } as const, [], { shape: 'lines-1' })
const TICK_MS = 15_000
const KINDS: ArmKind[] = ['pipeline', 'job', 'comment', 'approved', 'merged', 'closed', 'reopened', 'conflict', 'deployed']
const tool = <N extends string>(name: N) => ({ tool: `mcp__gitlab-link__${name}` as const })
const mrProp = { type: 'string', description: 'The MR: its URL, group/project!123, or !123 for this repository.' }

const LINK_DOC =
  'Link a GitLab merge request to this session (gitlab.com or self-hosted, through glab), or change how a linked one behaves. Each kind of change is delivered as the user\'s settings or this link say: "always" wakes the session each time, "quiet" adds it to your next message, "off" says nothing. The answer lists what wakes this link, what is quiet, who is ignored and what happens after merge or close; tell the user. Change delivery, ignored_users or unlink_when_done only when the user asks. Do not poll GitLab yourself for a linked MR.'

const WAIT_DOC =
  'Add a one-time wake for one condition on a GitLab MR (links it if needed). It works whatever the delivery settings are and leaves them alone: the session is woken once when it is met, then the wait is gone. If it is already met, this returns that at once and nothing stays waiting. Conditions: pipeline (the head pipeline of the current commit reaches a final status; status=failed or success for that result only), job (job_id finishes), comment (a new comment from someone not ignored; from=username for one person, even an ignored one, or @me), approved, merged, closed, reopened, conflict, deployed (target = a configured deploy target or a GitLab environment name; job = require one job of the target; waits for the merge first). If the user wants only one more wake for something set to "always", use gitlab_link_mr with delivery "once" instead.'

/** The link changes a call asks for, or why they are wrong. */
function readChanges(i: {
  delivery?: Record<string, string>; ignored_users?: Record<string, unknown>; unlink_when_done?: unknown
}): LinkChanges | { error: string } {
  for (const [e, c] of Object.entries(i.delivery ?? {})) {
    if (!EVENTS.includes(e as EventName)) return { error: `Unknown event ${e}. Use ${EVENTS.join(', ')}.` }
    if (![...CHOICES, 'once', 'default'].includes(c as DeliveryChoice)) return { error: `delivery.${e} must be ${CHOICES.join(', ')}, once or default.` }
  }
  for (const [key, users] of Object.entries(i.ignored_users ?? {})) {
    const checked = checkIgnored({ [key]: users === 'default' ? [] : users })
    if ('error' in checked) return { error: `ignored_users: ${checked.error}.` }
  }
  // The engine may pass a boolean as text, the property allowing either.
  const given = i.unlink_when_done
  const u = given === 'true' ? true : given === 'false' ? false : given
  if (u !== undefined && u !== true && u !== false && u !== 'default') return { error: 'unlink_when_done must be true, false or default.' }
  return { delivery: i.delivery as LinkChanges['delivery'], ignored: i.ignored_users as LinkChanges['ignored'], unlinkWhenDone: u }
}

export const register: Register = (on, options) => {
  const rt = makeRuntime(options)

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'gitlab_link_mr',
      isDeferred: false,
      description: LINK_DOC,
      inputSchema: {
        type: 'object',
        properties: {
          mr: mrProp,
          delivery: {
            type: 'object',
            description: 'This link\'s own delivery per event. "once": wake for the next change only (not one already there), then go back to the earlier choice ("quiet" if it was "always"). "default": use the settings.',
            properties: Object.fromEntries(EVENTS.map(e => [e, { type: 'string', enum: [...CHOICES, 'once', 'default'] }])),
            additionalProperties: false,
          },
          ignored_users: {
            type: 'object',
            description: `Users whose changes are ignored on this link, per key (${PERSON_EVENTS.join(', ')}); @me is glab's user. A list replaces the settings' list for that key ([] ignores nobody there); "default" goes back to the settings.`,
            properties: Object.fromEntries(PERSON_EVENTS.map(k => [k, { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string', enum: ['default'] }] }])),
            additionalProperties: false,
          },
          unlink_when_done: {
            description: 'Unlink once merged or closed and no one-time wait remains: true, false, or "default".',
            anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['default'] }],
          },
        },
        required: ['mr'],
      },
    })
    await $.tool.register({
      name: 'gitlab_wait_for',
      isDeferred: false,
      description: WAIT_DOC,
      inputSchema: {
        type: 'object',
        properties: {
          mr: mrProp,
          condition: { type: 'string', enum: KINDS },
          status: { type: 'string', enum: ['any', 'failed', 'success'], description: 'pipeline: any final status (default), or failed or success only.' },
          job_id: { type: 'number', description: 'job: the job id.' },
          from: { type: 'string', description: 'comment: only this username.' },
          since: { type: 'string', description: 'comment: count comments after this ISO time (default: now).' },
          target: { type: 'string', description: 'deployed: the deploy target or environment.' },
          job: { type: 'string', description: 'deployed: require this one job of the target.' },
        },
        required: ['mr', 'condition'],
      },
    })
    await $.tool.register({
      name: 'gitlab_unarm',
      description: 'Disarm conditions on a linked MR: one by arm_id, all of one condition, or all.',
      inputSchema: {
        type: 'object',
        properties: { mr: mrProp, arm_id: { type: 'string' }, condition: { type: 'string', enum: KINDS } },
        required: ['mr'],
      },
    })
    await $.tool.register({
      name: 'gitlab_unlink_mr',
      description: 'Unlink an MR from this session; its armed conditions go with it.',
      inputSchema: { type: 'object', properties: { mr: mrProp }, required: ['mr'] },
    })
    await $.tool.register({
      name: 'gitlab_linked_mrs',
      description: "List this session's linked MRs, their status, armed conditions and any GitLab outage.",
      inputSchema: { type: 'object', properties: {} },
    })
    await $.command.register({
      name: 'gitlab-link',
      description: 'Link a GitLab MR to this session, or list the linked MRs',
      argumentHint: '[MR url | group/project!123 | !123]',
    })
    await $.command.register({
      name: 'gitlab-unlink',
      description: 'Unlink a GitLab MR from this session',
      argumentHint: '<MR url | group/project!123 | !123>',
    })
    rt.sessionKey = (await $.session.info()).transcriptPath
    await restore($, rt.sessionKey)
    $.clock.every(TICK_MS, () => tick($, rt))
    return next(e)
  })

  on('tool.run', tool('gitlab_link_mr'), async ($, e) => {
    const i = e as unknown as {
      mr: string; delivery?: Record<string, string>; ignored_users?: Record<string, unknown>
      unlink_when_done?: boolean | 'default'
    }
    const changes = readChanges(i)
    if ('error' in changes) return { deny: changes.error }
    const r = await linkAndCheck($, rt, i.mr, changes)
    return 'error' in r ? { deny: r.error } : { result: r.text }
  })

  on('tool.run', tool('gitlab_wait_for'), async ($, e) => {
    const i = e as unknown as {
      mr: string; condition: ArmKind; status?: 'any' | 'failed' | 'success'; job_id?: number
      from?: string; since?: string; target?: string; job?: string
    }
    if (!KINDS.includes(i.condition)) return { deny: `Unknown condition ${i.condition}.` }
    if (i.status !== undefined && !['any', 'failed', 'success'].includes(i.status)) return { deny: 'status must be any, failed or success.' }
    if (i.condition === 'job' && !i.job_id) return { deny: 'job needs job_id.' }
    if (i.condition === 'deployed' && !i.target) return { deny: 'deployed needs target.' }
    if (i.since && Number.isNaN(Date.parse(i.since))) return { deny: `since is not a time: "${i.since}". Use ISO 8601.` }
    const r = await linkAndCheck($, rt, i.mr, {}, {
      kind: i.condition, status: i.status, jobId: i.job_id, from: i.from,
      since: i.since, target: i.target, job: i.job,
    })
    return 'error' in r ? { deny: r.error } : { result: r.text }
  })

  on('tool.run', tool('gitlab_unarm'), async ($, e) => {
    const i = e as unknown as { mr: string; arm_id?: string; condition?: string }
    return { result: await unarm($, rt, i.mr, i.arm_id, i.condition) }
  })

  on('tool.run', tool('gitlab_unlink_mr'), async ($, e) =>
    ({ result: await unlink($, rt, (e as unknown as { mr: string }).mr) }))

  on('tool.run', tool('gitlab_linked_mrs'), async $ => ({ result: await listText($, rt) }))

  on('command.run', { command: 'gitlab-link' }, async ($, e) => {
    if (!e.args.trim()) return { text: await listText($, rt) }
    const r = await linkAndCheck($, rt, e.args, {}, undefined, true)
    return { text: 'error' in r ? r.error : r.text }
  })

  on('command.run', { command: 'gitlab-unlink' }, async ($, e) => ({ text: await unlink($, rt, e.args) }))

  // Hold wakes while the main loop runs a turn, so they arrive as one.
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      rt.isBusy = true
      rt.mainTurn = e.turnId
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.turnId === rt.mainTurn) {
      rt.isBusy = false
      rt.mainTurn = null
      await deliver($, rt)
    }
    return done
  })

  // Quiet changes ride along on the next prompt, whoever starts it.
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    if ((await read($, quiet)).length === 0) return next(e)
    let lines: string[] = []
    await update($, quiet, l => {
      lines = l
      return []
    })
    await save($, rt.sessionKey)
    return next({ ...e, context: [...(e.context ?? []), quietText(lines)] })
  })

  // A wake is a plugin prompt the chat shows as a message row: draw only the part
  // written for the person. The terminal's ctrl+o shows all. The desktop app marks
  // every row expanded, so it is shortened there regardless.
  on('ui.render', { component: 'UserMessage' }, async (_$, e, next) => {
    const o = e.props.origin
    const isOurs = o.kind === 'plugin' && o.name === 'gitlab-link'
    if (!isOurs || (e.props.isExpanded && e.surface !== 'desktop')) return next(e)
    const text = wakeRow(e.props.text, e.surface === 'desktop')
    return text === null ? next(e) : next({ ...e, props: { ...e.props, text } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const all = Object.values(await read($, links))
    const hs = Object.entries(await read($, health))
    if (e.props.hasSurvey || (all.length === 0 && hs.length === 0)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    return (
      <Box flexDirection="column">
        {all.map(l => <Text dimColor>{linkStatus(l)}</Text>)}
        {hs.map(([host, h]) => <Text color="warning">{outageLine(host, h, now)}</Text>)}
      </Box>
    )
  })
}
