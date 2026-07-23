/** CLI 显式 migration/fork/version-fence 命令；不启动 TUI。 */

import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId, type AgentId, type GoalId } from "../runtime/protocol/v3/ids.ts";
import type {
	ExternalReceiptAuditReceipt,
	LifecycleResult,
	StartupExternalReceiptAuditPort,
} from "../runtime/lifecycle/recovery.ts";
import type { SessionMutationAdmissionGatePort } from "../runtime/lifecycle/mutation-gate.ts";
import {
	createStableForkPlan,
	type StableForkGoalMode,
} from "../runtime/session/checkpoint.ts";
import { migrateLegacySessionToV3, type LegacyMigrationMode } from "../runtime/session/legacy-migration.ts";
import { readAllRuntimeEvents } from "../runtime/session/snapshot.ts";
import { reduceSessionEvents } from "../runtime/session/reducer.ts";
import {
	DEFAULT_RUNTIME_FEATURES,
	resolveSessionV3Rollout,
	validateRuntimeFeatureFlags,
	type RuntimeFeatureFlags,
	type SessionV3FeatureState,
} from "../runtime/runtime-features.ts";
import type { ProjectSettings } from "../storage/settings-manager.ts";
import { GovernedV3SessionRuntime } from "../storage/v3-runtime-adapter.ts";
import { V3SessionManager } from "../storage/v3-session-manager.ts";

function unavailableExternalReceiptAudit(): Promise<LifecycleResult<ExternalReceiptAuditReceipt>> {
	return Promise.resolve({
		ok: false,
		error: {
			code: "external_unavailable",
			message: "CLI startup external receipt auditor is not configured",
			retryable: true,
		},
	});
}

export const FAIL_CLOSED_STARTUP_AUDITOR: StartupExternalReceiptAuditPort = Object.freeze({
	auditWorkspaceLease: unavailableExternalReceiptAudit,
	auditApprovalDecision: unavailableExternalReceiptAudit,
});

interface CliGovernedV3OpenOptions {
	filePath: string;
	features: Readonly<RuntimeFeatureFlags>;
	externalReceiptAuditor?: StartupExternalReceiptAuditPort;
	externalReceiptAuditTimeoutMs?: number;
	signal?: AbortSignal;
}

interface CliSessionCleanup {
	manager: V3SessionManager;
	label: string;
	discardIfEmpty: boolean;
}

function errorFrom(cause: unknown): Error {
	if (cause instanceof Error) return cause;
	return new Error(typeof cause === "string" ? cause : "unknown failure");
}

function commandError(operation: string, locator: string, cause: unknown): Error {
	const error = errorFrom(cause);
	return new Error(`${operation} failed; ${locator}: ${error.message}`, { cause: error });
}

async function cleanupSession(resource: CliSessionCleanup): Promise<Error | undefined> {
	const { manager, label } = resource;
	let discard = false;
	if (resource.discardIfEmpty) {
		try {
			discard = manager.writer().currentHead() === undefined;
		} catch (inspectionCause) {
			const errors = [errorFrom(inspectionCause)];
			try {
				await manager.closeAll();
			} catch (closeCause) {
				errors.push(errorFrom(closeCause));
			}
			return new AggregateError(
				errors,
				`${label} cleanup could not inspect the durable head: ${errors.map((error) => error.message).join("; ")}`,
			);
		}
	}
	if (discard) {
		try {
			await manager.discardEmptyTarget();
			return undefined;
		} catch (discardCause) {
			const errors = [errorFrom(discardCause)];
			try {
				await manager.closeAll();
			} catch (closeCause) {
				errors.push(errorFrom(closeCause));
			}
			const details = errors.map((error) => error.message).join("; ");
			return errors.length === 1
				? new Error(`${label} cleanup failed: ${details}`, { cause: errors[0] })
				: new AggregateError(errors, `${label} cleanup failed: ${details}`);
		}
	}
	try {
		await manager.closeAll();
		return undefined;
	} catch (closeCause) {
		const error = errorFrom(closeCause);
		return new Error(`${label} cleanup failed: ${error.message}`, { cause: error });
	}
}

