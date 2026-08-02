import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	RunledgerHomeError,
	resolveRunledgerHome,
} from "../../src/storage/runledger-home.ts";

describe("resolveRunledgerHome", () => {
	it("derives the default user home without creating files or falling back to cwd", async () => {
		const result = await resolveRunledgerHome({
			env: {},
			userHome: "/home/alice",
			pathFlavor: "posix",
		});

		expect(result.resolution).toEqual({
			ok: true,
			runledgerHome: "/home/alice/.runledger",
			source: "default",
			createDefault: true,
		});
		expect(result.layout.sessions).toBe("/home/alice/.runledger/sessions");
	});

	it("uses a verified RUNLEDGER_DIR canonical path", async () => {
		const result = await resolveRunledgerHome({
			env: { RUNLEDGER_DIR: "/srv/runledger" },
			userHome: "/home/alice",
			pathFlavor: "posix",
			probeOverride: () => ({
				rawValue: "/srv/runledger",
				state: "directory",
				canonicalPath: "/srv/runledger-real",
			}),
		});

		expect(result.resolution).toEqual({
			ok: true,
			runledgerHome: "/srv/runledger-real",
			source: "override",
			createDefault: false,
		});
		expect(result.layout.home).toBe("/srv/runledger-real");
	});

	it("probes a real existing override without creating a home", async () => {
		const existing = await mkdtemp(join(tmpdir(), "runledger-home-"));
		try {
			const result = await resolveRunledgerHome({
				env: { RUNLEDGER_DIR: existing },
				userHome: "/home/alice",
				pathFlavor: "posix",
			});
			expect(result.resolution).toMatchObject({ ok: true, source: "override", createDefault: false });
			expect(result.layout.home).toBe(existing);
		} finally {
			await rm(existing, { recursive: true, force: true });
		}
	});

	it("fails closed for an invalid override instead of falling back", async () => {
		await expect(resolveRunledgerHome({
			env: { RUNLEDGER_DIR: "relative/home" },
			userHome: "/home/alice",
			pathFlavor: "posix",
			probeOverride: () => ({
				rawValue: "relative/home",
				state: "directory",
				canonicalPath: "/tmp/should-not-be-used",
			}),
		})).rejects.toMatchObject<RunledgerHomeError>({ code: "override_not_absolute" });

		await expect(resolveRunledgerHome({
			env: { RUNLEDGER_DIR: "/missing" },
			userHome: "/home/alice",
			pathFlavor: "posix",
			probeOverride: () => ({ rawValue: "/missing", state: "missing" }),
		})).rejects.toMatchObject<RunledgerHomeError>({ code: "override_missing" });
	});

	it("does not accept an empty override as an invitation to use the default", async () => {
		await expect(resolveRunledgerHome({
			env: { RUNLEDGER_DIR: "" },
			userHome: "/home/alice",
			pathFlavor: "posix",
			probeOverride: () => ({ rawValue: "", state: "missing" }),
		})).rejects.toMatchObject<RunledgerHomeError>({ code: "override_empty" });
	});
});
