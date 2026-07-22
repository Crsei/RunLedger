/** Task DAG 的 exact canonical event repository、writer 与纯 reducer。 */

import type { ArtifactRef } from "../protocol/v3/capability.ts";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { parseIdempotencyKey, type IdempotencyKey } from "../protocol/v3/coordination.ts";
import type { RuntimeEventType } from "../protocol/v3/event-catalog.ts";
import type { RuntimeEventV3 } from "../protocol/v3/events.ts";
import {
	createRuntimeId,
	parseRuntimeId,
	type ArtifactId,
	type CommandId,
	type GoalId,
	type PrincipalId,
	type TraceId,
} from "../protocol/v3/ids.ts";
import type { RuntimeEventStore } from "../session/event-store.ts";
import type { EventWriter } from "../session/event-writer.ts";
import type { RuntimeEventDraft } from "../session/types.ts";
import { readVerifiedCanonicalEvents } from "./canonical-journals.ts";
import type { ExpectedTaskArtifact, OrchestratorResult, OrchestratorTask } from "./types.ts";

export const TASK_STATUSES = [
	"pending",
	"ready",
	"running",
	"blocked",
	"completed",
	"failed",
	"cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface CanonicalTaskDefinition extends OrchestratorTask {
	goalId: GoalId;
	definitionRevision: number;
	definitionDigest: string;
}

export interface TaskOutputBinding {
	logicalName: string;
	artifact: ArtifactRef;
	bindingDigest: string;
	boundAt: string;
}

export interface CanonicalTaskState {
	definition: CanonicalTaskDefinition;
	status: TaskStatus;
	outputs: readonly TaskOutputBinding[];
	lastReasonDigest: string | null;
	evidenceArtifactIds: readonly ArtifactId[];
	createdAt: string;
	updatedAt: string;
	lastRepositoryRevision: number;
}

export interface TaskRepositoryProjection {
	goalId: GoalId | null;
	revision: number;
	tasks: readonly CanonicalTaskState[];
	transactionIds: readonly CommandId[];
	idempotency: readonly { key: IdempotencyKey; transactionDigest: string }[];
}

export interface SessionTaskRepositoryOptions {
	writer: EventWriter;
	store: RuntimeEventStore;
	principalId: PrincipalId;
	traceIdFactory?: () => TraceId;
	clock?: () => Date;
}

export interface TaskCreateRequest {
	expectedRevision: number;
	idempotencyKey: IdempotencyKey;
	task: CanonicalTaskDefinition;
}

export interface TaskDefinitionRevisionRequest {
	expectedRevision: number;
	idempotencyKey: IdempotencyKey;
	taskId: string;
	toDefinition: CanonicalTaskDefinition;
}

export interface TaskTransitionRequest {
	expectedRevision: number;
	idempotencyKey: IdempotencyKey;
	taskId: string;
	to: TaskStatus;
	reasonDigest: string;
	evidenceArtifactIds?: readonly ArtifactId[];
}

export interface TaskOutputBindingRequest {
	expectedRevision: number;
	idempotencyKey: IdempotencyKey;
	taskId: string;
	logicalName: string;
	artifact: ArtifactRef;
}

interface MutableTaskProjection {
	goalId: GoalId | null;
	revision: number;
	tasks: Map<string, CanonicalTaskState>;
	transactionIds: Set<CommandId>;
	idempotency: Map<IdempotencyKey, string>;
}

type TaskRuntimeEvent = Extract<RuntimeEventV3, {
	type: "task.created" | "task.definition_revised" | "task.transitioned" | "task.output_bound";
}>;

const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
	pending: ["ready", "blocked", "failed", "cancelled"],
	ready: ["running", "blocked", "failed", "cancelled"],
	running: ["blocked", "completed", "failed", "cancelled"],
	blocked: ["ready", "failed", "cancelled"],
	completed: [],
	failed: [],
	cancelled: [],
};

const WRITER_QUEUES = new WeakMap<EventWriter, Promise<void>>();

function serializeWriter<T>(writer: EventWriter, operation: () => Promise<T>): Promise<T> {
	const previous = WRITER_QUEUES.get(writer) ?? Promise.resolve();
	const result = previous.then(operation, operation);
	WRITER_QUEUES.set(writer, result.then(() => undefined, () => undefined));
	return result;
}

function invalid<T>(message: string): OrchestratorResult<T> {
	return { ok: false, error: { code: "invalid_input", message, retryable: false } };
}

