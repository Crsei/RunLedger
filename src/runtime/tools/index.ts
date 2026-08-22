/**
 * 内置标准工具集 —— stdlib namespace。
 *
 * pi 的对应文件是 `core/tools/index.ts`。RunLedger 简化:不接收 ToolContext
 * 闭包(因为 our 工具直接 cwd 闭包即可),只暴露一组工厂 createXxxTool +
 * 一个 `createStdlibTools(cwd)` 一站式构造器返回 AgentTool[] / ToolRegistry。
 *
 * 工具集(对齐 pi):
 *   - read  : 读文件,行/字节截断 + cat -n 行号 + mtime 去重缓存
 *   - write : 写文件,递归建目录
 *   - edit  : 多块 oldText → newText + replaceAll + findActualString
 *   - bash  : 受治理 shell 执行,stdout/stderr 截断 + stdin + output_format；后台请求在 Host manager 接线前 fail closed
 *   - grep  : ripgrep / grep 查找 + afterContext + beforeContext + multiline + outputFormat
 *   - find  : fd / find glob
 *   - glob  : 第一方手写 ** 递归(无外部依赖)
 *   - ls    : 列目录
 *
 * 兼容:echo.ts 中 demo echo tool 也归入 stdlib namespace,但走自己的
 * `name: "echo"`,不与上面冲突。
 */

import type { AgentTool } from "../types.ts";
import type { ExecutionEnv, Shell } from "../execution-env.ts";
import { createToolRegistry, type ToolRegistry } from "../tool-registry.ts";
import { echoTool } from "./echo.ts";
import { createReadTool, type ReadToolOptions } from "./read.ts";
import { createWriteTool, type WriteToolOptions } from "./write.ts";
import { createEditTool, type EditToolOptions } from "./edit.ts";
import { createMultiEditTool } from "./multi-edit.ts";
import { createBashTool, type ManagedBackgroundBashOperations } from "./bash.ts";
import { createGrepTool } from "./grep.ts";
import { createFindTool } from "./find.ts";
import { createGlobTool, type GlobToolOptions } from "./glob.ts";
import { createLsTool, type LsToolOptions } from "./ls.ts";
import { createTodoWriteTool } from "./todo-write.ts";
import { createWebFetchTool } from "./web-fetch.ts";
import { createSkillTool } from "./skill.ts";
import { createNotebookEditTool } from "./notebook-edit.ts";
import { createProcessOutputTool } from "./process-output.ts";
import { createProcessWaitTool } from "./process-wait.ts";
import { createWriteStdinTool } from "./write-stdin.ts";
import { createProcessStopTool } from "./process-stop.ts";
import { createProcessResizeTool } from "./process-resize.ts";
import type { ProcessToolClient } from "./process-tool-support.ts";
import { withBuiltinCapabilityClaims } from "./capabilities.ts";
import { createRequestPermissionsTool, type RequestPermissionsPort } from "../../security/tools/request-permissions.ts";
import type { ToolPolicyProjection } from "../../storage/settings-policies.ts";
import {
	createTaskListTool,
	createTaskTool,
	createTaskUpdateTool,
	type TaskToolOptions,
} from "../tasks/task-tools.ts";

export interface StdlibToolsOptions {
	readonly managedProcess?: ManagedBackgroundBashOperations & Partial<ProcessToolClient>;
	/** Production Host composition supplies this; omitted only for low-level/tests. */
	readonly executionEnv?: ExecutionEnv;
	/** Production callers must opt into the governed Host-provided execution env. */
	readonly requireExecutionEnv?: boolean;
	/** Host-injected progressive-disclosure Skill loader（trust + digest 复核）。 */
	readonly skillLoader?: import("./skill.ts").SkillLoader;
	/** Host-governed permission request port；P6 接入完整 approval UX。 */
	readonly permissionRequester?: RequestPermissionsPort;
	/** 当前 turn 的 immutable tool policy；不改变 ExecutionGateway authority。 */
	readonly toolPolicy?: ToolPolicyProjection;
	/** Session-owned task ledger；未注入时不把 task tools 暴露给 production context。 */
	readonly taskOptions?: TaskToolOptions;
}

/**
 * 一站式构造标准库工具集。返回 ToolRegistry,namespace="stdlib"。
 *
 * 与 pi 的差异:不接收 ToolContext 闭包;cwd 直接进工厂。
 * 若工具需要 ToolContext(fs / shell 注入 ledger 等),在调用 AgentLoop 前
 * 自行 prepareContext 时把 ExecutionEnv 通过 ops 注入。
 */
