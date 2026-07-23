/** Session snapshot 是可丢弃的加速层；Event Store 始终是唯一事实来源。 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Check } from "typebox/value";
import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import { ArtifactRefSchema } from "../protocol/v3/capability.ts";
import {
	sameRuntimeEventStream,
	type GoalPhase,
	type EventCursor,
	type ExpectedRevision,
	type RuntimeEventV3,
} from "../protocol/v3/events.ts";
import {
	isRuntimeId,
	type ArtifactId,
	type AgentId,
	type CommandId,
	type GoalId,
	type LeafId,
	type ModelRequestId,
	type QueueItemId,
	type SnapshotId,
	type TurnId,
} from "../protocol/v3/ids.ts";
import {
	BUDGET_DIMENSIONS,
	projectBudgetSnapshotFromJournal,
	type BudgetDimension,
} from "../orchestrator/budget-guard.ts";
import {
	budgetTruthFromCanonicalEvents,
	latestCanonicalGoalState,
} from "../orchestrator/canonical-journals.ts";
import { reduceCanonicalTaskEvents, type TaskStatus } from "../orchestrator/task-repository.ts";
import { isEventCursor, isExpectedRevision, validateRuntimeEvent } from "../protocol/v3/schemas.ts";
import { verifyRuntimeEventChain } from "./chain-verification.ts";
import {
	isSessionLifecycleHeadRef,
	joinSessionLifecycle,
	type AuthorityLifecycleProjection,
} from "./authority-lifecycle-projection.ts";
import type { RuntimeEventStore } from "./event-store.ts";
import type {
	QueueItemContent,
	QueueItemNextTurnPolicy,
	QueueItemTargetTurnRevision,
	SessionForkGoalMode,
	SessionLifecycleHeadRef,
	SessionProjection,
} from "./projections.ts";
import { reduceSessionEvents } from "./reducer.ts";
import {
	createSessionRestoreDependencySnapshot,
	isSessionRestoreDependencySnapshot,
	type SessionRestoreDependencySnapshot,
} from "./restore-dependencies.ts";
import type { SessionKernelError, SessionResult } from "./types.ts";

export const SESSION_SNAPSHOT_SCHEMA_VERSION = 3 as const;
export const MAX_SESSION_SNAPSHOT_BYTES = 1024 * 1024;

export interface SnapshotQueueItem {
	queueItemId: QueueItemId;
	sourceCommandId: CommandId;
	kind: "steer" | "follow_up";
	enqueueRevision: ExpectedRevision;
	targetTurnRevision: QueueItemTargetTurnRevision | null;
	nextTurnPolicy: QueueItemNextTurnPolicy;
	contentDigest: string;
	content: QueueItemContent;
	status: "enqueued" | "claimed";
	enqueuedSequence: number;
	claimedSequence: number | null;
	turnId: TurnId | null;
	modelRequestId: ModelRequestId | null;
}

export interface SnapshotGoalProjection {
	goalId: GoalId;
	phase: GoalPhase | null;
}

export interface SnapshotTaskProjection {
	taskId: string;
	status: TaskStatus;
	definitionRevision: number;
	definitionDigest: string;
	dependsOn: readonly string[];
	outputArtifactIds: readonly ArtifactId[];
	lastRepositoryRevision: number;
}

export interface SnapshotBudgetProjection {
	dimension: BudgetDimension;
	reserved: number;
	committed: number;
	refunded: number;
	estimated: number | null;
	actual: number | null;
	consumed: number | null;
	limit: number | null;
}

export interface SessionSnapshotBody {
	schemaVersion: typeof SESSION_SNAPSHOT_SCHEMA_VERSION;
	snapshotId: SnapshotId;
	authorityId: SessionProjection["authorityId"];
	tenantId: SessionProjection["tenantId"];
	principalId: SessionProjection["principalId"];
	sessionId: SessionProjection["sessionId"];
	cursor: EventCursor;
	projectionDigest: string;
	lifecycleHeadRef: SessionLifecycleHeadRef | null;
	activeLeafId: LeafId;
	initialGoalId: GoalId;
	rootAgentId: AgentId;
	forkGoalMode: SessionForkGoalMode | null;
	parentRootAgentId: AgentId | null;
	goal: SnapshotGoalProjection | null;
	tasks: readonly SnapshotTaskProjection[];
	queue: readonly SnapshotQueueItem[];
	budgets: readonly SnapshotBudgetProjection[];
	/** v3 旧快照可缺省；新快照始终写入，非空 registry 不得恢复自缺省快照。 */
	restoreDependencies?: SessionRestoreDependencySnapshot;
	writtenAt: string;
}

