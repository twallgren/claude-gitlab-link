// gitlab-link: link GitLab MRs to a session; wake it only for armed conditions
// and blocking problems; everything else rides along on its next turn.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ArmKind, Problem } from '../types'
import { linkStatus, outageLine, quietText } from './format'
import { restore, save } from './persist'
import { deliver, linkAndCheck, listText, makeRuntime, PROBLEMS, tick, unarm, unlink } from './runtime'

const P = 'gitlab-link'
const links = atom({ plugin: 'gitlab-link', key: 'links' } as const, {}, { shape: 'links-1' })
const health = atom({ plugin: 'gitlab-link', key: 'health' } as const, {}, { shape: 'health-1' })
const quiet = atom({ plugin: 'gitlab-link', key: 'quiet' } as const, [], { shape: 'lines-1' })
const TICK_MS = 15_000
const KINDS: ArmKind[] = ['pipeline', 'job', 'comment', 'approved', 'merged', 'conflict', 'deployed']
const tool = <N extends string>(name: N) => ({ tool: `mcp__gitlab-link__${name}` as const })
const mrProp = { type: 'string', description: 'The MR: its URL, group/project!123, or !123 for this repository.' }

const LINK_DOC =
  'Link a GitLab merge request to this session (gitlab.com or self-hosted, through glab). A linked open MR wakes the session by itself only for blocking problems: its head pipeline failing, a merge conflict, or being closed without merging (each once per change). Other changes are attached quietly to your next turn. Returns the MR status. Use gitlab_wait_for to be woken for anything else. Do not poll GitLab yourself for a linked MR.'

const WAIT_DOC =
  'Arm one condition on a GitLab MR (links it if needed). The session is woken once when it is met, then it disarms; re-arm to keep waiting. If it is already met, this returns that at once and nothing stays armed. Conditions: pipeline (the head pipeline of the current commit reaches a final status; status=failed for failures only), job (job_id finishes), comment (a new comment by someone other than you; from=username for one person), approved, merged, conflict, deployed (target = a configured deploy target or a GitLab environment name; job = require one job of the target; waits for the merge first). Waits on comment, deployed, pipeline, job and merged survive the merge.'

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
          problems: {
            description: 'Default problem wakes: true (the defaults), false (none), or a list of pipeline, conflict, closed.',
            anyOf: [{ type: 'boolean' }, { type: 'array', items: { type: 'string', enum: PROBLEMS } }],
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
          status: { type: 'string', enum: ['any', 'failed'], description: 'pipeline: any final status (default) or failed only.' },
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
    const i = e as unknown as { mr: string; problems?: boolean | Problem[] }
    const problems = i.problems === undefined ? undefined
      : i.problems === true ? rt.defaultProblems
      : i.problems === false ? []
      : i.problems.filter(p => PROBLEMS.includes(p))
    const r = await linkAndCheck($, rt, i.mr, problems)
    return 'error' in r ? { deny: r.error } : { result: r.text }
  })

  on('tool.run', tool('gitlab_wait_for'), async ($, e) => {
    const i = e as unknown as {
      mr: string; condition: ArmKind; status?: 'any' | 'failed'; job_id?: number
      from?: string; since?: string; target?: string; job?: string
    }
    if (!KINDS.includes(i.condition)) return { deny: `Unknown condition ${i.condition}.` }
    if (i.condition === 'job' && !i.job_id) return { deny: 'job needs job_id.' }
    if (i.condition === 'deployed' && !i.target) return { deny: 'deployed needs target.' }
    const r = await linkAndCheck($, rt, i.mr, undefined, {
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
    const r = await linkAndCheck($, rt, e.args, undefined)
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
    const lines = await read($, quiet)
    if (lines.length === 0) return next(e)
    await update($, quiet, () => [])
    await save($, rt.sessionKey)
    return next({ ...e, context: [...(e.context ?? []), quietText(lines)] })
  })

  // A wake is a plugin prompt the chat shows as a message row: in the compact view,
  // draw only its first line (the plain sentence for the person); ctrl+o shows all.
  on('ui.render', { component: 'UserMessage' }, async (_$, e, next) => {
    const o = e.props.origin
    const isOurs = o.kind === 'plugin' && o.name === 'gitlab-link'
    if (!isOurs || e.props.isExpanded) return next(e)
    const first = e.props.text.split('\n')[0] ?? ''
    if (!first.startsWith('Automatic GitLab update')) return next(e)
    return next({ ...e, props: { ...e.props, text: first } })
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
