/** 本地 native addon loader；能力缺失时只返回 typed unavailable。 */

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateHighlightResult, type HighlightColor, type HighlightResult } from "./contracts.ts";
import { resolveNativeSyntaxPackage } from "./native-package.ts";
import { runtimeNodePlatform } from "../../workspace/runtime-platform.ts";

export interface NativeSyntaxEngineInfo {
	readonly addon: "runledger-syntax-highlighter";
	readonly apiVersion: 1;
	readonly engineBuildId: string;
}

export interface NativeSyntaxAddon {
	readonly engineInfo: () => NativeSyntaxEngineInfo;
	readonly builtinThemes: () => unknown;
	readonly highlightAsync: (source: string, language: string, theme: string) => Promise<HighlightResult>;
	readonly foregroundForScopes: (theme: string, scopes: readonly string[]) => HighlightColor | undefined;
	readonly diffScopeBackgrounds: (theme: string) => { readonly inserted?: HighlightColor; readonly deleted?: HighlightColor } | undefined;
	readonly registerCustomTheme: (name: string, bytes: Uint8Array) => { readonly ok: true } | { readonly ok: false; readonly reason: "theme_invalid" };
}

export type NativeSyntaxAddonAvailability =
	| { readonly ok: true; readonly addon: NativeSyntaxAddon; readonly info: NativeSyntaxEngineInfo }
	| { readonly ok: false; readonly reason: "native_unavailable" | "native_integrity_error" };

const require = createRequire(import.meta.url);

export function loadNativeSyntaxAddon(): NativeSyntaxAddonAvailability {
	const platform = runtimeNodePlatform();
	const target = resolveNativeSyntaxPackage({ platform, arch: process.arch, ...(platform === "linux" ? { libc: detectLinuxLibc() } : {}) });
	if (target.ok) {
		const packaged = loadNativeSyntaxAddonFromPackage({
			packageName: target.packageName,
			resolvePackageJson: (name) => require.resolve(`${name}/package.json`),
			readFile: (path) => readFileSync(path),
			loadModule: (path) => require(path) as unknown,
		});
		if (packaged.ok || packaged.reason === "native_integrity_error") return packaged;
	}
	const path = fileURLToPath(new URL("../../../dist/native/runledger-syntax-highlighter.node", import.meta.url));
	try {
		const candidate = require(path) as unknown;
		return inspectNativeSyntaxAddon(candidate);
	} catch {
		return { ok: false, reason: "native_unavailable" };
	}
}

export interface NativeSyntaxPackageLoaderPorts {
	readonly packageName: string;
	readonly resolvePackageJson: (packageName: string) => string;
	readonly readFile: (path: string) => Uint8Array;
	readonly loadModule: (path: string) => unknown;
}

export function loadNativeSyntaxAddonFromPackage(ports: NativeSyntaxPackageLoaderPorts): NativeSyntaxAddonAvailability {
	let packageRoot: string;
	try {
		packageRoot = dirname(ports.resolvePackageJson(ports.packageName));
	} catch {
		return { ok: false, reason: "native_unavailable" };
	}
	const addonPath = join(packageRoot, "runledger-syntax-highlighter.node");
	try {
		const manifest = parseChecksumManifest(ports.readFile(join(packageRoot, "checksums.json")));
		const expected = manifest?.files["runledger-syntax-highlighter.node"];
		if (expected === undefined) return { ok: false, reason: "native_integrity_error" };
		const actual = createHash("sha256").update(ports.readFile(addonPath)).digest("hex");
		if (actual !== expected) return { ok: false, reason: "native_integrity_error" };
		return inspectNativeSyntaxAddon(ports.loadModule(addonPath));
	} catch {
		return { ok: false, reason: "native_integrity_error" };
	}
}

function detectLinuxLibc(): "glibc" | "musl" | undefined {
	const report = process.report?.getReport();
	const header = isObject(report) && isObject(report.header) ? report.header : undefined;
	return typeof header?.glibcVersionRuntime === "string" && header.glibcVersionRuntime.length > 0 ? "glibc" : "musl";
}