export interface SessionSnapshot extends SessionSnapshotBody {
	snapshotDigest: string;
}

export interface CreateSessionSnapshotOptions {
	snapshotId: SnapshotId;
	activeLeafId: LeafId;
	writtenAt: string;
	/** 非空时必须先通过显式 authority projection join，snapshot 不能自行信任裸 ref。 */
	authorityLifecycle?: AuthorityLifecycleProjection;
	/** undefined 写入当前 empty binding；null 仅供验证历史缺字段的 v3 snapshot。 */
	restoreDependencies?: SessionRestoreDependencySnapshot | null;
}

export interface SnapshotReplayResult {
	projection: SessionProjection;
	events: readonly RuntimeEventV3[];
	tailEvents: readonly RuntimeEventV3[];
	snapshot: SessionSnapshot | undefined;
	source: "snapshot" | "full";
}

export type SessionSnapshotWritePhase = "before_write" | "before_rename" | "before_directory_sync";

export interface WriteSessionSnapshotOptions {
	onWritePhase?: (phase: SessionSnapshotWritePhase) => Promise<void> | void;
}

function fail<T>(error: SessionKernelError): SessionResult<T> {
	return { ok: false, error };
}

function corrupted<T>(message: string, details?: SessionKernelError["details"]): SessionResult<T> {
	return fail({ code: "corrupted_log", message, retryable: false, ...(details ? { details } : {}) });
}

function durableFailure<T>(message: string): SessionResult<T> {
	return fail({ code: "durable_write_failed", message, retryable: false });
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
		Number.isFinite(Date.parse(value))
	);
}

function isSafeRevision(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableFiniteNonNegative(value: unknown): value is number | null {
	return value === null || isFiniteNonNegative(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSnapshotQueueContent(value: unknown): value is QueueItemContent {
	if (!isRecord(value)) return false;
	if (value.storage === "bounded_text") {
		return hasExactKeys(value, ["storage", "messageJson"]) &&
			typeof value.messageJson === "string" &&
			value.messageJson.length >= 2 &&
			value.messageJson.length <= 60 * 1024;
	}
	return value.storage === "artifact" &&
		hasExactKeys(value, ["storage", "artifact"]) &&
		Check(ArtifactRefSchema, value.artifact);
}

function isSnapshotQueueTarget(value: unknown): value is QueueItemTargetTurnRevision {
	return isRecord(value) &&
		hasExactKeys(value, ["turnId", "sessionRevision"]) &&
		isRuntimeId(value.turnId, "turn") &&
		isExpectedRevision(value.sessionRevision);
}

function isSnapshotQueueItem(value: unknown): value is SnapshotQueueItem {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"queueItemId",
			"sourceCommandId",
			"kind",
			"enqueueRevision",
			"targetTurnRevision",
			"nextTurnPolicy",
			"contentDigest",
			"content",
			"status",
			"enqueuedSequence",
			"claimedSequence",
			"turnId",
			"modelRequestId",
		])
	) {
		return false;
	}
	return (
		isRuntimeId(value.queueItemId, "queueItem") &&
		isRuntimeId(value.sourceCommandId, "command") &&
		(value.kind === "steer" || value.kind === "follow_up") &&
		isExpectedRevision(value.enqueueRevision) &&
		(value.targetTurnRevision === null || isSnapshotQueueTarget(value.targetTurnRevision)) &&
		(value.nextTurnPolicy === "next_model_turn" || value.nextTurnPolicy === "after_active_run") &&
		isDigest(value.contentDigest) &&
		isSnapshotQueueContent(value.content) &&
		canonicalDigest(value.content) === value.contentDigest &&
		(value.status === "enqueued" || value.status === "claimed") &&
		isSafeRevision(value.enqueuedSequence) &&
		value.enqueueRevision.sequence + 1 === value.enqueuedSequence &&
		(value.targetTurnRevision === null || (
			sameRuntimeEventStream(value.targetTurnRevision.sessionRevision.stream, value.enqueueRevision.stream) &&
			value.targetTurnRevision.sessionRevision.sequence === value.enqueueRevision.sequence &&
			value.targetTurnRevision.sessionRevision.eventHash === value.enqueueRevision.eventHash
		)) &&
		(value.kind === "steer"
			? value.nextTurnPolicy === "next_model_turn"
			: value.nextTurnPolicy === "after_active_run") &&
		(value.claimedSequence === null || isSafeRevision(value.claimedSequence)) &&
		(value.turnId === null || isRuntimeId(value.turnId, "turn")) &&
		(value.modelRequestId === null || isRuntimeId(value.modelRequestId, "modelRequest")) &&
		(value.status !== "claimed" ||
			(value.claimedSequence !== null && value.turnId !== null && value.modelRequestId !== null))
	);
}

