import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRuntimeBoundaries } from "../../scripts/check-runtime-boundaries.ts";

describe("Runtime contract module boundary", () => {
	it("does not import storage, UI, provider, or raw I/O modules", () => {
		const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
		expect(scanRuntimeBoundaries(repoRoot)).toEqual([]);
	});

	it("scans the current protocol directory", async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), "runledger-boundary-") );
		try {
			const protocolDir = join(repoRoot, "src/runtime/protocol");
			await mkdir(protocolDir, { recursive: true });
			await writeFile(join(protocolDir, "bad.ts"), 'import fs from "node:fs";\n', "utf8");

			expect(scanRuntimeBoundaries(repoRoot)).toEqual([
				{ file: "src/runtime/protocol/bad.ts", reason: "contract module cannot own raw I/O" },
			]);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	it("scans the contract inventory directory", async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), "runledger-boundary-") );
		try {
			const contractsDir = join(repoRoot, "src/runtime/contracts");
			await mkdir(contractsDir, { recursive: true });
			await writeFile(join(contractsDir, "bad.ts"), 'import fs from "node:fs";\n', "utf8");

			expect(scanRuntimeBoundaries(repoRoot)).toEqual([
				{ file: "src/runtime/contracts/bad.ts", reason: "contract module cannot own raw I/O" },
			]);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	it("rejects host-environment reads from contract modules", async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), "runledger-boundary-") );
		try {
			const identityDir = join(repoRoot, "src/runtime/identity");
			await mkdir(identityDir, { recursive: true });
			await writeFile(join(identityDir, "host.ts"), 'import { hostname } from "node:os";\n', "utf8");

			expect(scanRuntimeBoundaries(repoRoot)).toEqual([
				{ file: "src/runtime/identity/host.ts", reason: "contract module cannot read the host environment" },
			]);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	it("allows the audited storage-layout contract but still rejects storage behavior imports", async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), "runledger-boundary-") );
		try {
			const contractsDir = join(repoRoot, "src/runtime/contracts");
			await mkdir(contractsDir, { recursive: true });
			await writeFile(join(contractsDir, "public.ts"), 'export * from "./storage-layout.ts";\n', "utf8");
			await writeFile(join(contractsDir, "storage-layout.ts"), "export const layout = true;\n", "utf8");
			expect(scanRuntimeBoundaries(repoRoot)).toEqual([]);

			await writeFile(join(contractsDir, "bad.ts"), 'import { SessionManager } from "../../storage/session-manager.ts";\n', "utf8");
			expect(scanRuntimeBoundaries(repoRoot)).toEqual([
				{ file: "src/runtime/contracts/bad.ts", reason: "contract module cannot depend on storage/UI/provider" },
			]);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
});
