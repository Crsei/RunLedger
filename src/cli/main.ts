/**
 * RunLedger CLI 主入口 —— 装配 SessionManager / SettingsManager / Agent /
 * InteractiveMode 后启动 TUI。
 *
 * 行为按 §3 计划文档:
 *   1. parseArgs → handle -h/-v
 *   2. compute cwd / 设置 RUNLEDGER_DEBUG
 *   3. loadProjectSettings(cwd)
 *   4. 决定 sessionDir:--session-dir > settings.sessionDir > 默认(.runledger/sessions/)
 *   5. 选择 session 操作:create / continueRecent / open(--session) / forkFrom
 *   6. 装配全部 builtin providers + AuthStorage;无认证时进入 TUI onboarding
 *   7. 构造 systemPrompt(合并 cwd/AGENTS.md 与全局 ~/.runledger/agent/AGENTS.md)
 *   8. 实例化 Agent + InteractiveMode + run
 *   9. finally closeAll ledger
 *
 * Extension 子命令在 session/TUI 装配前走 discovery-only 控制面。
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { InteractiveMode } from "../tui/interactive-mode.ts";
import { selectSessionInTui } from "../tui/session-selector.ts";
import { loadProjectSettings, saveProjectSettings } from "../storage/settings-manager.ts";
import { resolveSessionDir, getGlobalAgentsMd } from "../storage/paths.ts";
import { SessionManager } from "../storage/session-manager.ts";
import { replaySession } from "../storage/session-codec.ts";
import type { SessionReplay } from "../storage/session-codec.ts";
import { AuthStorage } from "../storage/auth-storage.ts";
import { V3SessionManager } from "../storage/v3-session-manager.ts";
import { AuthorityRuntimeManager } from "../storage/authority-runtime-manager.ts";
import {
  createProductionInteractiveRuntime,
  type ProductionInteractiveRuntime,
} from "../storage/production-interactive-runtime.ts";
import { builtinModels } from "../providers/all.ts";
import {
  InteractiveSessionController,
  type InteractiveSessionControllerPort,
} from "../runtime/interactive-session-controller.ts";
import { inspectSessionVersionFence } from "../runtime/session/legacy-migration.ts";
import {
  resolveSessionCliCompatibility,
  type SessionCliAction,
  type SessionFormatVersion,
} from "../runtime/runtime-features.ts";
import { parseArgs, USAGE } from "./args.ts";
import {
  FAIL_CLOSED_STARTUP_AUDITOR,
  forkV3FromCli,
  migrateLegacyFromCli,
  migrationEvidenceDigest,
  openGovernedV3FromCli,
  resolveCliRuntimeConfiguration,
} from "./v3-session-commands.ts";
import { createCliGovernedInteractiveController } from "./interactive-control-plane.ts";
import { createProductionModelRuntime } from "../runtime/integration/production-model-runtime.ts";
import {
  ClassifiedTextContextProvider,
  TrustedTextContextProvider,
} from "../runtime/integration/production-context-providers.ts";
import type { GovernedContextFragmentProvider } from "../runtime/integration/governed-model-request.ts";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId, type AuthorityId, type PrincipalId, type TenantId } from "../runtime/protocol/v3/ids.ts";
import type { StartupExternalReceiptAuditPort } from "../runtime/lifecycle/recovery.ts";
import { createLocalIdentityContext } from "../runtime/identity/local-principal.ts";
import { installCliRuntimeLifecycle, type InstalledCliRuntimeLifecycle } from "./runtime-lifecycle.ts";
import {
  createCliProductionInteractiveOptions,
  productionInteractiveWorkspaceStateRoot,
  productionInteractiveControllerBindings,
  type ProductionInteractiveOptionsProvider,
} from "./production-interactive-options.ts";
import { createProductionStartupExternalReceiptAuditor } from "../storage/production-startup-receipt-auditor.ts";
import { createV3SessionMutationAdmissionGate } from "../storage/v3-runtime-adapter.ts";
import {
  mutationGatedModelPreparation,
  type SessionMutationAdmissionGatePort,
} from "../runtime/lifecycle/mutation-gate.ts";
import { closeCliRuntimeResources } from "./runtime-resource-cleanup.ts";
import {
  parseExtensionCommand,
  type ExtensionCommand,
} from "../extensions/control-plane/commands.ts";
import {
  ExtensionControlPlane,
  renderExtensionControlPlane,
  type ExtensionConfirmationDetails,
  type ExtensionControlPlaneResponse,
} from "../extensions/control-plane/control-plane.ts";
import { createCliExtensionControlPlane } from "../extensions/control-plane/cli-control-plane.ts";

const VERSION = readVersionFromPackage();

const DEFAULT_SYSTEM_PROMPT =
  "You are RunLedger's interactive coding agent inside a TUI. " +
  "Use Read/Write/Edit/Bash/grep/find/ls tools to inspect and modify files. " +
  "Keep replies concise and ask before destructive operations.";

export interface CliMainDependencies {
  /** 嵌入式 deployment 可注入真实 adapters；标准 CLI 缺失时必须 fail closed。 */
  productionInteractiveOptions?: ProductionInteractiveOptionsProvider;
  startupExternalReceiptAuditor?: StartupExternalReceiptAuditPort;
  /** Production workspace/tool-gateway 共用的 durable state root。 */
  startupExternalReceiptStateRoot?: string;
  startupExternalReceiptAuditTimeoutMs?: number;
  /** 部署或测试可注入含 privileged ports 的控制面；默认仅 discovery。 */
  extensionControlPlane?: ExtensionControlPlane;
  /** 测试或嵌入式终端可替换交互确认；返回值必须逐字匹配当前 digest。 */
  extensionConfirmation?: ExtensionConfirmationPort;
}

