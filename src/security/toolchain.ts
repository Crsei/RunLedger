/** Session-scoped toolchain attestation 与最小 child environment。 */

import { createHash } from "node:crypto";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { runtimeDigest, type RuntimeDigest, type Sha256Digest } from "../runtime/protocol/foundation.ts";

export interface SessionToolchainFileIdentity {
	readonly device: number;
	readonly inode: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly contentDigest: RuntimeDigest;
}

export interface ExecutableAttestation {
	readonly launchPath: string;
	readonly canonicalPath: string;
	readonly version: string;
	readonly identity: SessionToolchainFileIdentity;
}

export interface SessionToolchainSnapshot {
	readonly node: ExecutableAttestation;
	readonly npm: ExecutableAttestation;
	readonly bun: ExecutableAttestation;
	readonly packageBinDirectory: string;
	readonly packageRoot: string;
	readonly snapshotDigest: RuntimeDigest;
}

export interface SessionToolchainProbe {
	which(program: "npm" | "bun"): Promise<string | undefined>;
	realpath(path: string): Promise<string | undefined>;
	readFile(path: string): Promise<Uint8Array>;
	stat(path: string): Promise<{ readonly device: number; readonly inode: number; readonly size: number; readonly mtimeMs: number }>;
	run(program: string, args: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
}

export type SessionToolchainErrorCode =
	| "toolchain_invalid_request"
	| "toolchain_executable_missing"
	| "toolchain_probe_failed"
	| "toolchain_version_unsupported"
	| "toolchain_identity_drift";

export type SessionToolchainResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: { readonly code: SessionToolchainErrorCode; readonly message: string } };

export interface GovernedProcessEnvironment {
	readonly environment: Readonly<Record<string, string>>;
	readonly environmentDigest: RuntimeDigest;
	readonly privateRoot: string;
}

export type GovernedProcessEnvironmentResult =
	| { readonly ok: true; readonly value: GovernedProcessEnvironment }
	| { readonly ok: false; readonly error: { readonly code: "invalid_environment" | "reserved_environment_key" | "environment_key_denied"; readonly message: string } };

export type GovernedEnvironmentOverridesResult =
	| { readonly ok: true; readonly value: Readonly<Record<string, string>> }
	| { readonly ok: false; readonly error: { readonly code: "invalid_environment" | "reserved_environment_key" | "environment_key_denied"; readonly message: string } };

