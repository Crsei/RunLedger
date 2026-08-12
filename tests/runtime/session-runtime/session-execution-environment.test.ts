import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import {
	createLocalSessionProcessLeaf,
	createLocalSessionToolchainProbe,
} from "../../../src/security/integration/session-local-leaves.ts";
import { createSessionSecurity } from "../../../src/security/session-composition.ts";
import {
	buildGovernedProcessEnvironment,
	resolveSessionToolchainSnapshot,
	validateSessionToolchainSnapshot,
	type SessionToolchainProbe,
} from "../../../src/security/toolchain.ts";

function probe(overrides: Partial<SessionToolchainProbe> = {}): SessionToolchainProbe {
	const files: Record<string, { readonly canonicalPath: string; readonly bytes: string; readonly inode: number }> = {
		"/runtime/bin/node": { canonicalPath: "/runtime/bin/node", bytes: "node-v22", inode: 1 },
		"/runtime/bin/npm": { canonicalPath: "/runtime/lib/npm/bin/npm-cli.js", bytes: "npm-v10", inode: 2 },
		"/runtime/bin/bun": { canonicalPath: "/runtime/lib/bun-runtime/bin/bun", bytes: "bun-current", inode: 3 },
		"/repo/package.json": { canonicalPath: "/repo/package.json", bytes: JSON.stringify({ engines: { node: ">=22.19.0", bun: ">=1.3.0" } }), inode: 4 },
	};
	return {
		which: async (program) => `/runtime/bin/${program}`,
		realpath: async (path) => files[path]?.canonicalPath,
		readFile: async (path) => {
			const value = files[path] ?? Object.values(files).find((candidate) => candidate.canonicalPath === path);
			if (value === undefined) throw new Error(`missing ${path}`);
			return Buffer.from(value.bytes);
		},
		stat: async (path) => {
			const value = files[path] ?? Object.values(files).find((candidate) => candidate.canonicalPath === path);
			if (value === undefined) throw new Error(`missing ${path}`);
			return { device: 1, inode: value.inode, size: Buffer.byteLength(value.bytes), mtimeMs: 100 + value.inode };
		},
		run: async (program, args) => {
			if (program === "/runtime/bin/node" && args.length === 1) return { exitCode: 0, stdout: "v22.23.1\n", stderr: "" };
			if (program === "/runtime/bin/node" && args[0] === "/runtime/lib/npm/bin/npm-cli.js") return { exitCode: 0, stdout: "10.9.8\n", stderr: "" };
			if (program === "/runtime/lib/bun-runtime/bin/bun" && args[0] === "--version") return { exitCode: 0, stdout: "1.3.14\n", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "unexpected probe" };
		},
		...overrides,
	};
}