export function createStdlibTools(cwd: string = process.cwd(), options: StdlibToolsOptions = {}): ToolRegistry {
  const r = createToolRegistry([], { namespace: "stdlib" });
  const register = (tool: AgentTool): void => { r.register(withBuiltinCapabilityClaims(tool), { namespace: "stdlib" }); };
  const env = options.executionEnv;
	if (options.requireExecutionEnv === true && env === undefined) {
		throw new Error("governed ExecutionEnv is required for production stdlib tools");
	}
  const helperShell = options.managedProcess?.exec === undefined
    ? env?.shell
    : managedProcessShell(options.managedProcess.exec, cwd);
	if (toolEnabled(options.toolPolicy, "read")) register(createReadTool(cwd, {
		...(env === undefined ? {} : { operations: readOperations(env) }),
		...(options.toolPolicy?.read?.defaultLimit === undefined ? {} : { defaultLimit: options.toolPolicy.read.defaultLimit }),
		...(options.toolPolicy?.read?.renderMarkdown === true ? { renderMarkdown: true } : {}),
	}));
	if (toolEnabled(options.toolPolicy, "write")) register(createWriteTool(cwd, env === undefined ? {} : { operations: writeOperations(env) }));
	if (toolEnabled(options.toolPolicy, "edit")) register(createEditTool(cwd, env === undefined ? {} : { operations: editOperations(env) }));
	register(createMultiEditTool(cwd, env === undefined ? {} : { fileSystem: env.fs }));
	if (toolEnabled(options.toolPolicy, "bash")) register(createBashTool(cwd, {
		...(env === undefined ? {} : { operations: { exec: (command, commandOptions) => env.shell.exec(command, commandOptions) } }),
		...(options.managedProcess === undefined ? {} : { managedProcess: options.managedProcess }),
		...(options.toolPolicy?.bash?.defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs: options.toolPolicy.bash.defaultTimeoutMs }),
		...(options.toolPolicy?.bash?.maxOutputChars === undefined ? {} : { defaultMaxOutputChars: options.toolPolicy.bash.maxOutputChars }),
	}));
	if (toolEnabled(options.toolPolicy, "grep")) register(createGrepTool(cwd, {
		...(helperShell === undefined ? {} : { shell: helperShell }),
		...(options.toolPolicy?.grep?.defaultLimit === undefined ? {} : { defaultLimit: options.toolPolicy.grep.defaultLimit }),
		...(options.toolPolicy?.grep?.contextBefore === undefined ? {} : { contextBefore: options.toolPolicy.grep.contextBefore }),
		...(options.toolPolicy?.grep?.contextAfter === undefined ? {} : { contextAfter: options.toolPolicy.grep.contextAfter }),
	}));
	if (toolEnabled(options.toolPolicy, "find")) register(createFindTool(cwd, {
		...(helperShell === undefined ? {} : { shell: helperShell }),
		...(options.toolPolicy?.find?.defaultLimit === undefined ? {} : { defaultLimit: options.toolPolicy.find.defaultLimit }),
	}));
	if (toolEnabled(options.toolPolicy, "glob")) register(createGlobTool(cwd, {
		...(env === undefined ? {} : { operations: globOperations(env) }),
		...(options.toolPolicy?.glob?.defaultLimit === undefined ? {} : { defaultLimit: options.toolPolicy.glob.defaultLimit }),
	}));
	if (toolEnabled(options.toolPolicy, "ls")) register(createLsTool(cwd, {
		...(env === undefined ? {} : { operations: lsOperations(env) }),
		...(options.toolPolicy?.ls?.defaultLimit === undefined ? {} : { defaultLimit: options.toolPolicy.ls.defaultLimit }),
	}));
	if (toolEnabled(options.toolPolicy, "webFetch")) register(createWebFetchTool(env === undefined ? {} : { network: env.network ?? unavailableNetwork() }));
  register(createSkillTool(options.skillLoader === undefined ? {} : { loader: options.skillLoader }));
	register(createNotebookEditTool());
	if (options.permissionRequester !== undefined) register(createRequestPermissionsTool(options.permissionRequester));
	if (options.taskOptions !== undefined) {
		register(createTaskTool(options.taskOptions));
		register(createTaskUpdateTool(options.taskOptions));
		register(createTaskListTool(options.taskOptions));
		register(createTodoWriteTool(options.taskOptions));
	}
	register(echoTool);
	if (options.managedProcess) {
		const processClient = options.managedProcess;
		if (isCompleteProcessToolClient(processClient)) {
			register(createProcessOutputTool(processClient));
			register(createProcessWaitTool(processClient));
			register(createWriteStdinTool(processClient, { actor: "driver" }));
			register(createProcessStopTool(processClient, { actor: "driver" }));
			register(createProcessResizeTool(processClient));
		}
	}
	return r;
}

