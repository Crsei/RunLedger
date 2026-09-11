import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shellOnlyHarnessProfileRef } from "../../src/runtime/harness-profiles/resolver.ts";
import { parseArgs } from "../../src/cli/args.ts";
import { resolveSessionId } from "../../src/cli/main.ts";
import { standardHarnessProfileRef } from "../../src/runtime/harness-profiles/index.ts";
import { openSessionDatabase } from "../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../src/storage/session-store/session-store.ts";
import { rmSyncRetry } from "../helpers/cleanup.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSyncRetry(directory);
});

function fixture(): { readonly store: SessionStore; readonly workspace: string } {
	const root = mkdtempSync(join(tmpdir(), "runledger-session-harness-"));
	temporaryDirectories.push(root);
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	const database = openSessionDatabase(join(root, "state.db"));
	installSessionStoreSchema(database);
	return { store: new SessionStore(database), workspace };
}

function args(argv: readonly string[]) {
	const parsed = parseArgs(argv);
	expect(parsed.error).toBeUndefined();
	return parsed.args;
}

describe("CLI harness profile selection", () => {
	it("uses settings only for fresh create, and explicit mode wins", async () => {
		const { store, workspace } = fixture();
		const minimalId = await resolveSessionId(store, args([]), workspace, undefined, "minimal");
		expect(store.getSession(minimalId)?.harnessProfile).toEqual(shellOnlyHarnessProfileRef());
		const standardId = await resolveSessionId(store, args(["--mode", "default"]), workspace, undefined, "minimal");
		expect(store.getSession(standardId)?.harnessProfile).toEqual(standardHarnessProfileRef(2));
		expect(await resolveSessionId(store, args(["--session-id", minimalId]), workspace, undefined, "default")).toBe(minimalId);
		await expect(resolveSessionId(store, args(["--session-id", minimalId, "--mode", "default"]), workspace)).rejects.toThrow("only valid when creating");
		store.database().close();
	});

	it("uses standard by default and freezes an explicit minimal profile on fresh create", async () => {
		const { store, workspace } = fixture();
		const standardId = await resolveSessionId(store, args([]), workspace);
		const minimalId = await resolveSessionId(store, args(["--harness-profile", "minimal"]), workspace);

		expect(store.getSession(standardId)?.harnessProfile).toEqual(standardHarnessProfileRef(2));
		expect(store.getSession(minimalId)?.harnessProfile).toEqual(shellOnlyHarnessProfileRef());
		store.database().close();
	});

	it("rejects a profile flag for open, resume, continue, and fork instead of overriding durable state", async () => {
		const { store, workspace } = fixture();
		const sourceId = await resolveSessionId(store, args(["--harness-profile", "minimal"]), workspace);

		for (const argv of [
			["--session-id", sourceId, "--harness-profile", "standard"],
			["--resume", "--harness-profile", "standard"],
			["--continue", "--harness-profile", "standard"],
			["--fork", sourceId, "--harness-profile", "standard"],
		]) {
			await expect(resolveSessionId(store, args(argv), workspace)).rejects.toThrow("only valid when creating");
		}
		expect(store.getSession(sourceId)?.harnessProfile).toEqual(shellOnlyHarnessProfileRef());
		store.database().close();
	});

	it("forks without a flag by atomically inheriting the source profile", async () => {
		const { store, workspace } = fixture();
		const sourceId = await resolveSessionId(store, args(["--harness-profile", "minimal"]), workspace);
		const forkId = await resolveSessionId(store, args(["--fork", sourceId]), workspace);

		expect(store.getSession(forkId)?.harnessProfile).toEqual(shellOnlyHarnessProfileRef());
		store.database().close();
	});
});
