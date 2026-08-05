import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	CommandDecision,
	CommandDescriptor,
	CommandIntent,
} from "../../../src/tui/commands/types.ts";
import type {
	SessionDetail,
	SessionDiagnostic,
	SessionLineage,
	SessionPreview,
	SessionSummary,
	SessionTransitionState,
	SessionWorkflowState,
} from "../../../src/tui/sessions/types.ts";
import type {
	TuiInteractionState,
	TuiOverlayState,
} from "../../../src/tui/application/state.ts";
import type { TimelineState } from "../../../src/tui/timeline/types.ts";

const emptyTimeline: TimelineState = {
	generation: 1,
	committedRows: [],
	activeRowsByCorrelationId: {},
	activeOrder: [],
	cursor: { messageIndex: 0 },
};

describe("passive command, session, and interaction contracts", () => {
	it("has the P3 type-only modules before exercising workflow fixtures", () => {
		for (const relativePath of [
			"src/tui/commands/types.ts",
			"src/tui/sessions/types.ts",
			"src/tui/application/state.ts",
		]) {
			const path = join(process.cwd(), relativePath);
			expect(existsSync(path)).toBe(true);
			expect(readFileSync(path, "utf8")).toContain("export");
		}
	});

	it("separates command metadata, intent, and terminal decision", () => {
		const descriptor: CommandDescriptor = {
			canonicalName: "help",
			aliases: ["?"],
			description: "Show help",
			category: "system",
			order: 1,
			argumentSchema: [],
			policy: { draft: "allowed", history: "allowed", query: "allowed", frozen: "allowed" },
		};
		const intent: CommandIntent = {
			invocationId: "invocation-1",
			displayOrder: 1,
			canonicalName: descriptor.canonicalName,
			normalizedArgs: [],
			catalogGeneration: 2,
			createdAt: "2026-08-05T00:00:00.000Z",
		};
		const decisions: CommandDecision[] = [
			{ state: "handled", invocationId: intent.invocationId, message: "done" },
			{ state: "action", invocationId: intent.invocationId, actionType: "open-help" },
			{ state: "effect", invocationId: intent.invocationId, effectId: "effect-1", effectType: "query-help" },
			{ state: "queued", invocationId: intent.invocationId, queueItemId: "queue-1" },
			{ state: "failed", invocationId: intent.invocationId, code: "failed", message: "failed", retryable: true },
			{ state: "cancelled", invocationId: intent.invocationId, reason: "user" },
			{ state: "aborted", invocationId: intent.invocationId, reason: "superseded" },
		];
		expect(descriptor).not.toHaveProperty("handler");
		expect(descriptor).not.toHaveProperty("execute");
		expect(structuredClone({ descriptor, intent, decisions })).toEqual({ descriptor, intent, decisions });
	});

	it("models only the current canonical session and explicit transition recovery", () => {
		const lineage: SessionLineage = { kind: "root", rootSessionId: "session-1" };
		const summary: SessionSummary = {
			id: "session-1",
			title: "Current",
			locator: { text: "sessions/current", truncated: false, byteLength: 17 },
			cwdLabel: "workspace",
			createdAt: "2026-08-05T00:00:00.000Z",
			updatedAt: "2026-08-05T00:00:01.000Z",
			lifecycle: "active",
			access: "read-write",
			format: "current-canonical",
			lineage,
			current: true,
		};
		const detail: SessionDetail = {
			summary,
			messageCount: { state: "known", value: 1 },
			turnCount: { state: "known", value: 1 },
			toolCount: { state: "unknown", reason: "not reported" },
			selection: { state: "unknown", reason: "not reported" },
			headCursor: { state: "known", value: "cursor-1" },
			lineage,
		};
		const preview: SessionPreview = {
			summary,
			messages: [{ role: "user", text: "hello", truncated: false }],
			timeline: emptyTimeline,
			truncated: false,
			sourceBytes: { state: "known", value: 128 },
		};
		const diagnostics: SessionDiagnostic[] = [
			{ kind: "corrupt", message: "invalid record" },
			{ kind: "oversize", message: "bounded preview limit" },
			{ kind: "staging", message: "not published" },
			{ kind: "unpublished", message: "not canonical" },
			{ kind: "symlink", message: "not accepted" },
			{ kind: "changed", message: "revision changed" },
		];
		const workflow: SessionWorkflowState[] = [
			{ state: "idle", generation: 1 },
			{ state: "loading", generation: 1, requestId: "request-1" },
			{ state: "ready", generation: 1, value: { kind: "catalog", items: [summary] } },
			{ state: "empty", generation: 1 },
			{ state: "error", generation: 1, code: "unavailable", message: "not assembled", retryable: false },
		];
		const transitions: SessionTransitionState[] = [
			{ state: "idle", generation: 1 },
			{ state: "requesting", generation: 1, intentId: "intent-1", expectedRevision: 1 },
			{ state: "confirming", generation: 1, intentId: "intent-1", expectedRevision: 1, targetSessionId: "session-2" },
			{ state: "succeeded", generation: 1, intentId: "intent-1", targetSessionId: "session-2" },
			{ state: "recovery-required", generation: 1, intentId: "intent-1", message: "completion uncertain" },
			{ state: "failed", generation: 1, intentId: "intent-1", message: "failed", retryable: true },
		];
		expect(structuredClone({ detail, preview, diagnostics, workflow, transitions })).toEqual({ detail, preview, diagnostics, workflow, transitions });
	});

	it("keeps overlay and client-local interaction state free of renderer references", () => {
		const overlays: TuiOverlayState[] = [
			{ state: "closed" },
			{ state: "command", requestId: "request-1" },
			{ state: "session", requestId: "request-1" },
			{ state: "provider", requestId: "request-1" },
			{ state: "auth", requestId: "request-1" },
			{ state: "model", requestId: "request-1" },
			{ state: "thinking", requestId: "request-1" },
			{ state: "prompt", requestId: "request-1" },
			{ state: "extension", requestId: "request-1" },
			{ state: "keymap", requestId: "request-1" },
			{ state: "approval", requestId: "request-1" },
			{ state: "process", requestId: "request-1" },
			{ state: "transition", requestId: "request-1" },
		];
		const interaction: TuiInteractionState = {
			overlay: overlays[0]!,
			search: { state: "known", value: "" },
			selectedId: { state: "unknown", reason: "nothing selected" },
			generation: 1,
			viewportClearRevision: 0,
			toolDetailsExpanded: false,
			composerEmpty: true,
			transitionFrozen: false,
		};
		expect(structuredClone({ overlays, interaction })).toEqual({ overlays, interaction });
	});

	it("does not declare old-generation readers or compatibility gates", () => {
		const paths = [
			join(process.cwd(), "src/tui/commands/types.ts"),
			join(process.cwd(), "src/tui/sessions/types.ts"),
			join(process.cwd(), "src/tui/application/state.ts"),
		];
		const missing = paths.filter((path) => !existsSync(path));
		expect(missing).toEqual([]);
		if (missing.length > 0) return;
		const source = paths.map((path) => readFileSync(path, "utf8")).join("\n");
		const forbiddenTokens = [
			["v", "1"].join(""),
			["v", "2"].join(""),
			["v", "3"].join(""),
			"legacy",
			"compatibility",
			"fallback",
			"featureFlag",
		];
		expect(forbiddenTokens.some((token) => source.toLowerCase().includes(token.toLowerCase()))).toBe(false);
		expect(source).not.toMatch(/\b(?:Renderable|Component|Theme|Controller|Storage|Promise|Map)\b/u);
	});
});
