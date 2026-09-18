/** Canonical user-skill root 的受限管理器。 */

import { join } from "node:path";
import { DEFAULT_EXTENSION_LIMITS } from "../diagnostics.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";
import { parseSkillDocument } from "./frontmatter.ts";

const MANAGED_METADATA_KEY = "runledger.managed";
const MANAGED_METADATA_VALUE = "true";
const SKILL_FILE = "SKILL.md";
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

export type ManageSkillAction = "create" | "update" | "delete";

export interface ManageSkillInput {
	readonly action: ManageSkillAction;
	readonly name: string;
	readonly description?: string;
	readonly body?: string;
}

export type ManageSkillStoreResult =
	| {
		readonly ok: true;
		readonly action: ManageSkillAction;
		readonly name: string;
		/** 写入后的 discovery 状态；active turn 中必为 pending，待 turn 结束后交换 snapshot。 */
		readonly reload?: "ready" | "pending" | "failed";
		readonly reloadError?: string;
	}
	| { readonly ok: false; readonly code: "invalid" | "missing" | "conflict" | "foreign" | "unavailable" | "storage"; readonly message: string };

/**
 * 只管理 composition root 注入的 `<home>/state/extensions/user/skills`。
 * `runledger.managed` 写在同一个原子 SKILL.md 中，避免额外 marker 的半写状态；
 * 它不是 trust receipt，新 skill 仍需现有 trust 流程后才会激活。
 */
export class ManagedSkillStore {
	readonly #storage: ExtensionStoragePort;
	readonly #userSkillRoot: string;

	public constructor(options: { readonly storage: ExtensionStoragePort; readonly userSkillRoot: string }) {
		this.#storage = options.storage;
		this.#userSkillRoot = options.userSkillRoot;
	}

	public async mutate(input: ManageSkillInput): Promise<ManageSkillStoreResult> {
		const valid = validate(input);
		if (!valid.ok) return valid;
		const root = join(this.#userSkillRoot, input.name);
		const skillFile = join(root, SKILL_FILE);
		if (input.action === "create") {
			const existing = await this.#storage.stat(root, { followSymlinks: false });
			if (existing.ok) return { ok: false, code: "conflict", message: "a user skill with this name already exists" };
			if (existing.code !== "missing") return storageFailure(existing.message);
			return this.#write(skillFile, input.name, input.description!, input.body!, "create");
		}
		const current = await this.#managed(skillFile, input.name);
		if (!current.ok) return current;
		if (input.action === "update") {
			return this.#write(skillFile, input.name, input.description ?? current.value.description, input.body ?? current.value.body, "update");
		}
		const entries = await this.#storage.readDirectory(root);
		if (!entries.ok) return storageFailure(entries.message);
		if (entries.value.length !== 1 || entries.value[0]?.name !== SKILL_FILE || entries.value[0]?.kind !== "file") {
			return { ok: false, code: "foreign", message: "managed skill has additional files and cannot be deleted by this tool" };
		}
		if (this.#storage.remove === undefined) return { ok: false, code: "unavailable", message: "managed skill delete port is unavailable" };
		const removedFile = await this.#storage.remove(skillFile, { recursive: false });
		if (!removedFile.ok) return storageFailure(removedFile.message);
		const removedRoot = await this.#storage.remove(root, { recursive: false });
		if (!removedRoot.ok) return storageFailure(removedRoot.message);
		return { ok: true, action: "delete", name: input.name };
	}

	async #managed(skillFile: string, name: string): Promise<
		| { readonly ok: true; readonly value: { readonly description: string; readonly body: string } }
		| Exclude<ManageSkillStoreResult, { readonly ok: true }>
	> {
		const read = await this.#storage.readFile(skillFile, DEFAULT_EXTENSION_LIMITS.maxSkillBodyBytes);
		if (!read.ok) return read.code === "missing"
			? { ok: false, code: "missing", message: "managed skill does not exist" }
			: storageFailure(read.message);
		const parsed = parseSkillDocument(Buffer.from(read.value).toString("utf8"), skillFile);
		if (!parsed.ok || parsed.frontmatter.name !== name || parsed.frontmatter.metadata[MANAGED_METADATA_KEY] !== MANAGED_METADATA_VALUE) {
			return { ok: false, code: "foreign", message: "skill was not created by manage_skill" };
		}
		return { ok: true, value: { description: parsed.frontmatter.description, body: parsed.body } };
	}

	async #write(skillFile: string, name: string, description: string, body: string, action: "create" | "update"): Promise<ManageSkillStoreResult> {
		const content = render(name, description, body);
		const parsed = parseSkillDocument(content, skillFile);
		if (!parsed.ok) return { ok: false, code: "invalid", message: "managed skill document does not satisfy the skill contract" };
		const written = await this.#storage.writeFileAtomic(skillFile, Buffer.from(content, "utf8"), { fileMode: 0o600, directoryMode: 0o700 });
		return written.ok
			? { ok: true, action, name }
			: storageFailure(written.message);
	}
}

function validate(input: ManageSkillInput): Extract<ManageSkillStoreResult, { readonly ok: false }> | { readonly ok: true } {
	if (!NAME.test(input.name)) return { ok: false, code: "invalid", message: "skill name must be a kebab-case identifier" };
	if (input.description !== undefined && (!validText(input.description, DEFAULT_EXTENSION_LIMITS.maxDescriptionChars) || input.description.includes("\n"))) {
		return { ok: false, code: "invalid", message: "skill description must be one bounded line" };
	}
	if (input.body !== undefined && !validText(input.body, DEFAULT_EXTENSION_LIMITS.maxSkillBodyBytes)) return { ok: false, code: "invalid", message: "skill body exceeds its byte bound" };
	if (input.action === "create" && (input.description === undefined || input.body === undefined)) return { ok: false, code: "invalid", message: "create requires description and body" };
	if (input.action === "update" && input.description === undefined && input.body === undefined) return { ok: false, code: "invalid", message: "update requires description or body" };
	if (input.action === "delete" && (input.description !== undefined || input.body !== undefined)) return { ok: false, code: "invalid", message: "delete accepts only action and name" };
	return { ok: true };
}

function validText(value: string, maxBytes: number): boolean {
	return value.length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function render(name: string, description: string, body: string): string {
	return [
		"---",
		`name: ${name}`,
		`description: ${JSON.stringify(description)}`,
		"metadata:",
		`  ${MANAGED_METADATA_KEY}: ${JSON.stringify(MANAGED_METADATA_VALUE)}`,
		"---",
		body,
	].join("\n");
}

function storageFailure(message: string): Extract<ManageSkillStoreResult, { readonly ok: false }> {
	return { ok: false, code: "storage", message };
}
