import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import {
	executeParallelWorkstreams,
	type ParallelExecuteDetails,
	type WorkstreamInput,
} from "./parallel-workers.ts";

const PLAN_MODEL = { provider: "openai-codex", model: "gpt-5.5" };
const IMPLEMENT_MODEL = { provider: "cursor", model: "composer-2.5" };
const IMPLEMENT_THINKING = "medium" as const;
const CURSOR_FAST_ENTRY_TYPE = "cursor-fast-state";
const PARALLEL_TOOL = "plan_parallel_execute";

const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls"];
const IMPLEMENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const SAFE_PLAN_BASH_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*ps\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-)/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*pnpm\s+(list|view|info|outdated|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
];

const PLANEXE_TIP =
	"Tip: pass constraints as args, e.g. /planexe skip tests or /planexe focus only on auth module";

function planPath(cwd: string): string {
	return join(cwd, ".pi", "plan.md");
}

function assistantText(message: unknown): string {
	const m = message as AssistantMessage | undefined;
	if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return "";
	return m.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function validTools(pi: ExtensionAPI, desired: string[]): string[] {
	const available = new Set(pi.getAllTools().map((tool) => tool.name));
	return desired.filter((name) => available.has(name));
}

async function setModel(ctx: ExtensionContext, pi: ExtensionAPI, provider: string, modelId: string): Promise<boolean> {
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) {
		ctx.ui.notify(`Model not found: ${provider}/${modelId}`, "warning");
		return false;
	}
	const ok = await pi.setModel(model);
	if (!ok) ctx.ui.notify(`No API key/session available for ${provider}/${modelId}`, "warning");
	return ok;
}

function savePlan(cwd: string, content: string): string {
	const file = planPath(cwd);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content.endsWith("\n") ? content : `${content}\n`, "utf8");
	return file;
}

function readPlan(cwd: string): string | undefined {
	try {
		const text = readFileSync(planPath(cwd), "utf8").trim();
		return text.length > 0 ? text : undefined;
	} catch {
		return undefined;
	}
}

