/**
 * R7:SessionRuntime 领域装配(06 §7.1)。
 *
 * - 唯一允许组合 InteractiveSessionController 的模块前缀是
 *   src/runtime/session-runtime/(边界检查 direct-controller 规则);
 * - 一个 SessionRuntime 只装配一个 Session 的 Agent/model/tool/ledger;
 *   不构成 machine-wide registry;
 * - ledger 走 SqliteLedgerSink(owner-fenced durable event),replay 复用
 *   session-codec 的 replaySession,checkpoint 可删。
 */

import type { SessionStore } from "../../storage/session-store/session-store.ts";
import type { SessionId } from "../protocol/ids.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type { SessionDomainPort, SessionDomainSnapshot } from "./session-runtime.ts";
import { SqliteLedgerSink } from "./sqlite-ledger.ts";
import { gatedExecutionEnv, type LateBoundAttemptPort } from "./attempt-gateway.ts";
import { replaySession } from "../../storage/session-codec.ts";
import type { ExecutionEnv } from "../execution-env.ts";
import { createStdlibTools, type StdlibToolsOptions } from "../tools/index.ts";
import { InteractiveSessionController, type RuntimeSelectionOverrides } from "../interactive-session-controller.ts";
import type { AgentTool } from "../types.ts";
import type { Models } from "../../models.ts";
import type { RunledgerLayout } from "../contracts/storage-layout.ts";
import type { ProjectSettings } from "../../storage/settings-manager.ts";
import { resolveRecordingConfig } from "../../storage/settings-manager.ts";
import type { TraceRecorderFactory } from "../trace/composition.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
	createSessionSecurity,
	type SessionSecurityConfigSource,
} from "../../security/session-composition.ts";
import { createLocalSessionToolchainProbe } from "../../security/integration/session-local-leaves.ts";
import {
	buildGovernedProcessEnvironment,
	resolveSessionToolchainSnapshot,
} from "../../security/toolchain.ts";
import type { RestoreOutcome } from "./restore.ts";
import { restoreCheckpointReplay } from "./checkpoint.ts";
import { isCurrentLedgerEntry, type LedgerEntry } from "../ledger/types.ts";
import type { SessionApprovalPorts } from "./approval-reverse-request.ts";
import type { AgentRunBudgetUsage } from "../types.ts";
import { createSessionProcessComposition } from "./process-composition.ts";
import { createProductionSessionExtensionComposition } from "./extension-composition.ts";
import { createSessionPlanInspection } from "./plan-composition.ts";
import { assembleAgentModelContext } from "../context/model-request-adapter.ts";
import { createLspTool, type LspToolOptions } from "../../lsp/tool.ts";
import { shutdownAll } from "../../lsp/client.ts";
import { clearLinterClientCache } from "../../lsp/clients/index.ts";
import {
	createGovernedLinterFactories,
	createGovernedLspSpawner,
	createGovernedLspWriteOperations,
} from "./lsp-composition.ts";
import { createSessionProductionToolSource } from "../agents/capability-subset.ts";
export { createSessionProcessComposition } from "./process-composition.ts";

export interface SessionDomainCompositionOptions {
	readonly cwd: string;
	readonly layout: RunledgerLayout;
	readonly settings: ProjectSettings;
	readonly models: Models;
	readonly overrides?: RuntimeSelectionOverrides;
	readonly traceRecorderFactory?: TraceRecorderFactory;
	/** Session Event Store + 当前 driver reverse-request 的 approval authority。 */
	readonly approvalPorts?: SessionApprovalPorts;
	/** CLI > managed > project > user 的 session-scoped Security 配置层。 */
	readonly securitySources?: readonly SessionSecurityConfigSource[];
	/** 可选:AGENTS 拼接(缺省读 <cwd>/AGENTS.md)。 */
	readonly systemPrompt?: string;
}

