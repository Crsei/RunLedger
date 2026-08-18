import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSyncRetry } from "../../helpers/cleanup.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore, SessionStoreError } from "../../../src/storage/session-store/session-store.ts";

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "session-title-store-"));
});

afterEach(() => {
	rmSyncRetry(directory);
});

function openStore(): SessionStore {
	const database = openSessionDatabase(join(directory, "state.db"));
	installSessionStoreSchema(database);
	return new SessionStore(database);
}

function createOwnedSession(store: SessionStore, suffix = "title"): {
	readonly sessionId: ReturnType<typeof createRuntimeId>;
	readonly runtimeId: ReturnType<typeof createRuntimeId>;
	readonly generation: number;
} {
	const sessionId = createRuntimeId("session", suffix);
	const runtimeId = createRuntimeId("runtime", suffix);
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "w"),
		repositoryId: createRuntimeId("repository", "r"),
		settingsDigest: "d".repeat(64),
	});
	store.database().runSync(
		"INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 1, 'running', 1)",
		[sessionId, runtimeId],
	);
	return { sessionId, runtimeId, generation: 1 };
}

function appendRawTitleEvent(store: SessionStore, owned: ReturnType<typeof createOwnedSession>, payload: Record<string, unknown>): void {
	store.appendEvent({ sessionId: owned.sessionId, runtimeId: owned.runtimeId, generation: owned.generation }, {
		eventId: createRuntimeId("event", `raw-title-${owned.sessionId.slice(-12)}`),
		ownerGeneration: owned.generation,
		eventType: "session.title_changed",
		payloadJson: JSON.stringify(payload),
		createdAtMs: 2,
		expectedPreviousEventHash: null,
	});
}

