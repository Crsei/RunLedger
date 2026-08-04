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
 * 本期不实现 trust-manager / extensions / skills / themes 加载。
 */

import { readFileSync } from "node:fs";
import { InteractiveMode } from "../tui/interactive-mode.ts";
import { loadProjectSettings } from "../storage/settings-manager.ts";
import { resolveRunledgerHome } from "../storage/runledger-home.ts";
import { RemoteInteractiveSessionController, type HostRequestTransport, type RemoteSessionSnapshot } from "../runtime/host/remote-session.ts";
import type { HostFrameEnvelope } from "../runtime/host/types.ts";
import { createProcessOverlayController } from "../tui/process/controller-adapter.ts";
import { parseArgs, USAGE } from "./args.ts";
import { validateLegacyCliEnvironment } from "./authority.ts";
import { runMigrateCommand } from "./migrate.ts";
import { connectProductionRuntimeHost } from "./runtime-host-production.ts";
import { createProductionProcessOverlayClient } from "./runtime-host-client.ts";

const VERSION = readVersionFromPackage();

export async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === "migrate") {
    await runMigrateCommand(argv.slice(1));
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

  const unsupportedEnvironment = validateLegacyCliEnvironment();
  if (unsupportedEnvironment) {
    process.stderr.write(`[runledger] ${unsupportedEnvironment}\n`);
    process.exit(2);
  }

  const cwd = process.cwd();
  const { layout } = await resolveRunledgerHome();
  const settings = await loadProjectSettings({ layout });
  let interactive: InteractiveMode | undefined;
  const host = await connectProductionRuntimeHost({
    layout,
    cwd,
    settings,
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
	  const snapshot = parseRemoteSnapshot(open.body.snapshot, sessionId);
	  const controller = new RemoteInteractiveSessionController(transport, {
	    ...snapshot,
	    hostGeneration: integerValue(open.body.hostGeneration) ?? host.endpoint.hostGeneration,
	    sessionGeneration: integerValue(open.body.sessionGeneration) ?? 1,
	    driverRevision: integerValue(open.body.driverRevision) ?? 0,
	    eventCursor: integerValue(open.body.eventCursor) ?? 0,
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