function isSnapshotGoal(value: unknown): value is SnapshotGoalProjection {
	if (!isRecord(value) || !hasExactKeys(value, ["goalId", "phase"])) return false;
	const phases: ReadonlySet<string> = new Set([
		"planning",
		"awaiting_plan_approval",
		"implementation",
		"build",
		"test",
		"security_review",
		"independent_review",
		"remediation",
		"reverification",
		"awaiting_verification",
		"awaiting_human",
		"completed",
		"failed",
		"stopped",
	]);
	return isRuntimeId(value.goalId, "goal") && (value.phase === null || (typeof value.phase === "string" && phases.has(value.phase)));
}

function isSnapshotTask(value: unknown): value is SnapshotTaskProjection {
	return (
		isRecord(value) &&
		hasExactKeys(value, [
			"taskId",
			"status",
			"definitionRevision",
			"definitionDigest",
			"dependsOn",
			"outputArtifactIds",
			"lastRepositoryRevision",
		]) &&
		typeof value.taskId === "string" &&
		value.taskId.length >= 1 &&
		value.taskId.length <= 128 &&
		typeof value.status === "string" &&
		(["pending", "ready", "running", "blocked", "completed", "failed", "cancelled"] as readonly string[])
			.includes(value.status) &&
		isSafeRevision(value.definitionRevision) &&
		value.definitionRevision >= 1 &&
		isDigest(value.definitionDigest) &&
		Array.isArray(value.dependsOn) &&
		value.dependsOn.length <= 256 &&
		value.dependsOn.every((dependency) => typeof dependency === "string" && dependency.length >= 1 && dependency.length <= 128) &&
		new Set(value.dependsOn).size === value.dependsOn.length &&
		Array.isArray(value.outputArtifactIds) &&
		value.outputArtifactIds.length <= 64 &&
		value.outputArtifactIds.every((artifactId) => isRuntimeId(artifactId, "artifact")) &&
		new Set(value.outputArtifactIds).size === value.outputArtifactIds.length &&
		isSafeRevision(value.lastRepositoryRevision) &&
		value.lastRepositoryRevision >= 1
	);
}

function isSnapshotBudget(value: unknown): value is SnapshotBudgetProjection {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["dimension", "reserved", "committed", "refunded", "estimated", "actual", "consumed", "limit"])
	) return false;
	return (
		typeof value.dimension === "string" &&
		(BUDGET_DIMENSIONS as readonly string[]).includes(value.dimension) &&
		isFiniteNonNegative(value.reserved) &&
		isFiniteNonNegative(value.committed) &&
		isFiniteNonNegative(value.refunded) &&
		isNullableFiniteNonNegative(value.estimated) &&
		isNullableFiniteNonNegative(value.actual) &&
		isNullableFiniteNonNegative(value.consumed) &&
		isNullableFiniteNonNegative(value.limit)
	);
}

