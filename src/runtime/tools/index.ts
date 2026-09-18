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
 *   - grep  : ripgrep / grep 查找 + afterContext + beforeContext + multiline + outputFormat + skip 翻页
 *   - glob  : 第一方手写 ** 递归(无外部依赖);不含 `/` 的 pattern 任意深度匹配,
 *             支持 hidden / gitignore 过滤。历史 `find` 工具已并入 glob,旧调用名由
 *             注册表的别名条目继续解析到同一个工具实例。
 *   - ls    : 列目录
 *   - todo  : 相位化任务表(op 增量更新),需注入 ledger 才持久化
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
import { createGlobTool, type GlobToolOptions } from "./glob.ts";
import { createLsTool, type LsToolOptions } from "./ls.ts";
import { createTodoTool, type TodoToolOptions } from "./todo.ts";
import { createWebFetchTool } from "./web-fetch.ts";
import { createWebSearchTool } from "../../websource/search/tool.ts";
import type { WebSearchCredentialPort } from "../../websource/credentials.ts";
import type { WebSearchSettings } from "../../websource/settings.ts";
import { createSkillTool } from "./skill.ts";
import { createNotebookEditTool } from "./notebook-edit.ts";
import { createProcessOutputTool } from "./process-output.ts";
import { createProcessWaitTool } from "./process-wait.ts";
import { createWriteStdinTool } from "./write-stdin.ts";
import { createProcessStopTool } from "./process-stop.ts";
import { createProcessResizeTool } from "./process-resize.ts";
import type { ProcessToolClient } from "./process-tool-support.ts";
import { withBuiltinCapabilityClaims } from "./capabilities.ts";
import { createWebSearchFetch } from "../../websource/transport.ts";
import { createRequestPermissionsTool, type RequestPermissionsPort } from "../../security/tools/request-permissions.ts";
import { createAskTool } from "./ask.ts";
import type { AskPort } from "../session-runtime/ask-reverse-request.ts";
import { createGithubTool } from "./github.ts";
import { createManageSkillTool, type ManageSkillPort } from "./manage-skill.ts";
import { createCheckpointTool } from "./checkpoint.ts";
import { createRewindTool } from "./rewind.ts";
import type { NamedCheckpointToolPort } from "../session-runtime/named-checkpoint-domain.ts";
import { createImageGenerationTool } from "./image-gen.ts";
import type { ImageGenerationPort } from "./image-generation-port.ts";

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
	/**
	 * 用户提问端口（reverse-request）；缺省不注册 `ask`，使未接线的组合
	 * 不会暴露一个必然失败的工具。
	 */
	readonly askPort?: AskPort;
	/** Canonical user-skill 写入端口；仅 standard Session Owner 组合注入。 */
	readonly manageSkill?: ManageSkillPort;
	/** Named checkpoint/fork handoff; both tools are absent unless the full port is wired. */
	readonly namedCheckpoint?: NamedCheckpointToolPort;
	/** Session-owned image generation adapter; absent outside the standard governed composition. */
	readonly imageGeneration?: ImageGenerationPort;
	/** todo 工具的持久化 sink;未注入时 todo 只在进程内维护状态。 */
	readonly ledger?: import("../ledger/types.ts").LedgerSink;
	/**
	 * web 检索的旁路依赖。三者齐备时才注册 `web_search`;缺省不注册,使未接线的
	 * 组合(以及 minimal/plan allowlist)不会暴露一个必然失败的工具。
	 */
	readonly webSearch?: {
		readonly credentials: WebSearchCredentialPort;
		readonly settings?: WebSearchSettings;
	};
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
	register(createReadTool(cwd, env === undefined ? {} : { operations: readOperations(env) }));
	register(createWriteTool(cwd, env === undefined ? {} : { operations: writeOperations(env) }));
	register(createEditTool(cwd, env === undefined ? {} : { operations: editOperations(env) }));
	register(createMultiEditTool(cwd, env === undefined ? {} : { fileSystem: env.fs }));
	register(createBashTool(cwd, {
		...(env === undefined ? {} : { operations: { exec: (command, commandOptions) => env.shell.exec(command, commandOptions) } }),
		...(options.managedProcess === undefined ? {} : { managedProcess: options.managedProcess }),
	}));
  register(createGrepTool(cwd, helperShell === undefined ? {} : { shell: helperShell }));
  register(createGlobTool(cwd, env === undefined ? {} : { operations: globOperations(env) }));
  register(createLsTool(cwd, env === undefined ? {} : { operations: lsOperations(env) }));
  const webSearchFetch = env === undefined ? undefined : createWebSearchFetch({
    network: env.network ?? unavailableNetwork(),
    principal: "web_search",
  });
  register(createWebFetchTool({
    ...(env === undefined ? {} : { network: env.network ?? unavailableNetwork() }),
    ...(options.webSearch === undefined ? {} : { credentials: options.webSearch.credentials }),
    ...(options.webSearch?.settings === undefined ? {} : { settings: options.webSearch.settings }),
  }));
  if (webSearchFetch !== undefined && options.webSearch !== undefined) {
    register(createWebSearchTool({
      fetch: webSearchFetch,
      credentials: options.webSearch.credentials,
      ...(options.webSearch.settings === undefined ? {} : { settings: options.webSearch.settings }),
    }));
    register(createGithubTool({
      fetch: createWebSearchFetch({ network: env?.network ?? unavailableNetwork(), principal: "github" }),
      credentials: options.webSearch.credentials,
    }));
  }
  register(createSkillTool(options.skillLoader === undefined ? {} : { loader: options.skillLoader }));
	register(createTodoTool(options.ledger === undefined ? {} : { ledger: options.ledger }));
	register(createNotebookEditTool());
	if (options.permissionRequester !== undefined) register(createRequestPermissionsTool(options.permissionRequester));
	if (options.askPort !== undefined) register(createAskTool(options.askPort));
	if (options.manageSkill !== undefined) register(createManageSkillTool(options.manageSkill));
	if (options.namedCheckpoint !== undefined) {
		register(createCheckpointTool(options.namedCheckpoint));
		register(createRewindTool(options.namedCheckpoint));
	}
	if (options.imageGeneration !== undefined) register(createImageGenerationTool(options.imageGeneration));
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

