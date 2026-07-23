/** Task DAG 的结构与外部 reference 验证。 */

import { isRuntimeId } from "../protocol/v3/ids.ts";
import type {
	OrchestratorResult,
	ReferenceValidation,
	TaskCapabilityRef,
	TaskCapabilityReferencePort,
	TaskDag,
	TaskWorkspaceRef,
	TaskWorkspaceReferencePort,
} from "./types.ts";

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
export const MAX_DAG_TASKS = 4_096;
export const MAX_TASK_DEPENDENCIES = 256;
export const MAX_TASK_EXPECTED_ARTIFACTS = 64;
export const MAX_TASK_CAPABILITY_REFS = 64;

export interface TaskDagValidationPorts {
	workspace: TaskWorkspaceReferencePort;
	capability: TaskCapabilityReferencePort;
}

export interface ValidatedTaskDag {
	dag: TaskDag;
	topologicalOrder: readonly string[];
	workspaceReferenceCount: number;
	capabilityReferenceCount: number;
}

function invalid(message: string, details?: Readonly<Record<string, string | number | boolean>>): OrchestratorResult<never> {
	return { ok: false, error: { code: "invalid_dag", message, retryable: false, details } };
}

function validWorkspaceRef(ref: TaskWorkspaceRef): boolean {
	return (
		isRuntimeId(ref.workspaceId, "workspace") &&
		Number.isSafeInteger(ref.bindingRevision) &&
		ref.bindingRevision >= 0 &&
		DIGEST_PATTERN.test(ref.bindingDigest)
	);
}

function validCapabilityRef(ref: TaskCapabilityRef): boolean {
	return (
		isRuntimeId(ref.receiptId, "receipt") &&
		Number.isSafeInteger(ref.decisionRevision) &&
		ref.decisionRevision >= 0 &&
		DIGEST_PATTERN.test(ref.receiptDigest)
	);
}

function validateStructure(dag: TaskDag): OrchestratorResult<readonly string[]> {
	if (!Number.isSafeInteger(dag.revision) || dag.revision < 0 || !isRuntimeId(dag.goalId, "goal")) {
		return invalid("DAG identity or revision is invalid");
	}
	if (dag.tasks.length === 0 || dag.tasks.length > MAX_DAG_TASKS) {
		return invalid(`DAG task count must be within 1..${MAX_DAG_TASKS}`);
	}
	const tasks = new Map<string, TaskDag["tasks"][number]>();
	const workspaceVersions = new Map<string, string>();
	const capabilityVersions = new Map<string, string>();
	for (const task of dag.tasks) {
		if (!TASK_ID_PATTERN.test(task.taskId)) return invalid("taskId is invalid", { taskId: task.taskId });
		if (tasks.has(task.taskId)) return invalid("taskId must be unique", { taskId: task.taskId });
		tasks.set(task.taskId, task);
		const ownerKind = task.owner.kind === "agent" ? "agent" : "principal";
		if (!isRuntimeId(task.owner.id, ownerKind)) return invalid("task owner is invalid", { taskId: task.taskId });
		if (task.expectedArtifacts.length === 0 || task.expectedArtifacts.length > MAX_TASK_EXPECTED_ARTIFACTS) {
			return invalid("task must declare at least one expected artifact", { taskId: task.taskId });
		}
		const logicalNames = new Set<string>();
		for (const artifact of task.expectedArtifacts) {
			if (
				artifact.logicalName.length === 0 ||
				artifact.logicalName.length > 256 ||
				artifact.mediaType.length === 0 ||
				artifact.mediaType.length > 256 ||
				logicalNames.has(artifact.logicalName)
			) {
				return invalid("expected artifact declaration is invalid", { taskId: task.taskId });
			}
			logicalNames.add(artifact.logicalName);
		}
		if (!validWorkspaceRef(task.workspace)) return invalid("workspace reference is invalid", { taskId: task.taskId });
		const workspaceVersion = `${task.workspace.bindingRevision}:${task.workspace.bindingDigest}`;
		const previousWorkspaceVersion = workspaceVersions.get(task.workspace.workspaceId);
		if (previousWorkspaceVersion && previousWorkspaceVersion !== workspaceVersion) {
			return invalid("workspace reference version is inconsistent across the DAG", { taskId: task.taskId });
		}
		workspaceVersions.set(task.workspace.workspaceId, workspaceVersion);
		if (task.capabilities.length === 0 || task.capabilities.length > MAX_TASK_CAPABILITY_REFS) {
			return invalid("task must declare capability references", { taskId: task.taskId });
		}
		for (const capability of task.capabilities) {
			if (!validCapabilityRef(capability)) return invalid("capability reference is invalid", { taskId: task.taskId });
			const capabilityVersion = `${capability.capability}:${capability.decisionRevision}:${capability.receiptDigest}`;
			const previousCapabilityVersion = capabilityVersions.get(capability.receiptId);
			if (previousCapabilityVersion && previousCapabilityVersion !== capabilityVersion) {
				return invalid("capability reference version is inconsistent across the DAG", { taskId: task.taskId });
			}
			capabilityVersions.set(capability.receiptId, capabilityVersion);
		}
	}

	const indegree = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const task of dag.tasks) {
		if (task.dependsOn.length > MAX_TASK_DEPENDENCIES) {
			return invalid("task dependency count exceeds the bound", { taskId: task.taskId });
		}
		const uniqueDependencies = new Set(task.dependsOn);
		if (uniqueDependencies.size !== task.dependsOn.length) {
			return invalid("task dependency must be unique", { taskId: task.taskId });
		}
		if (uniqueDependencies.has(task.taskId)) return invalid("task cannot depend on itself", { taskId: task.taskId });
		for (const dependency of task.dependsOn) {
			if (!tasks.has(dependency)) {
				return invalid("task dependency does not exist", { taskId: task.taskId, dependency });
			}
			const next = dependents.get(dependency) ?? [];
			next.push(task.taskId);
			dependents.set(dependency, next);
		}
		indegree.set(task.taskId, uniqueDependencies.size);
	}

	const ready = [...indegree.entries()]
		.filter(([, degree]) => degree === 0)
		.map(([taskId]) => taskId)
		.sort();
	const order: string[] = [];
	while (ready.length > 0) {
		const taskId = ready.shift();
		if (!taskId) break;
		order.push(taskId);
		for (const dependent of (dependents.get(taskId) ?? []).sort()) {
			const degree = (indegree.get(dependent) ?? 0) - 1;
			indegree.set(dependent, degree);
			if (degree === 0) {
				ready.push(dependent);
				ready.sort();
			}
		}
	}
	if (order.length !== dag.tasks.length) return invalid("task dependency graph contains a cycle");
	return { ok: true, value: order };
}

