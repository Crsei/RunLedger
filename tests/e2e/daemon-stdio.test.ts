import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalIdentityContext } from "../../src/runtime/identity/local-principal.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../src/runtime/protocol/v3/coordination.ts";
import { createSessionEventStreamRef } from "../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";

const PROJECT_ROOT = resolve(".");
const DAEMON_ENTRY = join(PROJECT_ROOT, "src", "daemon", "cli.ts");
const DIGEST = "a".repeat(64);
const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

interface CapturedChild {
	child: ChildProcessWithoutNullStreams;
	done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
}

function temporaryProject(): string {
	const root = mkdtempSync(join(tmpdir(), "runledger-daemon-stdio-"));
	roots.push(root);
	mkdirSync(join(root, ".runledger"), { recursive: true });
	writeFileSync(join(root, ".runledger", "settings.json"), JSON.stringify({
		runtimeFeatures: {
			sessionV3: true,
			workspaceContracts: true,
			securityContracts: true,
			workspaceGuard: true,
			capabilityGateway: true,
			sandboxEnforcement: true,
			artifactCas: true,
			resourceContracts: true,
			planContextMemoryContracts: true,
			orchestrator: true,
			verification: true,
			daemon: true,
		},
	}), "utf8");
	return root;
}

function spawnDaemon(root: string): CapturedChild {
	const child = spawn(process.execPath, [
		"--import",
		"tsx",
		DAEMON_ENTRY,
		"--cwd",
		root,
		"--session-dir",
		join(root, "sessions"),
		"--shutdown-timeout-ms",
		"2000",
	], {
		cwd: PROJECT_ROOT,
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.add(child);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => { stdout += chunk; });
	child.stderr.on("data", (chunk: string) => { stderr += chunk; });
	const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolveDone) => {
		child.once("close", (code, signal) => {
			children.delete(child);
			resolveDone({ code, signal, stdout, stderr });
		});
	});
	return { child, done };
}

function frames(source: string): Record<string, unknown>[] {
	return source.trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function hello() {
	return {
		kind: "handshake",
		requestId: "daemon-hello",
		clientName: "daemon-e2e",
		clientVersion: "1.0.0",
		protocol: { major: 1, minMinor: 0, maxMinor: 0 },
		controlPlaneSchemaVersions: [1],
		runtimeSchemaVersions: [3],
		requestedFeatures: [
			"session",
			"turn",
			"queue",
			"approval",
			"change_proposal",
			"human_gate",
			"artifact",
			"event_subscription",
			"activity",
			"health",
			"shutdown",
			"consumer_checkpoint",
		],
		requiredFeatures: ["session", "health"],
		transport: "jsonl",
	};
}

function health() {
	const identity = createLocalIdentityContext();
	return {
		kind: "query",
		type: "health",
		queryId: "daemon-health",
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		payload: {},
	};
}

function sessionStart() {
	const identity = createLocalIdentityContext();
	return {
		kind: "command",
		type: "session:start",
		commandId: createRuntimeId("command", "daemon-session-start"),
		idempotencyKey: createIdempotencyKey("daemon-session-start-key"),
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		expectedSessionRevision: null,
		expectedTurnId: null,
		sessionHandle: null,
		payload: { cwdDigest: DIGEST, configurationDigest: DIGEST },
	};
}

function shutdown() {
	const identity = createLocalIdentityContext();
	return {
		kind: "command",
		type: "shutdown",
		commandId: createRuntimeId("command", "daemon-shutdown"),
		idempotencyKey: createIdempotencyKey("daemon-shutdown-key-0001"),
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		expectedSessionRevision: null,
		expectedTurnId: null,
		sessionHandle: null,
		payload: { reasonDigest: DIGEST, drainTimeoutMs: 1_000 },
	};
}

function waitForLine(child: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> {
	return new Promise((resolveLine, reject) => {
		let buffered = "";
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("daemon response timed out"));
		}, 5_000);
		const onData = (chunk: string): void => {
			buffered += chunk;
			const newline = buffered.indexOf("\n");
			if (newline < 0) return;
			const line = buffered.slice(0, newline);
			cleanup();
			resolveLine(JSON.parse(line) as Record<string, unknown>);
		};
		const onClose = (): void => {
			cleanup();
			reject(new Error("daemon exited before producing a response"));
		};
		const cleanup = (): void => {
			clearTimeout(timer);
			child.stdout.off("data", onData);
			child.off("close", onClose);
		};
		child.stdout.on("data", onData);
		child.once("close", onClose);
	});
}

