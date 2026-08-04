import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import {
	HOOK_EVENT_NAMES,
	orderHookHandlers,
	parseHookDocument,
} from "../../src/extensions/hooks/parser.ts";
import {
	parseHookStdout,
	runHookPipeline,
} from "../../src/extensions/hooks/pipeline.ts";
import type {
	HookCommandRunner,
	HookCommandRunnerRequest,
	HookEvent,
	HookPipelineResult,
} from "../../src/extensions/hooks/types.ts";

const sessionId = createRuntimeId("session", "hooks-test");
const snapshotId = createRuntimeId("snapshot", "snapshot-test");

function handler(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "command",
		command: "./guard.sh",
		args: [],
		timeoutMs: 100,
		env: {},
		...overrides,
	};
}

function hookDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		hooks: {
			PreToolUse: [
				{
					id: "guard",
					matcher: "^Bash$",
					failureMode: "closed",
					handlers: [handler()],
				},
			],
			...overrides,
		},
	};
}

function event(overrides: Partial<HookEvent> = {}): HookEvent {
	return {
		event: "PreToolUse",
		eventId: createRuntimeId("event", "event-test"),
		timestamp: "2026-08-04T12:00:00.000Z",
		sessionId,
		snapshotId,
		source: "test",
		matcherValue: "Bash",
		input: { command: "rm -rf /tmp/example" },
		...overrides,
	};
}

function parsedHooks(document: Record<string, unknown>, sourcePath = "/workspace/hooks.json") {
	const parsed = parseHookDocument(document, { sourceLayer: "project", sourcePath });
		if (!parsed.ok) throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
	return parsed.hooks;
}

function runnerFor(
	respond: (request: HookCommandRunnerRequest, index: number) => Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> | { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string },
): HookCommandRunner & { readonly requests: HookCommandRunnerRequest[] } {
	const requests: HookCommandRunnerRequest[] = [];
	return {
		requests,
		run: async (request) => {
			requests.push(request);
			return respond(request, requests.length - 1);
		},
	};
}

describe("Hooks M3 parser and matcher", () => {
	it("accepts only the five current events and strict command descriptors", () => {
		const parsed = parseHookDocument(hookDocument());

		expect(HOOK_EVENT_NAMES).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionEnd"]);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.hooks[0]).toMatchObject({
				id: "guard",
				event: "PreToolUse",
				matcher: "^Bash$",
				failureMode: "closed",
			});
			expect(parsed.hooks[0]?.handlers[0]).toMatchObject({ type: "command", command: "./guard.sh" });
			expect(parsed.digest).toMatchObject({ algorithm: "sha256" });
		}
	});

	it("rejects unknown event names and unknown handler fields", () => {
		const unknownEvent = parseHookDocument({ hooks: { BeforeTool: [] } });
		const unknownField = parseHookDocument(hookDocument({
			PreToolUse: [{ id: "guard", handlers: [handler({ shell: true })] }],
		}));

		expect(unknownEvent.ok).toBe(false);
		expect(unknownEvent.diagnostics.map((diagnostic) => diagnostic.code)).toContain("hooks.unknown_event");
		expect(unknownField.ok).toBe(false);
		expect(unknownField.diagnostics.map((diagnostic) => diagnostic.code)).toContain("hooks.handler_unknown_field");
	});

	it("rejects an invalid matcher before a hook can be registered", () => {
		const parsed = parseHookDocument(hookDocument({
			PreToolUse: [{ id: "broken", matcher: "[", handlers: [handler()] }],
		}));

		expect(parsed.ok).toBe(false);
		expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toContain("hooks.matcher_invalid");
	});

	it("matches by matcher and orders handlers by layer, canonical path, declaration, then handler index", () => {
		const first = parsedHooks({ hooks: { PreToolUse: [{ id: "z", matcher: "^Bash$", handlers: [handler({ command: "z" })] }] } }, "/workspace/z.json");
		const second = parseHookDocument({ hooks: { PreToolUse: [{ id: "a", matcher: "^Bash$", handlers: [handler({ command: "a-1" }), handler({ command: "a-2" })] }] } }, { sourceLayer: "user", sourcePath: "/workspace/a.json" });
		if (!second.ok) throw new Error("expected valid second hook document");

		const ordered = orderHookHandlers([...first, ...second.hooks], "PreToolUse", "Bash");
		expect(ordered.map((entry) => entry.handler.command)).toEqual(["a-1", "a-2", "z"]);
		expect(orderHookHandlers(first, "PreToolUse", "Read")).toHaveLength(0);
	});
});