function conflict<T>(message: string): OrchestratorResult<T> {
	return { ok: false, error: { code: "revision_conflict", message, retryable: true } };
}

function unavailable<T>(message: string, retryable = false): OrchestratorResult<T> {
	return { ok: false, error: { code: "journal_unavailable", message, retryable } };
}

function isDigest(value: string): boolean {
	return /^[a-f0-9]{64}$/u.test(value);
}

function taskDefinitionBody(definition: CanonicalTaskDefinition): Omit<CanonicalTaskDefinition, "definitionDigest"> {
	const { definitionDigest: _definitionDigest, ...body } = definition;
	return body;
}

export function taskDefinitionDigest(definition: Omit<CanonicalTaskDefinition, "definitionDigest">): string {
	return canonicalDigest(definition);
}

export function createCanonicalTaskDefinition(
	goalId: GoalId,
	task: OrchestratorTask,
	definitionRevision = 1,
): CanonicalTaskDefinition {
	const body = {
		...task,
		goalId,
		definitionRevision,
		owner: { ...task.owner },
		dependsOn: [...task.dependsOn],
		expectedArtifacts: task.expectedArtifacts.map((artifact) => ({ ...artifact })),
		workspace: { ...task.workspace },
		capabilities: task.capabilities.map((capability) => ({ ...capability })),
	};
	return { ...body, definitionDigest: taskDefinitionDigest(body) };
}

function definitionIsValid(definition: CanonicalTaskDefinition): boolean {
	return (
		definition.definitionRevision >= 1 &&
		Number.isSafeInteger(definition.definitionRevision) &&
		definition.definitionDigest === taskDefinitionDigest(taskDefinitionBody(definition)) &&
		definition.taskId.length >= 1 &&
		definition.taskId.length <= 128 &&
		definition.dependsOn.length <= 256 &&
		new Set(definition.dependsOn).size === definition.dependsOn.length &&
		!definition.dependsOn.includes(definition.taskId) &&
		definition.expectedArtifacts.length >= 1 &&
		definition.expectedArtifacts.length <= 64 &&
		definition.capabilities.length >= 1 &&
		definition.capabilities.length <= 64
	);
}

function hasCycle(tasks: ReadonlyMap<string, CanonicalTaskState>): boolean {
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (taskId: string): boolean => {
		if (visiting.has(taskId)) return true;
		if (visited.has(taskId)) return false;
		visiting.add(taskId);
		const task = tasks.get(taskId);
		if (!task) return true;
		for (const dependency of task.definition.dependsOn) {
			if (!tasks.has(dependency) || visit(dependency)) return true;
		}
		visiting.delete(taskId);
		visited.add(taskId);
		return false;
	};
	return [...tasks.keys()].some(visit);
}

function cloneExpectedArtifact(value: ExpectedTaskArtifact): ExpectedTaskArtifact {
	return { ...value };
}

function cloneDefinition(value: CanonicalTaskDefinition): CanonicalTaskDefinition {
	return {
		...value,
		owner: { ...value.owner },
		dependsOn: [...value.dependsOn],
		expectedArtifacts: value.expectedArtifacts.map(cloneExpectedArtifact),
		workspace: { ...value.workspace },
		capabilities: value.capabilities.map((capability) => ({ ...capability })),
	};
}

function cloneTask(value: CanonicalTaskState): CanonicalTaskState {
	return {
		...value,
		definition: cloneDefinition(value.definition),
		outputs: value.outputs.map((output) => ({ ...output, artifact: { ...output.artifact } })),
		evidenceArtifactIds: [...value.evidenceArtifactIds],
	};
}

function immutableProjection(state: MutableTaskProjection): TaskRepositoryProjection {
	return {
		goalId: state.goalId,
		revision: state.revision,
		tasks: [...state.tasks.values()].sort((left, right) =>
			left.definition.taskId.localeCompare(right.definition.taskId)).map(cloneTask),
		transactionIds: [...state.transactionIds],
		idempotency: [...state.idempotency.entries()].map(([key, transactionDigest]) => ({ key, transactionDigest })),
	};
}

