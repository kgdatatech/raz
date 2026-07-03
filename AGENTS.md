<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

---

# Raziel (RAZ) — Agent Reference

Raziel is an Archon Systems internal multi-agent coding framework. It runs locally. Agents operate in isolated git worktrees, communicate through SQLite and MCP, and produce PRs.

---

## Stack & Versions

| Component | Version | Notes |
|-----------|---------|-------|
| Next.js | 16.2.9 | ⚠ BREAKING — non-standard; read docs in `node_modules/next/dist/docs/` |
| React | 19.2.4 | |
| TypeScript | ^5 | strict mode, `noUncheckedIndexedAccess` OFF |
| Tailwind CSS | ^4 | ⚠ BREAKING — CSS-first config, no `tailwind.config.js`. Use `@theme` in CSS |
| Zod | ^4.4.3 | ⚠ BREAKING — v3 patterns (`.parse`, `.safeParse`) still work but some APIs changed |
| better-sqlite3 | ^12.11.1 | Local SQLite, WAL mode, FK enforcement on |
| @anthropic-ai/sdk | ^0.104.2 | |
| @modelcontextprotocol/sdk | ^1.29.0 | |
| @octokit/rest | ^22.0.1 | |
| vitest | ^3.0.0 | Test runner |
| eslint | ^9.0.0 | Flat config (`eslint.config.mjs`) |

---

## Key Commands

```bash
npm run dev            # Start dev server (localhost:3000)
npm run build          # Production build — always uses cross-env NODE_ENV=production
npm test               # vitest run --passWithNoTests
npm run test:watch     # vitest (interactive)
npm run test:coverage  # vitest run --coverage
npm run lint           # eslint .
```

> **Build note:** The build script is `cross-env NODE_ENV=production next build`. Do NOT run `next build` directly — if `NODE_ENV=development` is inherited, the Next.js prerender workers crash with a React `useContext` error on `/_global-error`.

---

## Project Structure

```
raziel/
├── app/
│   ├── page.tsx              # Main UI — sidebar, task input, agent log, history
│   ├── layout.tsx
│   ├── global-error.tsx      # Standalone Next.js error boundary (no font context)
│   └── api/
│       ├── agent/route.ts    # POST — runs an agent task, SSE stream
│       ├── repos/route.ts    # GET/PATCH/POST — repo list and registration
│       ├── tasks/route.ts    # GET/DELETE — task history
│       ├── tasks/[id]/log/   # GET — stored agent log for a task
│       ├── reports/route.ts  # GET — list/read .raziel/reports/ files
│       ├── queue/route.ts    # GET/POST — task queue
│       └── config/route.ts   # GET/POST — system_config table
├── lib/
│   ├── agent.ts              # Thin router shim — dispatches to agent-cc or agent-sdk
│   ├── agent-cc.ts           # Claude Code CLI runner (RAZ_RUNNER=cc)
│   ├── agent-sdk.ts          # Anthropic SDK runner (default)
│   ├── mcp-server.ts         # MCP server started by agent-cc subprocess
│   ├── db.ts                 # SQLite schema + all DB helpers (migrations v1–v10)
│   ├── roles.ts              # 5 role definitions, tool allowlists, system prompts
│   ├── tools.ts              # Tool implementations (read_file, write_file, etc.)
│   ├── dispatch.ts           # Smart intent detection (detectIntent)
│   └── github.ts             # pushBranchAndOpenPR
├── .raziel/
│   ├── raziel.db             # SQLite database (WAL mode)
│   └── reports/              # Agent-generated markdown reports
├── vitest.config.ts
├── eslint.config.mjs
└── .env.example
```

---

## Database & Migrations

- **File:** `lib/db.ts`
- **Current schema version:** 18 (stored in `PRAGMA user_version`)
- **Migration pattern:** `if (VERSION < N) { db.exec(...); db.exec('PRAGMA user_version = N') }`
- **WAL mode + FK enforcement:** Set on startup
- **Startup safety:** Tasks stuck in `running` are auto-failed on server restart

**Task statuses:** `running` | `queued` | `pending` | `complete` | `failed`
- `pending` — handoff task created but waiting for parent's PR to merge before it can start.
  `activateHandoffs(parentTaskId)` flips it to `queued` after merge.
  The queue runner only picks up `queued` tasks, never `pending`.

Adding a migration:
```ts
if (VERSION < 11) {
  db.exec(`ALTER TABLE tasks ADD COLUMN new_col TEXT`)
  db.exec('PRAGMA user_version = 11')
}
```

