import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import * as auditModule from "../../scripts/runtime-host-audit.ts";

const execFileAsync = promisify(execFile);

describe("runtime Host audit evidence", () => {
	it("provides the audit evidence module", () => {
		const modulePath = fileURLToPath(new URL("../../scripts/runtime-host-audit.ts", import.meta.url));
		expect(existsSync(modulePath)).toBe(true);
	});

	it("binds tracked and untracked candidate bytes without exposing an absolute repository path", async () => {
		expect(typeof auditModule.collectCandidateSnapshot).toBe("function");
		const root = await mkdtemp(join(tmpdir(), "runledger-audit-candidate-"));
		try {
			await git(root, "init");
			await git(root, "config", "user.name", "RunLedger Test");
			await git(root, "config", "user.email", "runledger@example.invalid");
			await writeFile(join(root, "tracked.txt"), "one\n", "utf8");
			await git(root, "add", "--", "tracked.txt");
			await git(root, "commit", "-m", "fixture");
			await writeFile(join(root, "tracked.txt"), "two\n", "utf8");
			await writeFile(join(root, "untracked.txt"), "secret-candidate-byte\n", "utf8");

			const first = await auditModule.collectCandidateSnapshot(root);
			expect(first.head).toMatch(/^[a-f0-9]{40}$/u);
			expect(first.trackedPatchSha256).toMatch(/^[a-f0-9]{64}$/u);
			expect(first.untracked).toEqual([{ path: "untracked.txt", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }]);
			expect(first.candidateDigest).toMatch(/^[a-f0-9]{64}$/u);
			expect(JSON.stringify(first)).not.toContain(root);

			await writeFile(join(root, "untracked.txt"), "changed\n", "utf8");
			const second = await auditModule.collectCandidateSnapshot(root);
			expect(second.candidateDigest).not.toBe(first.candidateDigest);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reduces command output to digests and machine-readable verifier checks", () => {
		expect(typeof auditModule.summarizeGateExecution).toBe("function");
		const evidence = auditModule.summarizeGateExecution({
			id: "verify_multi_client_host",
			command: ["npm", "run", "verify:multi-client-host"],
			exitCode: 0,
			durationMs: 123,
			stdout: Buffer.from('{"outcome":"pass","checks":["two_clients_one_host"]}\n/private/output/path\n'),
			stderr: Buffer.from("credential=do-not-store"),
			verifier: { outcome: "pass", checks: ["two_clients_one_host"] },
		});
		expect(evidence).toMatchObject({
			id: "verify_multi_client_host",
			command: ["npm", "run", "verify:multi-client-host"],
			outcome: "pass",
			exitCode: 0,
			durationMs: 123,
			checks: ["two_clients_one_host"],
		});
		expect(evidence.stdoutSha256).toMatch(/^[a-f0-9]{64}$/u);
		expect(evidence.stderrSha256).toMatch(/^[a-f0-9]{64}$/u);
		const encoded = JSON.stringify(evidence);
		expect(encoded).not.toContain("/private/output/path");
		expect(encoded).not.toContain("do-not-store");
	});

	it("defines the ordered closure gates including focused TUI and both production runners", () => {
		expect(auditModule.RUNTIME_HOST_AUDIT_GATES.map((gate) => gate.id)).toEqual([
			"focused_host_process",
			"focused_tui_process",
			"check",
			"test",
			"build",
			"verify_multi_client_host",
			"verify_managed_process_pty",
			"diff_check",
		]);
	});

	it("writes a redacted manifest and fails closed when the candidate changes during a gate", async () => {
		expect(typeof auditModule.runRuntimeHostAudit).toBe("function");
		const root = await mkdtemp(join(tmpdir(), "runledger-audit-run-"));
		const output = await mkdtemp(join(tmpdir(), "runledger-audit-evidence-"));
		try {
			await git(root, "init");
			await git(root, "config", "user.name", "RunLedger Test");
			await git(root, "config", "user.email", "runledger@example.invalid");
			await writeFile(join(root, "tracked.txt"), "stable\n", "utf8");
			await git(root, "add", "--", "tracked.txt");
			await git(root, "commit", "-m", "fixture");
			await mkdir(join(output, "pass"));
			const passed = await auditModule.runRuntimeHostAudit({
				repositoryRoot: root,
				outputDirectory: join(output, "pass"),
				environment: { platform: "linux", arch: "x64", node: "v-test", npm: "test", bun: "test" },
				gates: [{
					id: "verifier",
					command: [process.execPath, "-e", "process.stdout.write(JSON.stringify({outcome:'pass',checks:['safe_check']})+'\\n/private/raw-output')"],
					verifier: true,
				}],
			});
			expect(passed.exitCode).toBe(0);
			expect(passed.manifest).toMatchObject({ format: "runtime-host-audit", outcome: "pass", candidateStable: true });
			expect(passed.manifest.gates[0]).toMatchObject({ outcome: "pass", checks: ["safe_check"] });
			const manifestText = await readFile(passed.manifestPath, "utf8");
			expect(manifestText).not.toContain(root);
			expect(manifestText).not.toContain("/private/raw-output");
			if (process.platform !== "win32") expect((await stat(passed.manifestPath)).mode & 0o777).toBe(0o600);

			await mkdir(join(output, "changed"));
			const changed = await auditModule.runRuntimeHostAudit({
				repositoryRoot: root,
				outputDirectory: join(output, "changed"),
				environment: { platform: "linux", arch: "x64", node: "v-test", npm: "test", bun: "test" },
				gates: [{
					id: "changes_candidate",
					command: [process.execPath, "-e", "require('node:fs').writeFileSync('tracked.txt','changed\\n')"],
				}],
			});
			expect(changed.exitCode).toBe(1);
			expect(changed.manifest).toMatchObject({ outcome: "fail", candidateStable: false, failureCode: "candidate_changed" });
		} finally {
			await Promise.all([rm(root, { recursive: true, force: true }), rm(output, { recursive: true, force: true })]);
		}
	});

	it("exposes the audit CLI contract without running gates for help", () => {
		const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-runtime-host-audit.ts", "--help"], {
			cwd: process.cwd(),
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("verify-runtime-host-audit --output <existing-absolute-dir>");
	});

	it("registers the audit runner as the canonical npm command", async () => {
		const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { scripts?: Record<string, string> };
		expect(packageJson.scripts?.["verify:runtime-host-audit"]).toBe("tsx scripts/verify-runtime-host-audit.ts");
	});
});

async function git(cwd: string, ...args: string[]): Promise<void> {
	await execFileAsync("git", args, { cwd });
}
