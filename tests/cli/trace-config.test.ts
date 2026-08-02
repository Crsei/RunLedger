import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeCliTraceRecorderFactory } from "../../src/cli/trace-config.ts";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { mockModel } from "../../src/runtime/providers/mock-stream.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CLI trace configuration", () => {
	it("keeps recording off when user settings omit it", async () => {
		const layout = buildRunledgerLayout("/tmp/runledger-cli-trace-off", "posix");
		const factory = composeCliTraceRecorderFactory(layout, {});
		expect(await factory.create({ sessionId: createRuntimeId("session", "off") })).toBeUndefined();
	});

	it("allows artifact body recording when user settings explicitly enable it", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-cli-trace-artifacts-"));
		roots.push(root);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const factory = composeCliTraceRecorderFactory(layout, {
			recording: { mode: "events_and_artifacts", failurePolicy: "best_effort" },
		});
		const recorder = await factory.create({ sessionId: createRuntimeId("session", "artifacts") });
		const handle = await recorder?.startModel({
			turn: 1,
			model: mockModel,
			context: { systemPrompt: "safe", messages: [], tools: [] },
		});

		expect(handle?.inputContent.storage).toBe("artifact");
		expect(existsSync(layout.artifacts)).toBe(true);
	});
});
