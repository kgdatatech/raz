# Raziel (RAZ)

**A self-operating engineering team that runs on your machine.**

You point RAZ at a GitHub repo. It watches for issues and pull requests, picks the right specialist agent to handle each one, does the work in an isolated branch, opens a PR, reviews it before merging, waits for CI to pass, then merges. When its queue runs dry, it scans the codebase itself for things to fix and queues those too. The only thing you have to do is turn it on.

Built by [Keanu Gomes](https://github.com/kgdatatech) — Founder, [Archon Systems](https://buildarchon.com).

> **License:** RAZ is source-available under PolyForm Shield. You may inspect, use,
> modify, and redistribute it for permitted purposes, but you may not provide a
> competing product or service. [Commercial licenses](COMMERCIAL-LICENSE.md) are
> available from Archon Systems LLC.

---

## What it does

RAZ runs a prioritized task queue. Each task is claimed by one of five specialist agents:

| Agent | Role |
|---|---|
| **RAZ-Dev** | Features, bug fixes, refactors |
| **RAZ-QA** | Tests, coverage, pre-merge code review |
| **RAZ-Sec** | Security audits, dependency scanning |
| **RAZ-Ops** | Build health, ops reports, failure recovery |
| **RAZ-Data** | Schema migrations, data pipelines |

Every PR runs through a gate: RAZ-QA reviews it, CI must be green, then it merges. If either fails, RAZ queues a fix and retries automatically.

---

## How tasks enter the queue

**You** — type a task in the dashboard. RAZ routes it to the right agent: an instant keyword match updates the role chip as you type, then a Claude Haiku classification refines the routing once you pause (falling back to keywords if the API is unreachable).

**GitHub issues** — open an issue on GitHub and RAZ queues a task for it automatically. Labels determine which agent picks it up:

| Label | Agent | Workflow |
|---|---|---|
| `bug`, `fix`, `regression` | RAZ-Dev | fix |
| `testing`, `coverage` | RAZ-QA | test |
| `security`, `vuln`, `cve` | RAZ-Sec | audit |
| `ops`, `infra`, `ci` | RAZ-Ops | strategy |
| `data`, `db`, `migration` | RAZ-Data | feature |

**GitHub webhooks** — RAZ reacts to events in real time:

| Event | What happens |
|---|---|
| Issue opened/reopened | Syncs issue, queues role-matched task |
| PR opened | Queues RAZ-QA pre-merge review |
| PR merged | Queues RAZ-QA post-merge audit |
| Human reviewer requests changes | Queues HIGH priority RAZ-Dev fix with feedback text |
| Push to default branch | Queues RAZ-Ops health scan |

**Autonomous health scan** — when the queue empties, RAZ scans the repo for TODOs/FIXMEs, source files missing test coverage, and open issues with no task. It queues what it finds. Works on any repo layout (`src/`, monorepos) and any common language; test conventions are detected for TypeScript/JavaScript, Python, and Go. Repos with no tests at all get a single test-setup strategy task instead of per-file noise, and findings are capped per scan so large repos seed a steady trickle, not a flood.

**Agent memory** — agents save findings as they work (e.g. `bug:login-crash`, `security:exposed-key`). RAZ reads those entries and converts actionable ones into queued tasks automatically.

**Failed tasks** — if an agent fails, RAZ-Ops is auto-queued to investigate and propose a strategy.

---

## The merge pipeline

```
Task queued
  → Agent works in isolated git worktree
  → Commits + opens PR
  → RAZ-QA reviews (pre-merge gate)
    → Approved: check CI
      → CI passing: merge
      → CI pending: poll every 30s (up to 45 min, one self-rescheduling task)
      → CI failing: queue CRITICAL RAZ-Dev fix
    → Changes requested: queue HIGH priority RAZ-Dev fix
  → RAZ-QA audits post-merge
  → Next task
```

---

## Priority ordering

| Priority | When it's used |
|---|---|
| **CRITICAL** | CI failures blocking a merge |
| **HIGH** | Review feedback, failed task recovery |
| **NORMAL** | Features, health scan findings, audits |

Within the same priority tier, tasks run FIFO.

---

## Modes

- **Autonomous** — the queue runs itself. Turn it on in the dashboard config panel.
- **Standard** — you trigger each task manually. Default.

---

## Spend caps

Autonomous mode can generate its own work indefinitely, so API spend is capped in two ways:

| Cap | Default | Behavior when hit |
|---|---|---|
| **Daily** (`spend_daily_cap_usd`) | $10 | Queue stops claiming tasks until the next UTC day |
| **Per-task** (`spend_task_cap_usd`) | $2 | The running agent is aborted and the task fails with a cost-cap error (no retry strategy is queued) |

Set either cap to `0` to disable it. Caps are editable via `POST /api/config`, and current spend is reported in `GET /api/status` under `spend`. Cost is accumulated from what each runner reports per task.

---

## Model selection

The Claude model is configurable via `POST /api/config`: `agent_model` for all roles, or `agent_model_<RoleId>` per role (e.g. run RAZ-QA reviews on `claude-haiku-4-5` while RAZ-Dev builds on `claude-opus-4-8`). Applies to both the SDK runner (default `claude-sonnet-4-6`) and the Claude Code runner (`--model` is passed only when configured — otherwise your CLI's `/model` default is used). Per-task cost tracking automatically uses the selected model's pricing, so the spend caps stay accurate.

---

## Concurrency

RAZ runs up to `max_concurrent_tasks` agents in parallel (default **2**, max 8), each in its own isolated git worktree. Raise it via `POST /api/config` if your machine and budget allow — the daily spend cap still applies across all workers combined. Autonomous health scans only run when the pool is fully idle.

---

## Setup

```bash
git clone <this-repo>
cd raziel
npm install
cp .env.example .env.local
npm run dev   # http://localhost:3000
```

**Required env vars:**

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key |
| `GITHUB_TOKEN` | Fine-grained PAT with `repo`, `pull_requests`, `contents` scopes |
| `GITHUB_WEBHOOK_SECRET` | Secret for verifying GitHub webhook payloads |

**Webhook setup** — in your GitHub repo go to Settings → Webhooks → Add webhook:
- Payload URL: `https://your-host/api/webhook/github`
- Content type: `application/json`
- Secret: same value as `GITHUB_WEBHOOK_SECRET`
- Events: `Issues`, `Pull requests`, `Pull request reviews`, `Pushes`

**Optional:**

| Variable | Description |
|---|---|
| `RAZ_RUNNER` | `cc` to use the Claude Code CLI runner instead of the default SDK runner |
| `RAZ_API_TOKEN` | **Set this before exposing RAZ outside localhost** (e.g. tunneling for webhooks). Locks every route except the webhook receiver, health check, and login. Browser: enter the token once at `/login`. API: `Authorization: Bearer <token>` or `x-raz-token` header. Unset = no auth (local use). |

---

## First run

1. RAZ loads your GitHub repos on startup.
2. Select a repo. Enter its absolute local path when prompted and click **Save**.
3. Choose a role and workflow, type a task, hit **Run**.

The agent log streams in real time. When done, a PR link appears in the log header.

---

## UI panels

| Area | What it shows |
|---|---|
| **Left panel** | Repo selector, role/workflow picker, task input, run/queue controls |
| **Agent log** | Real-time event stream — thinking, tool calls, plan, completion |
| **Plan sidebar** | Slides in when an agent creates a plan |
| **History** | All tasks with status, role, workflow, PR link. Click a row for full detail. |
| **Memory** | Per-repo memory entries. Editable and deletable inline. |
| **Comms** | All inter-agent delegations and handoffs. |
| **Issues** | GitHub issues synced to local DB. Click "→ Use as task" to populate the input. |
| **Reports** | Markdown reports from RAZ-Sec and RAZ-Ops. |
| **Brain** | Live graph of repos, tasks, and memory connections — visualizes how agents are building knowledge over time. |
| **⚙ Settings** | Header popover: model per role (global + per-role dropdowns), spend caps with today's spend, max concurrent tasks with live worker count. |

---

## Agent collaboration

**Delegate** (`delegate_to_role`) — spawn a sub-agent right now and wait for the result. Sub-agents run inside the parent's worktree and cannot commit. Use when you need specialist input before completing.

**Handoff** (`handoff_to_role`) — queue follow-up work for another role after you complete. Shows as an amber card in the agent log. Click Accept to queue it.

---

## Testing standard

Every new RAZ feature ships with tests. RAZ-QA will `request_changes` on any PR that doesn't include them — the PR does not merge until tests are added.

```bash
npm test           # 460 tests, all must pass
npm run test:watch # interactive
```

---

## Security constraints

Agents run inside an isolated git worktree. SDK file tools block secret paths and
path traversal, shell commands reject chaining operators, and GitHub credentials
are removed from the Claude Code process environment. `security_scan` runs on
every changed file before a task can complete.

---

## Stack

Next.js 16 · React 19 · TypeScript strict · Tailwind v4 · SQLite (better-sqlite3) · Anthropic SDK · Octokit · Vitest

---

## License

RAZ is source-available under the [PolyForm Shield License 1.0.0](LICENSE).
The license does not permit providing a product or service that competes with
RAZ or other covered Archon Systems offerings. See [commercial licensing](COMMERCIAL-LICENSE.md),
[required notices](NOTICE), and the [trademark policy](TRADEMARKS.md).

Contributions are accepted under the [Contributor License Agreement](CLA.md).

---

<sub>© 2026 Keanu Gomes · Archon Systems LLC · [buildarchon.com](https://buildarchon.com)</sub>
