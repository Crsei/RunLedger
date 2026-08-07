/**
 * RunLedger CLI 主入口(R7:Session Owner path)。
 *
 * 行为:
 *   1. parseArgs → handle -h/-v / migrate / workspace / storage
 *   2. resolve one RunledgerLayout and load canonical settings
 *   3. open/verify state.db schema compatibility(fail closed)
 *   4. resolve sessionId:create / open / resume / fork(§8 语义)
 *   5. attach/claim owner → embedded SessionRuntime + localhost TCP facade
 *   6. TUI 经 SessionInteractiveController 观察同一 runtime(driver claim 后
 *      mutation 权限走 connection-scoped driver)
 *   7. InteractiveMode.run();退出时 detach + 最后 attachment pause/checkpoint
 *
 * 标准入口不再 import/call 任何 runtime-host-*、Host socket/election/writer
 * lease;没有 feature flag 或 legacy fallback。
 */

import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { runtimeWorkspacePlatform } from "../workspace/runtime-platform.ts";
import { capabilityRowFor } from "../workspace/capability.ts";
import { InteractiveMode } from "../tui/interactive-mode.ts";
import { loadProjectSettings } from "../storage/settings-manager.ts";
import { resolveRunledgerHome } from "../storage/runledger-home.ts";
import { parseArgs, USAGE } from "./args.ts";
import { validateLegacyCliEnvironment } from "./authority.ts";
import { runMigrateCommand } from "./migrate.ts";
import { runWorkspaceCommand } from "./workspace-command.ts";
import { runPruneLegacyCommand } from "./session-store-migrate.ts";
import {
	controlCommandBody,
	controlCommandHelp,
	controlCommandQueryOperation,
	parseControlCommand,
	type ControlCommand,
} from "./control-commands.ts";
import { openSessionDatabase } from "../storage/session-store/database.ts";
import { checkStoreCompatibility, readStoreHeader } from "../storage/session-store/schema-compatibility.ts";
import { installSessionStoreSchema } from "../storage/session-store/schema.ts";
import { SessionStore } from "../storage/session-store/session-store.ts";
import { OwnerStore } from "../storage/session-store/owner-store.ts";
import { createEmbeddedSessionRuntime, type EmbeddedSessionRuntimeResult } from "./embedded-session-runtime.ts";
import { SessionInteractiveController, type SessionInteractiveSnapshot } from "./session-interactive-controller.ts";
import { builtinModels } from "../providers/all.ts";
import { AuthStorage } from "../storage/auth-storage.ts";
import { createRuntimeId, type SessionId } from "../runtime/protocol/ids.ts";
import type { SecurityConfigDocument } from "../security/types.ts";
import type { SessionSecurityConfigSource } from "../security/session-composition.ts";

const VERSION = readVersionFromPackage();

/** P6:Footer 展示的 workspace/path 能力标签(真实 runner 证据,不宣称 sandbox)。 */
function workspaceCapabilityLabel(): string {
	const platform = runtimeWorkspacePlatform();
	const row = capabilityRowFor(platform);
	return `ws:${platform}-${row.adapterAvailable ? "verified" : "unverified"}`;
}

