import type { SkillResourceSet } from "../../runtime/resources/types.ts";
import type { ExtensionDiagnostic } from "../diagnostics.ts";
import type { ExtensionResourceDescriptor, ExtensionSourceRoot } from "../types.ts";
import type { ResourceIdentity, ResourceManifestDigest } from "../../runtime/resources/types.ts";
import type { ReceiptId } from "../../runtime/protocol/v3/ids.ts";

export interface SkillFrontmatter {
	name: string;
	description: string;
	userInvocable: boolean;
	disableModelInvocation: boolean;
	allowedTools?: readonly string[];
	metadata: Readonly<Record<string, string>>;
}

export interface SkillDescriptor {
	descriptor: ExtensionResourceDescriptor;
	frontmatter: SkillFrontmatter;
	rootPath: string;
	skillFile: string;
	bodyDigest: string;
	resourceSet: SkillResourceSet;
	referencesPath?: string;
	assetsPath?: string;
	scriptsPath?: string;
	trustBinding: {
		identity: ResourceIdentity;
		canonicalPath: string;
		binding: ResourceManifestDigest;
		receiptId?: ReceiptId;
	};
}

export interface SkillDiscoveryResult {
	skills: readonly SkillDescriptor[];
	diagnostics: readonly ExtensionDiagnostic[];
}

export interface SkillDiscoveryRoot extends ExtensionSourceRoot {
	skillsPath?: string;
}

export type SkillTrigger = "model-tool" | "dollar" | "slash-skill" | "slash-alias";

export type SkillResolveResult =
	| { ok: true; skill: SkillDescriptor; trigger: SkillTrigger; argument?: string }
	| { ok: false; code: "not_found" | "ambiguous" | "invalid" | "blocked" | "stale"; message: string; candidates?: readonly string[] };

export interface LoadedSkill {
	skillId: string;
	body: string;
	bodyDigest: string;
	allowedTools: readonly string[];
	trigger: SkillTrigger;
	argument?: string;
}