describe("Hooks M3 pipeline", () => {
	it("passes canonical JSON stdin and protects Runtime-injected environment keys", async () => {
		const runner = runnerFor(async () => ({ exitCode: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" }));
		const result = await runHookPipeline({
			event: event(),
			hooks: parsedHooks(hookDocument()),
			runner,
			baseEnv: { PATH: "/usr/bin", RUNLEDGER_HOOK_EVENT: "forged" },
		});

		expect(result.decision).toBe("allow");
		expect(runner.requests).toHaveLength(1);
		expect(JSON.parse(runner.requests[0]?.stdin ?? "{}")).toMatchObject({ event: "PreToolUse", input: { command: "rm -rf /tmp/example" } });
		expect(runner.requests[0]?.env).toMatchObject({ PATH: "/usr/bin", RUNLEDGER_HOOK_EVENT: "PreToolUse", RUNLEDGER_HOOK_ID: "guard", RUNLEDGER_SESSION_ID: sessionId });
	});

	it("short-circuits on an explicit deny and returns a structured audit result", async () => {
		const document = { hooks: { PreToolUse: [{ id: "guard", handlers: [handler(), handler({ command: "never" })] }] } };
		const runner = runnerFor(async () => ({ exitCode: 0, stdout: JSON.stringify({ decision: "deny", reason: "blocked by policy" }), stderr: "" }));

		const result = await runHookPipeline({ event: event(), hooks: parsedHooks(document), runner });

		expect(result).toMatchObject({ decision: "deny", blocked: true });
		expect(runner.requests).toHaveLength(1);
		expect(result.handlers[0]).toMatchObject({ outcome: "deny", reason: "blocked by policy" });
		expect(result.auditDigest).toMatchObject({ algorithm: "sha256", digest: expect.any(String) });
		expect(result.handlers[0]?.inputDigest).toMatchObject({ algorithm: "sha256" });
	});

	it("returns updatedInput as a fresh value and marks revalidation and authorization as mandatory", async () => {
		const originalInput = { command: "unsafe", nested: { value: 1 } };
		const runner = runnerFor(async (_request, index) => index === 0
			? { exitCode: 0, stdout: JSON.stringify({ decision: "allow", updatedInput: { command: "safe", nested: { value: 1 } } }), stderr: "" }
			: { exitCode: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" });

		const result = await runHookPipeline({
			event: event({ input: originalInput }),
			hooks: parsedHooks({ hooks: { PreToolUse: [{ id: "guard", handlers: [handler(), handler({ command: "after-update" })] }] } }),
			runner,
		});

		expect(result).toMatchObject({ decision: "allow", requiresRevalidation: true, requiresAuthorization: true, finalInput: { command: "safe" } });
		expect(result.finalInput).not.toBe(originalInput);
		expect(originalInput).toEqual({ command: "unsafe", nested: { value: 1 } });
		expect(JSON.parse(runner.requests[1]?.stdin ?? "{}").input).toEqual({ command: "safe", nested: { value: 1 } });
	});

	it("uses closed failure for blocking hooks and open failure for observation hooks", async () => {
		const failing = runnerFor(async () => ({ exitCode: 7, stdout: "", stderr: "guard failed" }));
		const closed = await runHookPipeline({ event: event(), hooks: parsedHooks(hookDocument()), runner: failing });
		const open = await runHookPipeline({
			event: event({ event: "PostToolUse", matcherValue: "Bash" }),
			hooks: parsedHooks({ hooks: { PostToolUse: [{ id: "observer", handlers: [handler()] }] } }),
			runner: failing,
		});

		expect(closed).toMatchObject({ decision: "deny", blocked: true });
		expect(closed.handlers[0]).toMatchObject({ outcome: "failure", failureKind: "nonzero", exitCode: 7, effectiveFailureMode: "closed" });
		expect(open).toMatchObject({ decision: "allow", blocked: false });
		expect(open.handlers[0]).toMatchObject({ outcome: "failure", failureKind: "nonzero", effectiveFailureMode: "open" });
		expect(open.diagnostics.some((diagnostic) => diagnostic.code === "hooks.handler_failed")).toBe(true);
	});

	it("does not let a project hook lower the closed user safety floor", async () => {
		const runner = runnerFor(async () => ({ exitCode: 9, stdout: "", stderr: "no" }));
		const hooks = parsedHooks({ hooks: { PreToolUse: [{ id: "project-open", failureMode: "open", handlers: [handler()] }] } });
		const result = await runHookPipeline({ event: event(), hooks, runner });

		expect(result.handlers[0]?.effectiveFailureMode).toBe("closed");
		expect(result.blocked).toBe(true);
	});

	it("rejects invalid, oversized, and non-PreToolUse updated output as structured failures", async () => {
		const invalid = await runHookPipeline({
			event: event(),
			hooks: parsedHooks({ hooks: { PreToolUse: [{ id: "invalid", failureMode: "open", handlers: [handler()] }] } }),
			runner: runnerFor(async () => ({ exitCode: 0, stdout: JSON.stringify({ decision: "allow", extra: true }), stderr: "" })),
		});
		const oversized = await runHookPipeline({
			event: event(),
			hooks: parsedHooks({ hooks: { PreToolUse: [{ id: "large", failureMode: "open", handlers: [handler()] }] } }),
			runner: runnerFor(async () => ({ exitCode: 0, stdout: "x".repeat(100), stderr: "" })),
			limits: { maxStdoutBytes: 32, maxStderrBytes: 32 },
		});
		const postUpdate = await runHookPipeline({
			event: event({ event: "PostToolUse" }),
			hooks: parsedHooks({ hooks: { PostToolUse: [{ id: "post", failureMode: "open", handlers: [handler()] }] } }),
			runner: runnerFor(async () => ({ exitCode: 0, stdout: JSON.stringify({ decision: "allow", updatedInput: { changed: true } }), stderr: "" })),
		});

		expect(invalid.handlers[0]?.failureKind).toBe("invalid_output");
		expect(oversized.handlers[0]?.failureKind).toBe("oversized_output");
		expect(postUpdate.handlers[0]?.failureKind).toBe("invalid_output");
	});

	it("propagates timeout and AbortSignal without spawning a real command", async () => {
		const never = runnerFor(async (request) => await new Promise((resolve) => {
			request.signal.addEventListener("abort", () => resolve({ exitCode: null, stdout: "", stderr: "" }), { once: true });
		}));
		const timedOut = await runHookPipeline({
			event: event(),
			hooks: parsedHooks({ hooks: { PreToolUse: [{ id: "slow", handlers: [handler({ timeoutMs: 10 })] }] } }),
			runner: never,
		});

		const controller = new AbortController();
		const abortedPromise: Promise<HookPipelineResult> = runHookPipeline({
			event: event(),
			hooks: parsedHooks({ hooks: { PreToolUse: [{ id: "abort", failureMode: "open", handlers: [handler({ timeoutMs: 1_000 })] }] } }),
			runner: never,
			signal: controller.signal,
		});
		controller.abort();
		const aborted = await abortedPromise;

		expect(timedOut.handlers[0]).toMatchObject({ failureKind: "timeout", timedOut: true });
		expect(timedOut.blocked).toBe(true);
		expect(aborted.handlers[0]).toMatchObject({ failureKind: "aborted", aborted: true });
		expect(aborted.decision).toBe("aborted");
	});

	it("parses stdout with an exact result shape", () => {
		expect(parseHookStdout(JSON.stringify({ decision: "allow", reason: "ok", updatedInput: null, additionalContext: null })).ok).toBe(true);
		expect(parseHookStdout(JSON.stringify({ decision: "allow", unknown: true })).ok).toBe(false);
		expect(parseHookStdout("not-json").ok).toBe(false);
	});
});