function parseChecksumManifest(bytes: Uint8Array): { readonly files: Readonly<Record<string, string>> } | undefined {
	let value: unknown;
	try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return undefined; }
	if (!isObject(value) || value.algorithm !== "sha256" || !isObject(value.files)) return undefined;
	const files: Record<string, string> = {};
	for (const [path, digest] of Object.entries(value.files)) {
		if (path !== "runledger-syntax-highlighter.node" || typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) return undefined;
		files[path] = digest;
	}
	return Object.keys(files).length === 1 ? { files } : undefined;
}

export function inspectNativeSyntaxAddon(value: unknown): NativeSyntaxAddonAvailability {
	if (!isNativeSyntaxAddonShape(value)) return { ok: false, reason: "native_unavailable" };
	const info = value.engineInfo();
	if (!isNativeSyntaxEngineInfo(info)) return { ok: false, reason: "native_unavailable" };
	const addon: NativeSyntaxAddon = {
		engineInfo: () => info,
		builtinThemes: value.builtinThemes,
		foregroundForScopes: (theme, scopes) => validateForegroundScopeResult(value.foregroundForScopes(theme, [...scopes])),
		diffScopeBackgrounds: (theme) => validateDiffScopeResult(value.diffScopeBackgrounds(theme)),
		registerCustomTheme: (name, bytes) => validateCustomThemeResult(value.registerCustomTheme(name, bytes)),
		highlightAsync: async (source, language, theme) => {
			try {
				const result = decodeCompactHighlightResult(await value.highlightCompactAsync(source, language, theme));
				return result ?? { ok: false, reason: "highlight_error" };
			} catch {
				return { ok: false, reason: "highlight_error" };
			}
		},
	};
	return { ok: true, addon, info };
}

interface NativeSyntaxAddonShape {
	readonly engineInfo: () => unknown;
	readonly builtinThemes: () => unknown;
	readonly highlightCompactAsync: (source: string, language: string, theme: string) => Promise<unknown>;
	readonly foregroundForScopes: (theme: string, scopes: string[]) => unknown;
	readonly diffScopeBackgrounds: (theme: string) => unknown;
	readonly registerCustomTheme: (name: string, bytes: Uint8Array) => unknown;
}

function isNativeSyntaxAddonShape(value: unknown): value is NativeSyntaxAddonShape {
	return typeof value === "object" && value !== null &&
		"engineInfo" in value && typeof value.engineInfo === "function" &&
		"builtinThemes" in value && typeof value.builtinThemes === "function" &&
		"highlightCompactAsync" in value && typeof value.highlightCompactAsync === "function" &&
		"foregroundForScopes" in value && typeof value.foregroundForScopes === "function" &&
		"diffScopeBackgrounds" in value && typeof value.diffScopeBackgrounds === "function" &&
		"registerCustomTheme" in value && typeof value.registerCustomTheme === "function";
}

const COMPACT_HEADER_BYTES = 16;
const MAX_COMPACT_BYTES = 3 * 1024 * 1024;
const MAX_COMPACT_LINES = 10_000;
const MAX_COMPACT_SPANS = 200_000;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodeCompactHighlightResult(value: unknown): HighlightResult | undefined {
	if (!(value instanceof Uint8Array) || value.byteLength < COMPACT_HEADER_BYTES || value.byteLength > MAX_COMPACT_BYTES) return undefined;
	const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	if (bytes[0] !== 0x52 || bytes[1] !== 0x4c || bytes[2] !== 0x53 || bytes[3] !== 0x48 || bytes[4] !== 1 || bytes[7] !== 0) return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const status = bytes[5];
	const reason = bytes[6];
	const lineCount = view.getUint32(8, true);
	const spanCount = view.getUint32(12, true);
	if (status === 0) {
		if (bytes.byteLength !== COMPACT_HEADER_BYTES || lineCount !== 0 || spanCount !== 0) return undefined;
		return decodeFallbackReason(reason);
	}
	if (status !== 1 || reason !== 0 || lineCount > MAX_COMPACT_LINES || spanCount > MAX_COMPACT_SPANS) return undefined;
	let offset = COMPACT_HEADER_BYTES;
	let decodedSpans = 0;
	const lines = [];
	for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
		if (offset + 4 > bytes.byteLength) return undefined;
		const lineSpanCount = view.getUint32(offset, true);
		offset += 4;
		if (lineSpanCount === 0 || decodedSpans + lineSpanCount > spanCount) return undefined;
		const spans = [];
		for (let spanIndex = 0; spanIndex < lineSpanCount; spanIndex += 1) {
			if (offset + 8 > bytes.byteLength) return undefined;
			const length = view.getUint32(offset, true);
			const style = view.getUint32(offset + 4, true);
			offset += 8;
			if (offset + length > bytes.byteLength) return undefined;
			const foreground = decodeStyleColor(style);
			if (foreground === undefined) return undefined;
			let text: string;
			try {
				text = utf8Decoder.decode(bytes.subarray(offset, offset + length));
			} catch {
				return undefined;
			}
			if (/\r|\n/u.test(text)) return undefined;
			spans.push({ text, foreground, bold: (style & 4) !== 0 });
			offset += length;
			decodedSpans += 1;
		}
		lines.push({ spans });
	}
	if (decodedSpans !== spanCount || offset !== bytes.byteLength) return undefined;
	return validateHighlightResult({ ok: true, lines, themeRevision: 0 });
}