export function validateSessionSnapshot(value: unknown): value is SessionSnapshot {
	const legacyKeys = [
		"schemaVersion",
		"snapshotId",
		"authorityId",
		"tenantId",
		"principalId",
		"sessionId",
		"cursor",
		"projectionDigest",
		"lifecycleHeadRef",
		"activeLeafId",
		"initialGoalId",
		"rootAgentId",
		"forkGoalMode",
		"parentRootAgentId",
		"goal",
		"tasks",
		"queue",
		"budgets",
		"writtenAt",
		"snapshotDigest",
	] as const;
	if (
		!isRecord(value) ||
		(!hasExactKeys(value, legacyKeys) &&
			!hasExactKeys(value, [...legacyKeys, "restoreDependencies"]))
	) return false;
	if (
		value.schemaVersion !== SESSION_SNAPSHOT_SCHEMA_VERSION ||
		!isRuntimeId(value.snapshotId, "snapshot") ||
		!isRuntimeId(value.authorityId, "authority") ||
		!isRuntimeId(value.tenantId, "tenant") ||
		!isRuntimeId(value.principalId, "principal") ||
		!isRuntimeId(value.sessionId, "session") ||
		!isEventCursor(value.cursor) ||
		value.cursor.stream.scope !== "session" ||
		value.cursor.stream.sessionId !== value.sessionId ||
		!isDigest(value.projectionDigest) ||
		(value.lifecycleHeadRef !== null && !isSessionLifecycleHeadRef(value.lifecycleHeadRef)) ||
		!isRuntimeId(value.activeLeafId, "leaf") ||
		!isRuntimeId(value.initialGoalId, "goal") ||
		!isRuntimeId(value.rootAgentId, "agent") ||
		(value.forkGoalMode !== null &&
			value.forkGoalMode !== "continue_existing_goal" &&
			value.forkGoalMode !== "create_child_goal") ||
		(value.parentRootAgentId !== null && !isRuntimeId(value.parentRootAgentId, "agent")) ||
		(value.forkGoalMode === null) !== (value.parentRootAgentId === null) ||
		(value.parentRootAgentId !== null && value.parentRootAgentId === value.rootAgentId) ||
		(value.goal !== null && !isSnapshotGoal(value.goal)) ||
		!Array.isArray(value.tasks) ||
		value.tasks.length > 10_000 ||
		!value.tasks.every(isSnapshotTask) ||
		!Array.isArray(value.queue) ||
		value.queue.length > 10_000 ||
		!value.queue.every(isSnapshotQueueItem) ||
		!Array.isArray(value.budgets) ||
		value.budgets.length > 1_000 ||
		!value.budgets.every(isSnapshotBudget) ||
		(value.restoreDependencies !== undefined &&
			!isSessionRestoreDependencySnapshot(value.restoreDependencies)) ||
		!isCanonicalTimestamp(value.writtenAt) ||
		!isDigest(value.snapshotDigest)
	) return false;
	if (value.lifecycleHeadRef !== null && (
		value.lifecycleHeadRef.authorityId !== value.authorityId ||
		value.lifecycleHeadRef.tenantId !== value.tenantId ||
		value.lifecycleHeadRef.subjectSessionId !== value.sessionId ||
		!sameRuntimeEventStream(value.lifecycleHeadRef.finalSessionHead.stream, value.cursor.stream) ||
		value.lifecycleHeadRef.finalSessionHead.sequence !== value.cursor.sequence ||
		value.lifecycleHeadRef.finalSessionHead.eventId !== value.cursor.eventId ||
		value.lifecycleHeadRef.finalSessionHead.eventHash !== value.cursor.eventHash
	)) return false;
	const queueIds = new Set(value.queue.map((item) => item.queueItemId));
	const taskIds = new Set(value.tasks.map((task) => task.taskId));
	const dimensions = new Set(value.budgets.map((budget) => budget.dimension));
	if (
		queueIds.size !== value.queue.length ||
		taskIds.size !== value.tasks.length ||
		dimensions.size !== value.budgets.length ||
		value.tasks.some((task) => task.dependsOn.some((dependency) => !taskIds.has(dependency)))
	) return false;
	const { snapshotDigest, ...body } = value;
	try {
		return canonicalDigest(body) === snapshotDigest;
	} catch {
		return false;
	}
}