export async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === "migrate") {
    await runMigrateCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "workspace") {
    await runWorkspaceCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "storage") {
    if (argv[1] === "prune-legacy") {
      await runPruneLegacyCommand(argv.slice(2));
      return;
    }
    process.stderr.write(`[runledger] storage 子命令不存在: ${argv[1] ?? ""}\n`);
    process.exit(2);
    return;
  }
  const { args, error } = parseArgs(argv);
  if (error) {
    process.stderr.write(`[runledger] ${error}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.version) {
    process.stdout.write(`runledger ${VERSION}\n`);
    return;
  }
  if (args.debug) {
    process.env.RUNLEDGER_DEBUG = "1";
  }

  const parsedControl = parseControlCommand(args.positional);
  if (parsedControl && !parsedControl.ok) {
    process.stderr.write(`[runledger] ${parsedControl.error}\n\n${controlCommandHelp()}\n`);
    process.exit(2);
  }

  const unsupportedEnvironment = validateLegacyCliEnvironment();
  if (unsupportedEnvironment) {
    process.stderr.write(`[runledger] ${unsupportedEnvironment}\n`);
    process.exit(2);
  }

  const cwd = process.cwd();
  const { resolution, layout } = await resolveRunledgerHome();
  // 默认 home(<userHome>/.runledger)需要首启创建;显式 RUNLEDGER_DIR 必须
  // 已是既有目录(createDefault=false)。openSessionDatabase 会 stat 父目录,
  // 缺失时 fail closed,所以必须先建目录。
  if (resolution.createDefault) {
    await mkdir(layout.home, { recursive: true, mode: 0o700 });
  }
  const settings = await loadProjectSettings({ layout });

  // §4.2:owner discovery 前只读冻结 schema header;too-new/too-old 全部 fail closed。
  // 首次运行(fresh 空库)直接安装首个 schema;非空库 missing_header 视为损坏。
  const db = openSessionDatabase(layout.database);
  const header = readStoreHeader(db);
  if (!header.ok && header.code === "missing_header") {
    const tables = db.querySingle("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'");
    if (tables === undefined || Number(tables.n) === 0) {
      installSessionStoreSchema(db);
    } else {
      db.close();
      process.stderr.write("[runledger] state.db is not a valid session store; run 'runledger migrate session-store --confirm-archive' or inspect the file\n");
      process.exit(2);
      return;
    }
  }
  const compatibility = checkStoreCompatibility(db);
  if (!compatibility.ok) {
    db.close();
    process.stderr.write(`[runledger] ${compatibility.detail}\n`);
    process.exit(2);
  }
  if (compatibility.header.admission !== "ready") {
    db.close();
    process.stderr.write("[runledger] store is migration_blocked; resume or abort the offline migration first\n");
    process.exit(2);
  }
  const store = new SessionStore(db);
  const ownerStore = new OwnerStore(db);

  let embedded: EmbeddedSessionRuntimeResult;
  let sessionId: SessionId;
  try {
    sessionId = await resolveSessionId(store, args, cwd);
    const models = builtinModels({ credentials: AuthStorage.create(layout) });
    await models.refresh({ allowNetwork: false });
    embedded = await createEmbeddedSessionRuntime({
      sessionId,
      store,
      ownerStore,
      domain: {
        cwd,
        layout,
        settings,
        models,
        overrides: {
          ...(args.provider === undefined ? {} : { provider: args.provider }),
          ...(args.model === undefined ? {} : { model: args.model }),
          ...(args.thinking === undefined ? {} : { thinkingLevel: args.thinking }),
        },
        securitySources: cliSecuritySources(args),
      },
    });
  } catch (error) {
    db.close();
    process.stderr.write(`[runledger] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
    return;
  }

  const snapshot = await fetchDomainSnapshot(embedded);
  const controller = new SessionInteractiveController(embedded.handle, snapshot);
  await controller.resumeEvents();
  // 首个 client 成为 driver；冲突表示本连接是合法 observer。
  await claimDriver(embedded, controller);

  if (parsedControl?.ok === true) {
    try {
      await runControlCommand(controller, parsedControl.command);
    } finally {
      controller.dispose();
      await embedded.handle.close().catch(() => undefined);
      await pauseIfLastAttachment(embedded);
      db.close();
    }
    return;
  }

  let interactive: InteractiveMode | undefined;
  let removeSigint: (() => void) | undefined;
  let removeStdinEnd: (() => void) | undefined;
  try {
    const activeInteractive = new InteractiveMode({ controller, workspaceCapability: workspaceCapabilityLabel() });
    interactive = activeInteractive;
    const onSigint = (): void => {
      if (controller.inFlight) controller.interrupt();
      else activeInteractive.quit();
    };
    process.on("SIGINT", onSigint);
    removeSigint = () => process.off("SIGINT", onSigint);
    const onStdinEnd = (): void => activeInteractive.quit();
    process.stdin.once("end", onStdinEnd);
    removeStdinEnd = () => process.stdin.off("end", onStdinEnd);
    if (process.stdin.readableEnded) queueMicrotask(onStdinEnd);
    await activeInteractive.run();
  } finally {
    removeSigint?.();
    removeStdinEnd?.();
    controller.dispose();
    // 先 detach；只有 attachment 归零的 owner shutdown 才中断领域执行。
    await embedded.handle.close().catch(() => undefined);
    await pauseIfLastAttachment(embedded);
    db.close();
    if (process.env.RUNLEDGER_DEBUG === "1") {
      process.stderr.write(`[runledger] exit. session=${sessionId}\n`);
    }
  }
}

