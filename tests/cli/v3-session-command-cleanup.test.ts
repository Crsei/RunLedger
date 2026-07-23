import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const migrationCore = vi.hoisted(() => ({ failure: undefined as Error | undefined }));

vi.mock("../../src/runtime/session/legacy-migration.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/runtime/session/legacy-migration.ts")>();
	return {
		...actual,
		migrateLegacySessionToV3: async (
			...args: Parameters<typeof actual.migrateLegacySessionToV3>
		): ReturnType<typeof actual.migrateLegacySessionToV3> => {
			if (migrationCore.failure) throw migrationCore.failure;
			return actual.migrateLegacySessionToV3(...args);
		},
	};
});

import { forkV3FromCli, migrateLegacyFromCli } from "../../src/cli/v3-session-commands.ts";
import { DEFAULT_RUNTIME_FEATURES, type RuntimeFeatureFlags } from "../../src/runtime/runtime-features.ts";
import { V3SessionManager } from "../../src/storage/v3-session-manager.ts";

const FLAGS: RuntimeFeatureFlags = { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true };
const roots: string[] = [];
const managers = new Set<V3SessionManager>();

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "runledger-v3-cli-cleanup-"));
	roots.push(root);
	return root;
}

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
	try {
		await operation;
	} catch (cause) {
		if (cause instanceof Error) return cause;
		throw new Error("operation rejected with a non-Error value");
	}
	throw new Error("operation unexpectedly resolved");
}

async function createClosedParent(root: string, sessionDir: string): Promise<string> {
	const parent = await V3SessionManager.create({ cwd: root, sessionDir, features: FLAGS });
	await parent.sessionEvents().recordMessage({
		role: "user",
		content: [{ type: "text", text: "copy me" }],
	});
	const filePath = parent.filePath();
	await parent.closeAll();
	return filePath;
}

async function expectReopenable(filePath: string): Promise<void> {
	const reopened = await V3SessionManager.open(filePath, FLAGS);
	managers.add(reopened);
	expect(reopened.filePath()).toBe(filePath);
	await reopened.closeAll();
}

