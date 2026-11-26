// GitLab REST calls through glab, so the mod reuses glab's login and holds no token.
import type { EngineInterface } from 'claude-code'

export type FailKind = 'auth' | 'forbidden' | 'notfound' | 'network' | 'server' | 'missing' | 'other'

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
  // The request URL is in the message, and an MR or job number in it can look like a status.
  const said = stderr.replace(/https?:\/\/\S+/g, '')
  // A status is only what glab writes as one: `(HTTP 404)`, or `<url>: 404 {…}`. A port is not.
  const status = Number(said.match(/\bHTTP (\d{3})\b/)?.[1] ?? said.match(/(?:^|:\s+)([45]\d\d)(?=\s|$)/)?.[1] ?? 0)
  if (status === 401 || /insufficient_scope|invalid_grant|invalid_token|cannot fetch token|refresh token/i.test(said)) return 'auth'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'notfound'
  if (status >= 500) return 'server'
  if (status) return 'other'
  // Network failures before the loose words: glab wraps long URLs, so part of a path
  // (a project called token-service) can be left in the text.
  if (/dial |connection refused|no such host|timed? ?out|network is unreachable|tls:|tls handshake|\beof\b|reset by peer|\blookup /i.test(said)) return 'network'
  if (/unauthorized|invalid token|token (is )?(expired|revoked)/i.test(said)) return 'auth'
  if (/forbidden/i.test(said)) return 'forbidden'
  if (/not found/i.test(said)) return 'notfound'
  return 'other'
}

/** Whether a failure is one only the person can fix (no retry will help). */
export const needsPerson = (kind: FailKind) => kind === 'missing' || kind === 'auth'

/** What to do about glab being missing or not logged in, for the model to pass on. */
export function setupHelp(kind: FailKind, host: string): string | null {
  if (kind === 'missing') {
    return [
      'glab, the GitLab CLI this mod makes every GitLab call through, is not installed or not on the PATH Claude Code sees.',
      'Install it: on macOS `brew install glab`; other systems: https://gitlab.com/gitlab-org/cli#installation.',
      `Then log in: \`glab auth login --hostname ${host}\` (the person runs this themselves: it uses their own token).`,
      "If glab is installed but not found, set the mod's glabPath option to its full path (`which glab`).",
    ].join(' ')
  }
  if (kind === 'auth') {
    return [
      `glab is not logged in to ${host}, or its login was rejected (an expired or revoked token).`,
      `The person runs, in their own terminal: \`glab auth login --hostname ${host}\` (keep the port when the host has one),`,
      'then checks it with `glab auth status`. Logging in uses their own token, so they do it themselves.',
    ].join(' ')
  }
  return null
}

/** One short line for the band. */
export function setupHint(kind: FailKind, host: string): string | null {
  if (kind === 'missing') return 'install glab, or set glabPath'
  if (kind === 'auth') return `run: glab auth login --hostname ${host}`
  return null
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
        // glab answers a host it has no login for with a bare ERROR and exit 0.
        const said = `${run.stdout}\n${run.stderr}`
        if (/\berror\b/i.test(said)) {
          return { ok: false, kind: 'auth', detail: `glab has no login for ${host}` }
        }
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
  // A commit GitLab no longer has (a deleted ref, since cleaned up) contains nothing.
  const isUnknownRef = !mb.ok && (mb.kind === 'notfound' || /could not find ref/i.test(mb.detail))
  if (!mb.ok && !isUnknownRef) return mb
  const isIn = mb.ok && mb.data.id === sha
  ancestors.set(key, isIn)
  return { ok: true, data: isIn }
}
