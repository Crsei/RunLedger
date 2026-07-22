/** Skill catalog 的只读 resolver；读取前重新校验 digest 与 trust。 */

import { intersectAllowedTools } from "../config-layers.ts";
import { digestFile } from "../trust/digest.ts";
import type { TrustStore } from "../trust/trust-store.ts";
import { parseSkillDocument } from "./frontmatter.ts";
import type { SkillCatalog } from "./catalog.ts";
import type { LoadedSkill, SkillResolveResult, SkillTrigger } from "./types.ts";
import type { PrincipalId } from "../../runtime/protocol/v3/ids.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";

export type SkillLoadResult = { ok: true; value: LoadedSkill } | Extract<SkillResolveResult, { ok: false }>;

export class SkillToolResolver {
	readonly #catalog: SkillCatalog;
	readonly #trustStore: TrustStore;
	readonly #currentTools: () => readonly string[];
	readonly #principalId: PrincipalId;
	readonly #storage: ExtensionStoragePort;

	public constructor(options: { catalog: SkillCatalog; trustStore: TrustStore; principalId: PrincipalId; storage: ExtensionStoragePort; currentTools: () => readonly string[] }) {
		this.#catalog = options.catalog;
		this.#trustStore = options.trustStore;
		this.#principalId = options.principalId;
		this.#storage = options.storage;
		this.#currentTools = options.currentTools;
	}

	public async load(value: string, trigger?: SkillTrigger): Promise<SkillLoadResult> {
		const resolved = this.#catalog.resolve(value, trigger);
		if (!resolved.ok) return resolved;
		const { skill } = resolved;
		const trust = await this.#trustStore.evaluate({ identity: skill.trustBinding.identity, canonicalPath: skill.trustBinding.canonicalPath, binding: skill.trustBinding.binding, principalId: this.#principalId });
		if (skill.descriptor.trust !== "trusted" || trust.state !== "trusted" || trust.receipt.receiptId !== skill.trustBinding.receiptId) {
			return { ok: false, code: "blocked", message: "skill trust receipt is missing or stale" };
		}
		const digest = await digestFile(this.#storage, skill.skillFile, 1024 * 1024);
		if (!digest.ok || digest.digest !== skill.bodyDigest) return { ok: false, code: "stale", message: "SKILL.md changed after snapshot" };
		const read = await this.#storage.readFile(skill.skillFile, 1024 * 1024);
		if (!read.ok) {
			return { ok: false, code: "stale", message: "SKILL.md cannot be read" };
		}
		const content = Buffer.from(read.value).toString("utf8");
		const parsed = parseSkillDocument(content, skill.skillFile);
		if (!parsed.ok) return { ok: false, code: "stale", message: "SKILL.md no longer validates" };
		return {
			ok: true,
			value: {
				skillId: skill.descriptor.identity.qualifiedId,
				body: parsed.body,
				bodyDigest: digest.digest,
				allowedTools: intersectAllowedTools(this.#currentTools(), skill.frontmatter.allowedTools),
				trigger: resolved.trigger,
				...(resolved.argument ? { argument: resolved.argument } : {}),
			},
		};
	}
}
