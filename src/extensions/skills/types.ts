import type { ResourceIdentity } from "../../runtime/resources/types.ts";
import type { PrincipalId, ReceiptId } from "../../runtime/protocol/ids.ts";
import type { ExtensionDiagnostic } from "../diagnostics.ts";
import type { ExtensionManifestDigest } from "../trust/digest.ts";
import type { ExtensionResourceDescriptor, ExtensionSourceRoot } from "../types.ts";

export interface SkillFrontmatter {
	readonly name: string;
	readonly description: string;
	readonly userInvocable: boolean;
	readonly disableModelInvocation: boolean;
	readonly allowedTools?: readonly string[];
	readonly metadata: Readonly<Record<string, string>>;
}

export type SkillResourceFacetRole = "metadata" | "body" | "references" | "assets" | "script";

export interface SkillResourceFacet {
	readonly role: SkillResourceFacetRole;
	readonly identity: ResourceIdentity;
	readonly contentDigest: string;
	readonly byteLength: number;
	readonly entryCount: number;
	readonly capabilities: readonly string[];
}

export interface SkillResourceSet {
	readonly qualifiedId: string;
	readonly metadata: SkillResourceFacet;
	readonly body: SkillResourceFacet;
	readonly references?: SkillResourceFacet;
	readonly assets?: SkillResourceFacet;
	readonly script?: SkillResourceFacet;
	readonly budget: Readonly<{ maxBytes: number; maxEntries: number }>;
}

export interface SkillDescriptor {
	readonly descriptor: ExtensionResourceDescriptor;
	readonly frontmatter: SkillFrontmatter;
	readonly rootPath: string;
	readonly skillFile: string;
	readonly bodyDigest: string;
	readonly resourceSet: SkillResourceSet;
	readonly referencesPath?: string;
	readonly assetsPath?: string;
	readonly scriptsPath?: string;
	readonly sourceRoot: ExtensionSourceRoot;
	readonly priority: number;
	readonly trustBinding: {
		readonly identity: ResourceIdentity;
		readonly canonicalPath: string;
		readonly binding: ExtensionManifestDigest;
		readonly principalId: PrincipalId;
		readonly receiptId?: ReceiptId;
	};
}

export interface SkillDiscoveryResult {
	readonly skills: readonly SkillDescriptor[];
	readonly diagnostics: readonly ExtensionDiagnostic[];
}

export type SkillTrigger = "model-tool" | "dollar" | "slash-skill" | "slash-alias";

export type SkillResolveResult =
	| { readonly ok: true; readonly skill: SkillDescriptor; readonly trigger: SkillTrigger; readonly argument?: string }
	| { readonly ok: false; readonly code: "not_found" | "ambiguous" | "invalid" | "blocked" | "stale"; readonly message: string; readonly candidates?: readonly string[] };

export interface LoadedSkill {
	readonly skillId: string;
	readonly body: string;
	readonly bodyDigest: string;
	readonly allowedTools: readonly string[];
	readonly trigger: SkillTrigger;
	readonly argument?: string;
	readonly referencesPath?: string;
	readonly assetsPath?: string;
}
