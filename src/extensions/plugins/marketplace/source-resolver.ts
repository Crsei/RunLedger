/**
 * Marketplace plugin source 的解析与 containment 校验（P5、D7）。
 *
 * 支持：catalog 内相对路径 `./…`、`github|url|git-subdir` 受治 git 源、
 * 以及 omp 风格的 `host:owner/repo#ref` 简写。`npm` variant **显式拒绝**，
 * 给出 `source_unsupported` 而不是降级到别的源（§3.2）。
 *
 * 本模块只做纯解析：不 clone、不 fetch、不碰文件系统。相对路径的
 * containment 由调用方用注入的 storage/realpath 完成，避免在纯模块里
 * 引入 I/O。
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { MarketplacePluginSource } from "../../../contracts/extensions/marketplace.ts";

export type ExtensionSourceResolutionCode =
	| "source_unsupported"
	| "source_invalid"
	| "source_escapes_root"
	| "source_not_found";

export interface ResolvedLocalSource {
	readonly kind: "local";
	/** 已解析的绝对路径；必须仍在 marketplace root 之内。 */
	readonly path: string;
	/** 相对 marketplace root 的展示用定位符。 */
	readonly locator: string;
}

export interface ResolvedGitSource {
	readonly kind: "git";
	readonly url: string;
	readonly ref?: string;
	readonly sha?: string;
	/** `git-subdir` 的子目录；clone 后只取这一段。 */
	readonly subdir?: string;
}

export type ResolvedExtensionSource = ResolvedLocalSource | ResolvedGitSource;

export type ExtensionSourceResolution =
	| { readonly ok: true; readonly source: ResolvedExtensionSource }
	| { readonly ok: false; readonly code: ExtensionSourceResolutionCode; readonly message: string };

const GIT_HOSTS: Readonly<Record<string, (repository: string) => string>> = Object.freeze({
	github: (repository) => `https://github.com/${repository}.git`,
	gitlab: (repository) => `https://gitlab.com/${repository}.git`,
	bitbucket: (repository) => `https://bitbucket.org/${repository}.git`,
	codeberg: (repository) => `https://codeberg.org/${repository}.git`,
	sourcehut: (repository) => `https://git.sr.ht/${repository.startsWith("~") ? repository : `~${repository}`}`,
});

const SHORTHAND = /^(github|gitlab|bitbucket|codeberg|sourcehut):/u;
const SHA = /^[0-9a-f]{7,64}$/u;

