# RAZ — Agentic Coding Framework

RAZ is Archon Systems' internal AI coding agent framework. It connects Claude to your GitHub repositories, runs as a local Next.js app, and gives the team a UI to dispatch autonomous coding tasks — feature builds, bug fixes, security audits, QA, migrations, and ops assessments — each producing a real git branch and pull request.

## How it works

1. Select a GitHub repository from the dropdown (synced from your token).
2. Set the local path where that repo is cloned on the machine running RAZ.
3. Choose an agent role and workflow type.
4. Describe the task in plain language and hit **Run**.

RAZ creates a git worktree, runs the agent loop (plan → explore → implement → verify → complete), commits the result, and opens a pull request — all visible in real time through the agent log.

Tasks and per-repo memory persist in a local SQLite database (`.raziel/raziel.db`). If a task is interrupted, resume picks up from the last saved checkpoint without re-spending API cost.

---

## Agent Roles

| Role | Badge | Purpose |
|------|-------|---------|
| RAZ-Dev  | `DEV`  | Full-stack feature development, bug fixes, refactors |
| RAZ-Sec  | `SEC`  | Read-only security audit — OWASP Top 10, secrets, CVEs |
| RAZ-QA   | `QA`   | Test writing, coverage analysis |
| RAZ-Ops  | `OPS`  | Build health, environment config, CI/CD assessment |
| RAZ-Data | `DATA` | Database migrations, schema validation |

Each role has a defined tool allowlist, mandatory gates (e.g. RAZ-Dev must run `run_build` and `security_scan` before completing), and a role-specific system prompt. All roles read `AGENTS.md` as their mandatory first step before touching any code.

---

## Agent-to-Agent Communication

Roles can collaborate autonomously in two ways:

### Delegation
A role can delegate a sub-task to another role inline using `delegate_to_role`. The sub-agent:
- Runs inside the parent's worktree (sees in-progress changes)
- Streams its log with a `[SubRole]` prefix, visually indented
- Does **not** commit — the parent owns the final commit
- Is capped at 20 iterations

Example: RAZ-Dev delegates a security review to RAZ-Sec mid-feature, gets a report back, then continues implementation.

### Handoffs
When a task completes, the agent can propose handing off follow-up work to a peer role using `handoff_to_role`. The handoff:
- Surfaces as an amber **suggestion card** inline in the agent log — it does **not** auto-run
- Shows the suggested role, workflow, and description of the next task
- You click **Accept** to queue and run it, or **Dismiss** to drop it

All inter-agent communication is logged to the database and visible in the **Comms** tab.

---

## Prerequisites

- **Node.js 18+**
- **Git** available in `PATH`
- An **Anthropic API key** (Claude Sonnet 4.x or later)
- A **GitHub Personal Access Token** with `repo`, `read:org`, and `workflow` scopes
- The target repositories cloned locally on the machine running RAZ

> **Windows + WSL:** RAZ detects WSL paths (`\\wsl.localhost\...`) automatically and routes commands through the correct distro.

---

## Setup

```bash
git clone <this-repo>
cd raz-agent
npm install
cp .env.example .env.local
```

Edit `.env.local` and fill in both values:

```
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=ghp_...
```

Start the development server:

```bash
npm run dev
```

Open `http://localhost:3000` in your browser.

---

## First run

1. The repository list loads from GitHub automatically on startup.
2. Select a repo. If it has no local path saved, a path input appears — enter the absolute path to the local clone and click **Save**.
3. Choose a role (DEV by default) and workflow.
4. Type a task description and click **Run [role]**.

The agent log streams in real time. When the task completes, a pull request link appears in the log header.

---

## Task queue

Click **+Q** instead of **Run** to queue a task. Queued tasks run automatically in sequence after the current task finishes. Handoff-accepted tasks also enter the queue if an agent is currently running.

---

## UI layout

The dashboard has three main areas:

- **Left panel** — repo selector, role/workflow picker, task input, run/queue controls
- **Agent log** — real-time event stream (thinking, tool calls, plan, completion). Handoff suggestion cards appear inline here when proposed. Click any plan event to open the plan sidebar.
- **Plan sidebar** — slides in from the right when an agent creates a plan. Close with ✕ or reopen via the `⊞ Plan` tab on the right edge.
- **Bottom panel** — five tabs:

| Tab | What it shows |
|-----|--------------|
| **History** | All tasks — status, role, workflow, files changed count, child task indicator. Click any row to open the task detail modal. |
| **Memory** | Per-repo memory entries saved by the agent. Editable and deletable inline. |
| **Comms** | All inter-agent messages — delegations and handoffs — with from/to role, type badge, and result summary. |
| **Issues** | GitHub issues synced to the local DB. Filter open/closed, sync from GitHub, or click "→ Use as task" to populate the task input. |
| **Reports** | Markdown audit/ops reports generated by RAZ-Sec and RAZ-Ops. Click any report to open a full-screen viewer with download. |

---

## Task detail modal

Clicking a history row opens the detail modal showing:

- Status, role, workflow, linked issue number
- Pull request link with live CI status, review decision, and merged state
- Agent summary in markdown
- Files changed (full list)
- Error text for failed tasks
- Agent plan
- Parent task reference for delegated sub-tasks

Failed tasks show a **↺ Retry** button to resume from the last checkpoint.

---

## Memory and self-improvement

RAZ is designed to get cheaper and faster over time through a growing memory system:

- **Per-task log persistence** — every agent run saves its full event log (thinking, tool calls, plan, completion) to the database. `tool_result` entries are truncated to keep storage lean while preserving the reasoning trail.
- **Structured memory** — agents are instructed to call `save_memory` after every significant file read or finding, using typed keys (`file:<path>`, `finding:<slug>`, `fix:<slug>`, `pattern:<name>`). This builds a reusable knowledge base per repo.
- **Context injection** — every new task starts with the repo's full memory and the last 10 task summaries injected into the system prompt. Agents are told to check memory before re-reading files — if memory already covers a file, the read is skipped entirely, saving input tokens.

Memory is visible and editable in the **Memory** tab. You can delete or correct individual entries at any time.

---

## Checkpoint / resume

Every agent iteration is checkpointed to the database. If a task fails or is interrupted, click **↺ Retry** in the task history to resume from the last saved state. The agent picks up where it left off without repeating completed steps.

---

## Security constraints

The agent runs inside a git worktree isolated from the main branch. It cannot:

- Read, write, or log `.env` files or any secret files
- Run destructive commands (`rm -rf`, `git reset --hard`, `DROP TABLE`, `DELETE` without `WHERE`)
- Make outbound HTTP requests from tools
- Escape the worktree path

`security_scan` runs on every changed file before a task can complete. If secrets are detected, the agent is blocked from calling `task_complete`.

---

## Project structure

```
app/
  api/
    agent/      — SSE stream endpoint; runs the agent loop, buffers and saves log_json
    repos/      — GitHub repo sync + local path management
    issues/     — GitHub issue sync and retrieval
    tasks/      — Task CRUD
    memory/     — Per-repo memory CRUD
    messages/   — Agent message log (delegations + handoffs)
    pr-status/  — Latest PR CI/review state for a task
    reports/    — List and read .raziel/reports/*.md files
  page.tsx      — Main dashboard UI
  layout.tsx    — Root layout with fonts
lib/
  agent.ts      — Core agent loop, worktree management, sub-agent closures, system prompt
  tools.ts      — Tool definitions and execution (filesystem, bash, git, GitHub, delegation)
  roles.ts      — Role definitions, tool allowlists, system contexts
  db.ts         — SQLite schema and all DB operations (better-sqlite3)
scripts/
  fix-stuck.js  — Manually reset a stuck running task in the DB
  read-last.js  — Print the last N log lines for a task
.raziel/
  raziel.db     — Local SQLite database (git-ignored)
  reports/      — Markdown reports generated by RAZ-Sec and RAZ-Ops
```

---

## Customizing roles

Edit `lib/roles.ts` to change role names, badge colors, tool allowlists, or system prompt context. The `systemContext` field is injected verbatim into the agent's system prompt for that role.

To add a new role, extend the `ROLE_IDS` array and add a matching entry to the `ROLES` record.

---

## AGENTS.md convention

RAZ reads `AGENTS.md` (and `CLAUDE.md` → `@AGENTS.md`) from each target repository before starting work. Use this file to document project-specific conventions, framework versions, and rules the agent must follow. All roles are instructed to read this file as their mandatory first step.

Example `AGENTS.md` for a target repo:

```md
# Project conventions

- Uses Next.js 15 App Router — not Pages Router
- Database: Supabase (Postgres). Migrations live in supabase/migrations/
- Do not use `any` in TypeScript
- All API routes must validate input with zod
```

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `GITHUB_TOKEN` | Yes | GitHub PAT for repo/issue access and PR creation |

---

## License

MIT