describe("Session governed toolchain and process environment", () => {
	it("resolves Node from the attested PATH instead of assuming the CLI runtime is Node", async () => {
		const requested: string[] = [];
		const result = await resolveSessionToolchainSnapshot({
			packageRoot: "/repo",
			workspaceRoot: "/workspace",
			probe: probe({
				which: async (program) => {
					requested.push(program);
					return `/runtime/bin/${program}`;
				},
			}),
		});
		expect(result).toMatchObject({ ok: true, value: { node: { launchPath: "/runtime/bin/node", version: "22.23.1" } } });
		expect(requested).toEqual(["node", "npm", "bun"]);
	});

	it("attests Node npm Bun and rejects identity drift before spawn", async () => {
		const resolved = await resolveSessionToolchainSnapshot({
			packageRoot: "/repo",
			workspaceRoot: "/workspace",
			nodeExecutable: "/runtime/bin/node",
			probe: probe(),
		});
		expect(resolved).toMatchObject({
			ok: true,
			value: {
				node: { version: "22.23.1", canonicalPath: "/runtime/bin/node" },
				npm: { version: "10.9.8", canonicalPath: "/runtime/lib/npm/bin/npm-cli.js" },
				bun: { version: "1.3.14", canonicalPath: "/runtime/lib/bun-runtime/bin/bun" },
				packageBinDirectory: "/workspace/node_modules/.bin",
				snapshotDigest: { algorithm: "sha256", digest: expect.stringMatching(/^[a-f0-9]{64}$/u) },
			},
		});
		if (!resolved.ok) return;
		await expect(validateSessionToolchainSnapshot(resolved.value, probe())).resolves.toEqual({ ok: true, value: undefined });
		await expect(validateSessionToolchainSnapshot(resolved.value, probe({
			stat: async (path) => ({ device: 1, inode: path.includes("node") ? 99 : 2, size: 8, mtimeMs: 101 }),
		}))).resolves.toMatchObject({ ok: false, error: { code: "toolchain_identity_drift" } });
	});

	it("builds a minimal environment and rejects reserved or secret overrides", async () => {
		const resolved = await resolveSessionToolchainSnapshot({ packageRoot: "/repo", workspaceRoot: "/workspace", nodeExecutable: "/runtime/bin/node", probe: probe() });
		if (!resolved.ok) throw new Error(resolved.error.message);
		const built = buildGovernedProcessEnvironment({
			sessionId: "session_environment",
			toolchain: resolved.value,
			inherited: { TERM: "xterm-256color", LANG: "C.UTF-8", API_KEY: "must-not-leak", HTTPS_PROXY: "must-not-leak" },
			temporaryRoot: "/tmp",
		});
		expect(built).toMatchObject({
			ok: true,
			value: {
				environment: {
					HOME: expect.stringMatching(/^\/tmp\/runledger-[a-f0-9]{16}\/home$/u),
					USER: "runledger",
					LOGNAME: "runledger",
					SHELL: "/bin/sh",
					TERM: "xterm-256color",
					LANG: "C.UTF-8",
					PATH: "/workspace/node_modules/.bin:/runtime/bin:/usr/bin:/bin",
				},
				environmentDigest: { digest: expect.stringMatching(/^[a-f0-9]{64}$/u) },
			},
		});
		expect(JSON.stringify(built)).not.toMatch(/must-not-leak|API_KEY|HTTPS_PROXY/u);
		expect(buildGovernedProcessEnvironment({
			sessionId: "session_environment",
			toolchain: resolved.value,
			temporaryRoot: "/tmp",
			overrides: { HOME: "/home/escape" },
		})).toMatchObject({ ok: false, error: { code: "reserved_environment_key" } });
		expect(buildGovernedProcessEnvironment({
			sessionId: "session_environment",
			toolchain: resolved.value,
			temporaryRoot: "/tmp",
			overrides: { SERVICE_TOKEN: "secret" },
		})).toMatchObject({ ok: false, error: { code: "environment_key_denied" } });
	});

	it("fails closed when the package engine requires a newer Node", async () => {
		const result = await resolveSessionToolchainSnapshot({
			packageRoot: "/repo",
			workspaceRoot: "/workspace",
			nodeExecutable: "/runtime/bin/node",
			probe: probe({
				readFile: async (path) => path === "/repo/package.json"
					? Buffer.from(JSON.stringify({ engines: { node: ">=23.0.0", bun: ">=1.3.0" } }))
					: probe().readFile(path),
			}),
		});
		expect(result).toMatchObject({ ok: false, error: { code: "toolchain_version_unsupported" } });
	});

	it("treats the immutable launch plan as the complete child environment", async () => {
		const secretKey = "RUNLEDGER_TEST_PARENT_SECRET";
		const previous = process.env[secretKey];
		process.env[secretKey] = "must-not-leak";
		try {
			const policyDigest = runtimeDigest("policy");
			const requestDigest = runtimeDigest("request");
			const result = await createLocalSessionProcessLeaf().execute({
				backendId: "off",
				requested: "danger-full-access",
				resolved: "danger-full-access",
				effective: "danger-full-access",
				enforcement: "off",
				policyDigest,
				requestDigest,
				planDigest: runtimeDigest("plan"),
				program: process.execPath,
				arguments: ["-e", `process.stdout.write(JSON.stringify({ governed: process.env.GOVERNED_ONLY, leaked: process.env.${secretKey} }))`],
				command: "environment probe",
				cwd: process.cwd(),
				environment: { GOVERNED_ONLY: "yes" },
				timeoutMs: 5_000,
				workspaceRoot: process.cwd(),
				readRoots: [],
				writeRoots: [],
				denyRead: [],
				protectedPaths: [],
				network: "deny",
			});
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({ governed: "yes" });
		} finally {
			if (previous === undefined) delete process.env[secretKey];
			else process.env[secretKey] = previous;
		}
	});

	it("runs the attested local toolchain with stable identity and no ambient secrets", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-governed-toolchain-"));
		const home = join(root, "home");
		await mkdir(home, { recursive: true, mode: 0o700 });
		const secretKey = "RUNLEDGER_TEST_PARENT_SECRET";
		const previous = process.env[secretKey];
		process.env[secretKey] = "must-not-leak";
		try {
			const toolchainProbe = createLocalSessionToolchainProbe();
			const toolchain = await resolveSessionToolchainSnapshot({
				packageRoot: process.cwd(),
				workspaceRoot: process.cwd(),
				nodeExecutable: process.execPath,
				probe: toolchainProbe,
			});
			if (!toolchain.ok) throw new Error(toolchain.error.message);
			const governed = buildGovernedProcessEnvironment({
				sessionId: "session_real_toolchain",
				toolchain: toolchain.value,
				temporaryRoot: join(home, "tmp"),
				inherited: { TERM: "xterm-256color", HTTPS_PROXY: "must-not-leak", [secretKey]: "must-not-leak" },
			});
			if (!governed.ok) throw new Error(governed.error.message);
			const security = await createSessionSecurity({
				layout: buildRunledgerLayout(home, "posix"),
				cwd: process.cwd(),
				fence: {
					sessionId: createRuntimeId("session", "real-toolchain"),
					runtimeId: createRuntimeId("runtime", "real-toolchain"),
					generation: 1,
				},
				workspaceId: createRuntimeId("workspace", "real-toolchain"),
				repositoryId: createRuntimeId("repository", "real-toolchain"),
				securitySources: [{
					source: "cli",
					read: async () => ({ status: "available", text: JSON.stringify({ profile: "danger-full-access", approvalPolicy: "never", sandbox: "off" }) }),
				}],
				toolchain: toolchain.value,
				processEnvironment: governed.value,
				toolchainProbe,
			});
			const result = await security.executionEnv.shell.exec([
				'printf "node=%s\\n" "$(node --version)"',
				'printf "npm=%s\\n" "$(npm --version)"',
				'printf "bun=%s\\n" "$(bun --version)"',
				'printf "tsx=%s\\n" "$(tsx --version | head -n 1)"',
				'printf "node_path=%s\\n" "$(command -v node)"',
				'printf "tsx_path=%s\\n" "$(command -v tsx)"',
				'printf "home=%s\\nuser=%s\\npath=%s\\nsecret=%s\\nproxy=%s\\n" "$HOME" "$USER" "$PATH" "${RUNLEDGER_TEST_PARENT_SECRET-unset}" "${HTTPS_PROXY-unset}"',
			].join("; "));
			expect(result.exitCode).toBe(0);
			const values = Object.fromEntries(result.stdout.trim().split("\n").map((line) => line.split(/=(.*)/su).slice(0, 2)));
			expect(values).toMatchObject({
				node: `v${toolchain.value.node.version}`,
				npm: toolchain.value.npm.version,
				bun: toolchain.value.bun.version,
				node_path: toolchain.value.node.launchPath,
				tsx_path: join(process.cwd(), "node_modules", ".bin", "tsx"),
				home: governed.value.environment.HOME,
				user: "runledger",
				path: governed.value.environment.PATH,
				secret: "unset",
				proxy: "unset",
			});
			expect(values.tsx).toMatch(/^tsx v\d+\.\d+\.\d+$/u);
		} finally {
			if (previous === undefined) delete process.env[secretKey];
			else process.env[secretKey] = previous;
			await rm(root, { recursive: true, force: true });
		}
	});
});
