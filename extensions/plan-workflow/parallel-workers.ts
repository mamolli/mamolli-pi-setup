import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";

const MAX_WORKERS = 8;
const MAX_CONCURRENCY = 4;
const WORKER_MODEL = "cursor/composer-2.5";
const WORKER_TOOLS = "read,bash,edit,write,grep,find,ls";

export interface WorkstreamInput {
	label: string;
	task: string;
	paths?: string[];
}

export interface WorkerLogLine {
	label: string;
	text: string;
}

export interface WorkerResult {
	label: string;
	task: string;
	exitCode: number;
	summary: string;
	logs: WorkerLogLine[];
	failed: boolean;
	error?: string;
	patchApplied?: boolean;
}

export interface ParallelExecuteDetails {
	workstreams: WorkstreamInput[];
	workers: WorkerResult[];
	gitWorktrees: boolean;
}

function sanitizeLabel(label: string): string {
	return label.replace(/[^\w.-]+/g, "_").slice(0, 40) || "worker";
}

function worktreeRoot(cwd: string): string {
	return path.join(cwd, ".pi", "plan-workflow", "worktrees");
}

function runCmd(cwd: string, command: string, args: string[], timeoutMs = 60000): { stdout: string; stderr: string; code: number } {
	try {
		const stdout = execFileSync(command, args, {
			cwd,
			encoding: "utf8",
			timeout: timeoutMs,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { stdout, stderr: "", code: 0 };
	} catch (error) {
		const err = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
		return {
			stdout: String(err.stdout ?? ""),
			stderr: String(err.stderr ?? ""),
			code: err.status ?? 1,
		};
	}
}

function isGitRepo(cwd: string): boolean {
	return runCmd(cwd, "git", ["rev-parse", "--git-dir"], 5000).code === 0;
}

async function mapWithConcurrency<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: limit }, async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				results[i] = await fn(items[i], i);
			}
		}),
	);
	return results;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

function formatToolLine(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "bash":
			return `$ ${String(args.command ?? "").slice(0, 80)}`;
		case "read":
			return `read ${args.path ?? args.file_path ?? "?"}`;
		case "edit":
			return `edit ${args.path ?? "?"}`;
		case "write":
			return `write ${args.path ?? "?"}`;
		case "grep":
			return `grep ${args.pattern ?? ""}`;
		default:
			return toolName;
	}
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

async function setupWorktree(mainCwd: string, label: string): Promise<{ cwd: string; branch: string } | { error: string }> {
	const safe = sanitizeLabel(label);
	const root = worktreeRoot(mainCwd);
	fs.mkdirSync(root, { recursive: true });
	const wtPath = path.join(root, safe);
	const branch = `planwf/${safe}-${Date.now().toString(36)}`;

	if (fs.existsSync(wtPath)) {
		const rm = runCmd(mainCwd, "git", ["worktree", "remove", "--force", wtPath], 30000);
		if (rm.code !== 0) {
			try {
				fs.rmSync(wtPath, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}

	const add = runCmd(mainCwd, "git", ["worktree", "add", "-B", branch, wtPath], 60000);
	if (add.code !== 0) {
		return { error: add.stderr || add.stdout || `git worktree add failed for ${label}` };
	}
	return { cwd: wtPath, branch };
}

function collectPatch(worktreeCwd: string): string | undefined {
	const diff = runCmd(worktreeCwd, "git", ["diff", "HEAD"], 60000);
	if (diff.code !== 0 || !diff.stdout.trim()) return undefined;
	return diff.stdout;
}

function applyPatch(mainCwd: string, patch: string, label: string): { ok: boolean; error?: string } {
	const patchDir = path.join(mainCwd, ".pi", "plan-workflow", "patches");
	fs.mkdirSync(patchDir, { recursive: true });
	const patchFile = path.join(patchDir, `${sanitizeLabel(label)}.patch`);
	fs.writeFileSync(patchFile, patch, "utf8");
	const apply = runCmd(mainCwd, "git", ["apply", "--3way", patchFile], 60000);
	if (apply.code === 0) return { ok: true };
	return { ok: false, error: apply.stderr || apply.stdout || "git apply failed" };
}

function cleanupWorktree(mainCwd: string, worktreeCwd: string, branch: string): void {
	runCmd(mainCwd, "git", ["worktree", "remove", "--force", worktreeCwd], 30000);
	runCmd(mainCwd, "git", ["branch", "-D", branch], 10000);
}

async function runWorker(
	mainCwd: string,
	workstream: WorkstreamInput,
	useGit: boolean,
	signal: AbortSignal | undefined,
	onLog: (line: WorkerLogLine) => void,
): Promise<WorkerResult> {
	const { label, task, paths } = workstream;
	const logs: WorkerLogLine[] = [];
	const pushLog = (text: string) => {
		const line = { label, text };
		logs.push(line);
		onLog(line);
	};

	let workerCwd = mainCwd;
	let branch: string | undefined;

	if (useGit) {
		pushLog("creating git worktree");
		const wt = await setupWorktree(mainCwd, label);
		if ("error" in wt) {
			return { label, task, exitCode: 1, summary: "", logs, failed: true, error: wt.error };
		}
		workerCwd = wt.cwd;
		branch = wt.branch;
		pushLog(`worktree: ${workerCwd}`);
	}

	const pathHint = paths?.length ? `\nFocus paths: ${paths.join(", ")}` : "";
	const prompt = [
		`[plan-workflow worker: ${label}]`,
		"Implement only your assigned workstream. Do not touch files outside your scope unless required.",
		pathHint,
		"",
		"Task:",
		task,
		"",
		"End with a short summary of changes made.",
	].join("\n");

	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		WORKER_MODEL,
		"--thinking",
		"medium",
		"--tools",
		WORKER_TOOLS,
		prompt,
	];

	const messages: Message[] = [];
	let stderr = "";
	let exitCode = 0;

	try {
		exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: workerCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: { type?: string; toolName?: string; args?: Record<string, unknown>; message?: Message };
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "tool_execution_start" && event.toolName) {
					pushLog(formatToolLine(event.toolName, event.args ?? {}));
				}
				if (event.type === "message_end" && event.message) {
					messages.push(event.message);
				}
				if (event.type === "tool_result_end" && event.message) {
					messages.push(event.message);
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});
			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});
			proc.on("error", () => resolve(1));

			if (signal) {
				const kill = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (branch && useGit) cleanupWorktree(mainCwd, workerCwd, branch);
		return { label, task, exitCode: 1, summary: "", logs, failed: true, error: msg };
	}

	const summary = getFinalOutput(messages) || stderr || "(no output)";
	const failed = exitCode !== 0;

	let patchApplied: boolean | undefined;
	if (useGit && branch && !failed) {
		const patch = collectPatch(workerCwd);
		if (patch) {
			pushLog("applying patch to main worktree");
			const applied = applyPatch(mainCwd, patch, label);
			patchApplied = applied.ok;
			if (!applied.ok) {
				pushLog(`patch apply failed: ${applied.error}`);
			}
		}
		cleanupWorktree(mainCwd, workerCwd, branch);
	} else if (useGit && branch) {
		cleanupWorktree(mainCwd, workerCwd, branch);
	}

	return {
		label,
		task,
		exitCode,
		summary,
		logs,
		failed: failed || patchApplied === false,
		error: failed ? stderr || `exit ${exitCode}` : patchApplied === false ? "patch apply failed" : undefined,
		patchApplied,
	};
}

