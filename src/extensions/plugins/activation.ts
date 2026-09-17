/**
 * 启用 / 信任 / digest / host 状态的激活门禁（P5、D7、D8）。
 *
 * 这三件事严格分离，且顺序不可交换：
 *   install 只落盘 + 记 digest，不授予执行；enable 只改启用位；
 *   **host 只有在 enabled + trusted + receipt digest 与当前内容一致时才允许启动**。
 *
 * 本模块是纯判定：它不读 state/trust 文件，也不启动进程。owner 侧把它接在
 * supervisor.start 之前，判定失败就不装配可执行扩展（fail closed）。
 */

export type ExtensionActivationCode =
	| "disabled"
	| "untrusted"
	| "digest_stale"
	| "no_entrypoints"
	| "host_failed";

export type ExtensionActivationGate =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: ExtensionActivationCode; readonly message: string };

export interface ExtensionActivationInput {
	/** workspace/user 合并后的启用位。 */
	readonly enabled: boolean;
	/** 当前内容 digest（安装时记录或重新计算）。 */
	readonly digest: string;
	/** trust receipt 绑定的 digest；缺失表示从未批准。 */
	readonly trustedDigest?: string;
	/** manifest `extensions[]`；空数组表示纯声明式包，不需要 host。 */
	readonly entrypoints: readonly string[];
	/** 该 generation 的 host 状态；`failed` 时不得继续装配。 */
	readonly hostStatus?: "idle" | "starting" | "ready" | "failed" | "stopped";
}

/**
 * 判定是否允许为这个 package 启动 extension host。
 * 注意：纯声明式包（无 entrypoint）永远返回 `no_entrypoints`，这不是错误，
 * 只是表示“不该有 host”。
 */
export function resolveExtensionHostActivation(input: ExtensionActivationInput): ExtensionActivationGate {
	if (!input.enabled) return { ok: false, code: "disabled", message: "extension is disabled in this scope" };
	if (input.trustedDigest === undefined) return { ok: false, code: "untrusted", message: "extension has no trust receipt for its current content" };
	if (input.trustedDigest !== input.digest) return { ok: false, code: "digest_stale", message: "extension content changed after it was trusted; re-approval is required" };
	if (input.entrypoints.length === 0) return { ok: false, code: "no_entrypoints", message: "extension declares no executable entrypoints" };
	if (input.hostStatus === "failed") return { ok: false, code: "host_failed", message: "extension host for this generation already failed" };
	return { ok: true };
}

/** 该 package 是否需要在 turn 上装配可执行扩展（据此决定是否起 host）。 */
export function requiresExtensionHost(input: { readonly enabled: boolean; readonly entrypoints: readonly string[] }): boolean {
	return input.enabled && input.entrypoints.length > 0;
}
