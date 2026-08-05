/**
 * RunLedger CLI 主入口 —— 解析参数、连接 resident Runtime Host、装配 remote
 * session facade / OpenTUI 后启动 TUI。
 *
 * 行为按 §3 计划文档:
 *   1. parseArgs → handle -h/-v
 *   2. compute cwd / 设置 RUNLEDGER_DEBUG
 *   3. resolve one RunledgerLayout and load canonical settings
 *   4. authenticated connect-or-spawn 到 workspace Runtime Host
 *   5. 通过 Host request 选择 session:create / continue / open / resume / fork
 *   6. 构造 remote controller、订阅事件并尝试 claim driver
 *   7. 通过同一 Host facade 装配 managed-process overlay
 *   8. InteractiveMode.run；退出时只 detach 当前 client
 *
 * Extension/Plan/Context/Memory 控制命令也只经 Host domain port；客户端不
 * 装配 manager、approval waiter 或第二 writer。
 */

import { readFileSync } from "node:fs";
import { InteractiveMode } from "../tui/interactive-mode.ts";
import { loadProjectSettings } from "../storage/settings-manager.ts";
import { resolveRunledgerHome } from "../storage/runledger-home.ts";
import { RemoteInteractiveSessionController, type HostRequestTransport, type RemoteSessionSnapshot } from "../runtime/host/remote-session.ts";
import type { HostFrameEnvelope } from "../runtime/host/types.ts";
import { createProcessOverlayController } from "../tui/process/controller-adapter.ts";
import { parseArgs, USAGE } from "./args.ts";
import type { SecurityConfigDocument } from "../security/types.ts";
import { validateLegacyCliEnvironment } from "./authority.ts";
import { runMigrateCommand } from "./migrate.ts";
import { runWorkspaceCommand } from "./workspace-command.ts";
import { connectProductionRuntimeHost } from "./runtime-host-production.ts";
import { createProductionProcessOverlayClient } from "./runtime-host-client.ts";
import {
	controlCommandBody,
	controlCommandHelp,
	controlCommandQueryOperation,
	parseControlCommand,
	type ControlCommand,
} from "./control-commands.ts";

const VERSION = readVersionFromPackage();

export async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === "migrate") {
    await runMigrateCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "workspace") {
    await runWorkspaceCommand(argv.slice(1));
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
  const { layout } = await resolveRunledgerHome();
  const settings = await loadProjectSettings({ layout });
  const securityOverride = cliSecurityOverride(args);
  let interactive: InteractiveMode | undefined;
  const host = await connectProductionRuntimeHost({
    layout,
    cwd,
    settings,
    ...(securityOverride === undefined ? {} : { securityOverride }),
		...(args.noWorktree ? { workspaceBindingMode: "disabled" as const } : {}),
    reverseRequestHandler: (frame, signal) => interactive?.handleReverseRequest(frame, signal) ?? { ok: false, code: "approval_ui_unavailable" },
  });
  const transport: HostRequestTransport = {
    request: host.request,
    onEvent: host.onEvent,
    notify: host.notify,
  };
  const open = await requestHostCommand(transport, "session.open", {
    mode: sessionOpenMode(args),
    ...(args.session === undefined ? {} : { sessionPath: args.session }),
    ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
    ...(args.fork === undefined ? {} : { sessionPath: args.fork }),
    cwd,
    ...(args.provider === undefined ? {} : { provider: args.provider }),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.thinking === undefined ? {} : { thinkingLevel: args.thinking }),
  });
  if (open.body.ok === false) {
    await host.close().catch(() => undefined);
    throw new Error(responseCode(open));
  }
  const sessionId = stringValue(open.body.sessionId);
  if (!sessionId) {
    await host.close().catch(() => undefined);
    throw new Error("Host session id is missing");
  }
	let openedBody = open.body;
	if (args.worktree !== undefined) {
		openedBody = await bindHostWorktreeSession(transport, sessionId, openedBody, cwd, args);
	}
	if (parsedControl?.ok === true) {
		await runControlCommand(transport, sessionId, openedBody, parsedControl.command);
		await host.close().catch(() => undefined);
		return;
	}
	  const snapshot = parseRemoteSnapshot(openedBody.snapshot, sessionId);
	  const controller = new RemoteInteractiveSessionController(transport, {
	    ...snapshot,
	    hostGeneration: integerValue(openedBody.hostGeneration) ?? host.endpoint.hostGeneration,
	    sessionGeneration: integerValue(openedBody.sessionGeneration) ?? 1,
	    driverRevision: integerValue(openedBody.driverRevision) ?? 0,
	    eventCursor: integerValue(openedBody.eventCursor) ?? 0,
	  });
  let removeSigint: (() => void) | undefined;
  let removeStdinEnd: (() => void) | undefined;
  try {
	    await controller.resumeEvents();
	    const claim = await requestHostCommand(transport, "session.claim_driver", {
	      sessionId,
	      ...controller.driverFence(),
	    });
	    let isDriver = claim.body.ok === true;
	    controller.updateDriverFence({
	      hostGeneration: integerValue(claim.body.hostGeneration),
	      sessionGeneration: integerValue(claim.body.sessionGeneration),
	      driverRevision: integerValue(claim.body.driverRevision),
	    });
	    const processOverlay = createProcessOverlayController(
	      createProductionProcessOverlayClient(transport, sessionId, { isDriver: () => isDriver, driverFence: () => controller.driverFence() }),
      { driver: isDriver },
    );
    const activeInteractive = new InteractiveMode({ controller, processOverlayController: processOverlay });
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
    isDriver = false;
  } finally {
    removeSigint?.();
    removeStdinEnd?.();
    controller.dispose();
    await host.close().catch(() => {
      // client detach 失败不阻断退出；resident Host 不由 client 关闭。
    });
    if (process.env.RUNLEDGER_DEBUG === "1") {
      process.stderr.write(`[runledger] exit. session=${sessionId}\n`);
    }
  }
}

