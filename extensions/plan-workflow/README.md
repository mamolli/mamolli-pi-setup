# Plan Workflow Extension

Global pi extension providing a two-stage plan/execute flow with optional parallel workers.

## Commands

| Command | Description |
|---------|-------------|
| `/plan` | Enter planning mode (gpt-5.5). Next prompt builds a plan; if `.pi/plan.md` exists, asks whether to keep it (default: No, clears file). |
| `/plan <request>` | Clear any saved plan and immediately start planning for `<request>`. |
| `/planexe [notes]` | Execute `.pi/plan.md` with cursor/composer-2.5 fast, medium thinking. Optional notes, e.g. `/planexe skip tests`. |
| `/planstat` | Show mode, plan path, and full saved plan contents. |
| `/planclr` | Leave plan/execution mode and restore normal tools. |

## Planning mode

Read-only from the model's perspective:

- active tools: `read`, `bash`, `grep`, `find`, `ls`
- `edit` and `write` are blocked
- bash restricted to inspection allowlist
- extension writes `.pi/plan.md` after the planning response

Plans should include a **Parallelization** section when work can run in parallel.

## Execution mode

- Model: `cursor/composer-2.5` (fast), thinking `medium`
- Tools: read, bash, edit, write, grep, find, ls, plus `plan_parallel_execute`

The execution prompt instructs the agent to call `plan_parallel_execute` when the plan has clearly independent, non-overlapping workstreams.

## Parallel workers (`plan_parallel_execute`)

When the plan has disjoint workstreams:

1. Main agent calls `plan_parallel_execute` with labeled workstreams and optional `paths` hints.
2. Each worker runs in an isolated **git worktree** under `.pi/plan-workflow/worktrees/<label>`.
3. Workers spawn separate `pi` subprocesses (composer-2.5, medium thinking).
4. Logs are prefixed with `[label]` so parallel output is easy to follow.
5. Patches are applied back to the main worktree sequentially.

Requires a git repository. Without git, use serial implementation only.

## Install via mamolli-pi-setup

```bash
pi install git:github.com/mamolli/mamolli-pi-setup@v2
```

Remove separate `npm:pi-cursor-sdk` from settings if using the composite package.