describe("SessionStore session titles", () => {
	it("commits an auto title with an owner-fenced event and prevents a second auto winner", () => {
		const store = openStore();
		const owned = createOwnedSession(store);
		const fence = { sessionId: owned.sessionId, runtimeId: owned.runtimeId, generation: owned.generation };

		const titled = store.setTitle(fence, {
			title: "Fix login button",
			source: "auto",
			trigger: "first-user-message",
			expectedTitle: null,
			modelRef: { providerId: "openai", modelId: "gpt-test" },
		});

		expect(titled).toMatchObject({ title: "Fix login button", titleSource: "auto" });
		expect(store.replaySessionEvents(owned.sessionId).at(-1)).toMatchObject({ eventType: "session.title_changed" });
		expect(() => store.setTitle(fence, {
			title: "Second winner",
			source: "auto",
			trigger: "retry",
			expectedTitle: null,
		})).toThrowError(SessionStoreError);
		try {
			store.setTitle(fence, { title: "Second winner", source: "auto", trigger: "retry", expectedTitle: null });
		} catch (error) {
			expect((error as SessionStoreError).code).toBe("title_conflict");
		}
		store.database().close();
	});

	it("allows user rename to replace auto title but rejects a stale owner fence", () => {
		const store = openStore();
		const owned = createOwnedSession(store);
		const fence = { sessionId: owned.sessionId, runtimeId: owned.runtimeId, generation: owned.generation };
		store.setTitle(fence, { title: "Generated title", source: "auto", trigger: "first-user-message", expectedTitle: null });

		expect(store.setTitle(fence, {
			title: "Manual session name",
			source: "user",
			trigger: "manual-rename",
		})).toMatchObject({ title: "Manual session name", titleSource: "user" });
		store.database().runSync("UPDATE session_owners SET generation = 2 WHERE session_id = ?", [owned.sessionId]);
		expect(() => store.setTitle(fence, {
			title: "Stale write",
			source: "user",
			trigger: "manual-rename",
		})).toThrowError(/owner fenced/iu);
		store.database().close();
	});

	it("rejects a late auto completion after user rename and after owner takeover", () => {
		const store = openStore();
		const owned = createOwnedSession(store, "title-late-auto");
		const fence = { sessionId: owned.sessionId, runtimeId: owned.runtimeId, generation: owned.generation };
		store.setTitle(fence, { title: "Manual winner", source: "user", trigger: "manual-rename" });

		expect(() => store.setTitle(fence, {
			title: "Late generated title",
			source: "auto",
			trigger: "retry",
			expectedTitle: null,
		})).toThrowError(/title|auto/iu);

		store.database().runSync(
			"UPDATE session_owners SET runtime_id = ?, generation = 2, state = 'running' WHERE session_id = ?",
			[createRuntimeId("runtime", "title-late-auto-new"), owned.sessionId],
		);
		expect(() => store.setTitle(fence, {
			title: "Old generation title",
			source: "auto",
			trigger: "retry",
			expectedTitle: null,
		})).toThrowError(/owner fenced/iu);
		expect(store.getSession(owned.sessionId)).toMatchObject({ title: "Manual winner", titleSource: "user" });
		store.database().close();
	});

	it("uses a catalog revision CAS for title mutation and rejects corrupt title event payloads", () => {
		const store = openStore();
		const owned = createOwnedSession(store, "title-revision-cas");
		const fence = { sessionId: owned.sessionId, runtimeId: owned.runtimeId, generation: owned.generation };
		const revision = store.catalogRevision();
		store.setTitle(fence, {
			title: "Revision guarded title",
			source: "user",
			trigger: "manual-rename",
			expectedCatalogRevision: revision,
		});
		expect(store.catalogRevision()).toBe(revision + 1);
		expect(() => store.setTitle(fence, {
			title: "Stale catalog title",
			source: "user",
			trigger: "manual-rename",
			expectedCatalogRevision: revision,
		})).toThrowError(/catalog revision/iu);

		const corrupt = createOwnedSession(store, "title-corrupt-payload");
		store.appendEvent({ sessionId: corrupt.sessionId, runtimeId: corrupt.runtimeId, generation: corrupt.generation }, {
			eventId: createRuntimeId("event", "raw-title-corrupt"),
			ownerGeneration: corrupt.generation,
			eventType: "session.title_changed",
			payloadJson: "{not-json",
			createdAtMs: 2,
			expectedPreviousEventHash: null,
		});
		expect(() => store.rebuildFromEvents(corrupt.sessionId)).toThrowError(/invalid title event payload|projection/iu);
		store.database().close();
	});

	it("replays title state from events and fails closed on row/event drift", () => {
		const store = openStore();
		const owned = createOwnedSession(store);
		const fence = { sessionId: owned.sessionId, runtimeId: owned.runtimeId, generation: owned.generation };
		const titled = store.setTitle(fence, {
			title: "Replay the session title",
			source: "auto",
			trigger: "first-user-message",
			expectedTitle: null,
		});

		expect(store.rebuildFromEvents(owned.sessionId)).toMatchObject({
			title: titled.title,
			titleSource: "auto",
			titleUpdatedAtMs: titled.titleUpdatedAtMs,
		});

		store.database().runSync(
			"UPDATE sessions SET title = ?, title_source = ?, title_updated_at_ms = ? WHERE session_id = ?",
			["Drifted row", "user", titled.titleUpdatedAtMs, owned.sessionId],
		);
		expect(() => store.projectSession(owned.sessionId)).toThrowError(/projection|drift/iu);
		store.database().close();
	});

	it("requires the unnamed CAS marker for auto events and rejects oversize title payloads", () => {
		const store = openStore();
		const missingCas = createOwnedSession(store, "title-missing-cas");
		appendRawTitleEvent(store, missingCas, { title: "Missing CAS marker", source: "auto" });
		expect(() => store.rebuildFromEvents(missingCas.sessionId)).toThrowError(/expectedTitle|projection/iu);

		const oversize = createOwnedSession(store, "title-oversize");
		appendRawTitleEvent(store, oversize, { title: "x".repeat(161), source: "user" });
		expect(() => store.rebuildFromEvents(oversize.sessionId)).toThrowError(/invalid title state|projection/iu);
		store.database().close();
	});

	it("copies title state and title event history into a fork without changing identity", () => {
		const store = openStore();
		const source = createOwnedSession(store, "title-fork-source");
		const fence = { sessionId: source.sessionId, runtimeId: source.runtimeId, generation: source.generation };
		const titled = store.setTitle(fence, {
			title: "Fork this named session",
			source: "auto",
			trigger: "first-user-message",
			expectedTitle: null,
		});
		const forkId = createRuntimeId("session", "title-fork-target");
		const forked = store.forkSession({
			sessionId: forkId,
			sourceSessionId: source.sessionId,
			workspaceId: createRuntimeId("workspace", "title-fork-target"),
			repositoryId: createRuntimeId("repository", "title-fork-target"),
			settingsDigest: "d".repeat(64),
		});

		expect(forked.sessionId).not.toBe(source.sessionId);
		expect(forked).toMatchObject({
			title: titled.title,
			titleSource: "auto",
			titleUpdatedAtMs: titled.titleUpdatedAtMs,
		});
		expect(store.replaySessionEvents(forkId).map((event) => JSON.parse(event.payloadJson))).toEqual(
			store.replaySessionEvents(source.sessionId).map((event) => JSON.parse(event.payloadJson)),
		);
		expect(store.rebuildFromEvents(forkId)).toMatchObject({ title: titled.title, titleSource: "auto" });
		store.database().close();
	});

	it("keeps catalog revisions durable across forked title history and draft reclamation", () => {
		const store = openStore();
		const source = createOwnedSession(store, "title-revision-source");
		const fence = { sessionId: source.sessionId, runtimeId: source.runtimeId, generation: source.generation };
		store.setTitle(fence, { title: "Stable revision", source: "auto", trigger: "first-user-message", expectedTitle: null });

		const beforeFork = store.catalogRevision();
		store.forkSession({
			sessionId: createRuntimeId("session", "title-revision-fork"),
			sourceSessionId: source.sessionId,
			workspaceId: createRuntimeId("workspace", "title-revision-fork"),
			repositoryId: createRuntimeId("repository", "title-revision-fork"),
			settingsDigest: "d".repeat(64),
		});
		const afterFork = store.catalogRevision();
		expect(afterFork).toBe(beforeFork + 1);

		const draft = createOwnedSession(store, "title-revision-draft");
		const draftFence = { sessionId: draft.sessionId, runtimeId: draft.runtimeId, generation: draft.generation };
		new OwnerStore(store.database()).releaseOwner(draftFence, "paused");
		const beforeReclaim = store.catalogRevision();
		expect(store.reclaimSessionWithoutUserMessages(draftFence)).toBe(true);
		expect(store.catalogRevision()).toBe(beforeReclaim + 1);
		store.database().close();
	});
});