type ToolPolicyGateName = "read" | "write" | "edit" | "bash" | "grep" | "find" | "glob" | "ls" | "webFetch";

function toolEnabled(policy: ToolPolicyProjection | undefined, name: ToolPolicyGateName): boolean {
	if (policy === undefined) return true;
	const group = policy[name];
	return group?.enabled !== false;
}

function readOperations(env: ExecutionEnv): NonNullable<ReadToolOptions["operations"]> {
	return {
		readFile: (path) => env.fs.readFile(path),
		access: async (path) => { await env.fs.stat(path); },
		stat: async (path) => ({ mtimeMs: (await env.fs.stat(path)).mtimeMs }),
	};
}

function writeOperations(env: ExecutionEnv): NonNullable<WriteToolOptions["operations"]> {
	return {
		writeFile: (path, content) => env.fs.writeFile(path, content),
		mkdir: async (path) => { await env.fs.mkdir(path, { recursive: true }); },
	};
}

function editOperations(env: ExecutionEnv): NonNullable<EditToolOptions["operations"]> {
	return {
		readFile: (path) => env.fs.readFile(path),
		writeFile: (path, content) => env.fs.writeFile(path, content),
		access: async (path) => { await env.fs.stat(path); },
	};
}

function globOperations(env: ExecutionEnv): NonNullable<GlobToolOptions["operations"]> {
	return {
		readdir: (path) => env.fs.readdir(path),
		stat: async (path) => {
			const value = await env.fs.stat(path);
			return { isDirectory: value.isDirectory, mtimeMs: value.mtimeMs, isSymbolicLink: value.isSymbolicLink === true };
		},
	};
}

function lsOperations(env: ExecutionEnv): NonNullable<LsToolOptions["operations"]> {
	return {
		exists: async (path) => {
			try { await env.fs.stat(path); return true; } catch { return false; }
		},
		stat: async (path) => {
			const value = await env.fs.stat(path);
			return { isDirectory: () => value.isDirectory };
		},
		readdir: (path) => env.fs.readdir(path),
	};
}

function unavailableNetwork(): NonNullable<ExecutionEnv["network"]> {
	return { request: async () => { throw new Error("Host network port is unavailable"); } };
}

function managedProcessShell(
	exec: NonNullable<StdlibToolsOptions["managedProcess"]>["exec"],
	cwd: string,
): Shell {
	if (exec === undefined) throw new Error("managed process foreground facade is unavailable");
	return {
		exec: (command, options) => exec({
			command,
			cwd: options?.cwd ?? cwd,
			timeoutMs: options?.timeoutMs ?? 60_000,
			...(options?.maxOutputChars === undefined ? {} : { maxOutputChars: options.maxOutputChars }),
			...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
			...(options?.signal === undefined ? {} : { signal: options.signal }),
			...(options?.onStdout === undefined ? {} : { onStdout: options.onStdout }),
			...(options?.onStderr === undefined ? {} : { onStderr: options.onStderr }),
		}),
	};
}

function isCompleteProcessToolClient(
	client: ManagedBackgroundBashOperations & Partial<ProcessToolClient>,
): client is ManagedBackgroundBashOperations & ProcessToolClient {
	return typeof client.processOutput === "function" &&
		typeof client.processWait === "function" &&
		typeof client.write === "function" &&
		typeof client.stop === "function" &&
		typeof client.resize === "function";
}

/**
 * 创建带 ledger 注入的扩展工具集(stdlib + Task 系列 + TodoWrite)。
 * 与 pi "全 18 工具集"对齐:9 stdlib + 3 Task + 1 TodoWrite + MultiEdit +
 * WebFetch + Skill + NotebookEdit。
 */
export function createExtendedTools(cwd: string = process.cwd(), taskOptions: { ledger?: import("../ledger/types.ts").LedgerSink } = {}): ToolRegistry {
  return createStdlibTools(cwd, { taskOptions });
}

/** AgentTool[] 视图,与 AgentContext.tools 直接相容。 */
export function stdlibTools(cwd: string = process.cwd()): AgentTool[] {
  return createStdlibTools(cwd).toContext();
}

export { createReadTool, createWriteTool, createEditTool, createMultiEditTool, createBashTool, createGrepTool, createFindTool, createGlobTool, createLsTool, createWebFetchTool, createSkillTool, createNotebookEditTool, createTodoWriteTool };
export { createProcessOutputTool, createProcessWaitTool, createWriteStdinTool, createProcessStopTool, createProcessResizeTool };
export { createRequestPermissionsTool } from "../../security/tools/request-permissions.ts";
export { echoTool };