export interface ExtensionConfirmationPort {
  available(): boolean;
  confirm(details: ExtensionConfirmationDetails): Promise<string | undefined>;
}

export async function main(
  argv: readonly string[],
  dependencies: CliMainDependencies = {},
): Promise<void> {
  const extensionCommand = parseExtensionCommand(argv);
  if (!extensionCommand.ok && "message" in extensionCommand) {
    process.stderr.write(`[runledger] ${extensionCommand.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (extensionCommand.ok) {
    await runExtensionCommand(
      extensionCommand.command,
      dependencies.extensionControlPlane,
      dependencies.extensionConfirmation,
    );
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

  const cwd = process.cwd();
  let settings = await loadProjectSettings(cwd);
  const runtimeConfiguration = resolveCliRuntimeConfiguration(settings);
  const runtimeFeatures = runtimeConfiguration.features;
  const providerWorkspaceStateRoot = productionInteractiveWorkspaceStateRoot(
    dependencies.productionInteractiveOptions,
  );
  const cliWorkspaceStateRoot = args.stateRoot === undefined ? undefined : resolve(args.stateRoot);
  const dependencyWorkspaceStateRoot = dependencies.startupExternalReceiptStateRoot;
  if (
    cliWorkspaceStateRoot !== undefined &&
    dependencyWorkspaceStateRoot !== undefined &&
    cliWorkspaceStateRoot !== dependencyWorkspaceStateRoot
  ) {
    throw new TypeError("CLI and dependency workspace state roots must exactly match");
  }
  const explicitWorkspaceStateRoot = cliWorkspaceStateRoot ?? dependencyWorkspaceStateRoot;
  if (
    dependencies.startupExternalReceiptAuditor !== undefined &&
    (providerWorkspaceStateRoot !== undefined || explicitWorkspaceStateRoot !== undefined)
  ) {
    throw new TypeError("raw startup external receipt auditor cannot be combined with a workspace state root");
  }
  if (
    providerWorkspaceStateRoot !== undefined &&
    explicitWorkspaceStateRoot !== undefined &&
    providerWorkspaceStateRoot !== explicitWorkspaceStateRoot
  ) {
    throw new TypeError("explicit and provider workspace state roots must exactly match");
  }
  const startupExternalReceiptStateRoot = explicitWorkspaceStateRoot ?? providerWorkspaceStateRoot;
  let startupExternalReceiptAuditor = dependencies.startupExternalReceiptAuditor;
  if (startupExternalReceiptAuditor === undefined && startupExternalReceiptStateRoot !== undefined) {
    const identity = createLocalIdentityContext();
    startupExternalReceiptAuditor = await createProductionStartupExternalReceiptAuditor({
      stateRoot: startupExternalReceiptStateRoot,
      authorityId: identity.authorityId,
      tenantId: identity.tenantId,
    });
  }
  if (runtimeConfiguration.requiresHistoryPersistence) {
    settings = {
      ...settings,
      sessionV3HighestActivatedState: runtimeConfiguration.sessionV3HighestActivatedState,
    };
    await saveProjectSettings(cwd, settings);
  }

  const requireSessionAction = (
    sessionVersion: SessionFormatVersion | "new",
    action: SessionCliAction,
  ): 2 | 3 | undefined => {
    const decision = resolveSessionCliCompatibility({
      featureState: runtimeConfiguration.sessionV3State,
      highestActivatedState: runtimeConfiguration.sessionV3HighestActivatedState,
      sessionVersion,
      action,
    });
    if (!decision.allowed) {
      throw new Error(
        `session action denied [${decision.diagnostic}]: ${action} for ${sessionVersion === "new" ? "new session" : `v${sessionVersion}`}`,
      );
    }
    return decision.writeVersion;
  };

  const selectedNewSessionVersion = (): 2 | 3 => {
    const action = args.sessionVersion === 2
      ? "create_v2"
      : args.sessionVersion === 3
        ? "create_v3"
        : "create_default";
    const version = requireSessionAction("new", action);
    if (!version) throw new Error(`session action ${action} did not select a write format`);
    return version;
  };

  const sessionDir =
    args.sessionDir ?? resolveSessionDir(cwd, settings.sessionDir);

  if (args.downgrade) {
    throw new Error("Runtime v3 downgrade is forbidden; use read-only export instead");
  }
  if (args.migrate || args.forkToV3) {
    const sourcePath = args.migrate ?? args.forkToV3!;
    const source = await inspectSessionVersionFence(sourcePath, args.migrate ? "migrate" : "fork-to-v3");
    if (!("format" in source) || source.format !== "legacy" || source.sourceVersion === undefined) {
      throw new Error("legacy session migration requires an intact v1/v2 source");
    }
    requireSessionAction(source.sourceVersion, args.migrate ? "migrate_to_v3" : "fork_to_v3");
    const migrated = await migrateLegacyFromCli({
      sourcePath,
      mode: args.migrate ? "migrate" : "fork-to-v3",
      cwd,
      sessionDir,
      features: runtimeFeatures,
    });
    process.stdout.write(`${JSON.stringify({
      status: "migrated",
      mode: args.migrate ? "migrate" : "fork-to-v3",
      ...migrated,
      evidenceDigest: migrationEvidenceDigest(migrated),
    })}\n`);
    return;
  }

  let legacyManager: SessionManager | undefined;
  let v3Manager: V3SessionManager | undefined;
  let v3MutationGate: SessionMutationAdmissionGatePort | undefined;
  const attachNewV3Manager = (manager: V3SessionManager): void => {
    v3Manager = manager;
    v3MutationGate = createV3SessionMutationAdmissionGate(
      manager,
      startupExternalReceiptAuditor ?? FAIL_CLOSED_STARTUP_AUDITOR,
      dependencies.startupExternalReceiptAuditTimeoutMs === undefined
        ? {}
        : { externalReceiptAuditTimeoutMs: dependencies.startupExternalReceiptAuditTimeoutMs },
    );
  };
  const openSelected = async (filePath: string): Promise<void> => {
    const fence = await inspectSessionVersionFence(filePath, "continue");
    if (!("format" in fence)) {
      throw new Error(`session requires forensic inspection: ${fence.report.message}`);
    }
    if (fence.format === "v3") {
      requireSessionAction(3, "append");
      const governed = await openGovernedV3FromCli({
        filePath,
        features: runtimeFeatures,
        ...(startupExternalReceiptAuditor === undefined
          ? {}
          : { externalReceiptAuditor: startupExternalReceiptAuditor }),
        ...(dependencies.startupExternalReceiptAuditTimeoutMs === undefined
          ? {}
          : { externalReceiptAuditTimeoutMs: dependencies.startupExternalReceiptAuditTimeoutMs }),
      });
      v3Manager = governed.manager;
      v3MutationGate = governed.mutationGate;
      return;
    }
    const sourceVersion = fence.sourceVersion;
    if (sourceVersion === undefined) throw new Error("legacy session version is unavailable");
    const decision = resolveSessionCliCompatibility({
      featureState: runtimeConfiguration.sessionV3State,
      highestActivatedState: runtimeConfiguration.sessionV3HighestActivatedState,
      sessionVersion: sourceVersion,
      action: "append",
    });
    if (!decision.allowed) {
      throw new Error(
        `[${decision.diagnostic}] Legacy session v1/v2 is read-only; use --migrate or --fork-to-v3 before continuing`,
      );
    }
    if (fence.status === "blocked" && fence.format === "unknown") throw new Error(fence.error.message);
    legacyManager = await SessionManager.open(filePath);
  };
  if (args.session) {
    await openSelected(args.session);
  } else if (args.sessionId) {
    const match = (await SessionManager.list(cwd, sessionDir))
      .find((session) => session.id === args.sessionId);
    if (!match) throw new Error(`session id not found: ${args.sessionId}`);
    await openSelected(match.filePath);
  } else if (args.fork) {
    const source = await inspectSessionVersionFence(args.fork, "fork-to-v3");
    if (!("format" in source)) {
      throw new Error(`session requires forensic inspection: ${source.report.message}`);
    }
    if (source.format === "v3") {
      requireSessionAction(3, "fork_to_v3");
      const fork = await forkV3FromCli({
        sourcePath: args.fork,
        cwd,
        sessionDir,
        features: runtimeFeatures,
        ...(startupExternalReceiptAuditor === undefined
          ? {}
          : { externalReceiptAuditor: startupExternalReceiptAuditor }),
        ...(dependencies.startupExternalReceiptAuditTimeoutMs === undefined
          ? {}
          : { externalReceiptAuditTimeoutMs: dependencies.startupExternalReceiptAuditTimeoutMs }),
      });
      await openSelected(fork.filePath);
    } else {
      if (source.sourceVersion !== 2 || runtimeConfiguration.sessionV3State === "default" || runtimeConfiguration.sessionV3State === "required") {
        throw new Error("Legacy session v1/v2 is read-only; use --fork-to-v3 for an explicit v3 fork");
      }
      legacyManager = await SessionManager.forkFrom(args.fork, cwd, sessionDir);
    }
  } else if (args.resume) {
    const sessions = await SessionManager.list(cwd, sessionDir);
    if (sessions.length === 0) {
      process.stderr.write("[runledger] no sessions available to resume\n");
      return;
    }
    const selected = process.stdin.isTTY
      ? await selectSessionInTui(sessions)
      : sessions[0];
    if (!selected) return;
    await openSelected(selected.filePath);
  } else if (args.continueRecent) {
    const sessions = await SessionManager.list(cwd, sessionDir);
    if (sessions[0]) await openSelected(sessions[0].filePath);
    else if (selectedNewSessionVersion() === 3) {
      attachNewV3Manager(await V3SessionManager.create({ cwd, sessionDir, features: runtimeFeatures }));
    } else {
      legacyManager = await SessionManager.create({ cwd, sessionDir, metadata: { cwd } });
    }
  } else {
    if (selectedNewSessionVersion() === 3) {
      attachNewV3Manager(await V3SessionManager.create({ cwd, sessionDir, features: runtimeFeatures }));
    } else {
      legacyManager = await SessionManager.create({ cwd, sessionDir, metadata: { cwd } });
    }
  }
  let lifecycle: InstalledCliRuntimeLifecycle | undefined;
  let productionRuntime: ProductionInteractiveRuntime | undefined;
  let authorityRuntime: AuthorityRuntimeManager | undefined;
  let productionOwnsV3Manager = false;
  let closePromise: Promise<void> | undefined;
  const closeSessionRuntime = (): Promise<void> => {
    const closeOperations: Array<() => Promise<void>> = [];
    const activeProductionRuntime = productionRuntime;
    const activeLegacyManager = legacyManager;
    const activeV3Manager = v3Manager;
    const activeAuthorityRuntime = authorityRuntime;
    if (activeProductionRuntime) {
      closeOperations.push(() => activeProductionRuntime.close());
    } else {
      if (activeLegacyManager) closeOperations.push(() => activeLegacyManager.closeAll());
      if (!productionOwnsV3Manager && activeV3Manager) {
        closeOperations.push(() => activeV3Manager.closeAll());
      }
    }
    if (activeAuthorityRuntime) closeOperations.push(() => activeAuthorityRuntime.close());
    closePromise ??= closeCliRuntimeResources(closeOperations);
    return closePromise;
  };
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  let hasPrimaryFailure = false;
  let hasCleanupFailure = false;
  try {
    await legacyManager?.acquireLock();
    const models = builtinModels({ credentials: AuthStorage.create() });
    await models.refresh({ allowNetwork: false });
    let replay: SessionReplay;
    if (legacyManager) {
      replay = await replaySession(legacyManager.ledger());
    } else if (v3Manager) {
      const recovery = v3Manager.recoveryDecision();
      if (recovery?.kind === "corrupted") throw new Error(`v3 session corrupted: ${recovery.error.message}`);
      if (recovery?.kind === "stopped") throw new Error(`v3 session is stopped: ${recovery.reason}`);
      if (recovery?.kind === "pause_for_approval") {
        throw new Error(`v3 session requires explicit recovery approval: ${recovery.reasons.join(",")}`);
      }
      if (recovery?.kind === "reconciliation_required") {
        throw new Error(`v3 session requires side-effect reconciliation: ${recovery.reasons.join(",")}`);
      }
      replay = {
        messages: [...await v3Manager.replayMessages()],
        config: { ...await v3Manager.replayRuntimeConfig() },
        auditEntries: [],
        warnings: [],
      };
    } else {
      throw new Error("session composition did not produce a runtime");
    }
    let localController: InteractiveSessionController;
    if (v3Manager && runtimeFeatures.daemon) {
      if (!v3MutationGate) throw new Error("daemon interactive mode requires a session mutation gate");
      const productionOptions = await createCliProductionInteractiveOptions({
        cwd,
        manager: v3Manager,
        models,
        mutationGate: v3MutationGate,
      }, dependencies.productionInteractiveOptions, startupExternalReceiptStateRoot);
      // createProductionInteractiveRuntime 从调用开始接管 manager；失败路径也负责关闭。
      productionOwnsV3Manager = true;
      productionRuntime = await createProductionInteractiveRuntime(productionOptions);
      localController = await InteractiveSessionController.create({
        ...productionInteractiveControllerBindings(productionRuntime),
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        models,
        settings,
        replay,
        overrides: {
          provider: args.provider,
          model: args.model,
          thinkingLevel: args.thinking,
        },
      });
    } else {
      const modelRuntime = v3Manager
        ? createProductionModelRuntime({
            models,
            sessionEvents: v3Manager.sessionEvents(),
            identity: {
              authorityId: v3Manager.identity().authorityId,
              tenantId: v3Manager.identity().tenantId,
              principalId: v3Manager.identity().principalId,
              sessionId: v3Manager.sessionId(),
            },
            fragmentProviders: governedInstructionProviders(cwd, {
              authorityId: v3Manager.identity().authorityId,
              tenantId: v3Manager.identity().tenantId,
              principalId: v3Manager.identity().principalId,
            }),
          })
        : undefined;
      localController = await InteractiveSessionController.create({
        cwd,
        // v3 的原始 prompt 必须由 BasePromptContextProvider 唯一收编；
        // repository/user instruction 将在分类 provider 接线后单独注入。
        systemPrompt: v3Manager ? DEFAULT_SYSTEM_PROMPT : buildSystemPrompt(cwd),
        models,
        settings,
        replay,
        ledger: legacyManager?.ledger(),
        sessionId: v3Manager?.sessionId(),
        sessionEvents: v3Manager?.sessionEvents(),
        toolResultArtifactSink: v3Manager?.toolResultArtifactSink(),
        prepareModelRequest: modelRuntime && v3MutationGate
          ? mutationGatedModelPreparation(v3MutationGate, modelRuntime.prepare)
          : modelRuntime?.prepare,
        overrides: {
          provider: args.provider,
          model: args.model,
          thinkingLevel: args.thinking,
        },
      });
    }
    let controller: InteractiveSessionControllerPort = localController;
    if (runtimeFeatures.daemon) {
      if (!v3Manager || !productionRuntime) {
        throw new Error("daemon interactive mode requires an active production Runtime v3 composition");
      }
      authorityRuntime = await AuthorityRuntimeManager.open({
        cwd,
        identity: v3Manager.identity(),
        runtimeId: v3Manager.runtimeId(),
      });
      controller = await createCliGovernedInteractiveController({
        controller: localController,
        manager: v3Manager,
        authorityRuntime,
        featureEvidence: productionRuntime.featureEvidence,
      });
    }
    const interactive = new InteractiveMode({ controller });
    const lifecycleScope = v3Manager
      ? {
          authorityId: v3Manager.identity().authorityId,
          tenantId: v3Manager.identity().tenantId,
          runtimeId: v3Manager.runtimeId(),
        }
      : {
          authorityId: createRuntimeId("authority", "runledger-local-authority"),
          tenantId: createRuntimeId("tenant", "runledger-local-tenant"),
          runtimeId: createRuntimeId("runtime", canonicalDigest({
            pid: process.pid,
            sessionId: controller.sessionId,
            cwd,
          }).slice(0, 48)),
        };
    lifecycle = installCliRuntimeLifecycle({
      scope: lifecycleScope,
      controller,
      surface: interactive,
      writer: {
        close: closeSessionRuntime,
      },
      onFatal: () => { process.exitCode = 1; },
    });
    try {
      await interactive.run();
    } catch (runError) {
      await lifecycle.terminalError(runError);
      throw runError;
    }
    const shutdown = lifecycle.pending();
    if (shutdown) {
      const receipt = await shutdown;
      if (!receipt.ok || receipt.value.recoveryRequired) {
        process.exitCode = 1;
        process.stderr.write("[runledger] shutdown completed with recovery-required participants\n");
      }
    }
  } catch (error) {
    hasPrimaryFailure = true;
    primaryFailure = error;
  } finally {
    lifecycle?.dispose();
    try {
      await closeSessionRuntime();
    } catch (error) {
      hasCleanupFailure = true;
      cleanupFailure = error;
    }
    if (process.env.RUNLEDGER_DEBUG === "1") {
      process.stderr.write(
        `[runledger] exit. session=${legacyManager?.filePath() ?? v3Manager?.filePath() ?? "unknown"}\n`,
      );
    }
  }
  if (hasPrimaryFailure && hasCleanupFailure) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      "CLI execution failed and session cleanup was incomplete",
    );
  }
  if (hasPrimaryFailure) throw primaryFailure;
  if (hasCleanupFailure) throw cleanupFailure;
}

async function runExtensionCommand(
  command: ExtensionCommand,
  injected?: ExtensionControlPlane,
  injectedConfirmation?: ExtensionConfirmationPort,
): Promise<void> {
  const controlPlane = injected ?? await createCliExtensionControlPlane(process.cwd());
  let response = await controlPlane.execute(command);
  const confirmation = injectedConfirmation ?? processExtensionConfirmation();
  const details = confirmationDetails(response);
  if (
    response.error?.code === "confirmation_required" &&
    details &&
    confirmation.available()
  ) {
    const typedDigest = await confirmation.confirm(details);
    if (typedDigest === details.digest) {
      response = await controlPlane.execute({
        ...command,
        yes: true,
        digest: details.digest,
      });
    } else if (typedDigest !== undefined) {
      response = {
        schemaVersion: 1,
        ok: false,
        exitCode: 5,
        error: {
          code: "confirmation_rejected",
          message: "typed digest did not match; operation was not performed",
        },
      };
    }
  }
  const rendered = `${renderExtensionControlPlane(response, command.json)}\n`;
  if (command.json || response.ok) process.stdout.write(rendered);
  else process.stderr.write(rendered);
  if (response.exitCode !== 0) process.exitCode = response.exitCode;
}

function confirmationDetails(
  response: ExtensionControlPlaneResponse,
): ExtensionConfirmationDetails | undefined {
  if (typeof response.data !== "object" || response.data === null) return undefined;
  if (!("confirmation" in response.data)) return undefined;
  const value = response.data.confirmation;
  if (typeof value !== "object" || value === null) return undefined;
  if (
    !("operation" in value) ||
    !("identity" in value) ||
    !("digest" in value) ||
    !("capabilities" in value) ||
    typeof value.operation !== "string" ||
    typeof value.identity !== "string" ||
    typeof value.digest !== "string" ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every((item) => typeof item === "string")
  ) return undefined;
  return {
    operation: value.operation,
    identity: value.identity,
    digest: value.digest,
    capabilities: value.capabilities,
  };
}

function processExtensionConfirmation(): ExtensionConfirmationPort {
  return {
    available: () => Boolean(process.stdin.isTTY && process.stderr.isTTY),
    confirm: async (details) => {
      process.stderr.write(
        [
          `[runledger] privileged Extension operation: ${details.operation}`,
          `identity: ${details.identity}`,
          `digest: ${details.digest}`,
          `capabilities: ${details.capabilities.length > 0 ? details.capabilities.join(", ") : "none declared"}`,
        ].join("\n") + "\n",
      );
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await prompt.question("Type the exact digest to confirm (blank cancels): ");
        return answer.trim() || undefined;
      } finally {
        prompt.close();
      }
    },
  };
}

/**
 * 构造系统提示:DEFAULT + cwd 下 AGENTS.md(若存在) + 全局 ~/.runledger/agent/AGENTS.md(若存在)。
 *
 * 本期不向上扫祖先链(pi 也是按 ancestor chain,本期仅在 cwd 与 global 两点
 * 读 AGENTS.md;TODO(pi):祖先链扫描加 M8 后续 PR)。
 */
function buildSystemPrompt(cwd: string): string {
  const parts: string[] = [DEFAULT_SYSTEM_PROMPT];
  const localAg = getProjectAgentsMd(cwd);
  if (localAg && existsSync(localAg)) {
    try {
      parts.push(readFileSync(localAg, "utf8"));
    } catch {
      // 读失败静默
    }
  }
  const globalAg = getGlobalAgentsMd();
  if (globalAg && existsSync(globalAg)) {
    try {
      parts.push(readFileSync(globalAg, "utf8"));
    } catch {
      // 读失败静默
    }
  }
  return parts.join("\n\n---\n\n");
}

function governedInstructionProviders(
  cwd: string,
  identity: { authorityId: AuthorityId; tenantId: TenantId; principalId: PrincipalId },
): GovernedContextFragmentProvider[] {
  const providers: GovernedContextFragmentProvider[] = [];
  const observedAt = new Date().toISOString();
  const globalPath = getGlobalAgentsMd();
  if (globalPath && existsSync(globalPath)) {
    try {
      const content = readFileSync(globalPath, "utf8");
      const sourceDigest = canonicalDigest(content);
      providers.push(new TrustedTextContextProvider({
        key: "global-agents",
        content,
        principalId: identity.principalId,
        source: {
          schemaVersion: 1,
          authorityId: identity.authorityId,
          tenantId: identity.tenantId,
          sourceId: createRuntimeId("inputSource", `global-agents-${sourceDigest.slice(0, 48)}`),
          kind: "user",
          sourceDigest,
          trust: "trusted",
          taintLabels: [],
          observedAt,
        },
      }));
    } catch {
      // 读失败时不创建无来源 fragment。
    }
  }
  const localPath = getProjectAgentsMd(cwd);
  if (existsSync(localPath)) {
    try {
      const content = readFileSync(localPath, "utf8");
      const sourceDigest = canonicalDigest(content);
      providers.push(new ClassifiedTextContextProvider({
        key: "repository-agents",
        content,
        source: {
          schemaVersion: 1,
          authorityId: identity.authorityId,
          tenantId: identity.tenantId,
          sourceId: createRuntimeId("inputSource", `repository-agents-${sourceDigest.slice(0, 48)}`),
          kind: "instruction",
          sourceDigest,
          trust: "tainted",
          taintLabels: ["repository_controlled", "executable_instruction"],
          observedAt,
        },
        declassificationReceipts: [],
      }));
    } catch {
      // repository instruction 不可读取时 fail closed，不回退隐式拼接。
    }
  }
  return providers;
}

/**
 * 本仓库存在 `<cwd>/AGENTS.md`(本期属项目说明,被纳入 systemPrompt 推动 agent),
 * 与 `.runledger/` 子树区别:这是 codex 仓库惯例的 AGENTS.md。
 */
function getProjectAgentsMd(cwd: string = process.cwd()): string {
  return join(cwd, "AGENTS.md");
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