function currentGoal(events: readonly RuntimeEventV3[], projection: SessionProjection): SnapshotGoalProjection | null {
	let goalId: GoalId | undefined = projection.genesis.initialGoalId;
	for (const event of events) {
		if (event.type === "session.created" && event.payload.initialGoalId) goalId = event.payload.initialGoalId as GoalId;
		if (event.type === "turn.started") goalId = event.payload.goalId as GoalId;
	}
	const canonical = latestCanonicalGoalState(events);
	if (!canonical.ok) throw new TypeError(canonical.error.message);
	if (canonical.value) return { goalId: canonical.value.goalId, phase: canonical.value.phase };
	if (!goalId) goalId = projection.turns.at(-1)?.goalId;
	return goalId ? { goalId, phase: null } : null;
}

function taskProjection(events: readonly RuntimeEventV3[]): readonly SnapshotTaskProjection[] {
	const projection = reduceCanonicalTaskEvents(events);
	if (!projection.ok) throw new TypeError(projection.error.message);
	return projection.value.tasks.map((task) => ({
		taskId: task.definition.taskId,
		status: task.status,
		definitionRevision: task.definition.definitionRevision,
		definitionDigest: task.definition.definitionDigest,
		dependsOn: [...task.definition.dependsOn],
		outputArtifactIds: task.outputs.map((output) => output.artifact.artifactId),
		lastRepositoryRevision: task.lastRepositoryRevision,
	}));
}

function budgetProjection(events: readonly RuntimeEventV3[]): readonly SnapshotBudgetProjection[] {
	const truth = budgetTruthFromCanonicalEvents(events);
	if (!truth.ok) throw new TypeError(truth.error.message);
	if (!truth.value.goalId || !truth.value.limits) return [];
	const projected = projectBudgetSnapshotFromJournal(truth.value.goalId, truth.value.journal);
	if (!projected.ok) throw new TypeError(projected.error.message);
	const refunded = Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, 0])) as Record<BudgetDimension, number>;
	const estimated = Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, 0])) as Record<BudgetDimension, number>;
	for (const transaction of truth.value.journal.transactions) {
		for (const record of transaction.records) {
			if (record.kind === "budget.refunded") {
				for (const dimension of BUDGET_DIMENSIONS) refunded[dimension] += record.amount[dimension];
			}
			if (record.kind === "budget.reserved") {
				for (const dimension of BUDGET_DIMENSIONS) estimated[dimension] += record.estimatedUpperBound[dimension];
			}
		}
	}
	if ([...Object.values(refunded), ...Object.values(estimated)].some((value) => !Number.isSafeInteger(value))) {
		throw new TypeError("canonical budget snapshot aggregation overflowed");
	}
	return BUDGET_DIMENSIONS.map((dimension): SnapshotBudgetProjection => ({
		dimension,
		reserved: projected.value.reserved[dimension],
		committed: projected.value.committed[dimension],
		refunded: refunded[dimension],
		estimated: estimated[dimension],
		actual: projected.value.committed[dimension],
		consumed: projected.value.committed[dimension] + projected.value.reserved[dimension],
		limit: truth.value.limits![dimension].hard,
	}));
}

