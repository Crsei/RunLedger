import { isAbsolute, join, relative, resolve } from "node:path";
import { isRuntimeId, type MemoryId, type MemoryProposalId, type PlanId, type SessionId } from "../runtime/protocol/v3/ids.ts";

export class ContextPathError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "ContextPathError";
	}
}

function beneath(root: string, ...segments: string[]): string {
	const absoluteRoot = resolve(root);
	const target = resolve(absoluteRoot, ...segments);
	const suffix = relative(absoluteRoot, target);
	if (suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix))) return target;
	throw new ContextPathError("resolved context path escapes its configured root");
}

function assertId(kind: "session" | "plan" | "memory" | "memoryProposal", value: string): void {
	if (!isRuntimeId(value, kind)) throw new ContextPathError(`invalid ${kind} identifier`);
}

export function planDirectory(root: string, sessionId: SessionId, planId: PlanId): string {
	assertId("session", sessionId);
	assertId("plan", planId);
	return beneath(root, "artifacts", sessionId, "plans", planId);
}

export function planRevisionPath(root: string, sessionId: SessionId, planId: PlanId, revision: number): string {
	if (!Number.isSafeInteger(revision) || revision < 0) throw new ContextPathError("invalid plan revision");
	return beneath(planDirectory(root, sessionId, planId), "revisions", `${String(revision).padStart(12, "0")}.md`);
}

export function planRevisionMetadataPath(root: string, sessionId: SessionId, planId: PlanId, revision: number): string {
	return planRevisionPath(root, sessionId, planId, revision).replace(/\.md$/, ".json");
}

export function planWorkingPath(root: string, sessionId: SessionId, planId: PlanId): string {
	return beneath(planDirectory(root, sessionId, planId), "working.md");
}

export type CanonicalMemoryScopePath =
	| { kind: "user"; root: string }
	| { kind: "workspace"; root: string; workspaceKey: string }
	| { kind: "session"; root: string; sessionId: SessionId };

export function memoryScopeDirectory(scope: CanonicalMemoryScopePath): string {
	if (scope.kind === "user") return beneath(scope.root, "memory");
	if (scope.kind === "session") {
		assertId("session", scope.sessionId);
		return beneath(scope.root, "memory", "sessions", scope.sessionId);
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,95}$/.test(scope.workspaceKey)) {
		throw new ContextPathError("invalid canonical workspace memory key");
	}
	return beneath(scope.root, "memory", "workspaces", scope.workspaceKey);
}

export function memoryRecordPath(scope: CanonicalMemoryScopePath, memoryId: MemoryId): string {
	assertId("memory", memoryId);
	return join(memoryScopeDirectory(scope), "records", `${memoryId}.json`);
}

export function memoryProposalPath(scope: CanonicalMemoryScopePath, proposalId: MemoryProposalId): string {
	assertId("memoryProposal", proposalId);
	return join(memoryScopeDirectory(scope), "proposals", `${proposalId}.json`);
}

export function memoryDriftDiagnosticPath(scope: CanonicalMemoryScopePath, memoryId: MemoryId): string {
	assertId("memory", memoryId);
	return join(memoryScopeDirectory(scope), "diagnostics", `${memoryId}.json`);
}
