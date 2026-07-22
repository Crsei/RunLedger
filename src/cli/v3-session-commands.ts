/** CLI 显式 migration/fork/version-fence 命令；不启动 TUI。 */

import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId, type AgentId, type GoalId } from "../runtime/protocol/v3/ids.ts";
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
import { V3SessionManager } from "../storage/v3-session-manager.ts";

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
}): Promise<{ filePath: string; importedMessageCount: number; sourceDigest: string; headDigest: string }> {
	if (!options.features.sessionV3) {
		throw new Error("Runtime v3 migration is disabled; enable runtimeFeatures.sessionV3 explicitly");
	}
	const target = options.resumeTargetPath
		? await V3SessionManager.open(options.resumeTargetPath, options.features)
		: await V3SessionManager.create({
				cwd: options.cwd,
				sessionDir: options.sessionDir,
				features: options.features,
				writeGenesis: false,
			});
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
		if (!options.resumeTargetPath && target.writer().currentHead() === undefined) await target.discardEmptyTarget();
		else await target.closeAll().catch(() => undefined);
		const reason = result.status === "forensic_required" ? result.report.message : result.error.message;
		throw new Error(`legacy session migration refused: ${reason}`);
	}
	if (result.status === "partial" || result.status === "failed") {
		await target.closeAll().catch(() => undefined);
		throw new Error(`legacy session migration did not commit: ${result.error.message}; target=${target.filePath()}`);
	}
	const response = {
		filePath: target.filePath(),
		importedMessageCount: result.importedMessages.length,
		sourceDigest: result.source.sourceDigest,
		headDigest: result.head.eventHash,
	};
	await target.closeAll();
	return response;
}

export async function forkV3FromCli(options: {
	sourcePath: string;
	cwd: string;
	sessionDir: string;
	features: RuntimeFeatureFlags;
	goalMode?: StableForkGoalMode;
	initialGoalId?: GoalId;
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
	const parent = await V3SessionManager.open(options.sourcePath, options.features);
	try {
		const eventsResult = await readAllRuntimeEvents(parent.eventStore());
		if (!eventsResult.ok) throw new Error(eventsResult.error.message);
		const projection = reduceSessionEvents(eventsResult.value);
		if (!projection.ok) throw new Error(projection.error.message);
		const goalMode = options.goalMode ?? "continue_existing_goal";
		const initialGoalId = options.initialGoalId ?? (
			goalMode === "continue_existing_goal"
				? projection.value.genesis.initialGoalId
				: createRuntimeId("goal")
		);
		const rootAgentId = createRuntimeId("agent");
		const child = await V3SessionManager.create({
			cwd: options.cwd,
			sessionDir: options.sessionDir,
			features: options.features,
			writeGenesis: false,
			lineage: { goalId: initialGoalId, agentId: rootAgentId },
		});
		const plan = createStableForkPlan(projection.value, {
			newSessionId: child.sessionId(),
			parentLeafId: projection.value.activeLeafId,
			goalMode,
			initialGoalId,
			rootAgentId,
			idempotencyKey: createRuntimeId("command"),
			principalId: child.identity().principalId,
			traceId: createRuntimeId("trace"),
		});
		if (!plan.ok) {
			await child.discardEmptyTarget();
			throw new Error(plan.error.message);
		}
		const genesis = await child.writer().append(plan.value.genesisDraft);
		if (!genesis.ok) {
			await child.discardEmptyTarget();
			throw new Error(genesis.error.message);
		}
		const messages = await parent.replayMessages();
		for (const message of messages) await child.sessionEvents().recordMessage(message);
		const childHead = child.writer().currentHead();
		if (!childHead) throw new Error("v3 fork produced no child head");
		const response = {
			filePath: child.filePath(),
			parentHeadDigest: plan.value.parentCursor.eventHash,
			childHeadDigest: childHead.eventHash,
			goalMode: plan.value.goalMode,
			initialGoalId: plan.value.initialGoalId,
			rootAgentId: plan.value.rootAgentId,
			parentRootAgentId: plan.value.parentRootAgentId,
		};
		await child.closeAll();
		return response;
	} finally {
		await parent.closeAll().catch(() => undefined);
	}
}

export function migrationEvidenceDigest(value: unknown): string {
	return canonicalDigest(value);
}