function buildSnapshotBody(
	events: readonly RuntimeEventV3[],
	projection: SessionProjection,
	options: CreateSessionSnapshotOptions,
): SessionSnapshotBody {
	const genesis = events[0];
	if (!genesis || genesis.stream.scope !== "session") throw new TypeError("session snapshot requires session stream genesis");
	return {
		schemaVersion: SESSION_SNAPSHOT_SCHEMA_VERSION,
		snapshotId: options.snapshotId,
		authorityId: projection.authorityId,
		tenantId: projection.tenantId,
		principalId: projection.principalId,
		sessionId: projection.sessionId,
		cursor: {
			stream: genesis.stream,
			sequence: projection.headSequence,
			eventId: projection.headEventId,
			eventHash: projection.headEventHash,
		},
		projectionDigest: projection.projectionDigest,
		lifecycleHeadRef: projection.lifecycleHeadRef,
		activeLeafId: options.activeLeafId,
		initialGoalId: projection.genesis.initialGoalId,
		rootAgentId: projection.genesis.rootAgentId,
		forkGoalMode: projection.genesis.kind === "forked" ? projection.genesis.goalMode : null,
		parentRootAgentId: projection.genesis.kind === "forked" ? projection.genesis.parentRootAgentId : null,
		goal: currentGoal(events, projection),
		tasks: taskProjection(events),
		queue: projection.queueItems
			.filter((item) => item.status === "enqueued" || item.status === "claimed")
			.map((item) => ({
				queueItemId: item.queueItemId as QueueItemId,
				sourceCommandId: item.sourceCommandId,
				kind: item.kind,
				enqueueRevision: item.enqueueRevision,
				targetTurnRevision: item.targetTurnRevision,
				nextTurnPolicy: item.nextTurnPolicy,
				contentDigest: item.contentDigest,
				content: item.content,
				status: item.status as "enqueued" | "claimed",
				enqueuedSequence: item.enqueuedSequence,
				claimedSequence: item.claimedSequence,
				turnId: item.turnId,
				modelRequestId: item.modelRequestId,
			})),
		budgets: budgetProjection(events),
		...(options.restoreDependencies === null
			? {}
			: {
					restoreDependencies:
						options.restoreDependencies ??
						createSessionRestoreDependencySnapshot([]),
				}),
		writtenAt: options.writtenAt,
	};
}

export function createSessionSnapshot(
	events: readonly RuntimeEventV3[],
	options: CreateSessionSnapshotOptions,
): SessionResult<SessionSnapshot> {
	if (
		!isRuntimeId(options.snapshotId, "snapshot") ||
		!isRuntimeId(options.activeLeafId, "leaf") ||
		!isCanonicalTimestamp(options.writtenAt)
	) return corrupted("snapshot options are invalid");
	const reduced = reduceSessionEvents(events);
	if (!reduced.ok) return reduced;
	const projection = options.authorityLifecycle
		? joinSessionLifecycle(reduced.value, options.authorityLifecycle)
		: reduced;
	if (!projection.ok) return projection;
	if (
		options.activeLeafId !== projection.value.activeLeafId ||
		!projection.value.knownLeafIds.includes(options.activeLeafId)
	) return corrupted("snapshot active leaf does not match the connected session leaf");
	const body = buildSnapshotBody(events, projection.value, options);
	try {
		const snapshot: SessionSnapshot = { ...body, snapshotDigest: canonicalDigest(body) };
		if (!validateSessionSnapshot(snapshot)) return corrupted("generated snapshot exceeds structural limits");
		if (Buffer.byteLength(canonicalJson(snapshot), "utf8") > MAX_SESSION_SNAPSHOT_BYTES) {
			return corrupted("generated snapshot exceeds the byte limit");
		}
		return { ok: true, value: snapshot };
	} catch {
		return corrupted("snapshot could not be canonically encoded");
	}
}