/** CLI security flags → 最高优先级 `cli` 层 document；无 flags 时 undefined。 */
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

/**
 * `--worktree [label]` 经 Host 控制面创建/复用 session worktree；client 不
 * 直接运行 Git 或写 registry。创建失败即报错退出（显式请求不能静默降级）。
 */
export async function bindHostWorktreeSession(
	transport: HostRequestTransport,
	sessionId: string,
	openedBody: Record<string, unknown>,
	cwd: string,
	args: ReturnType<typeof parseArgs>["args"],
): Promise<Record<string, unknown>> {
	const inspected = await requestHostCommand(transport, "worktree.inspect", { sessionId });
	if (inspected.body.ok !== true) throw new Error(responseCode(inspected));
	const domainRevision = integerValue(inspected.body.domainRevision) ?? 0;
	const claimed = await requestHostCommand(transport, "session.claim_driver", {
		sessionId,
		expectedHostGeneration: integerValue(openedBody.hostGeneration) ?? 1,
		expectedSessionGeneration: integerValue(openedBody.sessionGeneration) ?? 1,
		expectedDriverRevision: integerValue(openedBody.driverRevision) ?? 0,
	});
	if (claimed.body.ok !== true) throw new Error(responseCode(claimed));
	const label = args.worktree === "" ? "default" : args.worktree;
	const created = await requestHostCommand(transport, "worktree.create", {
		sessionId,
		expectedHostGeneration: integerValue(claimed.body.hostGeneration),
		expectedSessionGeneration: integerValue(claimed.body.sessionGeneration),
		expectedDriverRevision: integerValue(claimed.body.driverRevision),
		expectedDomainRevision: domainRevision,
		sourceCwd: cwd,
		label,
		...(args.worktreeRef === undefined ? {} : { baseRef: args.worktreeRef }),
		...(args.worktreeBranch === undefined ? {} : { branch: args.worktreeBranch }),
	});
	if (created.body.ok !== true) throw new Error(responseCode(created));
	const rebound = await requestHostCommand(transport, "session.rebind_workspace", {
		sessionId,
		expectedHostGeneration: integerValue(claimed.body.hostGeneration),
		expectedSessionGeneration: integerValue(claimed.body.sessionGeneration),
		expectedDriverRevision: integerValue(claimed.body.driverRevision),
	});
	if (rebound.body.ok !== true) throw new Error(responseCode(rebound));
	process.stderr.write(`[runledger] worktree bound: ${label}\n`);
	return rebound.body;
}