function contained(root: string, target: string): boolean {
	const rel = relative(resolve(root), resolve(target));
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function invalid(message: string): ExtensionSourceResolution {
	return { ok: false, code: "source_invalid", message };
}

/**
 * 解析一个 catalog/安装 spec 的 source。`rootPath` 是相对 source 的解析基准
 * （marketplace catalog 所在目录或显式 `--root`）。
 */
export function resolveExtensionSource(source: MarketplacePluginSource | string, rootPath: string): ExtensionSourceResolution {
	if (typeof source === "string") {
		if (SHORTHAND.test(source)) return resolveGitShorthand(source);
		if (!source.startsWith("./")) return invalid("relative plugin sources must start with ./");
		const target = resolve(rootPath, source);
		if (!contained(rootPath, target)) return { ok: false, code: "source_escapes_root", message: "plugin source escapes the marketplace root" };
		return { ok: true, source: { kind: "local", path: target, locator: relative(rootPath, target).split(sep).join("/") } };
	}
	if (source.source === "npm") {
		// 显式拒绝：不得静默改道到 npm registry 或本地缓存。
		return { ok: false, code: "source_unsupported", message: "npm plugin sources are not supported; use a git or path source" };
	}
	if (source.source === "github") {
		return { ok: true, source: gitSource(`https://github.com/${source.repo}.git`, source.ref, source.sha) };
	}
	if (source.source === "url") {
		return { ok: true, source: gitSource(source.url, source.ref, source.sha) };
	}
	if (source.source === "git-subdir") {
		if (source.path.startsWith("/") || source.path.split("/").includes("..")) return invalid("git-subdir path must be a relative path without ..");
		return { ok: true, source: { ...gitSource(source.url, source.ref, source.sha), subdir: source.path } };
	}
	return invalid("plugin source is not a supported variant");
}

function gitSource(url: string, ref: string | undefined, sha: string | undefined): ResolvedGitSource {
	if (!url.startsWith("https://")) throw new Error("git sources must use https");
	if (sha !== undefined && !SHA.test(sha)) throw new Error("git sha must be a lowercase hex prefix");
	return { kind: "git", url, ...(ref === undefined ? {} : { ref }), ...(sha === undefined ? {} : { sha }) };
}

/** `github:owner/repo#ref` → https URL + pin。 */
export function resolveGitShorthand(spec: string): ExtensionSourceResolution {
	const match = SHORTHAND.exec(spec);
	if (match === null) return invalid("git shorthand must start with a known host prefix");
	const host = match[1] as string;
	const rest = spec.slice(match[0].length);
	const hashIndex = rest.indexOf("#");
	const repository = hashIndex < 0 ? rest : rest.slice(0, hashIndex);
	const ref = hashIndex < 0 ? undefined : rest.slice(hashIndex + 1);
	if (repository.length === 0) return invalid("git shorthand is missing a repository");
	if (ref !== undefined && (ref.length === 0 || ref.length > 256)) return invalid("git shorthand ref must be bounded");
	const builder = GIT_HOSTS[host];
	if (builder === undefined) return invalid(`unsupported git host: ${host}`);
	const isSha = ref !== undefined && SHA.test(ref);
	return {
		ok: true,
		source: {
			kind: "git",
			url: builder(repository),
			...(ref === undefined ? {} : isSha ? { sha: ref } : { ref }),
		},
	};
}

/**
 * 解析安装 spec：`pkg`、`pkg@marketplace`、`pkg[a,b]`、`pkg[*]`、`pkg[]`
 * 与可选的 source。feature 语法与 omp 对齐（§2.2）。
 */
export interface ExtensionInstallSpecParse {
	readonly name: string;
	readonly marketplace?: string;
	/** `null` = 只启用 default:true；`[]` = 全关；非空 = 精确集合。 */
	readonly enabledFeatures: readonly string[] | null;
}

const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const MARKETPLACE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,62}[A-Za-z0-9])?$/u;
const FEATURE = /^[a-z][a-z0-9-]{0,63}$/u;

export type ExtensionInstallSpecResult =
	| { readonly ok: true; readonly spec: ExtensionInstallSpecParse }
	| { readonly ok: false; readonly code: "spec_invalid"; readonly message: string };

export function parseExtensionInstallSpec(input: string): ExtensionInstallSpecResult {
	const trimmed = input.trim();
	if (trimmed.length === 0 || trimmed.length > 256) return { ok: false, code: "spec_invalid", message: "install spec must be bounded non-empty text" };
	let rest = trimmed;
	let enabledFeatures: readonly string[] | null = null;
	const bracket = rest.indexOf("[");
	if (bracket >= 0) {
		if (!rest.endsWith("]")) return { ok: false, code: "spec_invalid", message: "install spec feature list is not closed" };
		const inner = rest.slice(bracket + 1, -1);
		rest = rest.slice(0, bracket);
		if (inner === "*") enabledFeatures = null;
		else if (inner === "") enabledFeatures = [];
		else {
			const features = inner.split(",").map((feature) => feature.trim());
			if (features.some((feature) => !FEATURE.test(feature))) return { ok: false, code: "spec_invalid", message: "install spec contains an invalid feature name" };
			enabledFeatures = [...new Set(features)];
		}
	}
	const at = rest.lastIndexOf("@");
	const name = at > 0 ? rest.slice(0, at) : rest;
	const marketplace = at > 0 ? rest.slice(at + 1) : undefined;
	if (!PACKAGE_NAME.test(name)) return { ok: false, code: "spec_invalid", message: "install spec package name is invalid" };
	if (marketplace !== undefined && !MARKETPLACE_NAME.test(marketplace)) return { ok: false, code: "spec_invalid", message: "install spec marketplace name is invalid" };
	return { ok: true, spec: { name, ...(marketplace === undefined ? {} : { marketplace }), enabledFeatures } };
}

/** 依据 manifest feature 声明与用户选择计算实际启用的 feature 集合。 */
export function resolveEnabledFeatures(
	enabledFeatures: readonly string[] | null,
	declared: readonly { readonly name: string; readonly default?: boolean }[],
): readonly string[] {
	const declaredNames = new Set(declared.map((feature) => feature.name));
	if (enabledFeatures === null) return declared.filter((feature) => feature.default === true).map((feature) => feature.name).sort();
	return [...new Set(enabledFeatures)].filter((feature) => declaredNames.has(feature)).sort();
}