/**
 * §8.3/P0-3:只有本进程是 owner 且本地 view 是最后一个 attachment 时才
 * pause/checkpoint/release;remote attachment 仍存在时不得无条件终止 owner
 * (attachment count 决定 runtime lifetime)。attach 分支(runtime undefined)
 * 或 owner 已在 count=0 回调中 pause 时均为幂等空操作。
 */
export async function pauseIfLastAttachment(embedded: EmbeddedSessionRuntimeResult): Promise<void> {
  const runtime = embedded.runtime;
  if (runtime === undefined) return;
  // 等待本地 socket close 事件被 server 处理(attachment count 收敛到真值)。
  const deadline = Date.now() + 2_000;
  while (embedded.server.connectionCounts() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (embedded.server.connectionCounts() > 0) {
    if (process.env.RUNLEDGER_DEBUG === "1") {
      process.stderr.write(`[runledger] local view detached; ${embedded.server.connectionCounts()} remote attachment(s) keep the owner running\n`);
    }
    await runtime.waitForStopped();
    return;
  }
  await runtime.shutdownAfterLastAttachment("paused");
}

/** §8.1/§8.2:从 SQLite catalog resolve sessionId(create/open/resume/fork)。 */
export async function resolveSessionId(
	store: SessionStore,
	args: ReturnType<typeof parseArgs>["args"],
	cwd: string,
): Promise<SessionId> {
	const mode = sessionOpenMode(args);
	if (mode === "create") {
		const sessionId = createRuntimeId("session", `cwd-${cwd.replace(/[^A-Za-z0-9._~-]/g, "_").slice(0, 40)}-${Date.now().toString(36)}`);
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "default"),
			repositoryId: createRuntimeId("repository", "default"),
			settingsDigest: "d".repeat(64),
		});
		return sessionId;
	}
	if (mode === "open") {
		if (args.sessionId !== undefined) {
			const record = store.getSession(args.sessionId);
			if (!record) throw new Error(`session not found: ${args.sessionId}`);
			return record.sessionId as SessionId;
		}
		// --session <path> 是 legacy JSONL 路径:新 Runtime 不读取,要求显式迁移。
		if (args.session !== undefined) {
			throw new Error(`legacy JSONL session path requires explicit 'runledger migrate session-store --confirm-archive' first: ${args.session}`);
		}
		throw new Error("--session-id required for open");
	}
	if (mode === "fork") {
		if (args.fork === undefined) throw new Error("--fork <sessionId> required");
		const source = store.getSession(args.fork);
		if (!source) throw new Error(`fork source not found: ${args.fork}`);
		const sessionId = createRuntimeId("session", `fork-${args.fork.slice(-16)}-${Date.now().toString(36)}`);
		store.forkSession({
			sessionId,
			sourceSessionId: source.sessionId as SessionId,
			workspaceId: source.workspaceId,
			repositoryId: source.repositoryId,
			settingsDigest: source.settingsDigest,
		});
		return sessionId;
	}
	// resume / continue_recent:从 SQLite catalog 选最近 session。
	const candidates = store.listSessions().filter((record) => record.status === "active" || record.status === "paused" || record.status === "recovery_required");
	const recent = candidates.sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
	if (recent === undefined) throw new Error("no session to resume; create a new session first");
	return recent.sessionId as SessionId;
}

function sessionOpenMode(args: ReturnType<typeof parseArgs>["args"]): "create" | "open" | "continue_recent" | "resume" | "fork" {
  if (args.session !== undefined || args.sessionId !== undefined) return "open";
  if (args.fork !== undefined) return "fork";
  if (args.resume) return "resume";
  if (args.continueRecent) return "continue_recent";
  return "create";
}