Always wrap `ALTER TABLE` in try/catch — SQLite has no `ADD COLUMN IF NOT EXISTS`.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `GITHUB_TOKEN` | Yes | Fine-grained PAT — needs `repo`, `pull_requests`, `contents` |
| `RAZ_DB_PATH` | No | Override SQLite path (default: `.raziel/raziel.db`) |
| `NEXT_PUBLIC_RAZ_RUNNER` | No | Set to `cc` to use the Claude Code CLI runner |
| `RAZ_API_TOKEN` | No | When set, `proxy.ts` requires this token on every route except `/api/webhook/github`, `/api/health`, and the `/login` flow. Send via `Authorization: Bearer`, `x-raz-token`, or the `raz_token` cookie set by `/login`. Unset = auth disabled (local use). |

Copy `.env.example` → `.env.local` to get started.

**Model selection** (`lib/models.ts`, `system_config`): `agent_model` sets the SDK runner's model for all roles; `agent_model_<RoleId>` (e.g. `agent_model_RAZ-QA`) overrides per role. Resolution: role override → global → default `claude-sonnet-4-6`. Supported IDs and pricing live in `SUPPORTED_MODELS`; invalid values are ignored, and per-task cost is computed from the resolved model's pricing. Editable via `POST /api/config`. The Claude Code and Codex runners use their own CLI defaults — this applies to the SDK runner only.

**Concurrency** (`system_config` key `max_concurrent_tasks`, default 2, clamped 1–8): the queue runner fills a pool of up to N tasks per 5 s tick, each in its own git worktree. Health-scan seeding only happens when the pool is fully idle. Editable via `POST /api/config`; live pool state is in `GET /api/status` under `runner`.

**Spend caps** (`lib/spend.ts`, stored in `system_config`): `spend_daily_cap_usd` (default 10) stops the queue runner from claiming tasks for the rest of the UTC day once cumulative reported cost reaches it; `spend_task_cap_usd` (default 2) aborts a running agent whose reported cost crosses it (fails the task, no failure-strategy queued). A value of `0` disables that cap. Both are editable via `POST /api/config`; current state is in `GET /api/status` under `spend`.

---

## Agent Roles

| Role | Badge | Color | Can Write | Extra Gates | Description |
|------|-------|-------|-----------|-------------|-------------|
| RAZ-Dev | DEV | indigo | Yes | — | Features, bug fixes, refactors |
| RAZ-Sec | SEC | red | No | `generate_report` | Security audits, read-only |
| RAZ-QA | QA | green | Yes (tests only) | `run_tests`, `check_coverage` | Tests, coverage |
| RAZ-Ops | OPS | amber | No | `generate_report` | Build health, ops reports |
| RAZ-Data | DATA | purple | Yes (schema only) | `validate_migration` | DB migrations |

**RAZ-Dev and RAZ-Data** must call `security_scan` before `task_complete`.
**RAZ-Dev** must call `run_build` before `task_complete` (except `strategy` and `audit` workflows).

---

## Workflows

| Workflow | Typical Role | When to use |
|----------|-------------|-------------|
| `feature` | RAZ-Dev | New functionality |
| `fix` | RAZ-Dev | Bug fixes |
| `refactor` | RAZ-Dev | Code cleanup, no behavior change |
| `review` | RAZ-QA | **Pre-merge gate** — approve or request changes before a PR merges. Auto-queued by the system after every PR opens. Post a clear verdict via `post_pr_review`. |
| `audit` | RAZ-Sec, RAZ-Ops, RAZ-QA | Post-merge deeper analysis. PR already merged. Use `comment` verdict. |
| `test` | RAZ-QA | Writing or improving tests |
| `strategy` | RAZ-Ops | Planning, research, no code changes |
| `self` | RAZ-Dev, RAZ-Ops | Improving the RAZ system itself |

---

## Blocked Paths (read_file / write_file both blocked)

