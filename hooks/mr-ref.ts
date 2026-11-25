// Parsing the ways a person or the model names an MR.
import type { EngineInterface } from 'claude-code'

import { api, setupHelp } from './glab'

export type MrRef = { host: string; project: string; iid: number }

export const linkKey = (r: MrRef) => `${r.host}/${r.project}!${r.iid}`

/** `app!168`: the short name used in wakes and the band. */
export const shortName = (r: { project: string; iid: number }) =>
  `${r.project.split('/').pop()}!${r.iid}`

/**
 * Accepts an MR URL, `group/project!123`, or `!123` / `123` for the project of
 * the session's own repository.
 */
export async function parseMr(
  $: EngineInterface,
  text: string,
  glabPath: string,
): Promise<MrRef | { error: string }> {
  const s = text.trim()
  const url = s.match(/^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/)
  if (url) return { host: url[1]!, project: url[2]!, iid: Number(url[3]) }

  const full = s.match(/^([\w.-]+(?:\/[\w.-]+)+)!(\d+)$/)
  const bare = s.match(/^!?(\d+)$/)
  if (!full && !bare) {
    return { error: `Not an MR: "${s}". Give its URL, group/project!123, or !123.` }
  }
  const repo = await repoOfSession($, glabPath)
  if (full) {
    // The host: the session repository's, else the one host glab is logged in to.
    if (!('error' in repo)) return { host: repo.host, project: full[1]!, iid: Number(full[2]) }
    const only = await onlyGlabHost($, glabPath)
    if ('error' in only) return { error: `Can't tell which GitLab host ${full[1]} is on: ${only.error}` }
    return { host: only.host, project: full[1]!, iid: Number(full[2]) }
  }
  if ('error' in repo) return repo
  return { host: repo.host, project: repo.project, iid: Number(bare![1]) }
}

/** The host glab is logged in to, when it is logged in to exactly one. */
async function onlyGlabHost($: EngineInterface, glabPath: string): Promise<{ host: string } | { error: string }> {
  for (const bin of glabPath === 'glab' ? ['glab', '/opt/homebrew/bin/glab', '/usr/local/bin/glab'] : [glabPath]) {
    let out
    try {
      out = await $.process.run([bin, 'auth', 'status'], { env: { NO_COLOR: '1' } })
    } catch {
      continue
    }
    const hosts = [...new Set([...`${out.stdout}\n${out.stderr}`.matchAll(/Logged in to (\S+) as/g)].map(m => m[1]!))]
    if (hosts.length === 1) return { host: hosts[0]! }
    if (hosts.length === 0) {
      return { error: 'glab is not logged in to any GitLab host. Give the MR URL, and have the person log in with `glab auth login --hostname <host>`.' }
    }
    return { error: `glab is logged in to several hosts (${hosts.join(', ')}). Give the MR URL instead.` }
  }
  return { error: setupHelp('missing', '<your GitLab host>') ?? 'glab is not installed.' }
}

/** The GitLab host and project of the session's own repository, from its origin remote. */
async function repoOfSession(
  $: EngineInterface,
  glabPath: string,
): Promise<{ host: string; project: string } | { error: string }> {
  let remote = ''
  try {
    const r = await $.process.run(['git', 'remote', 'get-url', 'origin'])
    remote = r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    remote = ''
  }
  const https = remote.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/)
  if (https) return { host: https[1]!, project: https[2]! }
  const ssh = remote.match(/^(?:ssh:\/\/)?[^@]+@([^:/]+)(?::\d+)?[:/](.+?)(?:\.git)?$/)
  if (ssh) {
    // An ssh remote's port is the ssh port, not the web one: ask GitLab for the web URL.
    const project = await api<{ web_url: string }>(
      $, ssh[1]!, `projects/${encodeURIComponent(ssh[2]!)}`, glabPath,
    )
    const web = project.ok ? project.data.web_url.match(/^https?:\/\/([^/]+)\//) : null
    if (web) return { host: web[1]!, project: ssh[2]! }
    return { host: ssh[1]!, project: ssh[2]! }
  }
  return { error: 'This session is not in a GitLab repository; give the MR URL or group/project!123.' }
}
