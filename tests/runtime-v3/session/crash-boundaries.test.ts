import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { computeRuntimeEventHash, computeRuntimeEventPayloadDigest } from "../../../src/runtime/protocol/v3/event-hash.ts";
import type { RuntimeEventHashInput } from "../../../src/runtime/protocol/v3/event-hash.ts";
import { createSessionEventStreamRef, type RuntimeEventEnvelopeV3 } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { scanJsonlV3EventLog } from "../../../src/runtime/session/jsonl-v3-store.ts";
import { verifyRuntimeEventChain } from "../../../src/runtime/session/chain-verification.ts";

const roots: string[] = [];
const authorityId = createRuntimeId("authority", "crash-boundary");
const tenantId = createRuntimeId("tenant", "crash-boundary");
const sessionId = createRuntimeId("session", "crash-boundary");
const scope = {
	authorityId,
	tenantId,
	stream: createSessionEventStreamRef({ authorityId, tenantId }, sessionId),
};

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function genesis(): RuntimeEventEnvelopeV3<"session.created"> {
	const payload = {
		origin: "test" as const,
		runtimeId: createRuntimeId("runtime", "crash-boundary"),
		featureDigest: "0".repeat(64),
		initialGoalId: createRuntimeId("goal", "crash-boundary"),
		rootAgentId: createRuntimeId("agent", "crash-boundary"),
	};
	const input: RuntimeEventHashInput = {
		schemaVersion: 3,
		...scope,
		principalId: createRuntimeId("principal", "crash-boundary"),
		eventId: createRuntimeId("event", "genesis"),
		sequence: 0,
		timestamp: "2026-07-22T00:00:00.000Z",
		type: "session.created",
		previousEventHash: null,
		payloadDigest: computeRuntimeEventPayloadDigest(payload),
		traceId: createRuntimeId("trace", "genesis"),
	};
	return { ...input, currentEventHash: computeRuntimeEventHash(input), payload };
}

describe("Session v3 crash boundaries", () => {
	it.skipIf(process.platform === "win32")(
		"preserves the trusted prefix and marks a SIGKILL during an event body as a torn tail",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "runledger-crash-boundary-"));
			roots.push(root);
			const filePath = join(root, "events.jsonl");
			await writeFile(filePath, `${canonicalJson(genesis())}\n`, "utf8");
			const script = [
				"const fs=require('node:fs')",
				"fs.appendFileSync(process.argv[1], '{\"schemaVersion\":3')",
				"process.stdout.write('ready\\n')",
				"setInterval(()=>{}, 1000)",
			].join(";");
			const child = spawn(process.execPath, ["-e", script, filePath], { stdio: ["ignore", "pipe", "pipe"] });
			await new Promise<void>((resolveReady, rejectReady) => {
				child.once("error", rejectReady);
				child.stdout.once("data", () => resolveReady());
			});
			child.kill("SIGKILL");
			await once(child, "exit");

			const bytes = await readFile(filePath);
			const scan = scanJsonlV3EventLog(bytes, scope);
			expect(scan.events).toHaveLength(1);
			expect(scan.events[0]?.eventId).toBe(createRuntimeId("event", "genesis"));
			expect(scan).toMatchObject({
				tornTail: true,
				firstError: { code: "torn_tail", line: 1 },
			});
		},
	);

	it("locates a duplicate event id even when sequence and hashes are recomputed", () => {
		const first = genesis();
		const payload = { role: "user" as const, messageJson: "{}", contentDigest: "0".repeat(64) };
		const input: RuntimeEventHashInput = {
			...first,
			eventId: first.eventId,
			sequence: 1,
			type: "conversation.message_recorded",
			previousEventHash: first.currentEventHash,
			payloadDigest: computeRuntimeEventPayloadDigest(payload),
		};
		const duplicate: RuntimeEventEnvelopeV3<"conversation.message_recorded"> = {
			...input,
			currentEventHash: computeRuntimeEventHash(input),
			payload,
		};
		expect(verifyRuntimeEventChain([first, duplicate], scope)).toMatchObject({
			integrity: "corrupted",
			firstBadSequence: 1,
			error: { code: "invalid_event" },
		});
	});
});
