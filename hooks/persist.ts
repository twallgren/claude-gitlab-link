// Saving the session's links to $.store, so they outlive a restart of the plugin.
// $.state survives a hot reload only; an installed plugin's worker can be
// replaced mid-session, which drops $.state and timers. $.store is kept on disk.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { HostHealth, Link } from '../types'

const links = atom({ plugin: 'gitlab-link', key: 'links' } as const, {}, { shape: 'links-1' })
const health = atom({ plugin: 'gitlab-link', key: 'health' } as const, {}, { shape: 'health-1' })
const pendingWake = atom({ plugin: 'gitlab-link', key: 'pendingWake' } as const, [], { shape: 'lines-1' })
const quiet = atom({ plugin: 'gitlab-link', key: 'quiet' } as const, [], { shape: 'lines-1' })
const reported = atom({ plugin: 'gitlab-link', key: 'reportedDeploys' } as const, {}, { shape: 'reported-1' })

const SAVED = 's1:'
const DIAG = 'd1:'
const KEEP_MS = 14 * 24 * 60 * 60_000

type Saved = {
  savedAt: number
  links: Record<string, Link>
  health: Record<string, HostHealth>
  pendingWake: string[]
  quiet: string[]
  reportedDeploys?: Record<string, string[]>
}

export type Diag = {
  loads: number
  lastLoadAt: number
  ticks: number
  lastTickAt: number | null
  lastError: string | null
  lastErrorAt: number | null
}

/** Writes the session's values to the store under its key. */
export async function save($: EngineInterface, sessionKey: string) {
  if (!sessionKey) return
  const saved: Saved = {
    savedAt: await $.clock.now(),
    links: await read($, links),
    health: await read($, health),
    pendingWake: await read($, pendingWake),
    quiet: await read($, quiet),
    reportedDeploys: await read($, reported),
  }
  await $.store.set(SAVED + sessionKey, saved)
}

/**
 * At session start: put back what the store holds when $.state came up empty
 * (a fresh worker), count the load, and prune other sessions' old entries.
 * Returns how many links were restored.
 */
export async function restore($: EngineInterface, sessionKey: string): Promise<number> {
  const now = await $.clock.now()
  const saved = (await $.store.get(SAVED + sessionKey)) as Saved | undefined
  let restored = 0
  if (saved && Object.keys(await read($, links)).length === 0) {
    restored = Object.keys(saved.links ?? {}).length
    await update($, links, () => saved.links ?? {})
    await update($, health, () => saved.health ?? {})
    await update($, pendingWake, () => saved.pendingWake ?? [])
    await update($, quiet, () => saved.quiet ?? [])
    await update($, reported, () => saved.reportedDeploys ?? {})
  }
  await noteDiag($, sessionKey, d => ({ ...d, loads: d.loads + 1, lastLoadAt: now }))
  for (const key of await $.store.keys()) {
    if (!key.startsWith(SAVED) || key === SAVED + sessionKey) continue
    const other = (await $.store.get(key)) as Saved | undefined
    if (!other || now - (other.savedAt ?? 0) > KEEP_MS) {
      await $.store.delete(key)
      await $.store.delete(DIAG + key.slice(SAVED.length))
    }
  }
  return restored
}

export async function readDiag($: EngineInterface, sessionKey: string): Promise<Diag> {
  const d = (await $.store.get(DIAG + sessionKey)) as Diag | undefined
  return d ?? { loads: 0, lastLoadAt: 0, ticks: 0, lastTickAt: null, lastError: null, lastErrorAt: null }
}

export async function noteDiag($: EngineInterface, sessionKey: string, fn: (d: Diag) => Diag) {
  if (!sessionKey) return
  await $.store.set(DIAG + sessionKey, fn(await readDiag($, sessionKey)))
}

const hhmmss = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(11, 19) + 'Z' : 'never')

export async function diagLine($: EngineInterface, sessionKey: string): Promise<string> {
  const d = await readDiag($, sessionKey)
  const err = d.lastError ? `; last error ${hhmmss(d.lastErrorAt)}: ${d.lastError}` : ''
  return `mod: loaded ${d.loads}× (last ${hhmmss(d.lastLoadAt)}), ${d.ticks} check ticks (last ${hhmmss(d.lastTickAt)})${err}`
}
