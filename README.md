# gitlab-link

A Claude Code mod that links GitLab merge requests to a session, on gitlab.com or any self-hosted GitLab, and wakes the session only when something it is waiting for happens. The session never has to poll.

## Why

Claude Code's built-in pull-request integration is GitHub-only, and the GitLab plugin in Anthropic's directory is a set of tools the model calls when it wants data: nothing tells a session that a pipeline failed or a reviewer commented. Without that, a session waiting on an MR either polls GitLab, spending a model turn on every check, or never hears about the change.

gitlab-link checks GitLab itself, inside Claude Code, without spending model tokens. When a condition the session armed is met, or a linked MR hits a blocking problem, the mod starts one turn in the session, with every event from that check batched together. Changes nobody asked about never wake the session: they are attached quietly to its next turn and shown in a band above the prompt.

## Quick start

1. Install [glab](https://gitlab.com/gitlab-org/cli) and log in to your GitLab: `glab auth login --hostname gitlab.example.com`.
2. Install the mod (see [Install](#install)).
3. In a session, ask Claude to link an MR and wait on it, for example: *"Link !42 and wake me when its pipeline finishes."* Claude calls `gitlab_link_mr` and `gitlab_wait_for`, which answer with the MR's status:

   ```
   app!42 · opened · pipeline running · waiting: pipeline
     Add the export button https://gitlab.example.com/group/app/-/merge_requests/42
     default wakes: pipeline, conflict, closed
     armed a1x9k2: pipeline (since 2026-11-25T21:24:15.905Z)
   ```

4. Carry on, or leave the session idle. When the pipeline finishes, the session wakes with a turn like this:

   ```
   <gitlab-mr-event>
   From the gitlab-link mod: a condition you armed fired, or a linked MR hit a blocking problem.
   - app!42: pipeline #1234 failed (failed jobs: test:unit) https://gitlab.example.com/group/app/-/pipelines/1234
   Nothing else is armed.
   </gitlab-mr-event>
   ```

You can also link from the prompt yourself: `/gitlab-link <MR>` links one, and `/gitlab-link` with no argument lists the links.

## Install

Requires [glab](https://gitlab.com/gitlab-org/cli), installed and logged in to each GitLab host you use. Built and tested on Claude Code 2.1.330. Mods are a new part of Claude Code, so a later release may need an update.

At the prompt of a Claude Code terminal session:

```
/plugin install gitlab-link --marketplace twallgren/claude-gitlab-link
```

Answer `y` to add the marketplace, pick a scope (user scope loads the mod in every session), and set any options on the screen that follows. From a shell instead:

```bash
claude plugin install gitlab-link --marketplace twallgren/claude-gitlab-link
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `twallgren/claude-gitlab-link`, then **Add plugin**.

### Update and uninstall

```bash
claude plugin update gitlab-link@claude-gitlab-link
```

Restart the session to load the update. To remove the mod:

```bash
claude plugin uninstall gitlab-link@claude-gitlab-link
```

## Use

The model gets these tools; people get `/gitlab-link [MR]` and `/gitlab-unlink <MR>`.

An MR can be named by its URL, as `group/project!123`, or as `!123` for the session's own repository. Without a repository, `group/project!123` uses the one host glab is logged in to; with several hosts, give the URL.

| Tool | What it does |
| --- | --- |
| `gitlab_link_mr` | Links an MR and returns its status. |
| `gitlab_wait_for` | Arms one condition. It wakes the session once, then disarms. If the condition is already met, the tool says so at once and nothing stays armed. |
| `gitlab_unarm` | Disarms one condition by id, every condition of one kind, or all. |
| `gitlab_unlink_mr` | Unlinks an MR. |
| `gitlab_linked_mrs` | Lists the links, their armed conditions and any outage. |

### What wakes the session

**Default problems.** These apply to every linked open MR, and each fires once per change. Turn them off per MR with `problems: false` or a list, or for every MR in the settings.

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
- If a condition is armed, the session gets one wake once the outage has lasted an hour.
- A rejected glab login or a missing glab sends you a desktop notification instead of waking the session, since only you can fix those.
- An MR that returns 404 is unlinked.

## Settings

Set these in `/config`, or under `pluginConfigs["gitlab-link"].options` in `~/.claude/settings.json`.

| Setting | Default | What it sets |
| --- | --- | --- |
| `intervalSeconds` | 60 | Seconds between checks of a linked open MR. |
| `mergedIntervalSeconds` | 300 | Seconds between checks of a merged or closed MR that still has something armed. |
| `maxBackoffSeconds` | 600 | The longest wait between retries while GitLab is unreachable. |
| `outageWakeMinutes` | 60 | How long an outage lasts before the one wake (only while something is armed). |
| `defaultProblems` | `pipeline,conflict,closed` | The default problem wakes; empty for none. |
| `deployTargets` | `{}` | Named deploy targets per project, as JSON (see above). |
| `glabPath` | `glab` | The glab executable. Left as `glab`, `/opt/homebrew/bin` and `/usr/local/bin` are tried too. |

## Troubleshooting

- **"glab could not be started", or a notification about it.** The desktop app often starts without your shell's `PATH`. Set `glabPath` to glab's full path (`which glab`).
- **Login rejected.** Run `glab auth status`. For a host with a port, log in with the port included: `glab auth login --hostname gitlab.example.com:8443`.
- **A link never updates.** Ask for `gitlab_linked_mrs` or run `/gitlab-link`: an outage is listed with its cause, and the band above the prompt shows it too.
- **The MR can't be found.** glab's user needs access to the project. An MR that returns 404 is unlinked.

## Privacy and cost

- The mod talks only to your GitLab hosts, through glab, with glab's own login. It holds no token and sends nothing anywhere else.
- Checking costs no model tokens. Each wake is one model turn, billed like any other.
- Comment text from an MR goes into the session's context when a comment wait fires, or quietly on the next turn.

## Compatibility

Tested against a self-hosted GitLab. gitlab.com and the environment-based deploy targets have not yet been tested against a live server. Reports are welcome.

## Developing

```bash
git clone https://github.com/twallgren/claude-gitlab-link
cd claude-gitlab-link
claude --plugin-dir .            # run a session with the mod loaded from this folder
claude plugin validate .         # check the manifest and hooks module
claude plugin test .             # run tests/ (GitLab is faked; no network)
```

The hooks module is `hooks/register.tsx`, which wires the events. The checking loop is in `hooks/runtime.ts`, one MR's check in `hooks/check.ts`, and the GitLab calls in `hooks/glab.ts`.

## Issues and contributing

Bug reports and pull requests are welcome at [github.com/twallgren/claude-gitlab-link/issues](https://github.com/twallgren/claude-gitlab-link/issues). Please include your Claude Code version (`claude --version`) and whether your GitLab is gitlab.com or self-hosted.

## What it can't do

- It polls rather than using webhooks, because GitLab can't reach most laptops.
- It can't add to the desktop app's built-in pull-request features, which are GitHub-only.
- It never approves, merges or runs jobs. The session does those with glab.

## License

MIT. See [LICENSE](LICENSE).
