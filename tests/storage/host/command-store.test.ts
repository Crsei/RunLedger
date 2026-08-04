import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonHostCommandStore } from "../../../src/storage/host/command-store.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import type { HostFrameEnvelope } from "../../../src/runtime/host/types.ts";

const workspaceStorageKey = "ws-" + "c".repeat(64);

function response(requestFrameId: string): HostFrameEnvelope {
	return {
		frameId: `response_${requestFrameId}`,
		kind: "command_result",
		protocolVersion: 1,
		body: { requestFrameId, ok: true, value: "persisted" },
	};
}

describe("durable Host command store", () => {
	it("persists intent before receipt and replays the receipt after restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-command-store-"));
		try {
			const options = { layout: buildRunledgerLayout(root, "posix"), workspaceStorageKey };
			const first = new JsonHostCommandStore(options);
			expect(await first.begin("principal_test", "command-1", "digest-a")).toEqual({ status: "execute" });
			await first.complete("principal_test", "command-1", "digest-a", response("first"));

			const reloaded = new JsonHostCommandStore(options);
			expect(await reloaded.begin("principal_test", "command-1", "digest-a")).toEqual({
				status: "replay",
				response: response("first"),
			});
			expect(await reloaded.begin("principal_test", "command-1", "digest-b")).toEqual({ status: "conflict" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("returns uncertain_outcome for a durable intent without a receipt", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-command-intent-"));
		try {
			const options = { layout: buildRunledgerLayout(root, "posix"), workspaceStorageKey };
			const first = new JsonHostCommandStore(options);
			expect(await first.begin("principal_test", "command-uncertain", "digest-a")).toEqual({ status: "execute" });

			const reloaded = new JsonHostCommandStore(options);
			expect(await reloaded.begin("principal_test", "command-uncertain", "digest-a")).toEqual({ status: "uncertain" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