function mutationBody(event: TaskRuntimeEvent): unknown {
	switch (event.type) {
		case "task.created": {
			const payload = event.payload;
			return { task: payload.task };
		}
		case "task.definition_revised": {
			const payload = event.payload;
			return {
				taskId: payload.taskId,
				fromDefinitionRevision: payload.fromDefinitionRevision,
				toDefinition: payload.toDefinition,
			};
		}
		case "task.transitioned": {
			const payload = event.payload;
			return {
				taskId: payload.taskId,
				definitionRevision: payload.definitionRevision,
				from: payload.from,
				to: payload.to,
				reasonDigest: payload.reasonDigest,
				evidenceArtifactIds: payload.evidenceArtifactIds,
			};
		}
		case "task.output_bound": {
			const payload = event.payload;
			return {
				taskId: payload.taskId,
				definitionRevision: payload.definitionRevision,
				logicalName: payload.logicalName,
				artifact: payload.artifact,
				bindingDigest: payload.bindingDigest,
			};
		}
	}
}

function taskEvent(event: RuntimeEventV3): event is TaskRuntimeEvent {
	switch (event.type) {
		case "task.created":
		case "task.definition_revised":
		case "task.transitioned":
		case "task.output_bound":
			return true;
		default:
			return false;
	}
}

function allDependenciesCompleted(state: MutableTaskProjection, definition: CanonicalTaskDefinition): boolean {
	return definition.dependsOn.every((taskId) => state.tasks.get(taskId)?.status === "completed");
}

function allOutputsBound(state: CanonicalTaskState): boolean {
	const names = new Set(state.outputs.map((output) => output.logicalName));
	return state.definition.expectedArtifacts.every((expected) => names.has(expected.logicalName));
}

