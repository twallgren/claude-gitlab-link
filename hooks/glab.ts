// GitLab REST calls through glab, so the mod reuses glab's login and holds no token.
import type { EngineInterface } from 'claude-code'

export type FailKind = 'auth' | 'notfound' | 'network' | 'server' | 'missing' | 'other'

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: FailKind; detail: string }

const FALLBACK_PATHS = ['/opt/homebrew/bin/glab', '/usr/local/bin/glab', '/usr/bin/glab']

let resolvedGlab: string | null = null

/** Which glab to run: the configured one, else the usual install folders. */
async function glabCandidates(configured: string): Promise<string[]> {
  if (resolvedGlab) return [resolvedGlab]
  return configured === 'glab' ? ['glab', ...FALLBACK_PATHS] : [configured]
}

/** Sorts glab's stderr into the failures the mod treats differently. */
export function classify(stderr: string): FailKind {
  if (/\b(401|403)\b|unauthorized|forbidden|token/i.test(stderr)) return 'auth'
  if (/\b404\b|not found/i.test(stderr)) return 'notfound'
  if (/\b5\d\d\b/.test(stderr)) return 'server'
  if (/dial|connection refused|no such host|timed? ?out|network is unreachable|tls|eof|reset by peer|lookup/i.test(stderr)) return 'network'
  return 'other'
}

/** Percent-encodes a project path for /projects/:id. */
export const enc = (project: string) => encodeURIComponent(project)

/**
 * GET one API path on a host. The host is passed as GITLAB_HOST, which accepts
 * a port (glab's --hostname does not).
 */
export async function api<T>(
  $: EngineInterface,
  host: string,
  path: string,
  glabPath: string,
): Promise<ApiResult<T>> {
  let lastStartError = ''
  for (const bin of await glabCandidates(glabPath)) {
    let run
    try {
      run = await $.process.run([bin, 'api', path], {
        env: { GITLAB_HOST: host, NO_COLOR: '1', GLAB_CHECK_UPDATE: 'false' },
        timeoutMs: 30_000,
      })
    } catch (err) {
      const text = String(err)
      if (/still running|timed? ?out/i.test(text)) {
        return { ok: false, kind: 'network', detail: 'glab timed out after 30s' }
      }
      lastStartError = text
      continue // could not start this candidate; try the next
    }
    resolvedGlab = bin
    if (run.exitCode === 0) {
      try {
        return { ok: true, data: JSON.parse(run.stdout) as T }
      } catch {
        return { ok: false, kind: 'other', detail: `unreadable reply from ${path}` }
      }
    }
    const stderr = (run.stderr || run.stdout).trim().split('\n').slice(-3).join(' ')
    return { ok: false, kind: classify(stderr), detail: stderr.slice(0, 300) }
  }
  return { ok: false, kind: 'missing', detail: `glab could not be started (${lastStartError.slice(0, 200)})` }
}

const selfNames = new Map<string, string>()

/** The username glab is signed in as on a host, so the session's own comments are skipped. */
export async function selfName($: EngineInterface, host: string, glabPath: string): Promise<ApiResult<string>> {
  const known = selfNames.get(host)
  if (known) return { ok: true, data: known }
  const me = await api<{ username: string }>($, host, 'user', glabPath)
  if (!me.ok) return me
  selfNames.set(host, me.data.username)
  return { ok: true, data: me.data.username }
}

const ancestors = new Map<string, boolean>()

/** Whether commit `sha` is contained in `tip` (merge-base equals sha). Cached: history does not change. */
export async function contains(
  $: EngineInterface,
  host: string,
  project: string,
  sha: string,
  tip: string,
  glabPath: string,
): Promise<ApiResult<boolean>> {
  if (sha === tip) return { ok: true, data: true }
  const key = `${host}/${project}:${sha}:${tip}`
  const cached = ancestors.get(key)
  if (cached !== undefined) return { ok: true, data: cached }
  const mb = await api<{ id?: string }>(
    $, host,
    `projects/${enc(project)}/repository/merge_base?refs[]=${sha}&refs[]=${tip}`,
    glabPath,
  )
  if (!mb.ok) return mb
  const isIn = mb.data.id === sha
  ancestors.set(key, isIn)
  return { ok: true, data: isIn }
}
