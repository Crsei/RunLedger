import { defaultConvertToLlm } from "../agent-loop/context-conversion.ts";
import { TrajectoryService } from "../trajectory/service.ts";
import { SessionPlanDomain } from "./plan-domain.ts";
import { buildStandardExecutionPrompt } from "./standard-system-prompt.ts";
import { assertAssembledPromptBase } from "../harness-profiles/composition.ts";
import { createSessionPlanTools } from "./plan-tools.ts";
import { buildPlanFragment } from "../modes/plan/prompt.ts";
import { planReadOnlyExecutionEnv } from "./plan-execution.ts";
import { GovernedToolAuthorizationPolicy } from "../../security/integration/runtime-tool-authorization.ts";
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
import { InteractiveSessionController, type InteractiveSessionControllerOptions, type ModelRequestRouter, type RuntimeSelectionOverrides, type SessionTitleChangedEvent } from "../interactive-session-controller.ts";
import type { AgentTool } from "../types.ts";
import type { Models } from "../../models.ts";
import type { RunledgerLayout } from "../contracts/storage-layout.ts";
import type { ProjectSettings } from "../../storage/settings-manager.ts";
import { resolveRecordingConfig } from "../../storage/settings-manager.ts";
import { SecuritySettingsPort } from "../../storage/security-settings-port.ts";
import { builtinPermissionPresets } from "../../security/config/presets.ts";
import type { TraceRecorderFactory } from "../trace/composition.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
	createSessionSecurity,
	type SessionSecurityConfigSource,
} from "../../security/session-composition.ts";
import type { BashClassificationAuditPort } from "../../security/permission/bash-ast/types.ts";
import { createLocalSessionToolchainProbe } from "../../security/integration/session-local-leaves.ts";
import {
	buildGovernedProcessEnvironment,
	resolveSessionToolchainSnapshot,
} from "../../security/toolchain.ts";
import type { RestoreOutcome } from "./restore.ts";
import { restoreCheckpointReplay } from "./checkpoint.ts";
import { isCurrentLedgerEntry, type LedgerEntry } from "../ledger/types.ts";
import type { SessionApprovalPorts } from "./approval-reverse-request.ts";
import { createSessionBashClassificationAudit } from "./bash-classification-audit.ts";
import type { AgentRunBudgetUsage } from "../types.ts";
import { SessionTitleLifecycle } from "./title-lifecycle.ts";
import { createSessionProcessComposition } from "./process-composition.ts";
import { createProductionSessionExtensionComposition, type SessionExtensionComposition } from "./extension-composition.ts";
import type { SessionPlanInspection } from "./plan-composition.ts";
import type { ModelContextAssemblyInput } from "../types.ts";
import { collectUselessToolCallIds } from "../context/compaction/projection-prune.ts";
import { SessionCompactionDomain } from "./compaction-domain.ts";
import { createLspTool, type LspToolOptions } from "../../lsp/tool.ts";
import { shutdownAll } from "../../lsp/client.ts";
import { clearLinterClientCache } from "../../lsp/clients/index.ts";
import {
	createGovernedLinterFactories,
	createGovernedLspSpawner,
	createGovernedLspWriteOperations,
} from "./lsp-composition.ts";
import { createSessionProductionToolSource } from "../agents/capability-subset.ts";
import { createMultiAgentDomain, type SessionMultiAgentPolicySources } from "../agents/domain.ts";
import type { ChildRuntimeProviderPort } from "../agents/child-runtime.ts";
import type { PreviousOwnerLiveness } from "../agents/supervisor.ts";
import { composeSessionResourceDomains } from "./resource-domain-composition.ts";
import { createSecuritySettingsResourceDomain } from "./security-settings-domain.ts";
import { createSessionPermissionUpdater, recoverPermissionUpdates } from "./security-update.ts";
import { createPermissionUpdateJournal, nextPermissionRevision } from "./security-update-journal.ts";
import {
	HarnessCompositionError,
	MINIMAL_HARNESS_SYSTEM_PROMPT,
	createHarnessCompositionReceipt,
	resolveHarnessComposition,
	resolveHarnessProfile,
} from "../harness-profiles/index.ts";
import { SessionModelCalls, observeSessionModels } from "./model-call-observer.ts";
import type { HarnessCompositionReceipt } from "../harness-profiles/index.ts";
export { createSessionProcessComposition } from "./process-composition.ts";