/** R7:通过 TCP facade 拉取 TUI 初始投影(snapshot 查询)。 */
export async function fetchDomainSnapshot(embedded: EmbeddedSessionRuntimeResult): Promise<SessionInteractiveSnapshot> {
	const response = await embedded.handle.transport.request({
		frameId: `init_snapshot_${Date.now().toString(36)}`,
		kind: "query_request",
		protocolVersion: 1,
		body: { kind: "snapshot", body: {} },
	});
	if (response.kind !== "query_result" || response.body.ok !== true) {
		throw new Error("session snapshot query rejected");
	}
	const body = response.body as Record<string, unknown>;
	return {
		sessionId: embedded.handle.sessionId,
		messages: Array.isArray(body.messages) ? (body.messages as never[]) : [],
		warnings: Array.isArray(body.warnings) ? (body.warnings as string[]) : [],
		auditEntries: Array.isArray(body.auditEntries) ? (body.auditEntries as never[]) : [],
		selection: (body.selection ?? { thinkingLevel: "off" }) as SessionInteractiveSnapshot["selection"],
		toolCount: typeof body.toolCount === "number" ? body.toolCount : 0,
		eventCursor: 0,
		driverRevision: 0,
	};
}

/** 本地第一个 client claim driver(connection-scoped authority)。 */
export async function claimDriver(embedded: EmbeddedSessionRuntimeResult, _controller: SessionInteractiveController): Promise<"driver" | "observer"> {
	const response = await embedded.handle.transport.request({
		frameId: `driver_claim_${Date.now().toString(36)}`,
		kind: "command_request",
		protocolVersion: 1,
		body: { commandId: `command_${Date.now().toString(36)}`, kind: "driver_claim", body: {} },
	});
	if (response.body.ok === true) return "driver";
	if (response.body.code === "driver_revision_conflict") return "observer";
	if (response.body.ok !== true) {
		throw new Error(`driver claim rejected: ${String(response.body.code ?? "unknown")}`);
	}
	return "observer";
}

/** 控制命令(headless):经 domain_command 执行,TUI 之外的标准入口。 */
export async function runControlCommand(
	controller: SessionInteractiveController,
	command: ControlCommand,
): Promise<void> {
	const queryOperation = controlCommandQueryOperation(command);
	let inspectedBody: Record<string, unknown> = {};
	let domainRevision = 0;
	if (queryOperation !== undefined) {
		inspectedBody = await controller.queryHostDomain(queryOperation, {});
		domainRevision = integerValue(inspectedBody.domainRevision) ?? 0;
	}
	const request = {
		operation: command.group === "remember" ? "memory.propose" : command.group === "plan" && command.action === "approve" ? "plan.resolve_approval" : `${command.group}.${command.action}`,
		body: controlCommandBody(command, domainRevision, inspectedBody),
	};
	const response = await controller.commandHostDomain(request.operation, { ...request.body });
	process.stdout.write(`${JSON.stringify({ operation: request.operation, ...response })}\n`);
}

/** CLI security flags → 最高优先级 `cli` 层 document;无 flags 时 undefined。 */
export function cliSecurityOverride(args: ReturnType<typeof parseArgs>["args"]): SecurityConfigDocument | undefined {
  if (args.permissionProfile === undefined && args.approvalPolicy === undefined &&
      args.sandbox === undefined && args.network === undefined) return undefined;
  return {
    ...(args.permissionProfile === undefined ? {} : { profile: args.permissionProfile }),
    ...(args.approvalPolicy === undefined ? {} : { approvalPolicy: args.approvalPolicy }),
    ...(args.sandbox === undefined ? {} : { sandbox: args.sandbox }),
    ...(args.network === undefined ? {} : { network: { mode: args.network, allowedHosts: [] } }),
  };
}

/** CLI 安全参数是 Session Security 的最高优先级配置层。 */
export function cliSecuritySources(
	args: ReturnType<typeof parseArgs>["args"],
): readonly SessionSecurityConfigSource[] {
	const document = cliSecurityOverride(args);
	if (document === undefined) return [];
	return [{
		source: "cli",
		read: async () => ({ status: "available", text: JSON.stringify(document) }),
	}];
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** 版本号从 package.json 读取;失败兜底 0.0.0-unknown */
function readVersionFromPackage(): string {
  try {
    const here = new URL(".", import.meta.url);
    const pkgUrl = new URL("../../package.json", here);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
}
