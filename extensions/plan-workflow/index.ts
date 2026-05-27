import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PLAN_MODEL = { provider: "openai-codex", model: "gpt-5.5" };
const IMPLEMENT_MODEL = { provider: "cursor", model: "composer-2.5" };
const IMPLEMENT_THINKING = "medium" as const;
const CURSOR_FAST_ENTRY_TYPE = "cursor-fast-state";

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
		ctx.ui.notify("Cursor fast is forced off by --cursor-no-fast; /plan-execute cannot enable fast Composer.", "warning");
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

	async function enterPlanning(ctx: ExtensionContext, goal?: string) {
		const existingPlan = readPlan(ctx.cwd);
		retainedPlan = undefined;
		let clearedExisting = false;

		if (existingPlan) {
			if (ctx.hasUI) {
				const choice = await ctx.ui.select("Existing plan found", [
					"No, start fresh and clear saved plan",
					"Yes, keep working on existing plan",
				]);
				if (choice?.startsWith("Yes")) {
					retainedPlan = existingPlan;
				} else {
					if (clearPlan(ctx.cwd)) clearedExisting = true;
				}
			} else if (clearPlan(ctx.cwd)) {
				clearedExisting = true;
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

		if (goal?.trim()) {
			const request = goal.trim();
			if (retainedPlan) {
				pi.sendUserMessage(
					[
						"Continue or revise the existing saved plan for this request.",
						"Output the complete updated plan. Do not modify project files.",
						"",
						`Request:\n${request}`,
						"",
						"Existing plan:",
						"```md",
						retainedPlan,
						"```",
					].join("\n"),
				);
			} else {
				pi.sendUserMessage(`Create an implementation plan for this request. Do not modify project files.\n\nRequest:\n${request}`);
			}
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
		pi.setActiveTools(validTools(pi, IMPLEMENT_TOOLS));
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
					"If the work has clearly independent parts, explicitly identify them before implementing; otherwise implement serially.",
					"Run relevant checks/tests when practical and summarize changed files at the end.",
					notes?.trim() ? `Additional execution notes: ${notes.trim()}` : "",
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

	pi.registerCommand("plan", {
		description: "Enter planning mode with gpt-5.5; saves the generated plan to .pi/plan.md. Usage: /plan <request>",
		handler: async (args, ctx) => {
			await enterPlanning(ctx, args);
		},
	});

	pi.registerCommand("plan-execute", {
		description: "Execute .pi/plan.md with cursor/composer-2.5 fast and medium thinking. Usage: /plan-execute [notes]",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			await enterExecution(ctx, args);
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
			pi.sendMessage(
				{ customType: "plan-workflow-status", content, display: true },
				{ triggerTurn: false },
			);
			ctx.ui.notify("Plan status shown", "info");
		},
	});

	pi.registerCommand("plan-clear", {
		description: "Leave planning/execution mode and restore normal tools",
		handler: async (_args, ctx) => {
			planning = false;
			executing = false;
			retainedPlan = undefined;
			pi.setActiveTools(validTools(pi, IMPLEMENT_TOOLS));
			setStatus(ctx);
			ctx.ui.notify("Plan workflow disabled. Normal implementation tools restored.", "info");
		},
	});

	pi.on("before_agent_start", async (_event, _ctx) => {
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
			return { block: true, reason: "Plan mode is read-only. Use /plan-execute after the plan is approved." };
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
		ctx.ui.notify(`Saved plan to ${file}. Run /plan-execute to implement.`, "info");
	});

	pi.on("session_start", async (_event, ctx) => {
		setStatus(ctx);
	});
}
