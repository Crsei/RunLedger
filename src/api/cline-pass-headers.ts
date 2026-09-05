import { runtimeNodePlatform } from "../workspace/runtime-platform.ts";

/** Cline 官方客户端身份协议；来源 oh-my-pi 18.1.9 wire/cline-pass.ts。 */
export function clinePassHeaders(sessionId?: string): Record<string, string> {
	return {
		"HTTP-Referer": "https://cline.bot",
		"X-Title": "Cline",
		"X-IS-MULTIROOT": "false",
		"X-CLIENT-TYPE": "cline-sdk",
		"User-Agent": "Cline/3.0.58",
		"X-CLIENT-VERSION": "3.0.58",
		"X-PLATFORM": runtimeNodePlatform(),
		"X-PLATFORM-VERSION": "3.0.54",
		"X-CORE-VERSION": "0.0.79",
		...(sessionId ? { "X-Task-ID": sessionId } : {}),
	};
}
