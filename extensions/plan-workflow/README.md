# Plan Workflow Extension

Global pi extension providing a two-stage plan/execute flow with optional parallel workers.

## Workflow

1. `/plan <request>` drafts and saves `.pi/plan.md`.
2. `/plan-show` reviews the saved plan and current mode.
3. `/plan-run [notes]` implements the plan.
4. `/plan-check` compares execution against the plan.

Plan workflow modes exit automatically after each turn; there is no clear/exit command.

## Commands

| Command | Description |
|---------|-------------|
| `/plan` | Enter planning mode (gpt-5.5). Next prompt builds a plan; if `.pi/plan.md` exists, asks whether to keep it (default: No, clears file). |
| `/plan <request>` | Clear any saved plan and immediately start planning for `<request>`. |
| `/plan-run [notes]` | Execute `.pi/plan.md` with cursor/composer-2.5 fast, medium thinking. Optional notes, e.g. `/plan-run skip tests`. |
| `/plan-show` | Show mode, plan path, and full saved plan contents. |
| `/plan-check` | Compare saved plan vs session execution (gpt-5.5 high). Read-only; asks before follow-up. |
| `/plan-update` | Update `mamolli-pi-setup` from GitHub and reload pi. |

## Planning mode

Read-only from the model's perspective:

- active tools: `read`, `bash`, `grep`, `find`, `ls`
- `edit` and `write` are blocked
- bash restricted to inspection allowlist
- extension writes `.pi/plan.md` after the planning response
- mode exits automatically and restores your previous tools/model

Plans should include a **Parallelization** section when work can run in parallel.

## Execution mode

- Model: `cursor/composer-2.5` (fast), thinking `medium`
- Tools: read, bash, edit, write, grep, find, ls, plus `plan_parallel_execute`
- mode exits automatically and restores your previous tools/model

The execution prompt instructs the agent to call `plan_parallel_execute` when the plan has clearly independent, non-overlapping workstreams.

## Parallel workers (`plan_parallel_execute`)

When the plan has disjoint workstreams:

1. Main agent calls `plan_parallel_execute` with labeled workstreams and optional `paths` hints.
2. Each worker runs in an isolated **git worktree** under `.pi/plan-workflow/worktrees/<label>`.
3. Workers spawn separate `pi` subprocesses (composer-2.5, medium thinking).
4. Logs are prefixed with `[label]` so parallel output is easy to follow.
5. Patches are applied back to the main worktree sequentially.

Requires a git repository. Without git, use serial implementation only.

## Verification mode (`/plan-check`)

Read-only retrospective using gpt-5.5 with high thinking:

1. Reads `.pi/plan.md` and the current session transcript.
2. Produces a divergence report with recommendations for better future plans.
3. Asks whether to follow up with a new planning pass for plan-workflow improvements.
4. mode exits automatically and restores your previous tools/model

## Self-update (`/plan-update`)

Resolves the latest git tag from GitHub, runs `pi install git:github.com/mamolli/mamolli-pi-setup@<tag>`, then reloads extensions.

## Install via mamolli-pi-setup

```bash
pi install git:github.com/mamolli/mamolli-pi-setup@v2.4
```

Remove separate `npm:pi-cursor-sdk` from settings if using the composite package.