function applyTaskEvent(state: MutableTaskProjection, event: TaskRuntimeEvent): OrchestratorResult<void> {
	const payload = event.payload;
	if (payload.repositoryRevision !== state.revision + 1) return invalid("task repository revision is discontinuous");
	const transactionId = parseRuntimeId("command", payload.transactionId);
	const idempotencyKey = parseIdempotencyKey(payload.idempotencyKey);
	if (!transactionId || !idempotencyKey) return invalid("task mutation identity is invalid");
	if (state.transactionIds.has(transactionId) || state.idempotency.has(idempotencyKey)) {
		return invalid("task mutation identity is duplicated in the canonical chain");
	}
	if (taskMutationDigest(event.type, mutationBody(event)) !== payload.transactionDigest) {
		return invalid("task mutation digest does not match its exact payload");
	}
	if (event.type === "task.created") {
		const definition = event.payload.task as unknown as CanonicalTaskDefinition;
		if (!definitionIsValid(definition) || state.tasks.has(definition.taskId)) return invalid("task definition is invalid or duplicated");
		if (state.goalId !== null && state.goalId !== definition.goalId) return invalid("task repository contains multiple goals");
		if (definition.dependsOn.some((dependency) => !state.tasks.has(dependency))) {
			return invalid("task creation references a missing dependency");
		}
		state.goalId = definition.goalId;
		state.tasks.set(definition.taskId, {
			definition: cloneDefinition(definition),
			status: "pending",
			outputs: [],
			lastReasonDigest: null,
			evidenceArtifactIds: [],
			createdAt: event.timestamp,
			updatedAt: event.timestamp,
			lastRepositoryRevision: payload.repositoryRevision,
		});
	} else if (event.type === "task.definition_revised") {
		const current = state.tasks.get(event.payload.taskId);
		const definition = event.payload.toDefinition as unknown as CanonicalTaskDefinition;
		if (!current || current.definition.definitionRevision !== event.payload.fromDefinitionRevision) {
			return invalid("task definition revision does not match the canonical projection");
		}
		if (["running", "completed", "failed", "cancelled"].includes(current.status)) {
			return invalid("active or terminal task definition cannot be revised");
		}
		if (
			!definitionIsValid(definition) ||
			definition.taskId !== current.definition.taskId ||
			definition.goalId !== current.definition.goalId ||
			definition.definitionRevision !== current.definition.definitionRevision + 1 ||
			definition.dependsOn.some((dependency) => !state.tasks.has(dependency))
		) return invalid("revised task definition is invalid");
		state.tasks.set(definition.taskId, {
			...current,
			definition: cloneDefinition(definition),
			updatedAt: event.timestamp,
			lastRepositoryRevision: payload.repositoryRevision,
		});
		if (hasCycle(state.tasks)) return invalid("revised task definition creates a cycle");
	} else if (event.type === "task.transitioned") {
		const current = state.tasks.get(event.payload.taskId);
		if (!current || current.definition.definitionRevision !== event.payload.definitionRevision || current.status !== event.payload.from) {
			return invalid("task transition source does not match the canonical projection");
		}
		if (!TASK_TRANSITIONS[current.status].includes(event.payload.to)) return invalid("task transition is not allowed");
		if ((event.payload.to === "ready" || event.payload.to === "running") && !allDependenciesCompleted(state, current.definition)) {
			return invalid("task cannot become ready or running before dependencies complete");
		}
		if (event.payload.to === "completed" && !allOutputsBound(current)) {
			return invalid("task cannot complete before all expected outputs are bound");
		}
		const evidenceArtifactIds: ArtifactId[] = [];
		const seenEvidenceArtifactIds = new Set<ArtifactId>();
		for (const value of event.payload.evidenceArtifactIds) {
			const artifactId = parseRuntimeId("artifact", value);
			if (!artifactId || seenEvidenceArtifactIds.has(artifactId)) {
				return invalid("task transition evidence Artifact ids are invalid or duplicated");
			}
			seenEvidenceArtifactIds.add(artifactId);
			evidenceArtifactIds.push(artifactId);
		}
		state.tasks.set(event.payload.taskId, {
			...current,
			status: event.payload.to,
			lastReasonDigest: event.payload.reasonDigest,
			evidenceArtifactIds,
			updatedAt: event.timestamp,
			lastRepositoryRevision: payload.repositoryRevision,
		});
	} else {
		const current = state.tasks.get(event.payload.taskId);
		if (!current || current.definition.definitionRevision !== event.payload.definitionRevision || current.status !== "running") {
			return invalid("task output requires the current running task definition");
		}
		const expected = current.definition.expectedArtifacts.find((item) => item.logicalName === event.payload.logicalName);
		if (!expected || expected.kind !== event.payload.artifact.kind || expected.mediaType !== event.payload.artifact.mediaType) {
			return invalid("task output does not match its expected Artifact contract");
		}
		if (current.outputs.some((output) => output.logicalName === event.payload.logicalName)) {
			return invalid("task output logical name is already bound");
		}
		const artifact = event.payload.artifact as unknown as ArtifactRef;
		const expectedDigest = canonicalDigest({
			taskId: event.payload.taskId,
			definitionRevision: event.payload.definitionRevision,
			logicalName: event.payload.logicalName,
			artifact,
		});
		if (expectedDigest !== event.payload.bindingDigest) return invalid("task output binding digest is invalid");
		state.tasks.set(event.payload.taskId, {
			...current,
			outputs: [...current.outputs, {
				logicalName: event.payload.logicalName,
				artifact,
				bindingDigest: event.payload.bindingDigest,
				boundAt: event.timestamp,
			}],
			updatedAt: event.timestamp,
			lastRepositoryRevision: payload.repositoryRevision,
		});
	}
	state.revision = payload.repositoryRevision;
	state.transactionIds.add(transactionId);
	state.idempotency.set(idempotencyKey, payload.transactionDigest);
	return { ok: true, value: undefined };
}

export function reduceCanonicalTaskEvents(events: readonly RuntimeEventV3[]): OrchestratorResult<TaskRepositoryProjection> {
	const state: MutableTaskProjection = {
		goalId: null,
		revision: 0,
		tasks: new Map(),
		transactionIds: new Set(),
		idempotency: new Map(),
	};
	for (const event of events) {
		if (!taskEvent(event)) continue;
		const applied = applyTaskEvent(state, event);
		if (!applied.ok) return applied;
	}
	if (hasCycle(state.tasks)) return invalid("canonical task projection contains a dependency cycle");
	return { ok: true, value: immutableProjection(state) };
}

function taskById(projection: TaskRepositoryProjection, taskId: string): CanonicalTaskState | undefined {
	return projection.tasks.find((task) => task.definition.taskId === taskId);
}

function taskMutationDigest(type: RuntimeEventType, body: unknown): string {
	return canonicalDigest({ type, body });
}

export class SessionTaskRepository {
	readonly #writer: EventWriter;
	readonly #store: RuntimeEventStore;
	readonly #principalId: PrincipalId;
	readonly #traceIdFactory: () => TraceId;
	readonly #clock: () => Date;

	public constructor(options: SessionTaskRepositoryOptions) {
		this.#writer = options.writer;
		this.#store = options.store;
		this.#principalId = options.principalId;
		this.#traceIdFactory = options.traceIdFactory ?? (() => createRuntimeId("trace"));
		this.#clock = options.clock ?? (() => new Date());
	}