function clearPlan(cwd: string): boolean {
	try {
		unlinkSync(planPath(cwd));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function isSafePlanBash(command: string): boolean {
	return SAFE_PLAN_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

function cursorBaseModelId(modelId: string): string {
	const contextSeparator = modelId.indexOf("@");
	return contextSeparator === -1 ? modelId : modelId.slice(0, contextSeparator);
}

async function forceCursorFast(pi: ExtensionAPI, ctx: ExtensionContext, modelId: string): Promise<void> {
	if (pi.getFlag("cursor-no-fast") === true) {
		ctx.ui.notify("Cursor fast is forced off by --cursor-no-fast; /planexe cannot enable fast Composer.", "warning");
		return;
	}

	const baseModelId = cursorBaseModelId(modelId);
	try {
		pi.appendEntry(CURSOR_FAST_ENTRY_TYPE, { baseModelId, fast: true });
	} catch (error) {
		ctx.ui.notify(`Failed to persist Cursor fast preference: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}

	try {
		const moduleName = "pi-cursor-sdk/src/cursor-state.js";
		const cursorState = (await import(moduleName)) as { __testUtils?: { sessionFastPreferences?: Map<string, boolean> } };
		cursorState.__testUtils?.sessionFastPreferences?.set(baseModelId, true);
	} catch {
		// Composer 2.5 defaults to fast in pi-cursor-sdk; the session entry above also restores fast on resume.
	}

	ctx.ui.setStatus("cursor", "cursor fast");
}

const PLAN_CONTEXT_RULES = `[PLAN WORKFLOW ACTIVE]
You are building a plan only.

Rules:
- Do not edit, write, create, delete, rename, or move project files.
- You may inspect files and run read-only shell commands.
- Produce a concrete Markdown implementation plan.
- Include: objective, relevant files/areas, ordered steps, validation/tests, and parallelization assessment.
- If work can be parallelized, include a section named "Parallelization" with independent workstreams; otherwise say "Parallelization: not recommended".
- The extension will save your final assistant response to .pi/plan.md.`;

function planContextContent(retainedPlan?: string): string {
	if (!retainedPlan) return PLAN_CONTEXT_RULES;
	return [
		PLAN_CONTEXT_RULES,
		"",
		"You are revising/continuing an existing saved plan. Use it as context; output the complete updated plan (it will overwrite .pi/plan.md).",
		"",
		"Existing plan:",
		"```md",
		retainedPlan,
		"```",
	].join("\n");
}

const WorkstreamSchema = Type.Object({
	label: Type.String({ description: "Short unique label for this worker (shown in logs)" }),
	task: Type.String({ description: "Implementation task for this workstream" }),
	paths: Type.Optional(Type.Array(Type.String({ description: "File paths or areas this worker should focus on" }))),
});

const ParallelParams = Type.Object({
	workstreams: Type.Array(WorkstreamSchema),
	notes: Type.Optional(Type.String({ description: "Extra constraints for all workers" })),
});

export default function planWorkflow(pi: ExtensionAPI) {
	let planning = false;
	let executing = false;
	let retainedPlan: string | undefined;

	function setStatus(ctx: ExtensionContext) {
		if (planning) {
			ctx.ui.setStatus("plan-workflow", ctx.ui.theme.fg("warning", "plan:gpt-5.5"));
			return;
		}
		if (executing) {
			ctx.ui.setStatus("plan-workflow", ctx.ui.theme.fg("accent", "impl:composer-2.5 fast med"));
			return;
		}
		ctx.ui.setStatus("plan-workflow", undefined);
	}

	function implementationTools(pi: ExtensionAPI): string[] {
		return validTools(pi, [...IMPLEMENT_TOOLS, PARALLEL_TOOL]);
	}

	async function enterPlanning(ctx: ExtensionContext, goal?: string) {
		const hasGoal = Boolean(goal?.trim());
		retainedPlan = undefined;
		let clearedExisting = false;

		if (hasGoal) {
			if (clearPlan(ctx.cwd)) clearedExisting = true;
		} else {
			const existingPlan = readPlan(ctx.cwd);
			if (existingPlan) {
				if (ctx.hasUI) {
					const choice = await ctx.ui.select("Existing plan found", [
						"No, start fresh and clear saved plan",
						"Yes, keep working on existing plan",
					]);
					if (choice?.startsWith("Yes")) {
						retainedPlan = existingPlan;
					} else if (clearPlan(ctx.cwd)) {
						clearedExisting = true;
					}
				} else if (clearPlan(ctx.cwd)) {
					clearedExisting = true;
				}
			}
		}

		planning = true;
		executing = false;
		pi.setActiveTools(validTools(pi, PLAN_TOOLS));
		await setModel(ctx, pi, PLAN_MODEL.provider, PLAN_MODEL.model);
		pi.setThinkingLevel("high");
		setStatus(ctx);

		const modeNote = retainedPlan
			? " Continuing existing plan."
			: clearedExisting
				? " Cleared previous saved plan."
				: "";
		ctx.ui.notify(`Planning mode enabled. Plan will save to ${planPath(ctx.cwd)}.${modeNote}`, "info");

		if (hasGoal) {
			const request = goal!.trim();
			pi.sendUserMessage(
				`Create an implementation plan for this request. Do not modify project files.\n\nRequest:\n${request}`,
			);
		}
	}

	async function enterExecution(ctx: ExtensionContext, notes?: string) {
		const plan = readPlan(ctx.cwd);
		if (!plan) {
			ctx.ui.notify(`No plan found at ${planPath(ctx.cwd)}. Run /plan <request> first.`, "warning");
			return;
		}

		planning = false;
		executing = true;
		retainedPlan = undefined;
		pi.setActiveTools(implementationTools(pi));
		await setModel(ctx, pi, IMPLEMENT_MODEL.provider, IMPLEMENT_MODEL.model);
		pi.setThinkingLevel(IMPLEMENT_THINKING);
		await forceCursorFast(pi, ctx, IMPLEMENT_MODEL.model);
		setStatus(ctx);

		pi.sendUserMessage([
			{
				type: "text",
				text: [
					"Implement the saved plan using composer-2.5 fast with medium thinking.",
					"Follow the plan in order, but adapt if the codebase requires it.",
					"Read the plan's Parallelization section first.",
					"If it lists clearly independent workstreams with disjoint file areas, call plan_parallel_execute with one workstream per label (include paths hints).",
					"Only use plan_parallel_execute when workstreams do not overlap the same files.",
					"Otherwise implement serially yourself.",
					"Run relevant checks/tests when practical and summarize changed files at the end.",
					notes?.trim() ? `Additional execution notes: ${notes.trim()}` : "",
					PLANEXE_TIP,
					"",
					"Saved plan:",
					"```md",
					plan,
					"```",
				]
					.filter(Boolean)
					.join("\n"),
			},
		]);
	}

	async function planexeHandler(args: string, ctx: ExtensionContext) {
		await ctx.waitForIdle();
		await enterExecution(ctx, args);
	}

	async function planclrHandler(_args: string, ctx: ExtensionContext) {
		planning = false;
		executing = false;
		retainedPlan = undefined;
		pi.setActiveTools(validTools(pi, IMPLEMENT_TOOLS));
		setStatus(ctx);
		ctx.ui.notify("Plan workflow disabled. Normal implementation tools restored.", "info");
	}

	pi.registerTool({
		name: PARALLEL_TOOL,
		label: "Plan parallel execute",
		description:
			"Run independent plan workstreams in parallel using labeled worker agents (git worktrees). Use only for disjoint file areas.",
		parameters: ParallelParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeParallelWorkstreams(
				ctx.cwd,
				params.workstreams as WorkstreamInput[],
				params.notes,
				signal,
				onUpdate,
			);
		},
		renderCall(args, theme) {
			const n = Array.isArray(args.workstreams) ? args.workstreams.length : 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("plan_parallel_execute ")) +
					theme.fg("accent", `${n} workstream${n === 1 ? "" : "s"}`),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as ParallelExecuteDetails | undefined;
			if (!details?.workers?.length) {
				return new Text(theme.fg("muted", "No worker results"), 0, 0);
			}
			const lines = details.workers.map((w) => {
				const icon = w.exitCode === -1 ? "⏳" : w.failed ? "✗" : "✓";
				let line = `${icon} [${w.label}]`;
				const last = w.logs.at(-1);
				if (last) line += ` ${last.text}`;
				if (expanded && w.summary) {
					line += `\n  ${w.summary.split("\n")[0]?.slice(0, 120) ?? ""}`;
				}
				return line;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerCommand("plan", {
		description: "Planning mode (gpt-5.5). /plan = enter mode; /plan <request> = clear old plan and plan anew",
		handler: async (args, ctx) => enterPlanning(ctx, args),
	});

	pi.registerCommand("planexe", {
		description: `Execute .pi/plan.md with composer-2.5 fast. Usage: /planexe [notes]. ${PLANEXE_TIP}`,
		handler: planexeHandler,
		getArgumentCompletions: (prefix) => {
			const hints = ["skip tests", "focus only on", "serial only", "parallel if possible"];
			return hints
				.filter((h) => h.startsWith(prefix) || !prefix)
				.map((h) => ({ value: h, label: h }));
		},
	});

	pi.registerCommand("plan-status", {
		description: "Show plan workflow status, .pi/plan.md location, and full saved plan",
		handler: async (_args, ctx) => {
			const plan = readPlan(ctx.cwd);
			const statusLines = [
				`mode: ${planning ? "planning" : executing ? "executing" : "idle"}`,
				`file: ${planPath(ctx.cwd)}`,
				`saved plan: ${plan ? "yes" : "no"}`,
			];

			if (!plan) {
				ctx.ui.notify(statusLines.join("\n"), "info");
				return;
			}

			const content = [...statusLines, "", "--- saved plan ---", "", plan].join("\n");
			pi.sendMessage({ customType: "plan-workflow-status", content, display: true }, { triggerTurn: false });
			ctx.ui.notify("Plan status shown", "info");
		},
	});

	pi.registerCommand("planclr", {
		description: "Leave planning/execution mode and restore normal tools",
		handler: planclrHandler,
	});

	pi.on("before_agent_start", async () => {
		if (!planning) return;
		return {
			message: {
				customType: "plan-workflow-context",
				display: false,
				content: planContextContent(retainedPlan),
			},
		};
	});

	pi.on("tool_call", async (event) => {
		if (!planning) return;
		if (event.toolName === "edit" || event.toolName === "write") {
			return { block: true, reason: "Plan mode is read-only. Use /planexe after the plan is approved." };
		}
		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown }).command ?? "");
			if (!isSafePlanBash(command)) {
				return { block: true, reason: `Plan mode only allows read-only bash inspection commands. Blocked: ${command}` };
			}
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!planning) return;
		const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		const text = assistantText(lastAssistant);
		if (!text) return;
		const file = savePlan(ctx.cwd, text);
		retainedPlan = text;
		ctx.ui.notify(`Saved plan to ${file}. Run /planexe to implement.`, "info");
	});

	pi.on("session_start", async (_event, ctx) => {
		setStatus(ctx);
	});
}