const SAFE_INHERITED_ENV = new Set(["TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR"]);
const RESERVED_ENV = new Set(["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "XDG_CACHE_HOME", "npm_config_cache"]);
const DENIED_ENV = /(?:^|_)(?:API[_-]?KEY|AUTH|BEARER|COOKIE|CREDENTIAL|PASSWORD|PRIVATE[_-]?KEY|PROXY|SECRET|TOKEN)(?:_|$)/iu;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export async function resolveSessionToolchainSnapshot(input: {
	readonly packageRoot: string;
	readonly workspaceRoot: string;
	readonly nodeExecutable: string;
	readonly probe: SessionToolchainProbe;
}): Promise<SessionToolchainResult<SessionToolchainSnapshot>> {
	if (!isAbsolute(input.packageRoot) || !isAbsolute(input.workspaceRoot) || !isAbsolute(input.nodeExecutable)) {
		return failure("toolchain_invalid_request", "package root, workspace root and Node executable must be absolute");
	}
	const probe = input.probe;
	try {
		const packageRoot = resolve(input.packageRoot);
		const packageJson = parsePackageJson(await probe.readFile(join(packageRoot, "package.json")));
		if (!packageJson.ok) return packageJson;
		const npmPath = await probe.which("npm");
		const bunPath = await probe.which("bun");
		if (npmPath === undefined || bunPath === undefined || !isAbsolute(npmPath) || !isAbsolute(bunPath)) {
			return failure("toolchain_executable_missing", "absolute npm and Bun executables are required");
		}
		const node = await attest(input.nodeExecutable, probe, async (canonical) => probe.run(canonical, ["--version"]));
		if (!node.ok) return node;
		const npm = await attest(npmPath, probe, async (canonical) => probe.run(node.value.canonicalPath, [canonical, "--version"]));
		if (!npm.ok) return npm;
		const bun = await attest(bunPath, probe, async (canonical) => probe.run(canonical, ["--version"]));
		if (!bun.ok) return bun;
		if (!satisfiesMinimum(node.value.version, packageJson.value.node) || !satisfiesMinimum(bun.value.version, packageJson.value.bun)) {
			return failure("toolchain_version_unsupported", `toolchain does not satisfy package engines node=${packageJson.value.node} bun=${packageJson.value.bun}`);
		}
		const body = {
			node: node.value,
			npm: npm.value,
			bun: bun.value,
			packageBinDirectory: join(resolve(input.workspaceRoot), "node_modules", ".bin"),
			packageRoot,
		};
		return { ok: true, value: { ...body, snapshotDigest: runtimeDigest(body) } };
	} catch (error) {
		return failure("toolchain_probe_failed", error instanceof Error ? error.message : "toolchain probe failed");
	}
}

export async function validateSessionToolchainSnapshot(
	snapshot: SessionToolchainSnapshot,
	probe: SessionToolchainProbe,
): Promise<SessionToolchainResult<void>> {
	const { snapshotDigest: _snapshotDigest, ...body } = snapshot;
	if (runtimeDigest(body).digest !== snapshot.snapshotDigest.digest) {
		return failure("toolchain_identity_drift", "toolchain snapshot digest is invalid");
	}
	try {
		for (const executable of [snapshot.node, snapshot.npm, snapshot.bun]) {
			const [canonicalPath, current, bytes] = await Promise.all([
				probe.realpath(executable.launchPath),
				probe.stat(executable.canonicalPath),
				probe.readFile(executable.canonicalPath),
			]);
			const contentDigest = createHash("sha256").update(bytes).digest("hex");
			if (canonicalPath !== executable.canonicalPath || !sameFileIdentity(current, executable.identity) || contentDigest !== executable.identity.contentDigest.digest) {
				return failure("toolchain_identity_drift", `toolchain executable identity changed: ${executable.launchPath}`);
			}
		}
		return { ok: true, value: undefined };
	} catch {
		return failure("toolchain_identity_drift", "toolchain executable identity is unavailable");
	}
}

export function buildGovernedProcessEnvironment(input: {
	readonly sessionId: string;
	readonly toolchain: SessionToolchainSnapshot;
	readonly temporaryRoot: string;
	readonly inherited?: NodeJS.ProcessEnv;
	readonly overrides?: Readonly<Record<string, string>>;
	readonly shellProgram?: string;
}): GovernedProcessEnvironmentResult {
	if (!isAbsolute(input.temporaryRoot) || input.sessionId.length === 0) {
		return environmentFailure("invalid_environment", "temporary root must be absolute and sessionId must be non-empty");
	}
	const validatedOverrides = validateGovernedEnvironmentOverrides(input.overrides ?? {});
	if (!validatedOverrides.ok) return validatedOverrides;
	const override = validatedOverrides.value;
	const privateRoot = join(resolve(input.temporaryRoot), `runledger-${runtimeDigest(input.sessionId).digest.slice(0, 16)}`);
	const inherited = Object.fromEntries(Object.entries(input.inherited ?? {})
		.filter(([key, value]) => SAFE_INHERITED_ENV.has(key) && value !== undefined)) as Record<string, string>;
	const path = unique([
		input.toolchain.packageBinDirectory,
		dirname(input.toolchain.node.launchPath),
		dirname(input.toolchain.npm.launchPath),
		dirname(input.toolchain.bun.launchPath),
		"/usr/bin",
		"/bin",
	]).join(delimiter);
	const environment = Object.freeze({
		...inherited,
		...override,
		HOME: join(privateRoot, "home"),
		TMPDIR: join(privateRoot, "tmp"),
		XDG_CACHE_HOME: join(privateRoot, "cache"),
		npm_config_cache: join(privateRoot, "npm-cache"),
		USER: "runledger",
		LOGNAME: "runledger",
		SHELL: input.shellProgram ?? "/bin/sh",
		PATH: path,
	});
	return { ok: true, value: { environment, environmentDigest: runtimeDigest(environment), privateRoot } };
}

export function validateGovernedEnvironmentOverrides(
	overrides: Readonly<Record<string, string>>,
): GovernedEnvironmentOverridesResult {
	for (const [key, value] of Object.entries(overrides)) {
		if (!ENV_KEY.test(key) || value.includes("\0")) return environmentFailure("invalid_environment", `invalid environment entry: ${key}`);
		if (RESERVED_ENV.has(key)) return environmentFailure("reserved_environment_key", `environment override cannot replace ${key}`);
		if (DENIED_ENV.test(key)) return environmentFailure("environment_key_denied", `environment override is denied: ${key}`);
	}
	return { ok: true, value: Object.freeze({ ...overrides }) };
}

async function attest(
	launchPath: string,
	probe: SessionToolchainProbe,
	versionProbe: (canonicalPath: string) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>,
): Promise<SessionToolchainResult<ExecutableAttestation>> {
	if (!isAbsolute(launchPath)) return failure("toolchain_executable_missing", `toolchain path is not absolute: ${launchPath}`);
	const canonicalPath = await probe.realpath(launchPath);
	if (canonicalPath === undefined || !isAbsolute(canonicalPath)) return failure("toolchain_executable_missing", `toolchain path is unavailable: ${launchPath}`);
	const [bytes, stats, versionResult] = await Promise.all([probe.readFile(canonicalPath), probe.stat(canonicalPath), versionProbe(canonicalPath)]);
	if (versionResult.exitCode !== 0) return failure("toolchain_probe_failed", `toolchain version probe failed for ${launchPath}`);
	const version = normalizeVersion(versionResult.stdout);
	if (version === undefined) return failure("toolchain_probe_failed", `toolchain version is invalid for ${launchPath}`);
	return {
		ok: true,
		value: {
			launchPath: resolve(launchPath),
			canonicalPath,
			version,
			identity: {
				device: stats.device,
				inode: stats.inode,
				size: stats.size,
				mtimeMs: stats.mtimeMs,
				contentDigest: { algorithm: "sha256", digest: createHash("sha256").update(bytes).digest("hex") as Sha256Digest },
			},
		},
	};
}

function parsePackageJson(bytes: Uint8Array): SessionToolchainResult<{ readonly node: string; readonly bun: string }> {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
		if (!isRecord(parsed) || !isRecord(parsed.engines) || typeof parsed.engines.node !== "string" || typeof parsed.engines.bun !== "string") {
			return failure("toolchain_invalid_request", "package engines.node and engines.bun are required");
		}
		return { ok: true, value: { node: parsed.engines.node, bun: parsed.engines.bun } };
	} catch {
		return failure("toolchain_invalid_request", "package.json is invalid");
	}
}

function normalizeVersion(value: string): string | undefined {
	const match = /^v?(\d+\.\d+\.\d+)(?:[-+].*)?$/u.exec(value.trim());
	return match?.[1];
}

function satisfiesMinimum(version: string, range: string): boolean {
	const required = /^>=\s*v?(\d+)\.(\d+)\.(\d+)$/u.exec(range.trim());
	const actual = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
	if (required === null || actual === null) return false;
	for (let index = 1; index <= 3; index += 1) {
		const difference = Number(actual[index]) - Number(required[index]);
		if (difference !== 0) return difference > 0;
	}
	return true;
}

function sameFileIdentity(
	current: { readonly device: number; readonly inode: number; readonly size: number; readonly mtimeMs: number },
	expected: SessionToolchainFileIdentity,
): boolean {
	return current.device === expected.device && current.inode === expected.inode && current.size === expected.size && current.mtimeMs === expected.mtimeMs;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure<T>(code: SessionToolchainErrorCode, message: string): SessionToolchainResult<T> {
	return { ok: false, error: { code, message } };
}

function environmentFailure(
	code: "invalid_environment" | "reserved_environment_key" | "environment_key_denied",
	message: string,
): Extract<GovernedEnvironmentOverridesResult, { readonly ok: false }> {
	return { ok: false, error: { code, message } };
}