	public async load(): Promise<OrchestratorResult<TaskRepositoryProjection>> {
		const flushed = await this.#writer.flush();
		if (!flushed.ok) return unavailable("canonical task writer flush failed", flushed.error.retryable);
		const events = await readVerifiedCanonicalEvents(this.#store);
		return events.ok ? reduceCanonicalTaskEvents(events.value) : events;
	}

	async #append(
		expectedRevision: number,
		idempotencyKey: IdempotencyKey,
		type: "task.created" | "task.definition_revised" | "task.transitioned" | "task.output_bound",
		body: Readonly<Record<string, unknown>>,
	): Promise<OrchestratorResult<TaskRepositoryProjection>> {
		return serializeWriter(this.#writer, async () => {
			const loaded = await this.load();
			if (!loaded.ok) return loaded;
			const digest = taskMutationDigest(type, body);
			const previous = loaded.value.idempotency.find((entry) => entry.key === idempotencyKey);
			if (previous) return previous.transactionDigest === digest
				? loaded
				: { ok: false, error: { code: "idempotency_conflict", message: "task idempotency key was reused", retryable: false } };
			if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== loaded.value.revision) {
				return conflict("task repository expected revision does not match");
			}
			const transactionId = createRuntimeId("command");
			const payload = {
				transactionId,
				idempotencyKey,
				transactionDigest: digest,
				repositoryRevision: expectedRevision + 1,
				...body,
			};
			const draft = {
				type,
				principalId: this.#principalId,
				traceId: this.#traceIdFactory(),
				timestamp: this.#clock().toISOString(),
				payload,
			} as unknown as RuntimeEventDraft<typeof type>;
			const appended = await this.#writer.append(draft);
			if (!appended.ok) return unavailable("canonical task event append failed", appended.error.retryable);
			return this.load();
		});
	}

	public create(request: TaskCreateRequest): Promise<OrchestratorResult<TaskRepositoryProjection>> {
		if (!definitionIsValid(request.task) || request.task.definitionRevision !== 1) {
			return Promise.resolve(invalid("canonical task creation requires a valid revision-one definition"));
		}
		return this.#append(request.expectedRevision, request.idempotencyKey, "task.created", {
			task: request.task,
		});
	}

	public async reviseDefinition(request: TaskDefinitionRevisionRequest): Promise<OrchestratorResult<TaskRepositoryProjection>> {
		const loaded = await this.load();
		if (!loaded.ok) return loaded;
		const current = taskById(loaded.value, request.taskId);
		if (!current) return invalid("task definition revision target does not exist");
		return this.#append(request.expectedRevision, request.idempotencyKey, "task.definition_revised", {
			taskId: request.taskId,
			fromDefinitionRevision: current.definition.definitionRevision,
			toDefinition: request.toDefinition,
		});
	}

	public async transition(request: TaskTransitionRequest): Promise<OrchestratorResult<TaskRepositoryProjection>> {
		const loaded = await this.load();
		if (!loaded.ok) return loaded;
		const current = taskById(loaded.value, request.taskId);
		if (!current || !isDigest(request.reasonDigest)) return invalid("task transition target or reason digest is invalid");
		return this.#append(request.expectedRevision, request.idempotencyKey, "task.transitioned", {
			taskId: request.taskId,
			definitionRevision: current.definition.definitionRevision,
			from: current.status,
			to: request.to,
			reasonDigest: request.reasonDigest,
			evidenceArtifactIds: [...(request.evidenceArtifactIds ?? [])],
		});
	}

	public async bindOutput(request: TaskOutputBindingRequest): Promise<OrchestratorResult<TaskRepositoryProjection>> {
		const loaded = await this.load();
		if (!loaded.ok) return loaded;
		const current = taskById(loaded.value, request.taskId);
		if (!current) return invalid("task output target does not exist");
		const body = {
			taskId: request.taskId,
			definitionRevision: current.definition.definitionRevision,
			logicalName: request.logicalName,
			artifact: request.artifact,
			bindingDigest: canonicalDigest({
				taskId: request.taskId,
				definitionRevision: current.definition.definitionRevision,
				logicalName: request.logicalName,
				artifact: request.artifact,
			}),
		};
		return this.#append(request.expectedRevision, request.idempotencyKey, "task.output_bound", body);
	}
}
