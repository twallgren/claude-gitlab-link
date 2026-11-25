# gitlab-link

A Claude Code mod that links GitLab merge requests to a session, on gitlab.com or any self-hosted GitLab, and wakes the session only when something it is waiting for happens. The session never has to poll.

The mod checks GitLab itself, inside Claude Code, without spending model tokens. When a condition is met it starts one turn in the session, with every event that fired in that check batched together. Changes nobody asked about are never a reason to wake: they are attached quietly to the session's next turn and shown in a band above the prompt.

Built on Claude Code 2.1.330. Mods are a new part of Claude Code, so a later release may need an update.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install gitlab-link --marketplace twallgren/claude-gitlab-link
```

Answer `y` to add the marketplace, pick a scope (user scope loads it in every session), and set any options on the screen that follows. From a shell instead: `claude plugin install gitlab-link --marketplace twallgren/claude-gitlab-link`.

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `twallgren/claude-gitlab-link`, then Add plugin.

## Requirements

- [glab](https://gitlab.com/gitlab-org/cli) installed and logged in to each GitLab host: `glab auth login --hostname <host>`. The mod makes every call through glab, so it never holds a token.

## Use

The model gets these tools; people get `/gitlab-link <MR>` (no argument lists the links) and `/gitlab-unlink <MR>`.

An MR can be named by its URL, as `group/project!123`, or as `!123` for the session's own repository.

| Tool | What it does |
| --- | --- |
| `gitlab_link_mr` | Links an MR and returns its status. |
| `gitlab_wait_for` | Arms one condition. It wakes the session once, then disarms. If the condition is already met, the tool says so at once and nothing stays armed. |
| `gitlab_unarm` | Disarms one condition by id, every condition of one kind, or all. |
| `gitlab_unlink_mr` | Unlinks an MR. |
| `gitlab_linked_mrs` | Lists the links, their armed conditions and any outage. |

### What wakes the session

**Default problems.** These apply to every linked open MR and each fires once per change. Turn them off per MR with `problems: false` or a list, or for everything in the settings.

- The head pipeline of the latest commit failed. The wake names the failed jobs.
- A merge conflict appeared.
- The MR was closed without merging.

**Armed conditions.** Each fires once, then disarms.

| Condition | Fires when |
| --- | --- |
| `pipeline` | The head pipeline of the current commit reaches a final status. `status: failed` limits it to failures. |
| `job` | Job `job_id` finishes. |
| `comment` | Someone other than glab's user comments. `from` limits it to one person. |
| `approved` | The MR is approved. |
| `merged` | The MR is merged. |
| `conflict` | A merge conflict appears. |
| `deployed` | A deploy containing the MR's merge (or squash) commit finishes, with success, failure or cancellation. It waits for the merge first. |

An MR stays linked after it is merged while a `comment`, `deployed`, `pipeline`, `job` or `merged` condition is armed on it, and it is checked less often then. A condition that can no longer fire, such as `approved` on a closed MR, is disarmed and reported in one wake.

### Deploy targets

`deployed` takes a `target`:

- **An environment name.** For projects whose deploy jobs declare `environment:`, the target is just that name, such as `production`. It is read from GitLab's deployments API and needs no setup.
- **A named group of jobs.** For projects that don't declare environments, define the targets in the `deployTargets` setting. The target fires when any of its jobs finishes in a branch pipeline that contains the commit. `job` on the condition requires one particular job, and `notes` adds a line to the wake for a job.

```json
{
  "group/project": {
    "web": { "jobs": ["deploy:web"] },
    "workers": {
      "jobs": ["deploy:workers", "deploy:workers-and-restart"],
      "branch": "main",
      "notes": { "deploy:workers": "no restart: running workers keep the old code" }
    }
  }
}
```

### When GitLab is unreachable

- Retries back off from 1 minute up to 10, and the band shows the outage.
- Nothing is lost. Each check compares GitLab with the last state it read, so the first check after recovery catches up on everything.
- If a condition is armed, the session gets one wake after the outage has lasted an hour.
- A rejected glab login or a missing glab sends you a desktop notification instead of waking the session, since only you can fix those.
- An MR that returns 404 is unlinked.

## Settings

Set these in `/config`, or under `pluginConfigs["gitlab-link"].options` in `~/.claude/settings.json`.

| Setting | Default |
| --- | --- |
| `intervalSeconds` (open MRs) | 60 |
| `mergedIntervalSeconds` | 300 |
| `maxBackoffSeconds` | 600 |
| `outageWakeMinutes` | 60 |
| `defaultProblems` | `pipeline,conflict,closed` |
| `deployTargets` | `{}` |
| `glabPath` | `glab`; `/opt/homebrew/bin` and `/usr/local/bin` are tried too |

## What it can't do

- It is polling, not webhooks: GitLab can't reach most laptops.
- It can't add to the desktop app's built-in pull-request features, which are GitHub-only.
- It never approves, merges or runs jobs. The session does those with glab.

## License

MIT. See [LICENSE](LICENSE).
