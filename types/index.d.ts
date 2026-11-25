/** A problem that wakes the session for every linked MR unless turned off. */
export type Problem = 'pipeline' | 'conflict' | 'closed'

/** A condition a session arms; each fires once, then disarms. */
export type ArmKind =
  | 'pipeline'
  | 'job'
  | 'comment'
  | 'approved'
  | 'merged'
  | 'conflict'
  | 'deployed'

export type Arm = {
  id: string
  kind: ArmKind
  armedAt: string
  /** pipeline: fire on any final status, or on failed only. */
  status?: 'any' | 'failed'
  /** job: the job id. */
  jobId?: number
  /** comment: only this author's comments. */
  from?: string
  /** comment: comments created after this ISO time. */
  since?: string
  /** deployed: the target (a configured name, else an environment name). */
  target?: string
  /** deployed: wait for this one job of the target only. */
  job?: string
}

/** What one check read of an MR. */
export type Snapshot = {
  state: string
  title: string
  webUrl: string
  sha: string
  pipelineId: number | null
  pipelineSha: string | null
  pipelineStatus: string | null
  pipelineUrl: string | null
  hasConflicts: boolean
  notesCount: number
  deployCommit: string | null
}

export type Link = {
  key: string
  host: string
  project: string
  iid: number
  problems: Problem[]
  arms: Arm[]
  snap: Snapshot | null
  /** Problems already reported, so each fires once per change. */
  fired: { pipelineId?: number; conflict?: boolean }
  /** Newest note time seen, for quiet comment updates. */
  noteSince: string | null
  nextCheckAt: number
  linkedAt: string
}

/** A host that is failing: one record per outage. */
export type HostHealth = {
  since: number
  kind: string
  detail: string
  failures: number
  nextTryAt: number
  hasWoken: boolean
  hasNotified: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'gitlab-link': {
      links: Shaped<Record<string, Link>>
      health: Shaped<Record<string, HostHealth>>
      pendingWake: Shaped<string[]>
      quiet: Shaped<string[]>
    }
  }
}