function decodeFallbackReason(code: number): HighlightResult | undefined {
	const reasons = [undefined, "empty", "unknown_language", "oversize_bytes", "oversize_lines", "theme_invalid", "highlight_error"] as const;
	const reason = reasons[code];
	return reason === undefined ? undefined : { ok: false, reason };
}

function decodeStyleColor(style: number): HighlightColor | undefined {
	const kind = style & 3;
	if ((style & 0xf8) !== 0) return undefined;
	if (kind === 0) return (style >>> 8) === 0 ? { kind: "default" } : undefined;
	if (kind === 1) return (style >>> 16) === 0 ? { kind: "indexed", index: (style >>> 8) & 0xff } : undefined;
	if (kind === 2) return { kind: "rgb", r: (style >>> 8) & 0xff, g: (style >>> 16) & 0xff, b: (style >>> 24) & 0xff };
	return undefined;
}

function validateCustomThemeResult(value: unknown): { readonly ok: true } | { readonly ok: false; readonly reason: "theme_invalid" } {
	return isObject(value) && value.ok === true ? { ok: true } : { ok: false, reason: "theme_invalid" };
}

function isNativeSyntaxEngineInfo(value: unknown): value is NativeSyntaxEngineInfo {
	return typeof value === "object" && value !== null && "addon" in value && "apiVersion" in value && "engineBuildId" in value &&
		value.addon === "runledger-syntax-highlighter" && value.apiVersion === 1 &&
		typeof value.engineBuildId === "string" && value.engineBuildId.length > 0 && value.engineBuildId.length <= 128 &&
		/^[A-Za-z0-9@._:+-]+$/u.test(value.engineBuildId);
}

function validateForegroundScopeResult(value: unknown): HighlightColor | undefined {
	if (!isObject(value) || value.ok !== true || !("foreground" in value)) return undefined;
	return validateNativeColor(value.foreground);
}

function validateDiffScopeResult(value: unknown): { readonly inserted?: HighlightColor; readonly deleted?: HighlightColor } | undefined {
	if (!isObject(value) || value.ok !== true) return undefined;
	const inserted = value.inserted === null || value.inserted === undefined ? undefined : validateNativeColor(value.inserted);
	const deleted = value.deleted === null || value.deleted === undefined ? undefined : validateNativeColor(value.deleted);
	if ((value.inserted !== null && value.inserted !== undefined && inserted === undefined) ||
		(value.deleted !== null && value.deleted !== undefined && deleted === undefined)) return undefined;
	return { ...(inserted === undefined ? {} : { inserted }), ...(deleted === undefined ? {} : { deleted }) };
}

function validateNativeColor(value: unknown): HighlightColor | undefined {
	if (!isObject(value) || typeof value.kind !== "string") return undefined;
	if (value.kind === "default") return { kind: "default" };
	if (value.kind === "indexed" && isByte(value.index)) return { kind: "indexed", index: value.index };
	if (value.kind === "rgb" && isByte(value.r) && isByte(value.g) && isByte(value.b)) return { kind: "rgb", r: value.r, g: value.g, b: value.b };
	return undefined;
}

function isByte(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