async function settleSessions(
	operation: string,
	resources: readonly CliSessionCleanup[],
	operationError?: Error,
): Promise<void> {
	const cleanupErrors: Error[] = [];
	for (const resource of resources) {
		const cleanupError = await cleanupSession(resource);
		if (cleanupError) cleanupErrors.push(cleanupError);
	}
	if (cleanupErrors.length === 0) return;
	throw new AggregateError(
		operationError ? [operationError, ...cleanupErrors] : cleanupErrors,
		`${operation} cleanup was incomplete: ${cleanupErrors.map((error) => error.message).join("; ")}`,
	);
}

async function throwAfterGovernedClose(
	operation: string,
	filePath: string,
	governed: GovernedV3SessionRuntime,
	failure: Error,
): Promise<never> {
	try {
		await governed.close();
	} catch (closeCause) {
		const cleanupError = errorFrom(closeCause);
		throw new AggregateError(
			[failure, cleanupError],
			`${operation} rejected and target=${filePath} cleanup failed: ${cleanupError.message}`,
		);
	}
	throw failure;
}

function openGovernedRuntimeFromCli(options: CliGovernedV3OpenOptions): Promise<GovernedV3SessionRuntime> {
	return GovernedV3SessionRuntime.open({
		filePath: options.filePath,
		features: options.features,
		externalReceiptAuditor: options.externalReceiptAuditor ?? FAIL_CLOSED_STARTUP_AUDITOR,
		...(options.externalReceiptAuditTimeoutMs === undefined
			? {}
			: { externalReceiptAuditTimeoutMs: options.externalReceiptAuditTimeoutMs }),
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
}

export interface CliGovernedV3Session {
	manager: V3SessionManager;
	mutationGate: SessionMutationAdmissionGatePort;
}

export async function openGovernedV3FromCli(options: CliGovernedV3OpenOptions): Promise<CliGovernedV3Session> {
	const governed = await openGovernedRuntimeFromCli(options);
	const admitted = await governed.runIfResumable(async (manager) => manager);
	if (admitted.ok) return { manager: admitted.value, mutationGate: governed.mutationGate() };
	const startup = governed.startupReport().sessions[0];
	return throwAfterGovernedClose("V3 governed startup", options.filePath, governed, new Error(
		`V3 governed startup not approved after external receipt audit: ${startup?.reasons.join(",") || startup?.disposition || "unknown"}`,
	));
}

async function openGovernedMigrationTargetFromCli(options: CliGovernedV3OpenOptions): Promise<V3SessionManager> {
	const governed = await openGovernedRuntimeFromCli(options);
	const admitted = await governed.runIfMigrationRecoveryApproved(async (manager) => manager);
	if (admitted.ok) return admitted.value;
	const startup = governed.startupReport().sessions[0];
	return throwAfterGovernedClose("V3 governed migration recovery", options.filePath, governed, new Error(
		`V3 migration recovery not approved after external receipt audit: ${startup?.reasons.join(",") || startup?.disposition || "unknown"}`,
	));
}

export interface CliRuntimeConfiguration {
	features: RuntimeFeatureFlags;
	sessionV3State: SessionV3FeatureState;
	sessionV3HighestActivatedState: SessionV3FeatureState;
	requiresHistoryPersistence: boolean;
}

export function resolveCliRuntimeConfiguration(settings: ProjectSettings): CliRuntimeConfiguration {
	const rollout = resolveSessionV3Rollout({
		requestedState: settings.sessionV3FeatureState,
		legacyEnabled: settings.runtimeFeatures?.sessionV3,
		highestActivatedState: settings.sessionV3HighestActivatedState,
	});
	const flags: RuntimeFeatureFlags = {
		...DEFAULT_RUNTIME_FEATURES,
		...settings.runtimeFeatures,
		sessionV3: rollout.enabled,
	};
	const errors = validateRuntimeFeatureFlags(flags);
	if (errors.length > 0) throw new Error(`invalid runtime feature configuration: ${errors.join("; ")}`);
	return {
		features: flags,
		sessionV3State: rollout.state,
		sessionV3HighestActivatedState: rollout.highestActivatedState,
		requiresHistoryPersistence: rollout.requiresHistoryPersistence,
	};
}

/** 兼容既有 callers；CLI 主流程应使用 resolveCliRuntimeConfiguration 取得状态矩阵。 */
export function resolveCliRuntimeFeatures(settings: ProjectSettings): RuntimeFeatureFlags {
	return resolveCliRuntimeConfiguration(settings).features;
}

export async function migrateLegacyFromCli(options: {
	sourcePath: string;
	mode: LegacyMigrationMode;
	cwd: string;
	sessionDir: string;
	features: RuntimeFeatureFlags;
	/** partial target 的显式续跑路径；不提供时始终创建全新 target。 */
	resumeTargetPath?: string;
	externalReceiptAuditor?: StartupExternalReceiptAuditPort;
	externalReceiptAuditTimeoutMs?: number;
}): Promise<{ filePath: string; importedMessageCount: number; sourceDigest: string; headDigest: string }> {
	if (!options.features.sessionV3) {
		throw new Error("Runtime v3 migration is disabled; enable runtimeFeatures.sessionV3 explicitly");
	}
	const target = options.resumeTargetPath
		? await openGovernedMigrationTargetFromCli({
				filePath: options.resumeTargetPath,
				features: options.features,
				...(options.externalReceiptAuditor === undefined
					? {}
					: { externalReceiptAuditor: options.externalReceiptAuditor }),
				...(options.externalReceiptAuditTimeoutMs === undefined
					? {}
					: { externalReceiptAuditTimeoutMs: options.externalReceiptAuditTimeoutMs }),
			})
		: await V3SessionManager.create({
				cwd: options.cwd,
				sessionDir: options.sessionDir,
				features: options.features,
				writeGenesis: false,
			});
	let operationError: Error | undefined;
	try {
		const result = await migrateLegacySessionToV3({
			sourcePath: options.sourcePath,
			mode: options.mode,
			targetSessionId: target.sessionId(),
			writer: target.writer(),
			eventStore: target.eventStore(),
			principalId: target.identity().principalId,
			traceId: createRuntimeId("trace"),
			idempotencyKey: createRuntimeId("command"),
		});
		if (result.status === "forensic_required" || result.status === "rejected") {
			const reason = result.status === "forensic_required" ? result.report.message : result.error.message;
			throw new Error(`legacy session migration refused: ${reason}`);
		}
		if (result.status === "partial" || result.status === "failed") {
			throw new Error(`legacy session migration did not commit: ${result.error.message}`);
		}
		return {
			filePath: target.filePath(),
			importedMessageCount: result.importedMessages.length,
			sourceDigest: result.source.sourceDigest,
			headDigest: result.head.eventHash,
		};
	} catch (cause) {
		operationError = commandError("legacy session migration", `target=${target.filePath()}`, cause);
		throw operationError;
	} finally {
		await settleSessions("legacy session migration", [{
			manager: target,
			label: `migration target=${target.filePath()}`,
			discardIfEmpty: operationError !== undefined && options.resumeTargetPath === undefined,
		}], operationError);
	}
}

export async function forkV3FromCli(options: {
	sourcePath: string;
	cwd: string;
	sessionDir: string;
	features: RuntimeFeatureFlags;
	goalMode?: StableForkGoalMode;
	initialGoalId?: GoalId;
	externalReceiptAuditor?: StartupExternalReceiptAuditPort;
	externalReceiptAuditTimeoutMs?: number;
}): Promise<{
	filePath: string;
	parentHeadDigest: string;
	childHeadDigest: string;
	goalMode: StableForkGoalMode;
	initialGoalId: GoalId;
	rootAgentId: AgentId;
	parentRootAgentId: AgentId;
}> {
	if (!options.features.sessionV3) throw new Error("Runtime v3 fork is disabled");
	const governedParent = await openGovernedV3FromCli({
		filePath: options.sourcePath,
		features: options.features,
		...(options.externalReceiptAuditor === undefined
			? {}
			: { externalReceiptAuditor: options.externalReceiptAuditor }),
		...(options.externalReceiptAuditTimeoutMs === undefined
			? {}
			: { externalReceiptAuditTimeoutMs: options.externalReceiptAuditTimeoutMs }),
	});
	const parent = governedParent.manager;
	let child: V3SessionManager | undefined;
	let operationError: Error | undefined;
	try {
		const eventsResult = await readAllRuntimeEvents(parent.eventStore());
		if (!eventsResult.ok) throw new Error(eventsResult.error.message);
		const projection = reduceSessionEvents(eventsResult.value);
		if (!projection.ok) throw new Error(projection.error.message);
		const parentHead = parent.writer().currentHead();
		if (!parentHead) throw new Error("V3 session fork parent has no canonical head");
		const forkCommandId = createRuntimeId("command");
		const admitted = await governedParent.mutationGate.revalidate({
			kind: "session_fork",
			correlationId: forkCommandId,
			expectedHead: parentHead,
		});
		if (!admitted.ok) {
			throw new Error(`V3 session fork external receipt revalidation failed: ${admitted.error.message}`);
		}
		const goalMode = options.goalMode ?? "continue_existing_goal";
		const initialGoalId = options.initialGoalId ?? (
			goalMode === "continue_existing_goal"
				? projection.value.genesis.initialGoalId
				: createRuntimeId("goal")
		);
		const rootAgentId = createRuntimeId("agent");
		child = await V3SessionManager.create({
			cwd: options.cwd,
			sessionDir: options.sessionDir,
			features: options.features,
			writeGenesis: false,
			lineage: { goalId: initialGoalId, agentId: rootAgentId },
			publication: { kind: "fork", mode: "manual" },
		});
		const plan = createStableForkPlan(projection.value, {
			newSessionId: child.sessionId(),
			parentLeafId: projection.value.activeLeafId,
			goalMode,
			initialGoalId,
			rootAgentId,
			idempotencyKey: forkCommandId,
			principalId: child.identity().principalId,
			traceId: createRuntimeId("trace"),
		});
		if (!plan.ok) {
			throw new Error(plan.error.message);
		}
		const genesis = await child.writer().append(plan.value.genesisDraft);
		if (!genesis.ok) {
			throw new Error(genesis.error.message);
		}
		const messages = await parent.replayMessages();
		for (const message of messages) await child.sessionEvents().recordMessage(message);
		await child.publishStagedTarget();
		const childHead = child.writer().currentHead();
		if (!childHead) throw new Error("v3 fork produced no child head");
		return {
			filePath: child.filePath(),
			parentHeadDigest: plan.value.parentCursor.eventHash,
			childHeadDigest: childHead.eventHash,
			goalMode: plan.value.goalMode,
			initialGoalId: plan.value.initialGoalId,
			rootAgentId: plan.value.rootAgentId,
			parentRootAgentId: plan.value.parentRootAgentId,
		};
	} catch (cause) {
		let cleanupSummary = "";
		if (child?.publicationState() === "staging") {
			const cleanup = await child.abortUnpublishedTarget("fork construction failed");
			cleanupSummary = `; cleanup=${cleanup.status}` +
				(cleanup.errors.length === 0 ? "" : ` (${cleanup.errors.join("; ")})`);
		}
		operationError = commandError(
			"V3 session fork",
			child ? `child=${child.filePath()}` : `parent=${parent.filePath()}`,
			new Error(`${errorFrom(cause).message}${cleanupSummary}`, { cause: errorFrom(cause) }),
		);
		throw operationError;
	} finally {
		await settleSessions("V3 session fork", [
			...(child
				? [{ manager: child, label: `fork child=${child.filePath()}`, discardIfEmpty: operationError !== undefined }]
				: []),
			{ manager: parent, label: `fork parent=${parent.filePath()}`, discardIfEmpty: false },
		], operationError);
	}
}

export function migrationEvidenceDigest(value: unknown): string {
	return canonicalDigest(value);
}
