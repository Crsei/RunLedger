/** P5 locator 只读审计测试：fixture migration 分类，绝不产生写入。 */

import { describe, expect, it } from "vitest";
import { auditLocatorCollection, auditLocatorRecord } from "../../src/workspace/locator-audit.ts";

const CURRENT = JSON.stringify({ version: 1, platform: "linux", kind: "posix", path: "/home/user/.runledger/state/worktrees/managed/repo/task" });

describe("auditLocatorRecord: read-only classification", () => {
	it("classifies a current version-1 record without rewriting it", () => {
		const verdict = auditLocatorRecord("current.json", CURRENT);
		expect(verdict.verdict).toEqual({ status: "current", record: { version: 1, platform: "linux", kind: "posix", path: "/home/user/.runledger/state/worktrees/managed/repo/task" } });
	});

	it("marks unversioned legacy native paths as migration_required (never converted)", () => {
		const legacy = JSON.stringify({ platform: "linux", kind: "posix", path: "/home/user/.runledger/state/worktrees/managed/repo/task" });
		expect(auditLocatorRecord("legacy.json", legacy).verdict).toMatchObject({ status: "migration_required" });
	});

	it("marks unknown versions and unknown platforms as migration_required", () => {
		expect(auditLocatorRecord("unknown-version.json", JSON.stringify({ version: 2, platform: "linux", kind: "posix", path: "/x" })).verdict).toMatchObject({ status: "migration_required" });
		expect(auditLocatorRecord("freebsd.json", JSON.stringify({ version: 1, platform: "freebsd", kind: "posix", path: "/x" })).verdict).toMatchObject({ status: "migration_required" });
	});

	it("marks structurally broken records as migration_required without guessing", () => {
		expect(auditLocatorRecord("not-json", "not json").verdict).toMatchObject({ status: "migration_required" });
		expect(auditLocatorRecord("empty.json", "").verdict).toMatchObject({ status: "migration_required" });
	});

	it("marks records whose path is unusable as invalid (never repaired)", () => {
		const relative = JSON.stringify({ version: 1, platform: "linux", kind: "posix", path: "relative/path" });
		expect(auditLocatorRecord("relative.json", relative).verdict).toMatchObject({ status: "invalid" });
		const windowsPosix = JSON.stringify({ version: 1, platform: "windows", kind: "posix", path: "/x" });
		expect(auditLocatorRecord("kind-mismatch.json", windowsPosix).verdict).toMatchObject({ status: "invalid" });
	});
});

describe("auditLocatorCollection", () => {
	it("reports counts and declares read-only semantics", () => {
		const report = auditLocatorCollection([
			{ name: "current.json", content: CURRENT },
			{ name: "legacy.json", content: JSON.stringify({ platform: "linux", kind: "posix", path: "/old" }) },
			{ name: "broken.json", content: "{}" },
		]);
		expect(report.readOnly).toBe(true);
		expect(report.current).toBe(1);
		expect(report.migrationRequired).toBe(2);
		expect(report.invalid).toBe(0);
	});
});
