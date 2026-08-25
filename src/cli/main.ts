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
import { registerConfiguredProxyProvidersFromHome } from "../providers/configured-proxy.ts";
import { runtimeWorkspacePlatform } from "../workspace/runtime-platform.ts";
import { capabilityRowFor } from "../workspace/capability.ts";
import { InteractiveMode } from "../tui/interactive-mode.ts";
import { loadLayeredProjectSettings, loadProjectSettings } from "../storage/settings-manager.ts";
import { SettingsRuntimeStore } from "../storage/settings-runtime-store.ts";
import type { EffectiveRuntimeSettingsSnapshot } from "../storage/settings-resolver.ts";
import type { TaskPolicyProjection } from "../storage/settings-policies.ts";
import { RunledgerHomeError, resolveRunledgerHome } from "../storage/runledger-home.ts";
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
import { checkStoreCompatibility, migrateSessionStoreV1ToV2, readStoreHeader } from "../storage/session-store/schema-compatibility.ts";
import { installSessionStoreSchema } from "../storage/session-store/schema.ts";
import { SessionStore } from "../storage/session-store/session-store.ts";
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
import { createCliTuiPreferences } from "./tui-preferences.ts";
import { composeCliTraceRecorderFactory } from "./trace-config.ts";
import { createSessionWorkspaceFactory } from "../runtime/session-runtime/worktree-composition.ts";
import { createWorkspaceAdaptersForCurrentPlatform } from "../workspace/factory.ts";
import { createProductionGitCommandPort } from "./session-git-command.ts";
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
import { runAuthGatewayCommand } from "./auth-gateway-cli.ts";
import { createCliHideThinkingSettings, resolveHideThinkingBlock } from "./hide-thinking-settings.ts";
import { createCliComposerShapeSettings } from "./composer-shape-settings.ts";
import { createComposerShapeRegistry } from "../tui/composer/registry.ts";
import { createCliComposerShapeComposition } from "./composer-shape-composition.ts";
import { runSettingsCommand } from "./settings-command.ts";
import { SettingsCommandError } from "../storage/settings-service.ts";

const VERSION = readVersionFromPackage();

/** P6:TUI 启动 notice 使用的 workspace/path 能力标签(真实 runner 证据,不宣称 sandbox)。 */
function workspaceCapabilityLabel(): string {
	const platform = runtimeWorkspacePlatform();
	const row = capabilityRowFor(platform);
	return `ws:${platform}-${row.adapterAvailable ? "verified" : "unverified"}`;
}