async function validateReference(
	operation: () => Promise<ReferenceValidation>,
): Promise<ReferenceValidation> {
	try {
		return await operation();
	} catch {
		return { status: "unavailable", reasonDigest: "0".repeat(64) };
	}
}

export async function validateTaskDag(
	dag: TaskDag,
	ports: TaskDagValidationPorts,
): Promise<OrchestratorResult<ValidatedTaskDag>> {
	const structure = validateStructure(dag);
	if (!structure.ok) return structure;
	const workspaces = new Map<string, TaskWorkspaceRef>();
	const capabilities = new Map<string, TaskCapabilityRef>();
	for (const task of dag.tasks) {
		workspaces.set(`${task.workspace.workspaceId}:${task.workspace.bindingRevision}`, task.workspace);
		for (const capability of task.capabilities) {
			capabilities.set(`${capability.receiptId}:${capability.decisionRevision}`, capability);
		}
	}
	for (const [key, ref] of [...workspaces.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		const validation = await validateReference(() => ports.workspace.validate(ref));
		if (validation.status !== "valid") {
			return {
				ok: false,
				error: {
					code: "reference_unavailable",
					message: `workspace reference is ${validation.status}`,
					retryable: validation.status === "unavailable",
					details: { reference: key, status: validation.status },
				},
			};
		}
	}
	for (const [key, ref] of [...capabilities.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		const validation = await validateReference(() => ports.capability.validate(ref));
		if (validation.status !== "valid") {
			return {
				ok: false,
				error: {
					code: "reference_unavailable",
					message: `capability reference is ${validation.status}`,
					retryable: validation.status === "unavailable",
					details: { reference: key, status: validation.status },
				},
			};
		}
	}
	return {
		ok: true,
		value: {
			dag,
			topologicalOrder: structure.value,
			workspaceReferenceCount: workspaces.size,
			capabilityReferenceCount: capabilities.size,
		},
	};
}
