# Plan Workflow Extension

Global pi extension providing a simple two-stage plan/execute flow.

## Commands

- `/plan <request>` - switch to `openai-codex/gpt-5.5`, enable read-only planning tools, ask for a plan, and save the final assistant response to `.pi/plan.md`. If `.pi/plan.md` already exists, prompts whether to keep it (default: No, which clears the saved plan).
- `/plan` - enter planning mode without sending a request; the next user prompt will be treated as plan-building. Also checks for an existing plan with the same prompt.
- `/plan-execute [notes]` - read `.pi/plan.md`, switch to `cursor/composer-2.5`, enable Cursor fast mode, set thinking to `medium`, restore implementation tools, and send the plan for implementation.
- `/plan-status` - show mode, plan file path, and full saved plan contents.
- `/plan-clear` - leave plan/execution mode and restore implementation tools.

## Behavior

Planning mode is read-only from the model's perspective:

- active tools: `read`, `bash`, `grep`, `find`, `ls`
- `edit` and `write` are blocked defensively
- bash is restricted to an allowlist of inspection commands

The extension itself is allowed to write `.pi/plan.md` after the planning response.

When entering plan mode with an existing `.pi/plan.md`, the extension asks whether to continue from that plan. **No** is the default (first option). Choosing No or canceling removes `.pi/plan.md` and starts fresh. Choosing Yes injects the saved plan as context for revision. In non-UI mode, the saved plan is cleared by default. Each planning response overwrites `.pi/plan.md` with the complete updated plan.

Execution uses Composer 2.5 in Cursor fast mode with pi thinking set to `medium`.

Parallel/swarm implementation is not automated yet. The execution prompt asks composer to identify independent workstreams when they are clear; actual multi-agent fanout can be added later.
