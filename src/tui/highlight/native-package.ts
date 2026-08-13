/** Native syntax addon optional-package target selection；无 I/O、无平台探测。 */

export type NativeSyntaxPlatform = "linux" | "darwin" | "win32";
export type NativeSyntaxArchitecture = "x64" | "arm64";
export type NativeSyntaxLibc = "glibc" | "musl";

export type NativeSyntaxPackageResolution =
	| { readonly ok: true; readonly packageName: string }
	| { readonly ok: false; readonly reason: "native_unavailable" };

export function resolveNativeSyntaxPackage(input: {
	readonly platform: string;
	readonly arch: string;
	readonly libc?: string;
}): NativeSyntaxPackageResolution {
	if (input.arch !== "x64" && input.arch !== "arm64") return { ok: false, reason: "native_unavailable" };
	if (input.platform === "linux") {
		if (input.libc !== "glibc" && input.libc !== "musl") return { ok: false, reason: "native_unavailable" };
		return { ok: true, packageName: `@runledger/syntax-highlighter-linux-${input.arch}-${input.libc === "glibc" ? "gnu" : "musl"}` };
	}
	if (input.platform === "darwin") return { ok: true, packageName: `@runledger/syntax-highlighter-darwin-${input.arch}` };
	if (input.platform === "win32") return { ok: true, packageName: `@runledger/syntax-highlighter-win32-${input.arch}-msvc` };
	return { ok: false, reason: "native_unavailable" };
}
