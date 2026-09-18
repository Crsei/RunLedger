import { readRequestDump, requestDumpErrorMessage } from "../runtime/request-dump-reader.ts";
import type { RequestDumpView } from "../runtime/model-request-snapshots.ts";
import type { RuntimeSelectionOverrides } from "../runtime/interactive-session-controller.ts";
import type { LoopResetHandoff } from "../runtime/loop/handoff.ts";
import { createKimiCodeDeviceIdProvider } from "../storage/kimi-device-id.ts";
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

import { readFileSync, writeSync } from "node:fs";
import { runHeadless } from "./headless.ts";
import { mkdir } from "node:fs/promises";
import { registerConfiguredProxyProvidersFromHome } from "../providers/configured-proxy.ts";
import { runtimeWorkspacePlatform } from "../workspace/runtime-platform.ts";
import { capabilityRowFor } from "../workspace/capability.ts";
import { InteractiveMode } from "../tui/interactive-mode.ts";
import { loadLayeredProjectSettings, loadProjectSettings } from "../storage/settings-manager.ts";
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
	controlCommandRequest,
	parseControlCommand,
	type ControlCommand,
} from "./control-commands.ts";
import { openSessionDatabase } from "../storage/session-store/database.ts";
import { checkStoreCompatibility, readStoreHeader } from "../storage/session-store/schema-compatibility.ts";
import { installSessionStoreSchema, SESSION_STORE_SCHEMA_VERSION } from "../storage/session-store/schema.ts";
import { SessionStore } from "../storage/session-store/session-store.ts";
import { resolveAgentMode, type AgentMode } from "../runtime/harness-profiles/agent-mode.ts";
import { isHarnessProfileRef, type HarnessProfileRef } from "../runtime/harness-profiles/index.ts";
import { OwnerStore } from "../storage/session-store/owner-store.ts";
import { createEmbeddedSessionRuntime, type EmbeddedSessionRuntimeResult, type SessionWorkspaceFactory } from "./embedded-session-runtime.ts";
import { SessionInteractiveController, type SessionInteractiveSnapshot } from "./session-interactive-controller.ts";
import { builtinModels } from "../providers/all.ts";
import { AuthStorage } from "../storage/auth-storage.ts";
import { createRuntimeId, parseRuntimeId, type SessionId } from "../runtime/protocol/ids.ts";
import { runtimeDigest } from "../runtime/protocol/foundation.ts";
import type { SecurityConfigDocument } from "../security/types.ts";
import type { SessionSecurityConfigSource } from "../security/session-composition.ts";
import { SESSION_PROTOCOL_VERSION } from "../runtime/session-server/protocol.ts";
import { runSessionTransitionLoop } from "./session-transition-loop.ts";
import { formatExitSummary } from "./exit-summary.ts";
import type { UsageSnapshot } from "../runtime/usage/index.ts";
import { createCliTuiPreferences } from "./tui-preferences.ts";
import { createCliPromptDumpPort } from "./prompt-dump-artifacts.ts";
import { composeCliTraceRecorderFactory } from "./trace-config.ts";
import { createSessionWorkspaceFactory } from "../runtime/session-runtime/worktree-composition.ts";
import { createWorkspaceAdaptersForCurrentPlatform } from "../workspace/factory.ts";
import { createProductionGitCommandPort } from "./session-git-command.ts";
import type { GitCommandPort } from "../worktree/ports.ts";
import { JsonlWorktreeRegistryStore, WorktreeRegistry } from "../worktree/registry.ts";
import {
  createProcessOverlayController,
  createSessionProcessOverlayClient,
  type ProcessOverlayController,
  type ProcessOverlayHostClient,
} from "../tui/process/controller-adapter.ts";
import { createCliSyntaxThemeSettings } from "./syntax-theme-settings.ts";
import { composeCliSyntaxThemes } from "./syntax-theme-composition.ts";
import { gitWorkspaceDisplayFacts, workspaceDisplayAbsolutePathForView } from "./workspace-display-label.ts";
import { workspaceStorageKey } from "../runtime/contracts/storage-layout.ts";
import { createCliSessionModelRequestRouterFactory } from "./session-model-router.ts";
import { runWebCommand } from "./web-cli.ts";
import { runAuthGatewayCommand } from "./auth-gateway-cli.ts";
import { createCliHideThinkingSettings, resolveHideThinkingBlock } from "./hide-thinking-settings.ts";
import {
	assertSessionWorkspaceMatches,
	resolveSessionWorkspaceIdentity,
	sessionWorkspaceMatches,
	type SessionWorkspaceIdentity,
} from "./session-workspace-identity.ts";

