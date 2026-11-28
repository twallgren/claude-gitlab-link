/** A kind of change whose delivery can be chosen. */
export type EventName =
  | 'comment'
  | 'approved'
  | 'merged'
  | 'closed'
  | 'reopened'
  | 'conflict'
  | 'pipeline_failed'
  | 'pipeline_succeeded'

/** always: wake each time. quiet: add to the next message. off: say nothing. */
export type DeliveryChoice = 'always' | 'quiet' | 'off'

export type IgnoreKey = 'all' | 'comment' | 'approved' | 'merged' | 'closed' | 'reopened'
export type IgnoredUsers = Partial<Record<IgnoreKey, string[]>>

/** A condition a session arms; each fires once, then disarms. */
export type ArmKind =
  | 'pipeline'
  | 'job'
  | 'comment'
  | 'approved'
  | 'merged'
  | 'closed'
  | 'reopened'
  | 'conflict'
  | 'deployed'

export type Arm = {
  id: string
  kind: ArmKind
  armedAt: string
  /** pipeline: fire on any final status, or on failed or success only. */
  status?: 'any' | 'failed' | 'success'
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
  /** Linked while GitLab was still working out mergeability: hasConflicts is not known yet. */
  isConflictUnknown?: boolean
  deployCommit: string | null
  /** Who has approved; absent until the approvals have been read. */
  approvedBy?: string[]
}

export type Link = {
  key: string
  host: string
  project: string
  iid: number
  /** Only on links saved before 0.4.0: the default problem wakes then on. */
  problems?: string[]
  /** This link's own choices over the defaults. */
  delivery?: Partial<Record<EventName, DeliveryChoice>>
  /** Events whose next change wakes once, whatever the choice under it. */
  once?: Partial<Record<EventName, true>>
  /** Reads that failed and are to be tried again. */
  owes?: {
    /** No list of approvers was read when one was due: the next is told quietly. */
    approvals?: boolean
    /** A reopening whose author is still to be read: the tries so far. */
    reopen?: number
    /** A wait reported that reopening: the retry must not repeat it. */
    isReopenTold?: boolean
  }
  /** Checks for which a finished MR has stayed linked to retry a failed read. */
  held?: number
  /** This link's own ignored users; a key here replaces the default's list. */
  ignored?: IgnoredUsers
  unlinkWhenDone?: boolean
  arms: Arm[]
  snap: Snapshot | null
  /** Problems already reported, so each fires once per change. */
  fired: { pipelineId?: number; conflict?: boolean }
  /** Newest note time seen, for quiet comment updates. */
  noteSince: string | null
  nextCheckAt: number
  linkedAt: string
  /** The last check was refused with 403, and the session has been told. */
  isForbidden?: boolean
  /** Failed deploys already reported, so re-arming waits for the next one. */
  reportedDeploys?: string[]
  /** Set while this MR's checks fail although its host answers. */
  failing?: { since: number; count: number; isTold: boolean }
  /** The first read of the notes failed: older comments are not news when one succeeds. */
  isNotesUnread?: boolean
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
      /** Per MR key; kept when the link goes, so a later wait still knows. */
      reportedDeploys: Shaped<Record<string, string[]>>
    }
  }
}
