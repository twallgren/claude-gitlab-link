<img src=".claude-plugin/icon.png" alt="" width="96" align="right">

# gitlab-link

A Claude Code mod that links GitLab merge requests to a session, on gitlab.com or any self-hosted GitLab, and wakes the session for the changes you choose. The session never has to poll.

## Why

Claude Code's built-in pull-request integration is GitHub-only, and the GitLab plugin in Anthropic's directory is a set of tools the model calls when it wants data: nothing tells a session that a pipeline failed or a reviewer commented. Without that, a session waiting on an MR either polls GitLab, spending a model turn on every check, or never hears about the change.

gitlab-link checks GitLab itself, inside Claude Code, without spending model tokens. For each kind of change you choose whether it wakes the session, is added quietly to the session's next message, or is dropped. Everything one check finds arrives together, and a band above the prompt shows each link where the app draws it.

## Quick start

1. Install [glab](https://gitlab.com/gitlab-org/cli) and log in to your GitLab: `glab auth login --hostname gitlab.example.com`.
2. Install the mod (see [Install](#install)).
3. In a session, ask Claude to link an MR and wait on it, for example: *"Link !42 and wake me when its pipeline finishes."* Claude calls `gitlab_link_mr` and `gitlab_wait_for`, which answer with the MR's status:

   ```
   app!42 · opened · pipeline running · waiting: pipeline
     Add the export button https://gitlab.example.com/group/app/-/merge_requests/42
     wakes you for: comments, approvals, merged, closed without merging, reopened, merge conflict, pipeline failed
     added to your next message: pipeline succeeded
     off: nothing
     ignored users (@me is glab's user): all: @me
     once merged or closed: unlinks when no one-time wait remains, and reports nothing after that
     one-time wait a1x9k2: pipeline (since 2026-11-25T21:24:15.905Z)
   ```

4. Carry on, or leave the session idle. When the pipeline finishes, the session wakes with a turn like this. It shows in the conversation as a message from the plugin, drawn as its first line only, which is written for you. In the terminal, ctrl+o shows the rest, written for Claude. The desktop app has no way to expand it, so when one wake carries several events, it lists each of them under the first line. The full message is:

   ```
   Automatic GitLab update, not typed by you: app!42: pipeline #1234 failed (failed jobs: test:unit).

   <gitlab-mr-event>
   From the gitlab-link mod: a one-time wait fired, or something happened that is set to wake you.
   - app!42: pipeline #1234 failed (failed jobs: test:unit) https://gitlab.example.com/group/app/-/pipelines/1234
   No one-time waits remain.
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
claude plugin marketplace update claude-gitlab-link
claude plugin update gitlab-link@claude-gitlab-link
```

The first line fetches the latest version from GitHub; the second installs it. Restart the session to load the update. To remove the mod:

```bash
claude plugin uninstall gitlab-link@claude-gitlab-link
```

## Use

The model gets these tools; people get `/gitlab-link [MR]` and `/gitlab-unlink <MR>`.

An MR can be named by its URL, as `group/project!123`, or as `!123` for the session's own repository. Outside a repository, `group/project!123` uses the host in `GITLAB_HOST` when it is set (as glab does), else the one host glab is logged in to; with several hosts and no `GITLAB_HOST`, give the URL.

| Tool | What it does |
| --- | --- |
| `gitlab_link_mr` | Links an MR and returns its status and how it behaves. On a linked MR, changes its delivery, ignored users or unlinking. |
| `gitlab_wait_for` | Adds a one-time wake for one condition. It leaves your delivery choices alone. If the condition is already met, the tool says so at once. |
| `gitlab_unarm` | Removes one wait by id, every wait of one kind, or all. |
| `gitlab_unlink_mr` | Unlinks an MR. |
| `gitlab_linked_mrs` | Lists the links, how each behaves, their waits and any outage. |

To change something for one MR, ask Claude: *"don't wake me for comments on this one"*, *"wake me just once more for a comment"*, *"keep it linked after it merges"*.

### Delivery

Each kind of change has a default in the settings, used for every linked MR unless you change it for a specific one.

| Choice | What happens |
| --- | --- |
| **Always wake** (`always`) | Wakes the session each time. |
| **Quiet** (`quiet`) | Added to your next message, without waking. |
| **Off** (`off`) | Nothing. |
| **Wake once** (`once`) | For a specific MR only. Wakes for the next change (not one already there), then goes back to the earlier choice; if that was "always", it becomes "quiet". |

Whatever the choice, a one-time wait (`gitlab_wait_for`) wakes you once when its condition is met.

| Event | Default |
| --- | --- |
| `comment`: a new comment | always |
| `approved`: someone approves | always |
| `merged` | always |
| `closed`: closed without merging | always |
| `reopened` | always |
| `conflict`: a merge conflict appears | always |
| `pipeline_failed`: the head pipeline fails (the wake names the failed jobs) | always |
| `pipeline_succeeded`: the head pipeline succeeds | quiet |

A pipeline's other status changes, such as starting to run, are added quietly unless both pipeline events are off. What is already true when an MR is linked, such as a pipeline that has already failed, shows in its status but is not delivered.

### Ignored users

The `ignoredUsers` setting says whose changes you don't want to hear about. `@me` is the account glab uses, and the default is `{"all":["@me"]}`: your own comments and actions are left out.

```json
{
  "all": ["@me"],
  "comment": ["renovate-bot"],
  "merged": ["release-bot"]
}
```

The keys are `all`, `comment`, `approved`, `merged`, `closed` and `reopened`. A user is ignored for an event when listed under `all` or under that event. A specific MR can have its own lists; each replaces the default list under the same key. To hear when you merge but not your own comments, use `{"all":[],"comment":["@me"]}`.

- An ignored change neither wakes you nor is added quietly. Pipelines and conflicts are never ignored, even when your push caused them.
- A one-time wait for a state (`merged`, `approved`, `closed`, `reopened`) fires whoever did it. A `comment` wait skips ignored users unless it names one with `from`.
- If GitLab doesn't say who made a change, it is delivered.
- If you and your session share one account, GitLab can't tell you apart.

### One-time waits

| Condition | Fires when |
| --- | --- |
| `pipeline` | The head pipeline of the current commit reaches a final status. `status: failed` or `success` limits it to that result, and the wait ends quietly on another. |
| `job` | Job `job_id` finishes. |
| `comment` | Someone not ignored comments. `from` limits it to one person. |
| `approved` | The MR is approved by at least one person (and by enough people where approvals are required). |
| `merged` | The MR is merged. |
| `closed` | The MR is closed without merging. |
| `reopened` | A closed MR is reopened. |
| `conflict` | A merge conflict appears. |
| `deployed` | A deploy containing the MR's merge (or squash) commit finishes, with success, failure or cancellation. It waits for the merge first. A success wins over an earlier failure. A failure waits while a newer deploy is running, and once reported isn't reported again: add the wait again for the retry. |

A wait that can no longer fire, such as `approved` on a closed MR, is removed and reported in one wake. So is a wait GitLab refuses to answer, such as a job id that doesn't exist or deployments glab's user may not read; the host's other checks carry on.

### After a merge or close

With **Unlink after merge or close** on (the default), a merged or closed MR is unlinked once no one-time wait remains, even if events are set to "always", and nothing later on it is reported. So "always" for `reopened`, or for comments after a merge, needs a wait or this setting off. With it off, the MR stays linked until you unlink it. You can change it for a specific MR before it is unlinked, or link the MR again with it off.

If its comments or approvals can't be read just then, it stays linked for a few more checks, then says what it couldn't read.

A merged or closed MR that stays linked is checked less often, except while `deployed` is waiting. A reopening can therefore take that long to show.

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
- If a one-time wait is pending, the session gets one wake once the outage has lasted an hour.
- A rejected glab login or a missing glab sends you a desktop notification instead of waking the session, since only you can fix those.
- An outage is a host that stops answering. When one MR's checks fail while the host still answers, only that MR is retried less often, it shows `checks failing`, and a session with a one-time wait on it is woken once if that lasts an hour.
- An MR that returns 404 is unlinked, once a second request confirms glab's login still works. One that returns 403 stays linked and the session is told once.

## Upgrading from 0.3

The `defaultProblems` setting is gone: set the delivery of `pipeline_failed`, `conflict` and `closed` instead. Comments, approvals, merges and reopening now wake the session by default, and your own are ignored. An MR linked earlier keeps any problem wake you had turned off for it as quiet.

## Settings

Set these in `/config`, or under `pluginConfigs["gitlab-link"].options` in `~/.claude/settings.json`.

| Setting | Default | What it sets |
| --- | --- | --- |
| `intervalSeconds` | 60 | Seconds between checks of a linked open MR. |
| `mergedIntervalSeconds` | 300 | Seconds between checks of a merged or closed MR that is still linked and has no `deployed` wait. |
| `maxBackoffSeconds` | 600 | The longest wait between retries while GitLab is unreachable. |
| `outageWakeMinutes` | 60 | How long an outage lasts before the one wake (only while a one-time wait is pending). |
| `deliveryComment`, `deliveryApproved`, `deliveryMerged`, `deliveryClosed`, `deliveryReopened`, `deliveryConflict`, `deliveryPipelineFailed` | `always` | Default [delivery](#delivery) of each event: `always`, `quiet` or `off`. |
| `deliveryPipelineSucceeded` | `quiet` | The same, for a successful pipeline. |
| `ignoredUsers` | `{"all":["@me"]}` | Whose changes to [ignore](#ignored-users). |
| `unlinkWhenDone` | `true` | [Unlink after merge or close](#after-a-merge-or-close). |
| `deployTargets` | `{}` | Named deploy targets per project, as JSON (see above). |
| `glabPath` | `glab` | The glab executable. Left as `glab`, `/opt/homebrew/bin` and `/usr/local/bin` are tried too. |

## Troubleshooting

If glab is missing or not logged in, linking and arming are refused with the steps to fix it, and nothing is left linked. Claude passes those steps on, and can offer to install glab. Logging in is yours to do, because it uses your token. If a login fails later, for example because a token expired, checks pause without waking the session. The band shows the fix command, and Claude is told on its next turn.

- **glab not found.** The desktop app often starts without your shell's `PATH`. Install glab (`brew install glab` on macOS), or set `glabPath` to its full path (`which glab`).
- **Not logged in, or login rejected.** Run `glab auth login --hostname <host>`, then `glab auth status`. For a host with a port, keep the port: `glab auth login --hostname gitlab.example.com:8443`.
- **A link never updates.** Ask for `gitlab_linked_mrs` or run `/gitlab-link`. Its last line shows how many times the mod has loaded in this session, when it last ran a check, and its last error. An outage is listed with its cause, and the band above the prompt shows it too.
- **The MR can't be found.** glab's user needs access to the project. An MR that returns 404 is unlinked.

## Privacy and cost

- The mod talks only to your GitLab hosts, through glab, with glab's own login. It holds no token and sends nothing anywhere else.
- Checking costs no model tokens. Each wake is one model turn, billed like any other, so a busy MR with the default settings can add up. Set noisy events to quiet.
- Each linked open MR costs an extra request per check to read its approvals, unless approvals are off.
- Comments wake the session by default, and their text goes into its context, in a wake or quietly on the next turn. It is kept to one line and marked as the commenter's words, not an instruction from you. Anyone who can comment on a linked MR can therefore wake your session and put text in its context. On a public project, consider setting comments to quiet or off.
- Each session's links, their choices and their waits are saved in Claude Code's local plugin store, so they survive a restart of the plugin or the session, and are pruned 14 days after a session last saved them.

## Compatibility

Tested live against a self-hosted GitLab and gitlab.com. On gitlab.com, `deployed` has been tested live with environment targets. Merged-results and merge-train pipelines are covered by tests only. Reports are welcome.

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
- It runs only while the session's Claude Code process does. The desktop app stops idle sessions' processes when too many are open or memory is short, and while one is stopped nothing checks GitLab and nothing can wake it. Links and waits are saved, so the first check after the session resumes (when you or another session send it a message) catches up on everything that happened meanwhile.
- It can't add to the desktop app's built-in pull-request features, which are GitHub-only.
- It never approves, merges or runs jobs. The session does those with glab.

## License

MIT. See [LICENSE](LICENSE).
