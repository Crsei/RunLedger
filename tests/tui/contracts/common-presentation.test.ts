import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	CorrelatedRequestRef,
	Loadable,
	PortAvailability,
	QueryGuard,
	TuiExecutionState,
	TuiTerminalState,
} from "../../../src/tui/application/common.ts";
import type {
	ActiveStateView,
	CommandComposerView,
	CommandDraftProvenance,
	CommandSuggestionView,
	FooterView,
	SessionStripView,
	TuiBootstrapSnapshot,
	WelcomeView,
} from "../../../src/tui/presentation/types.ts";

function clone<T>(value: T): T {
	return structuredClone(value);
}

function expectCloneable(value: unknown): void {
	const cloned = clone(value);
	expect(cloned).toEqual(value);
	const serialized = JSON.stringify(value);
	expect(serialized).not.toContain("undefined");
}

describe("passive common and presentation contracts", () => {
	it("has the P1 type-only modules before exercising their fixtures", () => {
		const root = process.cwd();
		for (const relativePath of [
			"src/tui/application/common.ts",
			"src/tui/presentation/types.ts",
		]) {
			const path = join(root, relativePath);
			expect(existsSync(path)).toBe(true);
			expect(readFileSync(path, "utf8")).toContain("export");
		}
	});

	it("represents every common async discriminant without sentinel defaults", () => {
		const loadables: Loadable<string>[] = [
			{ state: "idle" },
			{ state: "loading", requestId: "request-1", generation: 1 },
			{ state: "ready", value: "known", generation: 1 },
			{ state: "empty", generation: 1 },
			{ state: "error", code: "unavailable", message: "not assembled", retryable: false, generation: 1 },
		];
		const guards: QueryGuard[] = [
			{ state: "idle" },
			{ state: "dispatching", correlationId: "correlation-1", effectId: "effect-1", generation: 1 },
			{ state: "running", correlationId: "correlation-1", effectId: "effect-1", generation: 1 },
		];
		const terminals: TuiTerminalState[] = [
			{ state: "succeeded", summary: "done" },
			{ state: "failed", code: "failed", message: "failed", retryable: true },
			{ state: "cancelled", reason: "user" },
			{ state: "aborted", reason: "superseded" },
		];
		const executions: TuiExecutionState[] = [
			{ state: "pending" },
			{ state: "running", effectId: "effect-1" },
			...terminals,
		];
		const request: CorrelatedRequestRef = {
			generation: 1,
			effectId: "effect-1",
			correlationId: "correlation-1",
		};
		const availability: PortAvailability[] = [
			{ state: "available" },
			{ state: "unavailable", reason: "no authority" },
		];
		expectCloneable({ loadables, guards, terminals, executions, request, availability });
	});

	it("keeps presentation views framework-neutral and structured-cloneable", () => {
		const bootstrap = {
			workspaceLabel: "workspace",
			session: {
				id: "session-1",
				format: "current-canonical",
				lifecycle: "active",
				title: "Current session",
			},
			authorityGeneration: 4,
		} satisfies TuiBootstrapSnapshot;
		const strip = {
			workspaceLabel: "workspace",
			sessionLabel: "Current session",
			sessionFormat: "current-canonical",
			lifecycle: "active",
			authorityGeneration: 4,
			securityMode: "unknown",
			connection: "connected",
		} satisfies SessionStripView;
		const activity = {
			priority: "unknown",
			query: "running",
			authorityGeneration: 4,
			frozen: false,
			recoveryRequired: false,
		} satisfies ActiveStateView;
		const footer = {
			status: "authority unavailable",
			securityMode: "unknown",
			context: { state: "unknown", reason: "not reported" },
			selection: { state: "unknown", reason: "not reported" },
			host: { state: "unavailable", reason: "not assembled" },
		} satisfies FooterView;
		const composer = {
			mode: "prompt",
			draft: "hello",
			queuedCount: { state: "unknown", reason: "durable queue unavailable" },
			frozen: false,
		} satisfies CommandComposerView;
		const suggestion = {
			canonicalName: "help",
			alias: "?",
			label: "Help",
			description: "Show help",
			catalogGeneration: 2,
			availability: { state: "available" },
		} satisfies CommandSuggestionView;
		const provenance = {
			source: "palette",
			canonicalName: "help",
			catalogGeneration: 2,
		} satisfies CommandDraftProvenance;
		const welcome = {
			versionLabel: "unknown",
			modelLabel: "unavailable",
			thinkingLabel: "unknown",
			directoryLabel: "workspace",
			branchLabel: "unavailable",
		} satisfies WelcomeView;
		expectCloneable({ bootstrap, strip, activity, footer, composer, suggestion, provenance, welcome });
	});
});
