import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalIdentityContext } from "../../src/runtime/identity/local-principal.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import { AuthorityRuntimeManager } from "../../src/storage/authority-runtime-manager.ts";

const roots: string[] = [];
const NOW = new Date("2026-07-22T13:00:00.000Z");

async function root(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "runledger-authority-runtime-"));
	roots.push(path);
	return path;
}

afterEach(async () => {
	for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("AuthorityRuntimeManager", () => {
	it("owns one durable authority writer and replays the canonical stream after restart", async () => {
		const cwd = await root();
		const identity = createLocalIdentityContext(NOW);
		const first = await AuthorityRuntimeManager.open({
			cwd,
			identity,
			runtimeId: createRuntimeId("runtime", "authority-first"),
			clock: () => NOW,
			leaseDurationMs: 60_000,
		});
		const appended = await first.authorityRepository().append({
			type: "policy.effective_recorded",
			principalId: identity.principalId,
			traceId: createRuntimeId("trace", "authority-policy"),
			timestamp: NOW.toISOString(),
			payload: {
				policyId: createRuntimeId("resource", "authority-policy"),
				policyRevision: 1,
				policyDigest: canonicalDigest({ policy: "strict" }),
				sourceReceiptId: createRuntimeId("receipt", "authority-policy-source"),
				sourceReceiptDigest: canonicalDigest({ source: "managed" }),
				effectiveAt: NOW.toISOString(),
			},
		});
		expect(appended).toMatchObject({ ok: true, value: { durableReceipt: { writerEpoch: 1 } } });

		await expect(AuthorityRuntimeManager.open({
			cwd,
			identity,
			runtimeId: createRuntimeId("runtime", "authority-contender"),
			clock: () => NOW,
			leaseDurationMs: 60_000,
		})).rejects.toThrow("authority writer lease unavailable");

		const eventFile = first.eventFilePath();
		await first.close();
		const second = await AuthorityRuntimeManager.open({
			cwd,
			identity,
			runtimeId: createRuntimeId("runtime", "authority-second"),
			clock: () => new Date(NOW.getTime() + 1_000),
			leaseDurationMs: 60_000,
		});
		const replay = await second.authorityRepository().replay();
		expect(replay).toMatchObject({
			ok: true,
			value: { events: [{ type: "policy.effective_recorded", sequence: 0 }] },
		});
		expect(second.eventFilePath()).toBe(eventFile);
		expect((await stat(eventFile)).mode & 0o777).toBe(0o600);
		await second.close();
	});

	it("fails closed on a malformed authority log and preserves the bytes", async () => {
		const cwd = await root();
		const identity = createLocalIdentityContext(NOW);
		const initial = await AuthorityRuntimeManager.open({
			cwd,
			identity,
			runtimeId: createRuntimeId("runtime", "authority-corrupt-initial"),
			clock: () => NOW,
		});
		const path = initial.eventFilePath();
		await initial.close();
		await writeFile(path, "{malformed}\n", { encoding: "utf8", mode: 0o600 });
		const before = await readFile(path, "utf8");

		await expect(AuthorityRuntimeManager.open({
			cwd,
			identity,
			runtimeId: createRuntimeId("runtime", "authority-corrupt-reopen"),
			clock: () => new Date(NOW.getTime() + 1_000),
		})).rejects.toThrow("authority Event Store open failed");
		expect(await readFile(path, "utf8")).toBe(before);
	});
});