const VERSION = readVersionFromPackage();

/** P6:TUI 启动 notice 使用的 workspace/path 能力标签(真实 runner 证据,不宣称 sandbox)。 */
function workspaceCapabilityLabel(): string {
	const platform = runtimeWorkspacePlatform();
	const row = capabilityRowFor(platform);
	return `ws:${platform}-${row.adapterAvailable ? "verified" : "unverified"}`;
}

export async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === "web") {
    try { await runWebCommand(argv.slice(1)); }
    catch (error) { process.stderr.write(`[runledger] ${error instanceof Error ? error.message : "web failed"}\n`); process.exitCode = 2; }
    return;
  }
  if (argv[0] === "auth-gateway") {
    try {
      await runAuthGatewayCommand(argv.slice(1));
    } catch (error) {
      process.stderr.write(`[runledger] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    }
    return;
  }
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

  const headlessPrompt = args.promptFile === undefined ? undefined : readFileSync(args.promptFile, "utf8");
  if (headlessPrompt !== undefined && !headlessPrompt.trim()) throw new Error("--prompt-file must not be empty");
  const cwd = process.cwd();
  const { resolution, layout } = await resolveRunledgerHome();
  // 默认 home(<userHome>/.runledger)需要首启创建;显式 RUNLEDGER_DIR 必须
  // 已是既有目录(createDefault=false)。openSessionDatabase 会 stat 父目录,
  // 缺失时 fail closed,所以必须先建目录。
  if (resolution.createDefault) {
    await mkdir(layout.home, { recursive: true, mode: 0o700 });
  }
  const settings = await loadProjectSettings({ layout });
  const syntaxThemes = await composeCliSyntaxThemes(layout, settings.theme);
  const tuiPreferences = await createCliTuiPreferences(layout);
  if (tuiPreferences.startupDiagnostic !== undefined) {
    process.stderr.write(`[runledger] ${tuiPreferences.startupDiagnostic.code}; using hidden transcript scrollbar\n`);
  }
  const traceRecorderFactory = composeCliTraceRecorderFactory(layout, settings);

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
  if (compatibility.ok && compatibility.header.storeVersion < SESSION_STORE_SCHEMA_VERSION) {
    db.close();
    process.stderr.write(`[runledger] session store schema ${compatibility.header.storeVersion} requires explicit migration: stop active sessions, then run 'runledger migrate schema --confirm'\n`);
    process.exit(2);
    return;
  }
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
	const authorityId = createRuntimeId("authority", "session-owner-runtime");
	const tenantId = createRuntimeId("tenant", "local-user");
	const worktreeGit = createProductionGitCommandPort();

	let sessionId: SessionId;
	let currentWorkspace: SessionWorkspaceIdentity;
	try {
		currentWorkspace = await resolveSessionWorkspaceIdentity(cwd, worktreeGit);
		sessionId = await resolveSessionId(store, args, cwd, worktreeGit, settings.agentMode);
  } catch (error) {
    db.close();
    process.stderr.write(`[runledger] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
    return;
  }
  const workspaceStorageKeyFor = (targetSessionId: SessionId): string => {
    const catalog = store.getSession(targetSessionId);
    if (catalog === undefined) throw new Error(`session not found while loading workspace scope: ${targetSessionId}`);
    return workspaceStorageKey({
	  authorityId,
	  tenantId,
      workspaceId: parseRuntimeId("workspace", catalog.workspaceId) ?? createRuntimeId("workspace", runtimeDigest(catalog.workspaceId).digest),
      repositoryId: parseRuntimeId("repository", catalog.repositoryId) ?? createRuntimeId("repository", runtimeDigest(catalog.repositoryId).digest),
    });
	};
  const multiAgentPolicySourcesFor = async (targetSessionId: SessionId) => {
	const key = workspaceStorageKeyFor(targetSessionId);
    const layered = await loadLayeredProjectSettings({ layout, workspaceKey: key });
    const source = (layer: typeof layered.user) => layer.multiAgent.state === "valid"
      ? layer.multiAgent.value
      : layer.multiAgent.state === "invalid" ? layer.multiAgent.raw : undefined;
    return {
      runtimeEnabled: args.experimentalMultiAgent,
      user: source(layered.user),
      workspace: source(layered.workspace),
    };
  };

  const models = builtinModels({ credentials: AuthStorage.create(layout) }, { kimiCode: { getDeviceId: createKimiCodeDeviceIdProvider(layout) } });
  await registerConfiguredProxyProvidersFromHome(models, layout.home);
  await models.refresh({ allowNetwork: false });
  const modelRequestRouters = await createCliSessionModelRequestRouterFactory({ layout, authorityId, tenantId, models });
	const worktreeRegistry = new WorktreeRegistry(new JsonlWorktreeRegistryStore(layout));
  const workspaceFactoryFor = async (targetSessionId: string): Promise<SessionWorkspaceFactory | undefined> => {
    const record = store.getSession(targetSessionId);
    if (record?.worktreeLocator !== undefined && args.noWorktree) {
      throw new Error("session is bound to a worktree; --no-worktree cannot bypass the persisted binding");
    }
    const requiresWorktree = record?.worktreeLocator !== undefined || args.worktree !== undefined;
    if (!requiresWorktree) return undefined;
    await mkdir(layout.worktrees, { recursive: true, mode: 0o700 });
    const adapters = createWorkspaceAdaptersForCurrentPlatform({ git: worktreeGit, managedRoot: layout.worktrees });
    if (!adapters.ok) throw new Error(`session worktree unavailable: ${adapters.error.code}: ${adapters.error.message}`);
    return createSessionWorkspaceFactory({
      layout,
      sourceCwd: cwd,
      mode: args.noWorktree ? "disabled" : args.worktree === undefined ? "auto" : "create",
      ...(args.worktree === undefined ? {} : { label: args.worktree }),
      ...(args.worktreeRef === undefined ? {} : { baseRef: args.worktreeRef }),
      ...(args.worktreeBranch === undefined ? {} : { branch: args.worktreeBranch }),
      git: worktreeGit,
      registry: worktreeRegistry,
      workspace: adapters.value,
    });
  };
  const selectionOverridesBySession = new Map<string, RuntimeSelectionOverrides>();
  const loopHandoffsBySession = new Map<string, LoopResetHandoff>();
  const retainedTransitionSources = new Set<string>();
  const ownedRuntimeRegistry = new Map<string, EmbeddedSessionRuntimeResult>();
  const openView = async (targetSessionId: string): Promise<CliSessionView> => {
	const target = store.getSession(targetSessionId);
	if (target === undefined) throw new Error(`session not found: ${targetSessionId}`);
	// /resume 的 Domain admission 只是第一道门；任何 view composition 都必须
	// 在使用 cwd、tools、security scope 之前复验同一 binding。
	assertSessionWorkspaceMatches(target, currentWorkspace);
	const typedSessionId = targetSessionId as SessionId;
	const workspaceStorageKey = workspaceStorageKeyFor(typedSessionId);
    const embedded = await createEmbeddedSessionRuntime({
	  sessionId: typedSessionId,
      store,
      ownerStore,
	  workspace: await workspaceFactoryFor(targetSessionId),
	  domain: {
        cwd,
        layout,
        settings,
        models,
		traceRecorderFactory,
		modelRequestRouter: modelRequestRouters.forSession({ sessionId: typedSessionId, workspaceStorageKey }),
		isModelSelectable: modelRequestRouters.isModelSelectable,
		multiAgent: await multiAgentPolicySourcesFor(typedSessionId),
        overrides: selectionOverridesBySession.get(targetSessionId) ?? {
          ...(args.provider === undefined ? {} : { provider: args.provider }),
          ...(args.model === undefined ? {} : { model: args.model }),
          ...(args.thinking === undefined ? {} : { thinkingLevel: args.thinking }),
        },
        securitySources: cliSecuritySources(args),
      },
    });
    if (embedded.runtime !== undefined) ownedRuntimeRegistry.set(targetSessionId, embedded);
    const snapshot = await fetchDomainSnapshot(embedded);
    const controller = new SessionInteractiveController(embedded.handle, snapshot);
    await controller.resumeEvents();
    const role = await claimDriver(embedded, controller);
    const processOverlayClient = createSessionProcessOverlayClient(controller);
    const processOverlayController = processOverlayClient === undefined
      ? undefined
      : createProcessOverlayController(processOverlayClient, { driver: role === "driver" });
    return {
	  sessionId: targetSessionId,
	  embedded,
	  controller,
	  processOverlayClient,
	  processOverlayController,
	  harnessProfile: snapshot.harnessProfile,
	  harnessToolNames: snapshot.harnessToolNames,
	  permissionProfile: snapshot.permissionProfile,
	};
  };

  let initialView: CliSessionView;
  try {
    initialView = await openView(sessionId);
  } catch (error) {
    db.close();
    process.stderr.write(`[runledger] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
    return;
  }

  if (parsedControl?.ok === true) {
    try {
      await runControlCommand(initialView.controller, parsedControl.command);
    } finally {
	  initialView.controller.dispose();
	  await initialView.embedded.handle.close().catch(() => undefined);
	  await pauseIfLastAttachment(initialView.embedded, true);
      db.close();
    }
    return;
  }

  if (headlessPrompt !== undefined) {
    const abort = new AbortController();
    const onSignal = () => abort.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      await runHeadless(initialView.controller, headlessPrompt, {
        signal: abort.signal,
        write: (event) => { writeSync(1, JSON.stringify(event) + "\n"); },
      });
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      initialView.controller.dispose();
      await initialView.embedded.handle.close().catch(() => undefined);
      await pauseIfLastAttachment(initialView.embedded, true);
      db.close();
    }
    return;
  }

  let firstView: CliSessionView | undefined = initialView;
  let exitUsage: UsageSnapshot | undefined;
  let showWelcomeOnNextView = sessionOpenMode(args) === "create";
  try {
    await runSessionTransitionLoop<CliSessionView>({
      initialSessionId: sessionId,
      open: async (targetSessionId) => {
        if (firstView !== undefined && firstView.sessionId === targetSessionId) {
          const view = firstView;
          firstView = undefined;
          return view;
        }
        return openView(targetSessionId);
      },
      run: runInteractiveView,
	  onQuit: (view) => {
		if (exitUsage === undefined) return;
		const summary = formatExitSummary({
			sessionId: view.sessionId,
			resumable: view.embedded.store.getSession(view.sessionId) !== undefined,
			usage: exitUsage,
			...(process.env.RUNLEDGER_DIR === undefined ? {} : { runledgerDir: layout.home }),
		});
		if (summary !== "") process.stdout.write(summary);
	  },
      detach: async (view) => {
        view.controller.dispose();
        await view.embedded.handle.close().catch(() => undefined);
        await pauseIfLastAttachment(view.embedded, false, retainedTransitionSources.has(view.sessionId));
        if (view.embedded.runtime !== undefined && (view.embedded.runtime.runtimeState === "stopping" || view.embedded.runtime.runtimeState === "fenced")) {
          await view.embedded.runtime.waitForStopped();
          ownedRuntimeRegistry.delete(view.sessionId);
        }
      },
      onSwitchFailure: ({ fromSessionId, targetSessionId, error }) => {
        process.stderr.write(`[runledger] switch ${fromSessionId} -> ${targetSessionId} failed; reopening original Session: ${error instanceof Error ? error.message : String(error)}\n`);
      },
    });
  } finally {
    // 退出最后一个 renderer 后，进程继续托管仍有 remote attachment 的 owned Runtime；
    // 每个 Runtime 的 count=0 回调最终执行 checkpoint/pause/release。
    await Promise.all([...ownedRuntimeRegistry.values()].map(async (entry) => {
      if (entry.runtime === undefined) return;
      if (entry.server.connectionCounts() === 0) await entry.runtime.shutdownAfterLastAttachment("paused");
      await entry.runtime.waitForStopped();
      if (entry.ownerFence !== undefined && !retainedTransitionSources.has(entry.ownerFence.sessionId)) entry.store.reclaimSessionWithoutUserMessages(entry.ownerFence);
    }));
    db.close();
    if (process.env.RUNLEDGER_DEBUG === "1") {
      process.stderr.write("[runledger] exit. all owned Session runtimes stopped\n");
    }
  }

  async function runInteractiveView(view: CliSessionView) {
	const showWelcome = showWelcomeOnNextView;
	showWelcomeOnNextView = false;
	const effectiveCwd = view.embedded.effectiveCwd;
	const gitDisplay = effectiveCwd === undefined
	  ? {}
	  : await gitWorkspaceDisplayFacts(effectiveCwd, worktreeGit);
    const activeInteractive = new InteractiveMode({
      loopHandoff: loopHandoffsBySession.get(view.sessionId),
      controller: view.controller,
      workspaceCapability: workspaceCapabilityLabel(),
      workspaceDisplayAbsolutePath: workspaceDisplayAbsolutePathForView({ effectiveCwd }),
      gitBranchLabel: gitDisplay.branchLabel,
      syntaxThemeName: settings.theme,
      uiTheme: settings.uiTheme,
      syntaxThemeController: syntaxThemes.controller,
      syntaxThemeSettingsPort: createCliSyntaxThemeSettings(layout, syntaxThemes.customThemeNames),
      syntaxThemeWarnings: syntaxThemes.takeWarnings(),
      processOverlayController: view.processOverlayController,
      processOverlayClient: view.processOverlayClient,
      initialPreferences: tuiPreferences.current(),
      preferencesPort: tuiPreferences.port,
      promptDumpPort: createCliPromptDumpPort(layout),
      hideThinkingBlock: resolveHideThinkingBlock(args.hideThinking, settings.hideThinkingBlock),
      hideThinkingSettingsPort: createCliHideThinkingSettings(layout),
      showWelcome,
      version: VERSION,
      logoLetters: settings.logo,
	  harnessProfile: view.harnessProfile,
	  harnessToolNames: view.harnessToolNames,
	  permissionProfile: view.permissionProfile,
    });
    loopHandoffsBySession.delete(view.sessionId);
    view.embedded.handle.transport.setReverseRequestHandler((frame, signal) => activeInteractive.handleSessionReverseRequest(frame, signal));
    const onSigint = (): void => {
      if (view.controller.inFlight) view.controller.interrupt();
      else activeInteractive.quit();
    };
    const onStdinEnd = (): void => activeInteractive.quit();
    process.on("SIGINT", onSigint);
    process.stdin.once("end", onStdinEnd);
    if (process.stdin.readableEnded) queueMicrotask(onStdinEnd);
    try {
      const intent = await activeInteractive.run();
      if (intent.kind === "quit") exitUsage = activeInteractive.getUsageSnapshot();
      if (intent.kind === "switch") retainedTransitionSources.add(view.sessionId);
      if (intent.kind === "switch" && intent.action === "new") {
        if (intent.loopHandoff !== undefined) loopHandoffsBySession.set(intent.target.sessionId, intent.loopHandoff);
        const selection = view.controller.currentSelection;
        const overrides: RuntimeSelectionOverrides = {
          ...(selection.provider === undefined ? {} : { provider: selection.provider }),
          ...(selection.model === undefined ? {} : { model: selection.model.id }),
          thinkingLevel: selection.thinkingLevel,
        };
        selectionOverridesBySession.set(intent.target.sessionId, overrides);
        selectionOverridesBySession.set(view.sessionId, overrides);
      }
      return intent;
    } finally {
      process.off("SIGINT", onSigint);
      process.stdin.off("end", onStdinEnd);
    }
  }
}

interface CliSessionView {
  readonly sessionId: string;
  readonly embedded: EmbeddedSessionRuntimeResult;
  readonly controller: SessionInteractiveController;
  readonly processOverlayClient: ProcessOverlayHostClient | undefined;
  readonly processOverlayController: ProcessOverlayController | undefined;
	readonly harnessProfile: HarnessProfileRef;
	readonly harnessToolNames?: readonly string[];
	readonly permissionProfile: string;
}

/**
 * §8.3/P0-3:只有本进程是 owner 且本地 view 是最后一个 attachment 时才
 * pause/checkpoint/release;remote attachment 仍存在时不得无条件终止 owner
 * (attachment count 决定 runtime lifetime)。attach 分支(runtime undefined)
 * 或 owner 已在 count=0 回调中 pause 时均为幂等空操作。
 */
export async function pauseIfLastAttachment(embedded: EmbeddedSessionRuntimeResult, waitForRemote = true, retainSession = false): Promise<void> {
  const runtime = embedded.runtime;
  if (runtime === undefined) return;
  if (!waitForRemote) {
    // switch path 只等待本地 socket close 事件入队；remote attachment 不阻塞下一轮 TUI。
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (embedded.server.connectionCounts() > 0) {
      if (process.env.RUNLEDGER_DEBUG === "1") {
        process.stderr.write(`[runledger] local view detached; ${embedded.server.connectionCounts()} remote attachment(s) keep the owner headless\n`);
      }
      return;
    }
    await runtime.shutdownAfterLastAttachment("paused");
    if (embedded.ownerFence !== undefined && !retainSession) embedded.store.reclaimSessionWithoutUserMessages(embedded.ownerFence);
    return;
  }
  // 等待本地 socket close 事件被 server 处理(attachment count 收敛到真值)。
  const deadline = Date.now() + 2_000;
  while (embedded.server.connectionCounts() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (embedded.server.connectionCounts() > 0) {
    if (process.env.RUNLEDGER_DEBUG === "1") {
      process.stderr.write(`[runledger] local view detached; ${embedded.server.connectionCounts()} remote attachment(s) keep the owner running\n`);
    }
    if (waitForRemote) {
      await runtime.waitForStopped();
      if (embedded.ownerFence !== undefined && !retainSession) embedded.store.reclaimSessionWithoutUserMessages(embedded.ownerFence);
    }
    return;
  }
  await runtime.shutdownAfterLastAttachment("paused");
  if (embedded.ownerFence !== undefined && !retainSession) embedded.store.reclaimSessionWithoutUserMessages(embedded.ownerFence);
}

/** §8.1/§8.2:从 SQLite catalog resolve sessionId(create/open/resume/fork)。 */
export async function resolveSessionId(
	store: SessionStore,
	args: ReturnType<typeof parseArgs>["args"],
	cwd: string,
	git?: GitCommandPort,
	defaultMode?: AgentMode,
): Promise<SessionId> {
	const mode = sessionOpenMode(args);
	if (mode !== "create" && (args.harnessProfile !== undefined || args.mode !== undefined)) {
		throw new Error("--mode / --harness-profile is only valid when creating a new Session");
	}
	const workspace = await resolveSessionWorkspaceIdentity(cwd, git);
	if (mode === "create") {
		const profile = resolveAgentMode(args.mode ?? (args.harnessProfile === "standard" ? "default" : args.harnessProfile) ?? defaultMode ?? "default");
		if (!profile.ok) throw new Error(profile.code);
		const sessionId = createRuntimeId("session", `cwd-${cwd.replace(/[^A-Za-z0-9._~-]/g, "_").slice(0, 40)}-${Date.now().toString(36)}`);
		store.createSession({
			sessionId,
			workspaceId: workspace.workspaceId,
			repositoryId: workspace.repositoryId,
			settingsDigest: "d".repeat(64),
			harnessProfile: profile.ref,
			sourceWorkspaceLocator: workspace.sourceWorkspaceLocator,
		});
		return sessionId;
	}
	if (mode === "open") {
		if (args.sessionId !== undefined) {
			const record = store.getSession(args.sessionId);
			if (!record) throw new Error(`session not found: ${args.sessionId}`);
			assertSessionWorkspaceMatches(record, workspace);
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
		assertSessionWorkspaceMatches(source, workspace);
		const sessionId = createRuntimeId("session", `fork-${args.fork.slice(-16)}-${Date.now().toString(36)}`);
		store.forkSession({
			sessionId,
			sourceSessionId: source.sessionId as SessionId,
			inheritCompaction: args.forkRaw !== true,
			...(args.forkAt === undefined ? {} : { throughSequence: args.forkAt }),
		});
		return sessionId;
	}
	// resume / continue_recent:从 SQLite catalog 选最近 session。
	const candidates = store.listSessions().filter((record) =>
		(record.status === "active" || record.status === "paused" || record.status === "recovery_required")
		&& sessionWorkspaceMatches(record, workspace),
	);
	const recent = candidates.sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
	if (recent === undefined) throw new Error("no session matches the current workspace binding; create a new Session or use explicit rebind/migrate");
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
		protocolVersion: SESSION_PROTOCOL_VERSION,
		body: { kind: "snapshot", body: {} },
	});
	if (response.kind !== "query_result" || response.body.ok !== true) {
		throw new Error("session snapshot query rejected");
	}
	const body = response.body as Record<string, unknown>;
	if (!isHarnessProfileRef(body.harnessProfile)) throw new Error("session snapshot has an invalid harness profile");
	if (typeof body.permissionProfile !== "string" || body.permissionProfile.length === 0) {
		throw new Error("session snapshot has an invalid permission profile");
	}
	return {
		sessionId: embedded.handle.sessionId,
		harnessProfile: body.harnessProfile,
		permissionProfile: body.permissionProfile,
		messages: Array.isArray(body.messages) ? (body.messages as never[]) : [],
		warnings: Array.isArray(body.warnings) ? (body.warnings as string[]) : [],
		auditEntries: Array.isArray(body.auditEntries) ? (body.auditEntries as never[]) : [],
		selection: (body.selection ?? { thinkingLevel: "off" }) as SessionInteractiveSnapshot["selection"],
		harnessToolNames: Array.isArray(body.harnessToolNames) && body.harnessToolNames.every((name) => typeof name === "string") ? body.harnessToolNames : undefined,
		toolCount: typeof body.toolCount === "number" ? body.toolCount : 0,
		compactionInFlight: body.compactionInFlight === true,
		eventCursor: typeof body.headSequence === "number" && Number.isSafeInteger(body.headSequence) ? body.headSequence : 0,
		driverRevision: 0,
		agentRuns: Array.isArray(body.agentRuns) ? body.agentRuns as SessionInteractiveSnapshot["agentRuns"] : [],
	};
}

/** 本地第一个 client claim driver(connection-scoped authority)。 */
export async function claimDriver(embedded: EmbeddedSessionRuntimeResult, _controller: SessionInteractiveController): Promise<"driver" | "observer"> {
	const response = await embedded.handle.transport.request({
		frameId: `driver_claim_${Date.now().toString(36)}`,
		kind: "command_request",
		protocolVersion: SESSION_PROTOCOL_VERSION,
		body: { commandId: `command_${Date.now().toString(36)}`, kind: "driver_claim", body: {} },
	});
	if (response.body.ok === true) {
		_controller.setConnectionRole("driver");
		return "driver";
	}
	if (response.body.code === "driver_revision_conflict") {
		_controller.setConnectionRole("observer");
		return "observer";
	}
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
	const correlationId = `control_${Date.now().toString(36)}`;
	let effectSequence = 0;
	const directRequest = controlCommandRequest(command);
	if (command.group === "dump") {
		const result = await readRequestDump(directRequest.body.view as RequestDumpView, (payload) => controller.querySessionDomain("session.request.inspect", payload, {
			correlationId, effectId: `control_dump_${++effectSequence}`,
		}));
		if (!result.ok) {
			process.stderr.write(`${requestDumpErrorMessage(result.code).replaceAll("/dump", "runledger dump")}\n`);
			process.exitCode = 1;
			return;
		}
		process.stderr.write(`${JSON.stringify(result.dump.metadata)}\n`);
		process.stdout.write(result.dump.content);
		return;
	}
	if (!directRequest.mutation) {
		const response = await controller.querySessionDomain(directRequest.operation, directRequest.body, {
			correlationId,
			effectId: "control_query_1",
		});
		writeControlResult(response);
		return;
	}
	const queryOperation = controlCommandQueryOperation(command);
	let inspectedBody: Record<string, unknown> = {};
	let domainRevision = 0;
	if (queryOperation !== undefined) {
		effectSequence += 1;
		const inspected = await controller.querySessionDomain(queryOperation, {}, { correlationId, effectId: `control_query_${effectSequence}` });
		if (!inspected.ok) {
			writeControlResult(inspected);
			return;
		}
		inspectedBody = inspected.value;
		domainRevision = inspected.domainRevision;
	}
	const request = {
		operation: directRequest.operation,
		body: controlCommandBody(command, domainRevision, inspectedBody),
	};
	effectSequence += 1;
	const response = await controller.commandSessionDomain(request.operation, { ...request.body }, {
		correlationId,
		effectId: `control_command_${effectSequence}`,
		expectedRevision: domainRevision,
	});
	writeControlResult(response);
}

/** 保留结构化错误，同时让 shell 可判断失败；退出前仍完成 Session 清理。 */
function writeControlResult(response: { readonly ok: boolean }): void {
	process.stdout.write(`${JSON.stringify(response)}\n`);
	if (!response.ok) process.exitCode = 1;
}

/** CLI security flags → 最高优先级 `cli` 层 document;无 flags 时 undefined。 */
export function cliSecurityOverride(args: ReturnType<typeof parseArgs>["args"]): SecurityConfigDocument | undefined {
  if (args.permissionProfile === undefined && args.approvalPolicy === undefined &&
      args.bashAnalyzer === undefined && args.sandbox === undefined && args.network === undefined) return undefined;
  return {
    ...(args.permissionProfile === undefined ? {} : { profile: args.permissionProfile }),
    ...(args.approvalPolicy === undefined ? {} : {
      approvalPolicy: args.approvalPolicy,
      ...(args.approvalPolicy === "granular" ? {
        granularApproval: {
          sandboxApproval: true,
          rules: true,
          skillApproval: true,
          requestPermissions: true,
          mcpElicitations: true,
        },
      } : {}),
    }),
    ...(args.bashAnalyzer === undefined ? {} : { bashAnalyzerMode: args.bashAnalyzer }),
    ...(args.sandbox === undefined ? {} : { sandbox: args.sandbox }),
    ...(args.network === undefined ? {} : { network: { mode: args.network, allowedHosts: args.networkHosts } }),
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