function readOperations(env: ExecutionEnv): NonNullable<ReadToolOptions["operations"]> {
	return {
		readFile: (path) => env.fs.readFile(path),
		access: async (path) => { await env.fs.stat(path); },
		stat: async (path) => {
			const value = await env.fs.stat(path);
			return { mtimeMs: value.mtimeMs, size: value.size };
		},
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
		readFile: (path) => env.fs.readFile(path),
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

/** 带 ledger 的 stdlib 视图:todo 的持久化由 createStdlibTools 的 ledger 选项承担。 */
export function createExtendedTools(cwd: string = process.cwd(), taskOptions: { ledger?: import("../ledger/types.ts").LedgerSink } = {}): ToolRegistry {
  return createStdlibTools(cwd, taskOptions);
}

/** AgentTool[] 视图,与 AgentContext.tools 直接相容。 */
export function stdlibTools(cwd: string = process.cwd()): AgentTool[] {
  return createStdlibTools(cwd).toContext();
}

export { createReadTool, createWriteTool, createEditTool, createMultiEditTool, createBashTool, createGrepTool, createGlobTool, createLsTool, createWebFetchTool, createSkillTool, createNotebookEditTool, createTodoTool, createImageGenerationTool };
export { createWebSearchTool };
export { createGithubTool, githubSchema } from "./github.ts";
export type { GitHubToolInput, GithubToolOptions } from "./github.ts";
export type { WebSearchCredentialPort, WebSearchSettings };
export type { TodoToolOptions };
export { createProcessOutputTool, createProcessWaitTool, createWriteStdinTool, createProcessStopTool, createProcessResizeTool };
export { createRequestPermissionsTool } from "../../security/tools/request-permissions.ts";
export { createAskTool, askSchema } from "./ask.ts";
export type { AskToolDetails } from "./ask.ts";
export type { AskAnswers, AskPort, AskQuestion } from "../session-runtime/ask-reverse-request.ts";
export { createManageSkillTool, manageSkillSchema } from "./manage-skill.ts";
export type { ManageSkillPort, ManageSkillToolInput } from "./manage-skill.ts";
export { createCheckpointTool, checkpointSchema } from "./checkpoint.ts";
export type { CheckpointToolInput } from "./checkpoint.ts";
export { createRewindTool, rewindSchema } from "./rewind.ts";
export type { RewindToolInput } from "./rewind.ts";
export type { NamedCheckpointToolPort, CheckpointCreateResult } from "../session-runtime/named-checkpoint-domain.ts";
export { echoTool };