/** 在 SessionRuntime 内装配真实 InteractiveSessionController(单一 Session 域)。 */
export async function assembleSessionDomain(
	options: SessionDomainCompositionOptions,
	sessionId: SessionId,
	store: SessionStore,
	fence: OwnerFence,
	restored: Extract<RestoreOutcome, { readonly ok: true }>,
	attemptPort?: LateBoundAttemptPort,
	runBudgetUsage?: AgentRunBudgetUsage,
): Promise<SessionDomainPort> {
	const ledger = new SqliteLedgerSink({ store, fence: () => fence });
	const replay = await replayDomain(ledger, restored);
	const catalog = store.getSession(sessionId);
	if (catalog === undefined) throw new Error(`session not found during domain composition: ${sessionId}`);
	if (attemptPort === undefined) throw new Error("session attempt gateway is required for production composition");
	const toolchainProbe = createLocalSessionToolchainProbe();
	const toolchainResult = await resolveSessionToolchainSnapshot({
		packageRoot: runledgerPackageRoot(),
		workspaceRoot: options.cwd,
		probe: toolchainProbe,
	});
	if (!toolchainResult.ok) throw new Error(`${toolchainResult.error.code}: ${toolchainResult.error.message}`);
	const environmentResult = buildGovernedProcessEnvironment({
		sessionId,
		toolchain: toolchainResult.value,
		temporaryRoot: options.layout.tmp,
		inherited: globalThis.process.env,
	});
	if (!environmentResult.ok) throw new Error(`${environmentResult.error.code}: ${environmentResult.error.message}`);
	const security = await createSessionSecurity({
		layout: options.layout,
		cwd: options.cwd,
		fence,
		workspaceId: catalog.workspaceId,
		repositoryId: catalog.repositoryId,
		toolchain: toolchainResult.value,
		processEnvironment: environmentResult.value,
		toolchainProbe,
		...(options.securitySources === undefined ? {} : { securitySources: options.securitySources }),
		...(options.approvalPorts === undefined ? {} : { approvalPorts: options.approvalPorts }),
	});
	const recording = resolveRecordingConfig(options.settings);
	const process = createSessionProcessComposition({
		layout: options.layout,
		store,
		cwd: options.cwd,
		fence,
		workspaceId: catalog.workspaceId as Parameters<typeof createSessionProcessComposition>[0]["workspaceId"],
		security: security.managedProcess,
		attemptPort: () => attemptPort.get(),
		recordingMode: recording.mode,
		recordingFailurePolicy: recording.failurePolicy,
		...(options.traceRecorderFactory === undefined ? {} : { traceRecorderFactory: options.traceRecorderFactory }),
	});
	// recovery attempt fence 包裹 governed 最终叶；任何一层缺失都 fail closed。
	const executionEnv = gatedExecutionEnv(security.executionEnv, () => attemptPort.get(), sessionId);
	const lspOptions: LspToolOptions = {
		spawn: createGovernedLspSpawner(process.toolClient()),
		writeOperations: createGovernedLspWriteOperations(executionEnv.fs),
		scope: sessionId,
		linterFactories: createGovernedLinterFactories(process.toolClient(), executionEnv.fs),
	};
	const traceRecorderFactory = options.traceRecorderFactory === undefined
		? undefined
		: {
			create: (input: Parameters<TraceRecorderFactory["create"]>[0]) => options.traceRecorderFactory!.create({
				...input,
				sessionId,
				ownerGeneration: fence.generation,
			}),
			};
	const baseTools = productionSessionTools(options.cwd, executionEnv, process.toolClient(), security.permissionRequester, lspOptions);
	const extensions = await createProductionSessionExtensionComposition({
		layout: options.layout,
		cwd: options.cwd,
		store,
		fence,
		workspaceId: catalog.workspaceId,
		repositoryId: catalog.repositoryId,
		executionEnv,
		managedProcess: process.toolClient(),
		attemptPort: () => attemptPort.get(),
		baseToolNames: baseTools.map((tool) => tool.name),
		skillCompatibility: { osUserHome: homedir(), projectBoundary: options.cwd },
	});
	const composedTools = [...baseTools, ...extensions.tools];
	const controller = await InteractiveSessionController.create({
		cwd: options.cwd,
		layout: options.layout,
		systemPrompt: options.systemPrompt ?? buildSystemPrompt(options.cwd, options.layout.agents),
		models: options.models,
		settings: options.settings,
		replay,
		ledger,
		overrides: options.overrides,
		tools: composedTools,
		executionEnv,
		authorizationPolicy: security.authorizationPolicy,
		traceRecorderFactory,
		extensionHookRuntime: extensions.hookRuntime,
		extensionHookSnapshotId: () => extensions.turnLifecycle?.snapshotId(),
		extensionTurnAdmission: extensions.turnLifecycle === undefined ? undefined : () => extensions.turnLifecycle!.admitTurn(),
		extensionTurnAbort: extensions.turnLifecycle === undefined ? undefined : () => extensions.turnLifecycle!.cancelTurn(),
		...(runBudgetUsage === undefined ? {} : { runBudgetUsage }),
		modelContextAssembler: async (input) => assembleAgentModelContext({
			...input,
			sources: extensions.contextSources(input.model.contextWindow),
		}),
	});
	const childRuntime = {
		productionToolSource: createSessionProductionToolSource({
			sessionId,
			cwd: options.cwd,
			executionEnv,
			authorizationPolicy: security.authorizationPolicy,
			tools: composedTools,
		}),
		modelRuntimeFactory: controller.createChildModelRuntimeFactory(),
	};
	const removeExtensionLifecycle = extensions.turnLifecycle === undefined
		? undefined
		: controller.subscribe((event) => extensions.turnLifecycle!.handle(event));
	const planInspection = createSessionPlanInspection({
		sessionId,
		store,
		policyCeilingDigest: security.snapshot.policyDigest,
	});
	return {
		controller,
		childRuntime,
		process,
		resources: extensions.resources,
		planInspection,
		start: extensions.start,
		shutdown: async (reason) => {
			removeExtensionLifecycle?.();
			try {
				await extensions.shutdown(reason);
			} finally {
				await shutdownAll(sessionId);
				clearLinterClientCache(sessionId);
			}
		},
		protocolCapabilities: ["session.approval.reverse", "session.security.inspect", "session.plan"],
		securityInspection: () => ({
			ownerGeneration: fence.generation,
			profile: security.snapshot.profile.name,
			approvalPolicy: security.snapshot.profile.approvalPolicy,
			filesystemMode: security.snapshot.profile.filesystemMode,
			networkMode: security.snapshot.profile.network.mode,
			sandboxMode: security.snapshot.profile.sandbox,
			policyDigest: security.snapshot.policyDigest,
			sourceCount: security.snapshot.sources.length,
		}),
		snapshot: (): SessionDomainSnapshot => ({
			messages: controller.messages,
			warnings: controller.warnings,
			auditEntries: controller.auditEntries,
			selection: controller.currentSelection,
			toolCount: controller.toolCount,
			inFlight: controller.inFlight,
			providerStatuses: [],
		}),
	};
}

