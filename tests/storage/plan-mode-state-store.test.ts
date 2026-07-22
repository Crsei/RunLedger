import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInactivePlanModeState } from "../../src/runtime/modes/plan/service.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef, type ExpectedRevision } from "../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import { FilePlanModeStateStore } from "../../src/storage/plan-mode-state-store.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const authorityId = createRuntimeId("authority", "plan-state-store");
const tenantId = createRuntimeId("tenant", "plan-state-store");
const principalId = createRuntimeId("principal", "plan-state-store");
const sessionId = createRuntimeId("session", "plan-state-store");
const workspaceId = createRuntimeId("workspace", "plan-state-store");
const revision: ExpectedRevision = {
	stream: createSessionEventStreamRef({ authorityId, tenantId }, sessionId),
	sequence: 4,
	eventHash: canonicalDigest("plan-state-event"),
};

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "runledger-plan-state-"));
	roots.push(root);
	const path = join(root, "state", "plan-mode.json");
	return {
		path,
		store: new FilePlanModeStateStore({
			path,
			authorityId,
			tenantId,
			sessionId,
			workspaceId,
			currentRevision: () => revision,
		}),
	};
}

describe("FilePlanModeStateStore", () => {
	it("commits and reopens a scoped state at the exact durable event revision", async () => {
		const { path, store } = await setup();
		const state = createInactivePlanModeState({ authorityId, tenantId, principalId, sessionId, workspaceId }, "2026-07-22T00:00:00.000Z");
		await store.commit(state);
		expect(await store.load()).toEqual({ state, eventRevision: revision, workspaceId });
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
	});

	it("fails closed on digest, scope, mode, and missing-revision failures", async () => {
		const { path, store } = await setup();
		const state = createInactivePlanModeState({ authorityId, tenantId, principalId, sessionId, workspaceId }, "2026-07-22T00:00:00.000Z");
		await store.commit(state);
		const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		await writeFile(path, `${JSON.stringify({ ...parsed, storedDigest: "f".repeat(64) })}\n`, { mode: 0o600 });
		await expect(store.load()).rejects.toThrow("scope or digest");

		await store.commit(state);
		const foreign = new FilePlanModeStateStore({
			path,
			authorityId,
			tenantId: createRuntimeId("tenant", "foreign-plan-state"),
			sessionId,
			workspaceId,
			currentRevision: () => revision,
		});
		await expect(foreign.load()).rejects.toThrow("scope or digest");

		await chmod(path, 0o644);
		await expect(store.load()).rejects.toThrow("unsafe");
		const noRevision = new FilePlanModeStateStore({
			path: join(dirname(path), "missing-revision.json"),
			authorityId,
			tenantId,
			sessionId,
			workspaceId,
			currentRevision: () => undefined,
		});
		await expect(noRevision.commit(state)).rejects.toThrow("durable v3 event revision");
		const wrongStream = new FilePlanModeStateStore({
			path: join(dirname(path), "wrong-stream.json"),
			authorityId,
			tenantId,
			sessionId,
			workspaceId,
			currentRevision: () => ({
				...revision,
				stream: createSessionEventStreamRef(
					{ authorityId, tenantId },
					createRuntimeId("session", "foreign-plan-state"),
				),
			}),
		});
		await expect(wrongStream.commit(state)).rejects.toThrow("durable v3 event revision");
	});
});