function sessionOpenMode(args: ReturnType<typeof parseArgs>["args"]): "create" | "open" | "continue_recent" | "resume" | "fork" {
  if (args.session !== undefined || args.sessionId !== undefined) return "open";
  if (args.fork !== undefined) return "fork";
  if (args.resume) return "resume";
  if (args.continueRecent) return "continue_recent";
  return "create";
}

async function requestHostCommand(
  transport: HostRequestTransport,
  operation: string,
  body: Record<string, unknown>,
): Promise<HostFrameEnvelope> {
  const frameId = `client_command_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return transport.request({
    frameId,
    kind: "command_request",
    protocolVersion: 1,
    body: { operation, commandId: frameId, ...body },
  });
}

async function runControlCommand(
	transport: HostRequestTransport,
	sessionId: string,
	openedBody: Record<string, unknown>,
	command: ControlCommand,
): Promise<void> {
	let inspectedBody: Record<string, unknown> = {};
	let domainRevision = 0;
	const queryOperation = controlCommandQueryOperation(command);
	if (queryOperation !== undefined) {
		const inspected = await requestHostCommand(transport, queryOperation, { sessionId });
		if (inspected.body.ok !== true) throw new Error(responseCode(inspected));
		inspectedBody = inspected.body;
		domainRevision = integerValue(inspected.body.domainRevision) ?? 0;
	}
	let fence = {
		expectedHostGeneration: integerValue(openedBody.hostGeneration) ?? 1,
		expectedSessionGeneration: integerValue(openedBody.sessionGeneration) ?? 1,
		expectedDriverRevision: integerValue(openedBody.driverRevision) ?? 0,
	};
	if (command.mutation) {
		const claimed = await requestHostCommand(transport, "session.claim_driver", { sessionId, ...fence });
		if (claimed.body.ok !== true) throw new Error(responseCode(claimed));
		fence = {
			expectedHostGeneration: integerValue(claimed.body.hostGeneration) ?? fence.expectedHostGeneration,
			expectedSessionGeneration: integerValue(claimed.body.sessionGeneration) ?? fence.expectedSessionGeneration,
			expectedDriverRevision: integerValue(claimed.body.driverRevision) ?? fence.expectedDriverRevision,
		};
	}
	const request = {
		operation: command.group === "remember" ? "memory.propose" : command.group === "plan" && command.action === "approve" ? "plan.resolve_approval" : `${command.group}.${command.action}`,
		body: controlCommandBody(command, domainRevision, inspectedBody),
	};
	const response = await requestHostCommand(transport, request.operation, {
		sessionId,
		...(command.mutation ? fence : {}),
		...request.body,
	});
	process.stdout.write(`${JSON.stringify({ operation: request.operation, ...response.body })}\n`);
	if (response.body.ok === false) throw new Error(responseCode(response));
}

function parseRemoteSnapshot(
  value: unknown,
  fallbackSessionId: string | undefined,
): Omit<RemoteSessionSnapshot, "hostGeneration" | "sessionGeneration" | "driverRevision" | "eventCursor"> {
  if (!isRecord(value)) throw new Error("Host session snapshot is invalid");
  const sessionId = stringValue(value.sessionId) ?? fallbackSessionId;
  if (!sessionId) throw new Error("Host session id is missing");
  const selection = isRecord(value.selection) && typeof value.selection.thinkingLevel === "string"
    ? value.selection as unknown as RemoteSessionSnapshot["selection"]
    : { thinkingLevel: "off" as const };
  return {
    sessionId,
    selection,
    messages: Array.isArray(value.messages) ? value.messages as RemoteSessionSnapshot["messages"] : [],
    warnings: Array.isArray(value.warnings) ? value.warnings.filter((item): item is string => typeof item === "string") : [],
    auditEntries: Array.isArray(value.auditEntries) ? value.auditEntries as RemoteSessionSnapshot["auditEntries"] : [],
    toolCount: integerValue(value.toolCount) ?? 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function responseCode(response: HostFrameEnvelope): string {
  return typeof response.body.code === "string" ? response.body.code : "host_request_rejected";
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
