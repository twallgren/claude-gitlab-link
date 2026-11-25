import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const URL = 'https://gl.example.com:8443/grp/app/-/merge_requests/7'
const TOOL = 'mcp__gitlab-link__'

type Fake = {
  mr: Record<string, unknown>
  notes: { id: number; body: string; system: boolean; created_at: string; author: { username: string } }[]
  failedJobs: { name: string }[]
  pipelines: { id: number; sha: string }[]
  jobs: Record<number, { name: string; status: string; web_url: string }[]>
  ancestors: Record<string, boolean>
  down: string | null
  missing?: boolean
  bareError?: boolean
  noLogin?: boolean
  calls: string[]
}

function fakeGitlab(): Fake {
  return {
    mr: {
      state: 'opened', title: 'Add thing', web_url: URL, sha: 'c2',
      has_conflicts: false, user_notes_count: 0,
      merge_commit_sha: null, squash_commit_sha: null,
      head_pipeline: { id: 11, sha: 'c2', status: 'running', web_url: 'https://gl/p/11' },
    },
    notes: [], failedJobs: [], pipelines: [], jobs: {}, ancestors: {}, down: null, calls: [],
  }
}

const ok = (data: unknown) => ({
  value: { exitCode: 0, stdout: JSON.stringify(data), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})
const bad = (stderr: string) => ({
  value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

/** The engine beneath the mod: glab answered from `g`, wakes recorded. */
function world(on: On, g: Fake, store?: Record<string, unknown>) {
  mock.store(on, store)
  const wakes: string[] = []
  const contexts: string[][] = []
  on('process.run', ((_: unknown, e: { argv: string[] }) => {
    const path = e.argv[2] ?? ''
    g.calls.push(path)
    if (g.missing) return { deny: 'spawn glab ENOENT' }
    if (g.bareError) return { value: { exitCode: 0, stdout: '', stderr: '   ERROR  \n', isStdoutTruncated: false, isStderrTruncated: false } }
    if (g.noLogin) return path === 'user' ? bad('glab: 401 Unauthorized (HTTP 401)') : bad('glab: 404 Not Found (HTTP 404)')
    if (g.down) return bad(g.down)
    if (path === 'user') return ok({ username: 'claude-bot' })
    if (path.endsWith('/merge_requests/7')) return ok(g.mr)
    if (path.includes('/merge_requests/7/notes')) return ok([...g.notes].reverse())
    if (path.includes('/jobs?scope[]=failed')) return ok(g.failedJobs)
    if (path.includes('/repository/merge_base')) {
      const [, a, b] = path.match(/refs\[\]=(\w+)&refs\[\]=(\w+)/) ?? []
      return ok({ id: g.ancestors[`${a}:${b}`] ? a : 'zzz' })
    }
    if (path.includes('/pipelines?ref=')) return ok(g.pipelines)
    const jobs = path.match(/pipelines\/(\d+)\/jobs/)
    if (jobs) return ok(g.jobs[Number(jobs[1])] ?? [])
    return bad(`404 Not Found ${path}`)
  }) as never)
  on('tool.register', (() => ({ value: {} })) as never)
  on('session.info', (() => ({ value: { transcriptPath: '/tmp/test-session.jsonl' } })) as never)
  on('command.register', ((_: unknown, e: { name: string }) => ({ value: { command: e.name } })) as never)
  on('ui.notify', (() => ({ value: { isSent: true, channel: 'test' } })) as never)
  on('session.start', ((_: unknown, e: { cwd: string }) => ({ cwd: e.cwd })) as never)
  on('prompt.submit', ((_: unknown, e: { text: string; context?: string[]; origin?: { kind: string } }) => {
    if (e.origin?.kind === 'plugin') wakes.push(e.text)
    else contexts.push([...(e.context ?? [])])
    return { text: e.text, context: e.context }
  }) as never)
  return { wakes, contexts }
}

async function start($: any) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

const call = ($: any, name: string, input: Record<string, unknown>) =>
  $.tool.call({ tool: `${TOOL}${name}`, ...input })

test('a failed head pipeline wakes once; a running one does not', async ($, on) => {
  const g = fakeGitlab()
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, g)
  await start($)
  const linked = await call($, 'gitlab_link_mr', { mr: URL })
  expect(String(linked.result)).toContain('app!7')

  await clock.advance(61_000)
  expect(w.wakes.length).toBe(0)

  g.mr = { ...g.mr, head_pipeline: { id: 11, sha: 'c2', status: 'failed', web_url: 'https://gl/p/11' } }
  g.failedJobs = [{ name: 'lint' }]
  await clock.advance(61_000)
  expect(w.wakes.length).toBe(1)
  expect(w.wakes[0]).toContain('pipeline #11 failed (failed jobs: lint)')

  await clock.advance(61_000)
  expect(w.wakes.length).toBe(1)
})

test('an armed comment wakes; own comments and unarmed changes stay quiet', async ($, on) => {
  const g = fakeGitlab()
  const clock = mock.clock(on, { now: Date.parse('2026-11-25T12:00:00Z') })
  const w = world(on, g)
  await start($)
  await call($, 'gitlab_wait_for', { mr: URL, condition: 'comment' })

  g.notes.push({ id: 1, body: 'my own note', system: false, created_at: '2026-11-25T12:00:30.000Z', author: { username: 'claude-bot' } })
  g.mr = { ...g.mr, user_notes_count: 1, head_pipeline: { id: 11, sha: 'c2', status: 'success', web_url: 'x' } }
  await clock.advance(61_000)
  expect(w.wakes.length).toBe(0)

  g.notes.push({ id: 2, body: 'please rename', system: false, created_at: '2026-11-25T12:01:30.000Z', author: { username: 'reviewer' } })
  g.mr = { ...g.mr, user_notes_count: 2 }
  await clock.advance(61_000)
  expect(w.wakes.length).toBe(1)
  expect(w.wakes[0]).toContain('comment by reviewer: please rename')
  expect(w.wakes[0]).toContain('Nothing else is armed.')

  await $.prompt.submit({ text: 'next thing' })
  const ctx = w.contexts.at(-1)?.join('\n') ?? ''
  expect(ctx).toContain('pipeline #11: success')
})

test('an outage wakes once after an hour, only with something armed', async ($, on) => {
  const g = fakeGitlab()
  const clock = mock.clock(on, { now: 5_000_000 })
  const w = world(on, g)
  await start($)
  await call($, 'gitlab_wait_for', { mr: URL, condition: 'approved' })
  g.down = 'dial tcp: connect: connection refused'
  await clock.advance(30 * 60_000)
  expect(w.wakes.length).toBe(0)
  await clock.advance(35 * 60_000)
  expect(w.wakes.length).toBe(1)
  expect(w.wakes[0]).toContain('unreachable')
  await clock.advance(60 * 60_000)
  expect(w.wakes.length).toBe(1)

  g.down = null
  await clock.advance(11 * 60_000)
  expect(w.wakes.length).toBe(1)
})

test('deployed waits for the merge, then for a target job in a pipeline containing the commit', {
  options: {
    deployTargets: JSON.stringify({
      'grp/app': {
        workers: {
          jobs: ['deploy:workers', 'deploy:workers-and-restart'],
          notes: { 'deploy:workers': 'no restart: running workers keep the old code' },
        },
      },
    }),
  },
} as never, async ($, on) => {
  const g = fakeGitlab()
  const clock = mock.clock(on, { now: 9_000_000 })
  const w = world(on, g)
  await start($)
  const armed = await call($, 'gitlab_wait_for', { mr: URL, condition: 'deployed', target: 'workers' })
  expect(String(armed.result)).toContain('deployed workers')

  g.mr = { ...g.mr, state: 'merged', squash_commit_sha: 'sq1' }
  g.pipelines = [{ id: 30, sha: 'm3' }, { id: 29, sha: 'm2' }, { id: 28, sha: 'm1' }]
  g.ancestors = { 'sq1:m3': true, 'sq1:m2': true, 'sq1:m1': false }
  g.jobs = {
    29: [{ name: 'deploy:workers', status: 'manual', web_url: 'j29' }],
    30: [{ name: 'deploy:workers', status: 'success', web_url: 'j30' }],
  }
  await clock.advance(61_000)
  expect(w.wakes.length).toBe(1)
  expect(w.wakes[0]).toContain('deployed workers: deploy:workers success at m3')
  expect(w.wakes[0]).toContain('no restart')

  const list = await call($, 'gitlab_linked_mrs', {})
  expect(String(list.result)).toContain('No MRs are linked to this session.')
})

const denied = (r: any) => String(r.deny ?? r.text ?? '')

test('glab missing: the link is refused with install steps and nothing stays linked', async ($, on) => {
  const g = fakeGitlab()
  mock.clock(on, { now: 1 })
  world(on, g)
  await start($)
  g.missing = true
  const r = await call($, 'gitlab_link_mr', { mr: URL })
  expect(denied(r)).toContain('brew install glab')
  expect(denied(r)).toContain('glabPath')
  g.missing = false
  expect(String((await call($, 'gitlab_linked_mrs', {})).result)).toContain('No MRs are linked to this session.')
})

test('not logged in (401, a bare ERROR, or a private 404): the arm is refused with the login command', async ($, on) => {
  const g = fakeGitlab()
  mock.clock(on, { now: 1 })
  world(on, g)
  await start($)
  for (const set of [() => { g.down = 'glab: 401 Unauthorized (HTTP 401)' }, () => { g.bareError = true }, () => { g.noLogin = true }]) {
    g.down = null; g.bareError = false; g.noLogin = false
    set()
    const r = await call($, 'gitlab_wait_for', { mr: URL, condition: 'approved' })
    expect(denied(r)).toContain('glab auth login --hostname gl.example.com:8443')
    expect(denied(r)).toContain('nothing was armed')
  }
  g.down = null; g.bareError = false; g.noLogin = false
  expect(String((await call($, 'gitlab_linked_mrs', {})).result)).toContain('No MRs are linked to this session.')
})

test('a login that fails after linking pauses checks, never wakes, and tells the next turn how to fix it', async ($, on) => {
  const g = fakeGitlab()
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, g)
  await start($)
  await call($, 'gitlab_wait_for', { mr: URL, condition: 'approved' })
  g.down = 'glab: 401 Unauthorized (HTTP 401)'
  await clock.advance(2 * 60 * 60_000)
  expect(w.wakes.length).toBe(0)
  await $.prompt.submit({ text: 'anything new?' })
  const ctx = w.contexts.at(-1)?.join('\n') ?? ''
  expect(ctx).toContain('checks are paused')
  expect(ctx).toContain('glab auth login --hostname gl.example.com:8443')
  expect(String((await call($, 'gitlab_linked_mrs', {})).result)).toContain('checks paused')
})

test('links saved to the store come back when a fresh plugin worker starts with empty state', async ($, on) => {
  const g = fakeGitlab()
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, g, {
    's1:/tmp/test-session.jsonl': {
      savedAt: 900_000,
      links: {
        'gl.example.com:8443/grp/app!7': {
          key: 'gl.example.com:8443/grp/app!7', host: 'gl.example.com:8443', project: 'grp/app', iid: 7,
          problems: ['pipeline', 'conflict', 'closed'],
          arms: [{ id: 'a1', kind: 'pipeline', armedAt: '2026-11-25T00:00:00.000Z' }],
          snap: null, fired: {}, noteSince: null, nextCheckAt: 0, linkedAt: '2026-11-25T00:00:00.000Z',
        },
      },
      health: {}, pendingWake: [], quiet: [],
    },
  })
  await start($)
  const listed = String((await call($, 'gitlab_linked_mrs', {})).result)
  expect(listed).toContain('app!7')
  expect(listed).toContain('waiting: pipeline')
  expect(listed).toContain('loaded 1×')

  g.mr = { ...g.mr, head_pipeline: { id: 11, sha: 'c2', status: 'success', web_url: 'https://gl/p/11' } }
  await clock.advance(16_000)
  expect(w.wakes.length).toBe(1)
  expect(w.wakes[0]).toContain('pipeline #11 success')
})