export async function writeSessionSnapshot(
	filePath: string,
	snapshot: SessionSnapshot,
	options: WriteSessionSnapshotOptions = {},
): Promise<SessionResult<void>> {
	if (!validateSessionSnapshot(snapshot)) return corrupted("snapshot input is invalid");
	let encoded: string;
	try {
		encoded = `${canonicalJson(snapshot)}\n`;
	} catch {
		return corrupted("snapshot input is not canonical JSON");
	}
	if (Buffer.byteLength(encoded, "utf8") > MAX_SESSION_SNAPSHOT_BYTES) {
		return corrupted("snapshot exceeds the byte limit");
	}
	const directory = dirname(filePath);
	const temporary = join(directory, `.snapshot.${process.pid}.${randomUUID()}.tmp`);
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const handle = await open(temporary, "wx", 0o600);
		try {
			await options.onWritePhase?.("before_write");
			await handle.writeFile(encoded, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await options.onWritePhase?.("before_rename");
		await rename(temporary, filePath);
		const directoryHandle = await open(directory, "r");
		try {
			await options.onWritePhase?.("before_directory_sync");
			await directoryHandle.sync();
		} finally {
			await directoryHandle.close();
		}
		return { ok: true, value: undefined };
	} catch {
		await rm(temporary, { force: true }).catch(() => undefined);
		return durableFailure("snapshot could not be committed");
	}
}

export async function readSessionSnapshot(filePath: string): Promise<SessionResult<SessionSnapshot | undefined>> {
	try {
		const bytes = await readFile(filePath);
		if (bytes.byteLength > MAX_SESSION_SNAPSHOT_BYTES) return corrupted("snapshot exceeds the byte limit");
		const text = bytes.toString("utf8");
		if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) {
			return corrupted("snapshot must contain one LF-terminated record");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text.slice(0, -1)) as unknown;
		} catch {
			return corrupted("snapshot contains malformed JSON");
		}
		if (!validateSessionSnapshot(parsed)) return corrupted("snapshot is invalid or has been modified");
		if (`${canonicalJson(parsed)}\n` !== text) return corrupted("snapshot is not canonically encoded");
		return { ok: true, value: parsed };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: undefined };
		return corrupted("snapshot cannot be read");
	}
}

export async function readAllRuntimeEvents(store: RuntimeEventStore): Promise<SessionResult<readonly RuntimeEventV3[]>> {
	const events: RuntimeEventV3[] = [];
	let afterSequence: number | undefined;
	for (;;) {
		let page;
		try {
			page = await store.readPage(store.streamRef(), { ...(afterSequence === undefined ? {} : { afterSequence }), limit: 1000 });
		} catch {
			return corrupted("event store replay failed");
		}
		if (!page.ok) return page;
		if (page.value.events.length === 0) {
			if (page.value.hasMore) return corrupted("event store returned an empty non-terminal page");
			break;
		}
		for (const event of page.value.events) {
			const validated = validateRuntimeEvent(event);
			if (!validated.ok) return corrupted("event store returned an invalid replay event");
			events.push(validated.value);
		}
		if (events.length > 1_000_000) return corrupted("event replay exceeds the session event limit");
		const last = page.value.events.at(-1);
		if (!last) return corrupted("event store page has no terminal cursor");
		if (!page.value.hasMore) break;
		if (afterSequence !== undefined && last.sequence <= afterSequence) {
			return corrupted("event store pagination did not advance");
		}
		afterSequence = last.sequence;
	}
	return { ok: true, value: events };
}

async function verifiedEvents(
	store: RuntimeEventStore,
	snapshot?: SessionSnapshot,
): Promise<SessionResult<readonly RuntimeEventV3[]>> {
	let verification;
	try {
		verification = await store.verify(store.streamRef());
	} catch {
		return corrupted("event store verification failed");
	}
	if (!verification.ok) return verification;
	if (verification.value.integrity === "corrupted") {
		return fail(
			verification.value.error ?? {
				code: "corrupted_log",
				message: "event log is corrupted",
				retryable: false,
			},
		);
	}
	if (verification.value.integrity !== "valid") return corrupted("event log is not fully verified");
	if (
		snapshot &&
			(verification.value.authorityId !== snapshot.authorityId ||
				verification.value.tenantId !== snapshot.tenantId ||
				verification.value.stream.scope !== "session" ||
				verification.value.stream.sessionId !== snapshot.sessionId)
	) return corrupted("snapshot scope does not match the Event Store");
	const events = await readAllRuntimeEvents(store);
	if (!events.ok) return events;
	const first = events.value[0];
	if (!first) return corrupted("event log has no genesis event");
	if (
		first.authorityId !== verification.value.authorityId ||
			first.tenantId !== verification.value.tenantId ||
			!sameRuntimeEventStream(first.stream, verification.value.stream)
	) return corrupted("event replay scope does not match Event Store verification");
	const chain = verifyRuntimeEventChain(events.value, {
			authorityId: first.authorityId,
			tenantId: first.tenantId,
			stream: first.stream,
	});
	if (chain.integrity === "corrupted") {
		return fail(chain.error ?? { code: "corrupted_log", message: "event log is corrupted", retryable: false });
	}
	const actualHead = events.value.at(-1);
	if (
		verification.value.eventCount !== events.value.length ||
		!actualHead ||
		!verification.value.head ||
		verification.value.head.sequence !== actualHead.sequence ||
		verification.value.head.eventId !== actualHead.eventId ||
		verification.value.head.eventHash !== actualHead.currentEventHash
	) return corrupted("event replay head does not match Event Store verification");
	return events;
}