function runledgerPackageRoot(): string {
	return fileURLToPath(new URL("../../../", import.meta.url));
}

async function replayDomain(
	ledger: SqliteLedgerSink,
	restored: Extract<RestoreOutcome, { readonly ok: true }>,
) {
	if (restored.checkpoint !== undefined) {
		const tail = restored.replayEvents.flatMap((event): LedgerEntry[] => {
			if (!event.eventType.startsWith("ledger.")) return [];
			try {
				const entry = JSON.parse(event.payloadJson) as unknown;
				return isCurrentLedgerEntry(entry) ? [entry] : [];
			} catch {
				return [];
			}
		});
		const replay = restoreCheckpointReplay(restored.checkpoint.snapshot, tail);
		if (replay !== undefined) return replay;
	}
	return replaySession(ledger);
}

/** AGENTS 拼接:项目 AGENTS.md + 用户全局 AGENTS.md(与 legacy Host 同源逻辑)。 */
export function buildSystemPrompt(cwd: string, globalAgents: string): string {
	const instructions: string[] = [];
	for (const path of [join(cwd, "AGENTS.md"), globalAgents]) {
		try {
			const content = readFileSync(path, "utf8");
			if (content.length > 0) instructions.push(content);
		} catch {
			// AGENTS.md 不存在或不可读时只保留默认提示。
		}
	}
	return `You are RunLedger's interactive coding agent inside a TUI. Work in ${cwd}. ` +
		"Use governed Read/Write/Edit/Bash/process tools and keep replies concise." +
		(instructions.length > 0 ? `\n\n---\n\n${instructions.join("\n\n---\n\n")}` : "");
}

/** 生产工具集:stdlib(read/write/edit/bash/grep/find/ls/multi-edit/web-fetch/todo/task),排除 echo/Skill/NotebookEdit。 */
export function productionSessionTools(
	cwd: string,
	executionEnv: ExecutionEnv,
	managedProcess?: StdlibToolsOptions["managedProcess"],
	permissionRequester?: StdlibToolsOptions["permissionRequester"],
	lspOptions?: LspToolOptions,
): AgentTool[] {
	const excluded = new Set(["NotebookEdit", "echo"]);
	excluded.add("Skill");
	const tools = createStdlibTools(cwd, {
		requireExecutionEnv: true,
		executionEnv,
		...(managedProcess === undefined ? {} : { managedProcess }),
		...(permissionRequester === undefined ? {} : { permissionRequester }),
	})
		.toContext()
		.filter((tool: AgentTool) => !excluded.has(tool.name));
	if (lspOptions !== undefined) tools.push(createLspTool(cwd, lspOptions));
	return tools;
}