export interface SessionDomainCompositionOptions {
	readonly cwd: string;
	readonly layout: RunledgerLayout;
	readonly settings: ProjectSettings;
	readonly models: Models;
	readonly overrides?: RuntimeSelectionOverrides;
	/** Host-owned route gate shared by coding and title completions. */
	readonly modelRequestRouter?: ModelRequestRouter;
	/** 启动恢复与模型发现共用的 canonical compatibility preflight。 */
	readonly isModelSelectable?: InteractiveSessionControllerOptions["isModelSelectable"];
	readonly traceRecorderFactory?: TraceRecorderFactory;
	/** Session Event Store + 当前 driver reverse-request 的 approval authority。 */
	readonly approvalPorts?: SessionApprovalPorts;
	/** CLI > managed > project > user 的 session-scoped Security 配置层。 */
	readonly securitySources?: readonly SessionSecurityConfigSource[];
	/** 可选的脱敏 Bash AST 分类审计端口。 */
	readonly bashClassificationAudit?: BashClassificationAuditPort;
	/** 可选:AGENTS 拼接(缺省读 <cwd>/AGENTS.md)。 */
	readonly systemPrompt?: string;
	/** Runtime gate + preserved user/workspace policy layers for M1 delegation. */
	readonly multiAgent?: SessionMultiAgentPolicySources;
	/** Host-controlled child provider seam; it must preserve the governed prepare spec. */
	readonly multiAgentChildRuntimeProvider?: ChildRuntimeProviderPort;
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
	multiAgentPreviousOwnerLiveness?: PreviousOwnerLiveness,
): Promise<SessionDomainPort> {
	const models = observeSessionModels(options.models, new SessionModelCalls(store, fence));
	const ledger = new SqliteLedgerSink({ store, fence: () => fence });
	const replay = await replayDomain(ledger, restored);
	const catalog = store.getSession(sessionId);
	if (catalog === undefined) throw new Error(`session not found during domain composition: ${sessionId}`);
	const harnessProfile = resolveHarnessProfile(catalog.harnessProfile);
	if (!harnessProfile.ok) throw new HarnessCompositionError(harnessProfile.error.code, harnessProfile.error.message);
	if (options.systemPrompt !== undefined) assertAssembledPromptBase(harnessProfile.descriptor, options.systemPrompt);
	if (
		harnessProfile.descriptor.prompt.mode === "complete"
		&& options.systemPrompt !== undefined
		&& options.systemPrompt !== harnessProfile.descriptor.prompt.text
	) {
		throw new HarnessCompositionError(
			"harness_prompt_override_conflict",
			`${catalog.harnessProfile.id}@${catalog.harnessProfile.version} does not accept a system prompt override`,
		);
	}
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
	const permissionJournal = createPermissionUpdateJournal(store, fence);
	const security = await createSessionSecurity({
		initialSecurityRevision: nextPermissionRevision(permissionJournal),
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
		bashClassificationAudit: options.bashClassificationAudit ?? createSessionBashClassificationAudit({ store, fence }),
	});
	const securitySettingsPort = new SecuritySettingsPort({
		layout: options.layout,
		workspaceKey: security.workspaceStorageKey,
		workspaceRoot: options.cwd,
		tempRoot: options.layout.tmp,
		...(security.snapshot.managedConstraints === undefined ? {} : { managedConstraints: security.snapshot.managedConstraints }),
	});
	try {
		await recoverPermissionUpdates({ security, settings: securitySettingsPort, journal: permissionJournal });
		permissionJournal.initialize?.(security.snapshot.securityRevision!, security.snapshot.policyDigest);
	} catch (error) { await security.close(); throw error; }
	const recording = resolveRecordingConfig(options.settings);
	const trajectory = new TrajectoryService({ layout: options.layout, store, sessionId, generation: fence.generation, config: recording });
	const observedTraceFactory: TraceRecorderFactory | undefined = options.traceRecorderFactory === undefined ? undefined : {
		create: (input) => options.traceRecorderFactory!.create({ ...input, sessionId, ownerGeneration: fence.generation,
			onRecorded: (event, locator) => trajectory.recorded(event, locator),
			onDiagnostic: (diagnostic) => trajectory.diagnostic(diagnostic),
		}),
	};
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
		...(observedTraceFactory === undefined ? {} : { traceRecorderFactory: observedTraceFactory }),
	});
	// recovery attempt fence 包裹 governed 最终叶；任何一层缺失都 fail closed。
	const governedExecutionEnv = gatedExecutionEnv(security.executionEnv, () => attemptPort.get(), sessionId);
	const planReadonly = catalog.harnessProfile.id === "plan";
	const planDomain = new SessionPlanDomain({
		store, fence,
		workspaceId: catalog.workspaceId as Parameters<typeof createSessionProcessComposition>[0]["workspaceId"],
		repositoryId: catalog.repositoryId as SessionPlanInspection["repositoryId"],
		policyCeilingDigest: security.snapshot.policyDigest,
		attemptPort: () => attemptPort.get(),
		autoActivate: planReadonly,
		plansDir: options.layout.plans,
	});
	const executionEnv = planReadonly ? planReadOnlyExecutionEnv(governedExecutionEnv) : governedExecutionEnv;
	const planTools = createSessionPlanTools(planDomain);
	const lspOptions: LspToolOptions | undefined = harnessProfile.descriptor.tools.mode === "standard"
		? {
			spawn: createGovernedLspSpawner(process.toolClient()),
			writeOperations: createGovernedLspWriteOperations(executionEnv.fs),
			scope: sessionId,
			linterFactories: createGovernedLinterFactories(process.toolClient(), executionEnv.fs),
		}
		: undefined;
	const baseTools = [...productionSessionTools(options.cwd, executionEnv, process.toolClient(), security.permissionRequester, lspOptions), ...planTools.tools];
	let extensions: SessionExtensionComposition | undefined;
	if (Object.values(harnessProfile.descriptor.extensions).some(Boolean)) {
		extensions = await createProductionSessionExtensionComposition({
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
	}
	const securitySettings = createSecuritySettingsResourceDomain({
		generation: fence.generation,
		settings: securitySettingsPort,
		permissionUpdater: createSessionPermissionUpdater({
			generation: fence.generation, security, settings: securitySettingsPort,
			journal: permissionJournal, attemptPort: () => attemptPort.get(),
		}),
		attemptPort: () => attemptPort.get(),
	});

	const governedTools = [
		...baseTools,
		...(extensions === undefined || !harnessProfile.descriptor.extensions.tools ? [] : extensions.tools),
	];
	const standardSystemPrompt = harnessProfile.descriptor.prompt.mode === "assembled"
		? options.systemPrompt ?? (catalog.harnessProfile.version === 2
			? buildStandardExecutionPrompt(options.cwd, options.layout.agents)
			: buildSystemPrompt(options.cwd, options.layout.agents))
		: MINIMAL_HARNESS_SYSTEM_PROMPT;
	const harnessComposition = resolveHarnessComposition({
		ref: catalog.harnessProfile,
		systemPrompt: standardSystemPrompt,
		governedTools,
	});
	let compositionReceipt: HarnessCompositionReceipt;
	const traceRecorderFactory = observedTraceFactory === undefined
		? undefined
		: {
			create: (input: Parameters<TraceRecorderFactory["create"]>[0]) => observedTraceFactory.create({
				...input,
				sessionId,
				ownerGeneration: fence.generation,
				metadata: {
					harnessProfileId: compositionReceipt.profile.id,
					harnessProfileVersion: compositionReceipt.profile.version,
					harnessCompositionDigest: compositionReceipt.compositionDigest.digest,
				},
			}),
		};
	const titleListeners = new Set<(event: SessionTitleChangedEvent) => void>();
	let titleLifecycle: SessionTitleLifecycle | undefined;
	let compaction: SessionCompactionDomain;
	const withContextSources = (input: ModelContextAssemblyInput): ModelContextAssemblyInput => {
		const inspection = planDomain.inspect();
		const planContent = typeof inspection.content === "string" ? inspection.content : undefined;
		const convergenceReminder = planDomain.notePlanTurn();
		const fragment = buildPlanFragment({
			state: inspection.state,
			...(planContent === undefined ? {} : { content: planContent }),
			...(convergenceReminder === 0 ? {} : { convergenceReminder }),
		});
		return {
			...input,
			sources: [
				...(fragment === undefined ? [] : [{
					fragmentId: fragment.key, key: fragment.key,
					layer: "mode" as const, trust: "trusted" as const, taint: "none" as const, priority: "required" as const,
					content: fragment.text,
				}]),
				...(harnessProfile.descriptor.prompt.mode !== "assembled" ? [] : [{
					fragmentId: "session-effective-permissions", key: "session-effective-permissions",
					layer: "policy" as const, trust: "trusted" as const, taint: "none" as const, priority: "required" as const,
					content: [
						"Current Session permissions (runtime authority):",
						`profile: ${security.snapshot.profile.name}; revision: ${security.snapshot.securityRevision}`,
						`approval_policy: ${security.snapshot.profile.approvalPolicy}; filesystem: ${security.snapshot.profile.filesystemMode}; network: ${security.snapshot.profile.network.mode}`,
						"The runtime governs every operation. Only the user can change this Session's permission preset. System-destructive operations still require explicit one-time confirmation.",
					].join("\n"),
				}]),
				...(extensions === undefined || !harnessProfile.descriptor.extensions.context ? [] : extensions.contextSources(input.model.contextWindow)),
			],
		};
	};
	let controller: InteractiveSessionController;
	controller = await InteractiveSessionController.create({
		cwd: options.cwd,
		layout: options.layout,
		systemPrompt: harnessComposition.systemPrompt,
		models,
		settings: options.settings,
		replay,
		ledger,
		overrides: options.overrides,
		...(options.modelRequestRouter === undefined ? {} : { modelRequestRouter: options.modelRequestRouter }),
		...(options.isModelSelectable === undefined ? {} : { isModelSelectable: options.isModelSelectable }),
		tools: [...harnessComposition.tools],
		executionEnv,
		authorizationPolicy: new GovernedToolAuthorizationPolicy({
			basePolicy: security.authorizationPolicy, planState: () => planDomain.inspect().state,
			planProfileReadonly: planReadonly, planArtifactWriteTools: planTools.writeGates,
			// 基准是 controller 的当前工具实例,含之后 `addTools` 追加的 Session-owned
			// 工具(如 spawn_agent);构造期快照会漏掉它们并静默拒绝。
			admittedTools: () => controller.composedTools,
		}),
		traceRecorderFactory,
		...(extensions?.hookRuntime === undefined || !harnessProfile.descriptor.extensions.hooks
			? {}
			: { extensionHookRuntime: extensions.hookRuntime }),
		...(extensions?.turnLifecycle === undefined || !harnessProfile.descriptor.extensions.lifecycle
			? {}
			: {
				extensionHookSnapshotId: () => extensions!.turnLifecycle?.snapshotId(),
				extensionTurnAdmission: () => extensions!.turnLifecycle!.admitTurn(),
				extensionTurnAbort: () => extensions!.turnLifecycle!.cancelTurn(),
			}),
		onModelSelectionChanged: () => titleLifecycle?.selectionChanged(),
		...(runBudgetUsage === undefined ? {} : { runBudgetUsage }),
		onAcceptedUserPrompt: (text) => titleLifecycle?.handleAcceptedInput(text),
		modelContextAssembler: async (input) => compaction.assemble(withContextSources(input)),
		modelSelectionPreflight: (model) => compaction.preflightModel(model),
		modelContextOverflowRecovery: async (input) => compaction.recoverOverflow(withContextSources(input)),
		modelIncompleteOutputRecovery: async (input) => compaction.recoverIncomplete(withContextSources(input)),

	});
	compaction = new SessionCompactionDomain({
		store, fence, layout: options.layout, models,
		getInput: (model) => withContextSources(controller.compactionInput(model)),
		getHistory: () => defaultConvertToLlm([...controller.messages]),
		getPruneHints: () => {
			const content = planDomain.inspect().content;
			return { uselessToolCallIds: collectUselessToolCallIds(controller.messages), protectedReferences: typeof content === "string" ? [content] : [] };
		},
		withExclusive: (work) => controller.withContextMutation(work),
		attemptPort: () => attemptPort.get(),
		hasPendingApproval: () => planDomain.inspect().state.status === "awaiting_approval",
		protectedState: () => {
			const plan = planDomain.inspect().state;
			return {
				securityRevision: security.snapshot.securityRevision, policyDigest: security.snapshot.policyDigest,
				workspaceId: catalog.workspaceId, harnessProfile: catalog.harnessProfile,
				plan: { revision: plan.revision, status: plan.status, plan: plan.plan, approval: plan.approval },
				steering: controller.getSteeringMessages(), followUp: controller.getFollowUpMessages(),
			};
		},
		...(options.modelRequestRouter === undefined ? {} : { router: options.modelRequestRouter }),
		...(traceRecorderFactory === undefined ? {} : { traceRecorderFactory }),
	});
	await compaction.validateRestored();
	const resources = composeSessionResourceDomains([
		...(extensions === undefined ? [] : [extensions.resources]),
		securitySettings, compaction, planDomain,
	]);
	const childRuntime = !harnessProfile.descriptor.multiAgent
		? undefined
		: {
			productionToolSource: createSessionProductionToolSource({
				capturePermissionScope: () => security.capturePermissionScope(),
				sessionId,
				cwd: options.cwd,
				executionEnv,
				authorizationPolicy: security.authorizationPolicy,
				tools: governedTools,
			}),
			modelRuntimeFactory: controller.createChildModelRuntimeFactory(),
		};
	const multiAgentResult = options.multiAgent === undefined || childRuntime === undefined
		? { ok: true as const, value: undefined }
		: await createMultiAgentDomain({
			sessionId,
			ownerGeneration: fence.generation,
			store,
			fence,
			policySources: options.multiAgent,
			childRuntime: {
				systemPrompt: harnessComposition.systemPrompt,
				productionToolSource: childRuntime.productionToolSource,
				modelRuntimeFactory: childRuntime.modelRuntimeFactory,
			},
			attemptPort,
			...(multiAgentPreviousOwnerLiveness === undefined ? {} : { previousOwnerLiveness: multiAgentPreviousOwnerLiveness }),
			...(options.multiAgentChildRuntimeProvider === undefined ? {} : { provider: options.multiAgentChildRuntimeProvider }),
		});
	titleLifecycle = new SessionTitleLifecycle({
			sessionId,
			fence,
			models,
			enabled: options.settings.autoTitle !== false,
		getSelection: () => controller.currentSelection,
		getCurrentTitle: () => store.getSession(sessionId)?.title,
		setAutoTitle: (input) => {
			const titled = store.setTitle(fence, {
				title: input.title,
				source: "auto",
				expectedTitle: input.expectedTitle,
				trigger: input.trigger,
				modelRef: { providerId: input.providerId, modelId: input.modelId },
			});
			const event = store.replaySessionEvents(sessionId).at(-1);
			if (event?.eventType !== "session.title_changed") return;
			const titleEvent: SessionTitleChangedEvent = {
				sessionId,
				title: titled.title!,
				source: "auto",
				sequence: event.sequence,
			};
			for (const listener of titleListeners) {
				try {
					listener(titleEvent);
				} catch {
					// A subscriber cannot turn a committed title into a failed mutation.
				}
			}
		},
		...(options.modelRequestRouter === undefined ? {} : { modelRequestRouter: options.modelRequestRouter }),
	});
	if (!multiAgentResult.ok) throw new Error(`${multiAgentResult.error.code}: ${multiAgentResult.error.message}`);
	if (multiAgentResult.value !== undefined) controller.addTools(multiAgentResult.value.tools);
	// controller.create 只恢复配置；完整工具注册和 receipt 落盘后才交付可运行 domain。
	const finalComposition = resolveHarnessComposition({
		ref: catalog.harnessProfile,
		systemPrompt: standardSystemPrompt,
		governedTools: [...governedTools, ...(multiAgentResult.value?.tools ?? [])],
	});
	compositionReceipt = createHarnessCompositionReceipt({
		sessionId,
		ownerGeneration: fence.generation,
		descriptor: harnessProfile.descriptor,
		composition: finalComposition,
	});
	persistHarnessCompositionReceipt(store, fence, compositionReceipt);
	const removeExtensionLifecycle = extensions?.turnLifecycle === undefined
		? undefined
		: controller.subscribe((event) => extensions.turnLifecycle!.handle(event));
	const planInspection = () => planDomain.inspect();
	return {
		controller,
		trajectory,
		subscribeCompaction: (listener) => compaction.subscribe(listener),
		subscribeTitleChanged: (listener: (event: SessionTitleChangedEvent) => void) => {
			titleListeners.add(listener);
			return () => titleListeners.delete(listener);
		},
		...(childRuntime === undefined ? {} : { childRuntime }),
		...(multiAgentResult.value === undefined ? {} : { multiAgent: multiAgentResult.value }),
		...(planReadonly ? {} : { process }),
		resources,
		planInspection,
		start: async () => {
			await planDomain.start();
			await extensions?.start();
		},
		shutdown: async (reason) => {
			compaction.cancel();
			titleLifecycle?.dispose();
			if (!planReadonly) await process.shutdown(reason);
			removeExtensionLifecycle?.();
			try {
				await extensions?.shutdown(reason);
			} finally {
				try {
					await shutdownAll(sessionId);
					clearLinterClientCache(sessionId);
				} finally {
					try { await trajectory.close(); } finally { await security.close(); }
				}
			}
		},
		protocolCapabilities: ["session.approval.reverse", "session.security.inspect", "session.plan", "session.trajectory"],
		// `/dump` 只读投影：provider 面文本取自 controller 捕获点，digest 取自 harness composition。
		requestDump: (view) => controller.requestDump(view),
		promptInspection: () => ({
			...controller.promptInspection,
			basePromptDigest: finalComposition.promptDigest,
			compositionDigest: finalComposition.compositionDigest,
		}),
		securityInspection: () => ({
			ownerGeneration: fence.generation,
			securityRevision: security.snapshot.securityRevision,
			applicationState: security.applicationState,
			profile: security.snapshot.profile.name,
			approvalPolicy: security.snapshot.profile.approvalPolicy,
			filesystemMode: security.snapshot.profile.filesystemMode,
			networkMode: security.snapshot.profile.network.mode,
			sandboxMode: security.snapshot.profile.sandbox,
			approvalReviewer: security.snapshot.approvalReviewer ?? "user",
			policyDigest: security.snapshot.policyDigest,
			...(security.snapshot.managedConstraintsDigest === undefined ? {} : { managedConstraintsDigest: security.snapshot.managedConstraintsDigest }),
			sourceCount: security.snapshot.sources.length,
			presetAvailability: builtinPermissionPresets().map((preset) => ({
				id: preset.id,
				...preset.availability(security.snapshot.managedConstraints, security.sandboxCapability),
			})),
			bashAnalyzerMode: security.snapshot.bashAnalyzer?.mode,
			bashAnalyzerSource: security.snapshot.bashAnalyzer?.source,
			bashAnalyzerConfigDigest: security.snapshot.bashAnalyzer?.configDigest,
		}),
		snapshot: (): SessionDomainSnapshot => ({
			messages: controller.messages,
			warnings: controller.warnings,
			auditEntries: controller.auditEntries,
			selection: controller.currentSelection,
			toolCount: controller.toolCount,
			harnessToolNames: compositionReceipt.tools.map((tool) => tool.name),
			inFlight: controller.inFlight,
			compactionInFlight: compaction.busy,
			providerStatuses: [],
		}),
	};
}

function persistHarnessCompositionReceipt(
	store: SessionStore,
	fence: OwnerFence,
	receipt: HarnessCompositionReceipt,
): void {
	const payloadJson = JSON.stringify(receipt);
	const existing = store.replaySessionEvents(fence.sessionId).filter((event) =>
		event.eventType === "harness.composed" && event.ownerGeneration === fence.generation,
	);
	if (existing.length > 0) {
		if (existing.length === 1 && existing[0]!.payloadJson === payloadJson) return;
		throw new HarnessCompositionError(
			"harness_composition_conflict",
			`owner generation ${fence.generation} already has a different harness composition receipt`,
		);
	}
	const tail = store.replaySessionEvents(fence.sessionId).at(-1);
	store.appendEvent(fence, {
		eventId: `event_harness_composed_${fence.sessionId.slice(-12)}_${fence.generation}`,
		ownerGeneration: fence.generation,
		eventType: "harness.composed",
		payloadJson,
		createdAtMs: Date.now(),
		expectedPreviousEventHash: tail?.currentEventHash ?? null,
	});
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