`.env`, `.env.local`, `.env.production`, `.env.development`, `.env.staging`, `.env.test`, `secrets`, `.secret`, `.secrets`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`

---

## Agent Collaboration

- `delegate_to_role` — spawn a sub-agent **right now** and wait for the result (synchronous). Budget: 8 turns. Use only when you need specialist input before completing. Prefer `handoff_to_role` when the work is sequential.
- `handoff_to_role` — queue a follow-up task for another role **after** you complete (async). This is the standard post-completion flow.

Sub-agents share the same worktree as the parent and cannot commit — the parent owns the commit.

## PR Review Tools (RAZ-QA, RAZ-Sec, RAZ-Ops)

- `list_open_prs` — list open PRs in the repo
- `get_pr_summary` — metadata + file list + CI status (no diff, ~1.5KB). **Always call this first.**
- `get_pr_file_diff(pr_number, filename)` — diff for a single file (capped 8KB). Call per-file after seeing the summary.
- `post_pr_review(pr_number, body, verdict)` — post a GitHub review. Verdict: `approve` / `comment` / `request_changes`.

**Code review pattern:** `get_pr_summary` → `get_pr_file_diff` per relevant file → `post_pr_review` → `generate_report`

## Context Efficiency Rules

These rules keep token usage low. Violating them wastes budget and degrades multi-agent performance.

- **read_file is capped at 6KB.** For large files, use `search_codebase` to locate specific sections before reading.
- **You have 20 turns (sub-agents: 8 turns).** At turn 15 (sub-agents: turn 6), wrap up. If work is complete, call `security_scan` then `task_complete`.
- **Memory values are capped at 400 chars.** Save specific findings, not paragraphs. Keys should be descriptive: `auth:session-token-storage` not `notes`.
- **Don't read files you won't use.** Plan first (`create_plan`), then read only the files the plan identifies as relevant.

---

## Testing Standard

**Every new feature shipped to RAZ must include tests.** This is non-negotiable — it is part of what "done" means.

### What to test

| Feature type | What to cover |
|---|---|
| New DB helper | Value caps, FK cleanup, edge cases (empty, boundary, staleness) — use in-memory SQLite (`:memory:`) |
| New queue routing logic | Each routing branch (all `if/else` arms), export the handler so it can be unit-tested via `vi.mock` |
| New tool (tools.ts) | Schema completeness: name, description, `input_schema.type`, `required` fields — add to `tools-schema.test.ts` |
| New role permission | Allowed tools present, write-only tools blocked for read-only roles — add to `roles.test.ts` |
| New pure function | All branches covered, edge cases (empty input, max boundary, no-op path) |

### Rules

- Tests live in `lib/__tests__/` (or `app/api/<route>/__tests__/` for route handlers).
- Use `vi.hoisted(() => { process.env['RAZ_DB_PATH'] = ':memory:' })` at the top of any test that touches the DB.
- Never hit real GitHub API, real filesystem, or real Anthropic API in tests — mock with `vi.mock`.
- Every `describe` block that touches the DB must have a `beforeEach` that deletes **all** child tables before `repos` (FK order: `memory`, `chat_messages`, `tasks`, then `repos`).
- Run `npm test` before pushing. All tests must pass — no skips, no `only`.

### When a PR lands without tests

RAZ-QA's pre-merge `review` workflow must `request_changes` citing missing tests. The PR does not merge until tests are added.

---

## Critical Rules

### TypeScript
- No `any`. No implicit `any`. Use explicit return types on all exports.
- No commented-out code. No `// TODO` placeholders.
- Run `npm run lint` and fix **all errors** (warnings are non-blocking) before `task_complete`.

### Next.js 16
- App Router only — no `pages/` directory.
- Server components are the default. Mark client components with `'use client'`.
- API routes that read from the filesystem at request time need `export const dynamic = 'force-dynamic'`.
- `params` in dynamic routes is a `Promise` — always `await params` before destructuring.

### Tailwind v4
- No `tailwind.config.js`. Customization goes in `@theme { }` blocks in CSS.
- Utility class names are the same as v3 but the config mechanism is completely different.

### Zod v4
- `z.object({}).parse(x)` still works.
- `z.string().nonempty()` is deprecated — use `z.string().min(1)`.
- `.nullable()` and `.optional()` behave slightly differently; verify before assuming.

### Database
- Always bump `PRAGMA user_version` at the end of every migration block.
- Never `DROP TABLE` or `DELETE` without a `WHERE` clause without explicit user approval.
- Wrap all `ALTER TABLE` in try/catch.

### Security
- Never read, log, or expose `.env` files or any value that looks like a secret.
- Always call `security_scan` before `task_complete` (RAZ-Dev, RAZ-Data).
- Never hardcode API keys, tokens, or credentials in code.
- Work only within the worktree path — never escape it.

### Git / PR
- Conventional commit prefixes: `feat:`, `fix:`, `refactor:`, `chore:`, `test:`, `docs:`.
- Do not force-push, `git reset --hard`, or `git push --force`.
- Sub-agents do not commit — only the parent agent commits via `task_complete`.