afterEach(async () => {
	migrationCore.failure = undefined;
	vi.restoreAllMocks();
	await Promise.allSettled([...managers].map((manager) => manager.closeAll()));
	managers.clear();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CLI v3 session command cleanup", () => {
	it("discards and closes a new empty migration target when the migration core throws", async () => {
		const root = temporaryRoot();
		const realCreate = V3SessionManager.create.bind(V3SessionManager);
		let target: V3SessionManager | undefined;
		vi.spyOn(V3SessionManager, "create").mockImplementation(async (options) => {
			target = await realCreate(options);
			managers.add(target);
			return target;
		});
		migrationCore.failure = new Error("migration core exploded");

		const error = await rejectedError(migrateLegacyFromCli({
			sourcePath: join(root, "legacy.jsonl"),
			mode: "migrate",
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		}));

		expect(target).toBeDefined();
		expect(error.message).toContain("migration core exploded");
		expect(error.message).toContain(`target=${target!.filePath()}`);
		expect(target!.isClosed()).toBe(true);
		expect(existsSync(target!.filePath())).toBe(false);
	});

	it("reports both migration and cleanup failures without leaking the writer", async () => {
		const root = temporaryRoot();
		const realCreate = V3SessionManager.create.bind(V3SessionManager);
		const coreFailure = new Error("migration core exploded");
		const cleanupFailure = new Error("migration target cleanup exploded");
		let target: V3SessionManager | undefined;
		vi.spyOn(V3SessionManager, "create").mockImplementation(async (options) => {
			target = await realCreate(options);
			managers.add(target);
			const discard = target.discardEmptyTarget.bind(target);
			vi.spyOn(target, "discardEmptyTarget").mockImplementation(async () => {
				await discard();
				throw cleanupFailure;
			});
			return target;
		});
		migrationCore.failure = coreFailure;

		const error = await rejectedError(migrateLegacyFromCli({
			sourcePath: join(root, "legacy.jsonl"),
			mode: "migrate",
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		}));

		expect(error).toBeInstanceOf(AggregateError);
		expect(error.message).toContain(`target=${target!.filePath()}`);
		expect((error as AggregateError).errors.map(String).join("\n")).toContain("migration core exploded");
		expect((error as AggregateError).errors.map(String).join("\n")).toContain("migration target cleanup exploded");
		expect(target!.isClosed()).toBe(true);
	});

	it("removes an unpublished fork child and closes its parent when replay throws", async () => {
		const root = temporaryRoot();
		const sessionDir = join(root, "sessions");
		const parentPath = await createClosedParent(root, sessionDir);
		const realCreate = V3SessionManager.create.bind(V3SessionManager);
		let child: V3SessionManager | undefined;
		vi.spyOn(V3SessionManager, "create").mockImplementation(async (options) => {
			child = await realCreate(options);
			managers.add(child);
			return child;
		});
		vi.spyOn(V3SessionManager.prototype, "replayMessages")
			.mockRejectedValueOnce(new Error("fork replay exploded"));

		const error = await rejectedError(forkV3FromCli({
			sourcePath: parentPath,
			cwd: root,
			sessionDir,
			features: FLAGS,
		}));

		expect(child).toBeDefined();
		expect(error.message).toContain("fork replay exploded");
		expect(error.message).toContain(`child=${child!.filePath()}`);
		expect(error.message).toContain("cleanup=cleaned");
		expect(child!.writer().currentHead()).toBeDefined();
		expect(child!.isClosed()).toBe(true);
		expect(existsSync(child!.filePath())).toBe(false);
		vi.restoreAllMocks();
		await expectReopenable(parentPath);
	});

	it("removes an unpublished fork child and closes its parent when history copy throws", async () => {
		const root = temporaryRoot();
		const sessionDir = join(root, "sessions");
		const parentPath = await createClosedParent(root, sessionDir);
		const realCreate = V3SessionManager.create.bind(V3SessionManager);
		let child: V3SessionManager | undefined;
		vi.spyOn(V3SessionManager, "create").mockImplementation(async (options) => {
			child = await realCreate(options);
			managers.add(child);
			vi.spyOn(child.sessionEvents(), "recordMessage")
				.mockRejectedValueOnce(new Error("fork copy exploded"));
			return child;
		});

		const error = await rejectedError(forkV3FromCli({
			sourcePath: parentPath,
			cwd: root,
			sessionDir,
			features: FLAGS,
		}));

		expect(child).toBeDefined();
		expect(error.message).toContain("fork copy exploded");
		expect(error.message).toContain(`child=${child!.filePath()}`);
		expect(error.message).toContain("cleanup=cleaned");
		expect(child!.writer().currentHead()).toBeDefined();
		expect(child!.isClosed()).toBe(true);
		expect(existsSync(child!.filePath())).toBe(false);
		vi.restoreAllMocks();
		await expectReopenable(parentPath);
	});

	it("aggregates a fork failure with child cleanup failure and still closes the parent", async () => {
		const root = temporaryRoot();
		const sessionDir = join(root, "sessions");
		const parentPath = await createClosedParent(root, sessionDir);
		const realCreate = V3SessionManager.create.bind(V3SessionManager);
		const cleanupFailure = new Error("fork child cleanup exploded");
		let child: V3SessionManager | undefined;
		vi.spyOn(V3SessionManager, "create").mockImplementation(async (options) => {
			child = await realCreate(options);
			managers.add(child);
			const close = child.closeAll.bind(child);
			vi.spyOn(child, "closeAll").mockImplementation(async () => {
				await close();
				throw cleanupFailure;
			});
			return child;
		});
		vi.spyOn(V3SessionManager.prototype, "replayMessages")
			.mockRejectedValueOnce(new Error("fork replay exploded"));

		const error = await rejectedError(forkV3FromCli({
			sourcePath: parentPath,
			cwd: root,
			sessionDir,
			features: FLAGS,
		}));

		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors.map(String).join("\n")).toContain("fork replay exploded");
		expect((error as AggregateError).errors.map(String).join("\n")).toContain("fork child cleanup exploded");
		expect(child!.isClosed()).toBe(true);
		expect(existsSync(child!.filePath())).toBe(false);
		vi.restoreAllMocks();
		await expectReopenable(parentPath);
	});
});