export async function replaySessionSnapshot(
	store: RuntimeEventStore,
	snapshot: SessionSnapshot,
	authorityLifecycle?: AuthorityLifecycleProjection,
): Promise<SessionResult<SnapshotReplayResult>> {
	if (!validateSessionSnapshot(snapshot)) return corrupted("snapshot input is invalid");
	if (snapshot.lifecycleHeadRef !== null && !authorityLifecycle) {
		return corrupted("snapshot lifecycle head requires an explicit authority projection proof");
	}
	const events = await verifiedEvents(store, snapshot);
	if (!events.ok) return events;
	const cursorEvent = events.value[snapshot.cursor.sequence];
	if (
		!cursorEvent ||
		cursorEvent.eventId !== snapshot.cursor.eventId ||
		cursorEvent.currentEventHash !== snapshot.cursor.eventHash ||
		!sameRuntimeEventStream(cursorEvent.stream, snapshot.cursor.stream)
	) return corrupted("snapshot cursor does not exist on the verified event chain", { sequence: snapshot.cursor.sequence });
	const prefix = events.value.slice(0, snapshot.cursor.sequence + 1);
	const proof = createSessionSnapshot(prefix, {
		snapshotId: snapshot.snapshotId,
		activeLeafId: snapshot.activeLeafId,
		writtenAt: snapshot.writtenAt,
		restoreDependencies: snapshot.restoreDependencies ?? null,
		...(snapshot.lifecycleHeadRef === null || !authorityLifecycle ? {} : { authorityLifecycle }),
	});
	if (!proof.ok) return proof;
	if (proof.value.snapshotDigest !== snapshot.snapshotDigest) {
		return corrupted("snapshot projection does not match its verified event prefix", { sequence: snapshot.cursor.sequence });
	}
	const reduced = reduceSessionEvents(events.value);
	if (!reduced.ok) return reduced;
	const projection = snapshot.lifecycleHeadRef === null || !authorityLifecycle
		? reduced
		: joinSessionLifecycle(reduced.value, authorityLifecycle);
	if (!projection.ok) return projection;
	return {
		ok: true,
		value: {
			projection: projection.value,
			events: events.value,
			tailEvents: events.value.slice(snapshot.cursor.sequence + 1),
			snapshot,
			source: "snapshot",
		},
	};
}

export async function loadSessionProjection(
	store: RuntimeEventStore,
	snapshotFilePath?: string,
	authorityLifecycle?: AuthorityLifecycleProjection,
): Promise<SessionResult<SnapshotReplayResult>> {
	if (snapshotFilePath) {
		const snapshot = await readSessionSnapshot(snapshotFilePath);
		if (!snapshot.ok) return snapshot;
		if (snapshot.value) return replaySessionSnapshot(store, snapshot.value, authorityLifecycle);
	}
	const events = await verifiedEvents(store);
	if (!events.ok) return events;
	const reduced = reduceSessionEvents(events.value);
	if (!reduced.ok) return reduced;
	const projection = authorityLifecycle ? joinSessionLifecycle(reduced.value, authorityLifecycle) : reduced;
	if (!projection.ok) return projection;
	return {
		ok: true,
		value: {
			projection: projection.value,
			events: events.value,
			tailEvents: events.value,
			snapshot: undefined,
			source: "full",
		},
	};
}