export function validateWorkstreams(workstreams: WorkstreamInput[]): string | undefined {
	if (!workstreams.length) return "At least one workstream is required.";
	if (workstreams.length > MAX_WORKERS) return `Max ${MAX_WORKERS} workstreams.`;
	const labels = new Set<string>();
	for (const ws of workstreams) {
		if (!ws.label?.trim()) return "Each workstream needs a label.";
		if (!ws.task?.trim()) return `Workstream "${ws.label}" needs a task.`;
		const key = ws.label.trim().toLowerCase();
		if (labels.has(key)) return `Duplicate label: ${ws.label}`;
		labels.add(key);
	}
	return undefined;
}

export async function executeParallelWorkstreams(
	mainCwd: string,
	workstreams: WorkstreamInput[],
	notes: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ParallelExecuteDetails> | undefined,
): Promise<AgentToolResult<ParallelExecuteDetails>> {
	const validation = validateWorkstreams(workstreams);
	if (validation) {
		return {
			content: [{ type: "text", text: validation }],
			details: { workstreams, workers: [], gitWorktrees: false },
		};
	}

	const useGit = isGitRepo(mainCwd);
	if (!useGit) {
		return {
			content: [
				{
					type: "text",
					text: "Parallel workers require a git repository (for isolated worktrees). Implement serially or initialize git first.",
				},
			],
			details: { workstreams, workers: [], gitWorktrees: false },
		};
	}

	const workers: WorkerResult[] = workstreams.map((ws) => ({
		label: ws.label,
		task: ws.task,
		exitCode: -1,
		summary: "",
		logs: [],
		failed: false,
	}));

	const emit = () => {
		onUpdate?.({
			content: [
				{
					type: "text",
					text: workers
						.map((w) => {
							const status = w.exitCode === -1 ? "running" : w.failed ? "failed" : "done";
							const last = w.logs.at(-1);
							return `[${w.label}] ${status}${last ? `: ${last.text}` : ""}`;
						})
						.join("\n"),
				},
			],
			details: { workstreams, workers: [...workers], gitWorktrees: true },
		});
	};

	emit();

	const notePrefix = notes?.trim() ? `Notes: ${notes.trim()}\n\n` : "";

	const results = await mapWithConcurrency(workstreams, MAX_CONCURRENCY, async (ws, index) => {
		const task = notePrefix + ws.task;
		const result = await runWorker(
			mainCwd,
			{ ...ws, task },
			useGit,
			signal,
			(line) => {
				workers[index].logs.push(line);
				emit();
			},
		);
		workers[index] = result;
		emit();
		return result;
	});

	const ok = results.filter((r) => !r.failed).length;
	const body = results
		.map((r) => {
			const status = r.failed ? "FAILED" : "OK";
			const logTail = r.logs
				.slice(-5)
				.map((l) => `  [${l.label}] ${l.text}`)
				.join("\n");
			return `### [${r.label}] ${status}\n\n${r.summary}\n\n${logTail}`;
		})
		.join("\n\n---\n\n");

	return {
		content: [{ type: "text", text: `Parallel workers: ${ok}/${results.length} succeeded\n\n${body}` }],
		details: { workstreams, workers: results, gitWorktrees: true },
	};
}
