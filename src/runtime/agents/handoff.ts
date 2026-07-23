/** ArtifactRef-only handoff manifest；不传递 prompt、credential、env 或 workspace handle。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import { inputLineageIsValid, inputLineagePreserves } from "./delegation.ts";
import type {
	AgentErrorCode,
	AgentHandoffManifest,
	AgentNode,
	AgentResult,
} from "./types.ts";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function fail<T>(code: AgentErrorCode, message: string): AgentResult<T> {
	return { ok: false, error: { code, message, retryable: false } };
}

function bodyOf(manifest: AgentHandoffManifest): Omit<AgentHandoffManifest, "manifestDigest"> {
	const { manifestDigest: _manifestDigest, ...body } = manifest;
	return body;
}

function handoffIntegrity(node: AgentNode, status: AgentHandoffManifest["status"]): AgentHandoffManifest["integrity"] {
	if (node.artifacts.some((report) => report.integrity === "corrupted")) return "corrupted";
	if (status !== "complete" || node.artifacts.some((report) => report.integrity === "partial")) return "partial";
	return "valid";
}

export function createAgentHandoffManifest(
	node: AgentNode,
	handoffId: AgentHandoffManifest["handoffId"],
	status: AgentHandoffManifest["status"],
	createdAt = new Date().toISOString(),
): AgentResult<AgentHandoffManifest> {
	if (!node.parentAgentId || !node.delegationReceipt || !isRuntimeId(handoffId, "command")) {
		return fail("handoff_invalid", "root or unadmitted agent cannot produce a child handoff");
	}
	if (status === "complete" && node.state !== "completed") {
		return fail("handoff_invalid", "complete handoff requires a completed child");
	}
	if (status === "partial" && node.state !== "partial") {
		return fail("handoff_invalid", "partial handoff requires a partial child");
	}
	if (status === "failed" && node.state !== "failed") {
		return fail("handoff_invalid", "failed handoff requires a failed child");
	}
	if (status === "partial" && node.artifacts.length === 0) {
		return fail("handoff_invalid", "partial handoff must contain at least one ArtifactRef");
	}
	const body: Omit<AgentHandoffManifest, "manifestDigest"> = {
		manifestVersion: 1,
		handoffId,
		agentId: node.agentId,
		parentAgentId: node.parentAgentId,
		sessionId: node.sessionId,
		workspaceId: node.workspaceReceipt.workspaceId,
		...(node.cursor ? { cursor: { ...node.cursor } } : {}),
		delegationReceiptId: node.delegationReceipt.receiptId,
		workspaceReceiptId: node.workspaceReceipt.receiptId,
		artifacts: node.artifacts.map((report) => ({ ...report, artifact: { ...report.artifact } })),
		inputSources: node.inputSources.map((source) => ({ ...source, taintLabels: [...source.taintLabels] })),
		declassificationReceipts: node.declassificationReceipts.map((receipt) => ({ ...receipt })),
		status,
		integrity: handoffIntegrity(node, status),
		createdAt,
	};
	return { ok: true, value: { ...body, manifestDigest: canonicalDigest(body) } };
}

export function validateAgentHandoffManifest(manifest: AgentHandoffManifest, node?: AgentNode): AgentResult<void> {
	let expectedDigest: string;
	try {
		expectedDigest = canonicalDigest(bodyOf(manifest));
	} catch {
		return fail("handoff_invalid", "handoff manifest is not canonical");
	}
	if (
		manifest.manifestVersion !== 1 ||
		!isRuntimeId(manifest.handoffId, "command") ||
		!isRuntimeId(manifest.agentId, "agent") ||
		!isRuntimeId(manifest.parentAgentId, "agent") ||
		!isRuntimeId(manifest.sessionId, "session") ||
		!isRuntimeId(manifest.workspaceId, "workspace") ||
		!isRuntimeId(manifest.delegationReceiptId, "receipt") ||
		!isRuntimeId(manifest.workspaceReceiptId, "receipt") ||
		!inputLineageIsValid(manifest.inputSources, manifest.declassificationReceipts) ||
		!DIGEST_PATTERN.test(manifest.manifestDigest) ||
		manifest.manifestDigest !== expectedDigest
	) {
		return fail("handoff_invalid", "handoff manifest identity or digest is invalid");
	}
	if (manifest.status === "partial" && manifest.artifacts.length === 0) {
		return fail("handoff_invalid", "partial handoff omitted its ArtifactRef");
	}
	if (
		(manifest.status === "complete" && manifest.integrity !== "valid") ||
		(manifest.status === "partial" && manifest.integrity === "valid")
	) {
		return fail("handoff_invalid", "handoff status and integrity are inconsistent");
	}
	if (
		manifest.artifacts.some(
			(report) =>
				report.agentId !== manifest.agentId ||
				(report.artifact.workspaceId !== undefined && report.artifact.workspaceId !== manifest.workspaceId) ||
				!DIGEST_PATTERN.test(report.artifact.storedDigest),
		)
	) {
		return fail("handoff_invalid", "handoff contains a foreign or malformed ArtifactRef");
	}
	if (
		node &&
		(node.agentId !== manifest.agentId ||
			node.parentAgentId !== manifest.parentAgentId ||
			node.sessionId !== manifest.sessionId ||
			node.workspaceReceipt.workspaceId !== manifest.workspaceId ||
			node.delegationReceipt?.receiptId !== manifest.delegationReceiptId ||
			node.workspaceReceipt.receiptId !== manifest.workspaceReceiptId ||
			!inputLineagePreserves(
				node.inputSources,
				node.declassificationReceipts,
				manifest.inputSources,
				manifest.declassificationReceipts,
			) ||
			!inputLineagePreserves(
				manifest.inputSources,
				manifest.declassificationReceipts,
				node.inputSources,
				node.declassificationReceipts,
			) ||
			manifest.artifacts.some(
				(report) =>
					!node.artifacts.some(
						(candidate) =>
							candidate.logicalName === report.logicalName &&
							candidate.artifact.artifactId === report.artifact.artifactId,
					),
			))
	) {
		return fail("handoff_invalid", "handoff manifest is not bound to the durable child state");
	}
	return { ok: true, value: undefined };
}