afterEach(async () => {
	for (const child of children) child.kill("SIGKILL");
	children.clear();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runledger-daemon stdio process", () => {
	it("fails closed when the daemon rollout gate is not enabled", async () => {
		const root = temporaryProject();
		writeFileSync(join(root, ".runledger", "settings.json"), JSON.stringify({
			runtimeFeatures: { sessionV3: true },
		}), "utf8");
		const running = spawnDaemon(root);
		running.child.stdin.end();

		const exited = await running.done;
		expect(exited).toMatchObject({ code: 1, signal: null, stdout: "" });
		expect(exited.stderr).toContain("unsupported_feature: local daemon requires the daemon rollout feature");
	}, 20_000);

	it("negotiates only wired features, serves health, and rejects unavailable session mutation at EOF", async () => {
		const root = temporaryProject();
		const running = spawnDaemon(root);
		running.child.stdin.end([
			`${JSON.stringify(hello())}\r\n`,
			`${JSON.stringify(health())}\n`,
			JSON.stringify(sessionStart()),
		].join(""));

		const exited = await running.done;
		expect(exited).toMatchObject({ code: 0, signal: null, stderr: "" });
		const output = frames(exited.stdout);
		expect(output).toHaveLength(3);
		expect(output[0]).toMatchObject({
			kind: "handshake_result",
			features: ["session", "queue", "activity", "health"],
		});
		expect(output[1]).toMatchObject({
			kind: "query_result",
			result: { type: "health", status: "ok", shuttingDown: false },
		});
		expect(output[2]).toMatchObject({ kind: "error", error: { code: "unsupported_feature" } });
		expect(existsSync(join(root, "sessions"))).toBe(false);
	}, 20_000);

	it("returns one typed malformed-frame error and exits without waiting for parent EOF", async () => {
		const running = spawnDaemon(temporaryProject());
		running.child.stdin.write("{not-json}\n");

		const exited = await running.done;
		expect(exited.code).toBe(2);
		expect(exited.signal).toBeNull();
		expect(exited.stderr).toBe("");
		expect(frames(exited.stdout)).toEqual([
			expect.objectContaining({
				kind: "error",
				requestId: null,
				error: expect.objectContaining({ code: "malformed_frame", retryable: false }),
			}),
		]);
	}, 20_000);

	it("rejects turn, approval, and artifact requests because their production ports are not advertised", async () => {
		const running = spawnDaemon(temporaryProject());
		let response = waitForLine(running.child);
		running.child.stdin.write(`${JSON.stringify(hello())}\n`);
		await expect(response).resolves.toMatchObject({
			kind: "handshake_result",
			features: ["session", "queue", "activity", "health"],
		});

		response = waitForLine(running.child);
		running.child.stdin.write(`${JSON.stringify(sessionStart())}\n`);
		await expect(response).resolves.toMatchObject({ kind: "error", error: { code: "unsupported_feature" } });
		const identity = createLocalIdentityContext();
		const sessionId = createRuntimeId("session", "unsupported");
		const handle = {
			handleId: "handle_unsupported00001",
			sessionId,
			generation: 1,
		};
		const expectedSessionRevision = {
			stream: createSessionEventStreamRef(identity, sessionId),
			sequence: 0,
			eventHash: DIGEST,
		};
		const base = {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
		};
		const prompt = { storage: "bounded_text", text: "not dispatched" };

		response = waitForLine(running.child);
		running.child.stdin.write(`${JSON.stringify({
			...base,
			kind: "command",
			type: "turn:start",
			commandId: createRuntimeId("command", "unsupported-turn"),
			idempotencyKey: createIdempotencyKey("unsupported-turn-key"),
			expectedSessionRevision,
			expectedTurnId: null,
			sessionHandle: handle,
			payload: {
				sessionId,
				prompt: { ...prompt, contentDigest: canonicalDigest(prompt) },
			},
		})}\n`);
			await expect(response).resolves.toMatchObject({ kind: "error", error: { code: "unsupported_feature" } });

			const approvalResolutionBody = {
				authorityId: base.authorityId,
				tenantId: base.tenantId,
				principalId: base.principalId,
				receiptId: createRuntimeId("receipt", "unsupported-approval"),
				approvalId: createRuntimeId("approval", "unsupported"),
				requestId: createRuntimeId("command", "approval-request"),
				requestDigest: DIGEST,
				ticketDigest: DIGEST,
				decision: "denied" as const,
				decisionRevision: 1,
				decidedAt: "2026-07-22T00:00:00.000Z",
				evidenceComplete: true,
				evidenceTruncated: false,
				originalInputDigest: DIGEST,
			};
			response = waitForLine(running.child);
		running.child.stdin.write(`${JSON.stringify({
			...base,
			kind: "command",
			type: "approval:resolve",
			commandId: createRuntimeId("command", "unsupported-approval"),
			idempotencyKey: createIdempotencyKey("unsupported-approval-key"),
			expectedSessionRevision,
			expectedTurnId: null,
			sessionHandle: handle,
			payload: {
				sessionId,
					approvalId: approvalResolutionBody.approvalId,
					requestId: approvalResolutionBody.requestId,
					ticketDigest: DIGEST,
					expectedDecisionRevision: 0,
					resolutionReceipt: {
						...approvalResolutionBody,
						receiptDigest: canonicalDigest(approvalResolutionBody),
					},
			},
		})}\n`);
		await expect(response).resolves.toMatchObject({ kind: "error", error: { code: "unsupported_feature" } });

		response = waitForLine(running.child);
		running.child.stdin.write(`${JSON.stringify({
			...base,
			kind: "query",
			type: "artifact:metadata",
			queryId: "unsupported-artifact",
			payload: {
				sessionId,
				sessionHandle: handle,
				artifactId: createRuntimeId("artifact", "unsupported"),
			},
		})}\n`);
		await expect(response).resolves.toMatchObject({ kind: "error", error: { code: "unsupported_feature" } });

		running.child.stdin.end();
		await expect(running.done).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
	}, 20_000);

	it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("drains and exits cleanly on %s", async (signal) => {
		const running = spawnDaemon(temporaryProject());
		const response = waitForLine(running.child);
		running.child.stdin.write(`${JSON.stringify(hello())}\n`);
		await expect(response).resolves.toMatchObject({ kind: "handshake_result" });
		expect(running.child.kill(signal)).toBe(true);

		await expect(running.done).resolves.toMatchObject({ code: 0, signal: null, stderr: "" });
	}, 20_000);

	it("rejects an explicit shutdown command when production drain adapters are not advertised", async () => {
		const running = spawnDaemon(temporaryProject());
		let response = waitForLine(running.child);
		running.child.stdin.write(`${JSON.stringify(hello())}\n`);
		await expect(response).resolves.toMatchObject({
			kind: "handshake_result",
			features: ["session", "queue", "activity", "health"],
		});
		response = waitForLine(running.child);
		running.child.stdin.write(`${JSON.stringify(shutdown())}\n`);
		await expect(response).resolves.toMatchObject({ kind: "error", error: { code: "unsupported_feature" } });
		running.child.stdin.end();
		const exited = await running.done;
		expect(exited).toMatchObject({ code: 0, signal: null, stderr: "" });
	}, 20_000);
});