export async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === "auth-gateway") {
    try {
      await runAuthGatewayCommand(argv.slice(1));
    } catch (error) {
      process.stderr.write(`[runledger] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    }
    return;
  }
  if (argv[0] === "settings") {
    try {
      const { resolution, layout } = await resolveRunledgerHome();
      if (resolution.createDefault) await mkdir(layout.home, { recursive: true, mode: 0o700 });
      await runSettingsCommand(argv.slice(1), { layout });
    } catch (error) {
      const code = error instanceof SettingsCommandError
        ? error.code
        : error instanceof RunledgerHomeError
          ? error.code
          : "settings_command_failed";
      const detail = error instanceof SettingsCommandError || error instanceof RunledgerHomeError
        ? error.message
        : "settings command failed";
      process.stderr.write(`[runledger] ${code}: ${detail}\n`);
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

  const cwd = process.cwd();
  const { resolution, layout } = await resolveRunledgerHome();
  // 默认 home(<userHome>/.runledger)需要首启创建;显式 RUNLEDGER_DIR 必须
  // 已是既有目录(createDefault=false)。openSessionDatabase 会 stat 父目录,
  // 缺失时 fail closed,所以必须先建目录。
  if (resolution.createDefault) {
    await mkdir(layout.home, { recursive: true, mode: 0o700 });
  }
  const settings = await loadProjectSettings({ layout });
  const composerShapeRegistry = createComposerShapeRegistry();
  const composerShapeComposition = createCliComposerShapeComposition({ registry: composerShapeRegistry });
  const composerShapeLoad = composerShapeComposition.load();
  if (!composerShapeLoad.ok) {
    process.stderr.write(`[runledger] composer shape contributions unavailable (${composerShapeLoad.diagnostic.code}); using builtins\n`);
  }
  const composerShapeSettingsPort = createCliComposerShapeSettings(layout, composerShapeRegistry);
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
  let compatibility = checkStoreCompatibility(db);
  if (compatibility.ok && compatibility.header.storeVersion === 1) {
    const migration = migrateSessionStoreV1ToV2(db);
    if (!migration.ok) {
      db.close();
		process.stderr.write(`[runledger] session store legacy -> current migration failed: ${migration.code}: ${migration.detail}\n`);
      process.exit(2);
      return;
    }
    compatibility = checkStoreCompatibility(db);
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
  const initialSettingsRuntimeStore = new SettingsRuntimeStore({ layout });
  const initialRuntimeSettings = await initialSettingsRuntimeStore.load();
  const initialStartupPolicy: StartupSelectionPolicy = {
		autoResume: initialRuntimeSettings.startup.autoResume === true,
	};
	const hasInitialResumeCandidate = store.listSessions().some((record) =>
		record.status === "active" || record.status === "paused" || record.status === "recovery_required",
	);

  let sessionId: SessionId;
  try {
		sessionId = await resolveSessionId(store, args, cwd, initialRuntimeSettings.digest.digest, initialStartupPolicy);
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
  const multiAgentPolicySourcesFor = async (targetSessionId: SessionId, taskPolicy?: TaskPolicyProjection) => {
	const key = workspaceStorageKeyFor(targetSessionId);
    const layered = await loadLayeredProjectSettings({ layout, workspaceKey: key });
    const source = (layer: typeof layered.user) => layer.multiAgent.state === "valid"
      ? layer.multiAgent.value
      : layer.multiAgent.state === "invalid" ? layer.multiAgent.raw : undefined;
    return {
      runtimeEnabled: args.experimentalMultiAgent,
      user: source(layered.user),
      workspace: source(layered.workspace),
      ...(taskPolicy === undefined ? {} : { taskPolicy }),
    };
  };

  const models = builtinModels({ credentials: AuthStorage.create(layout) });
  await registerConfiguredProxyProvidersFromHome(models, layout.home);
  await models.refresh({ allowNetwork: false });
  const modelRequestRouters = await createCliSessionModelRequestRouterFactory({ layout, authorityId, tenantId });
  const worktreeGit = createProductionGitCommandPort();
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
  const ownedRuntimeRegistry = new Map<string, EmbeddedSessionRuntimeResult>();
  const openView = async (targetSessionId: string): Promise<CliSessionView> => {
	const typedSessionId = targetSessionId as SessionId;
	const workspaceStorageKey = workspaceStorageKeyFor(typedSessionId);
	const settingsRuntimeStore = new SettingsRuntimeStore({ layout, workspaceKey: workspaceStorageKey });
	const runtimeSettings = await settingsRuntimeStore.load();
	const embedded = await createEmbeddedSessionRuntime({
		sessionId: typedSessionId,
		store,
		ownerStore,
		workspace: await workspaceFactoryFor(targetSessionId),
		domain: {
			cwd,
			layout,
			settings,
				runtimeSettings,
				runtimeSettingsForTurn: () => settingsRuntimeStore.admitTurn(),
				compactionSummarizerFactory: ({ providerGate, retryPolicy }) => modelRequestRouters.compactionSummarizer({
					models,
					providerGate,
					retryPolicy,
				}),
				retryPolicy: runtimeSettings.retry,
			models,
			traceRecorderFactory,
			modelRequestRouter: modelRequestRouters.forSession({ sessionId: typedSessionId, workspaceStorageKey }),
			multiAgent: await multiAgentPolicySourcesFor(typedSessionId, runtimeSettings.taskPolicy),
			overrides: {
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
	return { sessionId: targetSessionId, embedded, controller, processOverlayClient, processOverlayController, runtimeSettings, settingsRuntimeStore };
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

  let firstView: CliSessionView | undefined = initialView;
	  let showWelcomeOnNextView = shouldShowWelcomeOnInitialView(args, initialStartupPolicy, hasInitialResumeCandidate);
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
      detach: async (view) => {
        view.controller.dispose();
        await view.embedded.handle.close().catch(() => undefined);
        await pauseIfLastAttachment(view.embedded, false);
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
      if (entry.ownerFence !== undefined) entry.store.reclaimSessionWithoutUserMessages(entry.ownerFence);
    }));
    composerShapeComposition.dispose();
    db.close();
    if (process.env.RUNLEDGER_DEBUG === "1") {
      process.stderr.write("[runledger] exit. all owned Session runtimes stopped\n");
    }
  }

  async function runInteractiveView(view: CliSessionView) {
	const showWelcome = showWelcomeOnNextView;
	showWelcomeOnNextView = false;
	const composerShapeSettings = await loadProjectSettings({ layout });
	const effectiveCwd = view.embedded.effectiveCwd;
	const gitDisplay = effectiveCwd === undefined
	  ? {}
	  : await gitWorkspaceDisplayFacts(effectiveCwd, worktreeGit, view.runtimeSettings.git.enabled);
	    const activeInteractive = new InteractiveMode({
	      controller: view.controller,
	      runtimeSettings: view.runtimeSettings,
	      settingsRuntimeStore: view.settingsRuntimeStore,
	      settingsEditorPort: view.settingsRuntimeStore.editorPort(),
	      workspaceCapability: workspaceCapabilityLabel(),
      workspaceDisplayAbsolutePath: workspaceDisplayAbsolutePathForView({ effectiveCwd }),
      gitBranchLabel: gitDisplay.branchLabel,
      syntaxThemeName: settings.theme,
      syntaxThemeController: syntaxThemes.controller,
      syntaxThemeSettingsPort: createCliSyntaxThemeSettings(layout, syntaxThemes.customThemeNames),
      syntaxThemeWarnings: syntaxThemes.takeWarnings(),
      processOverlayController: view.processOverlayController,
      processOverlayClient: view.processOverlayClient,
      initialPreferences: tuiPreferences.current(),
      preferencesPort: tuiPreferences.port,
      hideThinkingBlock: resolveHideThinkingBlock(args.hideThinking, settings.hideThinkingBlock),
      hideThinkingSettingsPort: createCliHideThinkingSettings(layout),
      composerShape: composerShapeSettings.composer?.shape,
      composerShapeRegistry,
      composerShapeSettingsPort,
      showWelcome,
      version: VERSION,
    });
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
      return await activeInteractive.run();
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
	readonly runtimeSettings: EffectiveRuntimeSettingsSnapshot;
	readonly settingsRuntimeStore: SettingsRuntimeStore;
}

/**
 * §8.3/P0-3:只有本进程是 owner 且本地 view 是最后一个 attachment 时才
 * pause/checkpoint/release;remote attachment 仍存在时不得无条件终止 owner
 * (attachment count 决定 runtime lifetime)。attach 分支(runtime undefined)
 * 或 owner 已在 count=0 回调中 pause 时均为幂等空操作。
 */
export async function pauseIfLastAttachment(embedded: EmbeddedSessionRuntimeResult, waitForRemote = true): Promise<void> {
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
    if (embedded.ownerFence !== undefined) embedded.store.reclaimSessionWithoutUserMessages(embedded.ownerFence);
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
      if (embedded.ownerFence !== undefined) embedded.store.reclaimSessionWithoutUserMessages(embedded.ownerFence);
    }
    return;
  }
  await runtime.shutdownAfterLastAttachment("paused");
  if (embedded.ownerFence !== undefined) embedded.store.reclaimSessionWithoutUserMessages(embedded.ownerFence);
}

/** §8.1/§8.2:从 SQLite catalog resolve sessionId(create/open/resume/fork)。 */
export async function resolveSessionId(
		store: SessionStore,
		args: ReturnType<typeof parseArgs>["args"],
		cwd: string,
		settingsDigest: string = runtimeDigest({ settings: "default" }).digest,
		startupPolicy: StartupSelectionPolicy = {},
): Promise<SessionId> {
	const mode = sessionOpenMode(args, startupPolicy);
	const createSession = (): SessionId => {
		const sessionId = createRuntimeId("session", `cwd-${cwd.replace(/[^A-Za-z0-9._~-]/g, "_").slice(0, 40)}-${Date.now().toString(36)}`);
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "default"),
			repositoryId: createRuntimeId("repository", "default"),
			settingsDigest,
		});
		return sessionId;
	};
	if (mode === "create") {
		return createSession();
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
	if (recent === undefined) {
		// 只有 settings 驱动的隐式 autoResume 可以在首次启动时创建；显式
		// --continue/--resume 没有候选时仍保持可诊断的失败语义。
		if (startupPolicy.autoResume === true && !args.continueRecent && !args.resume) return createSession();
		throw new Error("no session to resume; create a new session first");
	}
	return recent.sessionId as SessionId;
}

export interface StartupSelectionPolicy {
	readonly autoResume?: boolean;
}

export function sessionOpenMode(
	args: ReturnType<typeof parseArgs>["args"],
	startupPolicy: StartupSelectionPolicy = {},
): "create" | "open" | "continue_recent" | "resume" | "fork" {
  if (args.session !== undefined || args.sessionId !== undefined) return "open";
  if (args.fork !== undefined) return "fork";
  if (args.resume) return "resume";
  if (args.continueRecent) return "continue_recent";
  return startupPolicy.autoResume === true ? "continue_recent" : "create";
}

export function shouldShowWelcomeOnInitialView(
	args: ReturnType<typeof parseArgs>["args"],
	startupPolicy: StartupSelectionPolicy,
	hasResumeCandidate: boolean,
): boolean {
	const mode = sessionOpenMode(args, startupPolicy);
	if (mode === "create") return true;
	return mode === "continue_recent"
		&& startupPolicy.autoResume === true
		&& !args.continueRecent
		&& !hasResumeCandidate;
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
	return {
		sessionId: embedded.handle.sessionId,
		messages: Array.isArray(body.messages) ? (body.messages as never[]) : [],
		warnings: Array.isArray(body.warnings) ? (body.warnings as string[]) : [],
		auditEntries: Array.isArray(body.auditEntries) ? (body.auditEntries as never[]) : [],
		selection: (body.selection ?? { thinkingLevel: "off" }) as SessionInteractiveSnapshot["selection"],
		toolCount: typeof body.toolCount === "number" ? body.toolCount : 0,
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
	if (!directRequest.mutation) {
		const response = await controller.querySessionDomain(directRequest.operation, directRequest.body, {
			correlationId,
			effectId: "control_query_1",
		});
		process.stdout.write(`${JSON.stringify(response)}\n`);
		return;
	}
	const queryOperation = controlCommandQueryOperation(command);
	let inspectedBody: Record<string, unknown> = {};
	let domainRevision = 0;
	if (queryOperation !== undefined) {
		effectSequence += 1;
		const inspected = await controller.querySessionDomain(queryOperation, {}, { correlationId, effectId: `control_query_${effectSequence}` });
		if (!inspected.ok) {
			process.stdout.write(`${JSON.stringify(inspected)}\n`);
			return;
		}
		inspectedBody = inspected.value;
		domainRevision = inspected.domainRevision;
	}
	const request = {
		operation: command.group === "remember" ? "memory.propose" : command.group === "plan" && command.action === "approve" ? "plan.resolve_approval" : `${command.group}.${command.action}`,
		body: controlCommandBody(command, domainRevision, inspectedBody),
	};
	effectSequence += 1;
	const response = await controller.commandSessionDomain(request.operation, { ...request.body }, {
		correlationId,
		effectId: `control_command_${effectSequence}`,
		expectedRevision: domainRevision,
	});
	process.stdout.write(`${JSON.stringify(response)}\n`);
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
