/** Host-owned `settings.json#security` durable adapter. */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import { runtimeDigest, type RuntimeDigest } from "../runtime/contracts/public.ts";
import type { SecurityConfigDocument, SecurityResult } from "../security/types.ts";
import type { ManagedSecurityConstraints } from "../security/types.ts";
import { parseSecurityConfigLayer } from "../security/config/schema.ts";
import { resolveSecuritySnapshot } from "../security/config/resolver.ts";
import { validateWorkspaceSecurityDocument } from "../security/config/workspace-scope.ts";
import { getSettingsPath } from "./settings-manager.ts";

export type SecuritySettingsScope = "user" | "workspace";

export interface SecuritySettingsInspection {
	readonly scope: SecuritySettingsScope;
	readonly document: SecurityConfigDocument;
	readonly sourceDigest: RuntimeDigest;
}

export interface SecuritySettingsUpdate {
	readonly scope: SecuritySettingsScope;
	readonly expectedSourceDigest: RuntimeDigest;
	readonly document: SecurityConfigDocument;
}

export interface SecuritySettingsPortOptions {
	readonly layout: RunledgerLayout;
	readonly workspaceKey?: string;
	/** 当前仅保留为 Host composition identity；settings port 不接收 TUI path。 */
	readonly workspaceRoot: string;
	readonly tempRoot: string;
	/** Managed ceiling 逐项校验候选配置，而不是把全部本地设置冻结。 */
	readonly managedConstraints?: ManagedSecurityConstraints;
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function failure(code: "invalid_config" | "policy_denied" | "revision_conflict" | "settings_unavailable", message: string): SecurityResult<never> {
	return { ok: false, error: { code, message, retryable: false } };
}

function sameDigest(left: RuntimeDigest, right: RuntimeDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyDocument(): SecurityConfigDocument {
	return {};
}

function sourceFor(scope: SecuritySettingsScope): "user" | "project" {
	return scope === "user" ? "user" : "project";
}

function parseRoot(text: string): SecurityResult<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		return failure("invalid_config", "settings file is not valid JSON");
	}
	return isRecord(parsed)
		? { ok: true, value: parsed }
		: failure("invalid_config", "settings file must contain an object");
}

function securitySection(root: Record<string, unknown>, scope: SecuritySettingsScope): SecurityResult<SecuritySettingsInspection["document"]> {
	if (!Object.prototype.hasOwnProperty.call(root, "security")) return { ok: true, value: emptyDocument() };
	const parsed = parseSecurityConfigLayer(sourceFor(scope), JSON.stringify(root.security));
	return parsed.ok ? { ok: true, value: parsed.value.document } : parsed;
}

/**
 * TUI 与 canonical JSON 之间的唯一 durable adapter。它保留非 security
 * 设置，使用 source digest compare-and-swap，且永不修改当前 session snapshot。
 */
export class SecuritySettingsPort {
	readonly #options: SecuritySettingsPortOptions;

	public constructor(options: SecuritySettingsPortOptions) {
		this.#options = options;
	}

	public async inspect(input: { readonly scope: SecuritySettingsScope }): Promise<SecurityResult<SecuritySettingsInspection>> {
		const path = this.#path(input.scope);
		const root = await this.#readRoot(path);
		if (!root.ok) return root;
		const document = securitySection(root.value, input.scope);
		if (!document.ok) return document;
		return {
			ok: true,
			value: {
				scope: input.scope,
				document: document.value,
				sourceDigest: runtimeDigest(root.value.security ?? null),
			},
		};
	}

	public async update(input: SecuritySettingsUpdate): Promise<SecurityResult<SecuritySettingsInspection>> {
		const path = this.#path(input.scope);
		const candidate = parseSecurityConfigLayer(sourceFor(input.scope), JSON.stringify(input.document));
		if (!candidate.ok) return candidate;
		let release: (() => Promise<void>) | undefined;
		try {
			await mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
			await this.#ensureFile(path);
			release = await lockfile.lock(path, {
				realpath: false,
				lockfilePath: `${path}.security.lock`,
				stale: 30_000,
				retries: { retries: 20, factor: 1.5, minTimeout: 10, maxTimeout: 250, randomize: true },
			});
			const root = await this.#readRoot(path);
			if (!root.ok) return root;
			const currentDigest = runtimeDigest(root.value.security ?? null);
			if (!sameDigest(currentDigest, input.expectedSourceDigest)) return failure("revision_conflict", "security settings source digest changed");
			let layers = [candidate.value];
			if (input.scope === "workspace") {
				const userRoot = await this.#readRoot(this.#path("user"));
				if (!userRoot.ok) return userRoot;
				const userSecurity = securitySection(userRoot.value, "user");
				if (!userSecurity.ok) return userSecurity;
				const scopeCheck = validateWorkspaceSecurityDocument(candidate.value.document, userSecurity.value);
				if (!scopeCheck.ok) return scopeCheck;
				const userLayer = parseSecurityConfigLayer("user", JSON.stringify(userSecurity.value));
				if (!userLayer.ok) return userLayer;
				layers = [candidate.value, userLayer.value];
			}
			if (this.#options.managedConstraints !== undefined) {
				const resolved = resolveSecuritySnapshot({
					layers,
					workspaceRoot: this.#options.workspaceRoot,
					tempRoot: this.#options.tempRoot,
					createdAt: new Date(0).toISOString(),
					constraints: this.#options.managedConstraints,
				});
				if (!resolved.ok) return resolved;
			}
			const next = { ...root.value, security: candidate.value.document };
			await this.#writeAtomically(path, next);
			return {
				ok: true,
				value: {
					scope: input.scope,
					document: candidate.value.document,
					sourceDigest: runtimeDigest(candidate.value.document),
				},
			};
		} catch {
			return failure("settings_unavailable", "security settings cannot be durably updated");
		} finally {
			await release?.().catch(() => undefined);
		}
	}

	#path(scope: SecuritySettingsScope): string {
		try {
			return scope === "user"
				? getSettingsPath({ layout: this.#options.layout })
				: getSettingsPath({ layout: this.#options.layout, workspaceKey: this.#options.workspaceKey ?? "" });
		} catch {
			return join(this.#options.layout.projects, "invalid", "settings.json");
		}
	}

	async #readRoot(path: string): Promise<SecurityResult<Record<string, unknown>>> {
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			if (isMissing(error)) return { ok: true, value: {} };
			return failure("settings_unavailable", "security settings cannot be read");
		}
		return parseRoot(text);
	}

	async #ensureFile(path: string): Promise<void> {
		try {
			await writeFile(path, "{}\n", { encoding: "utf8", flag: "wx", mode: FILE_MODE });
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
		}
	}

	async #writeAtomically(path: string, value: Record<string, unknown>): Promise<void> {
		const temporary = join(dirname(path), `.${randomUUID()}.security-settings.tmp`);
		try {
			await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: FILE_MODE });
			await rename(temporary, path);
			await chmod(path, FILE_MODE);
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	}
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
