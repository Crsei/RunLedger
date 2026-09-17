/**
 * websource 的平台 shim。
 *
 * 上游 `web/` 依赖 `@oh-my-pi/pi-utils` 的一批小工具。这里只补齐被移植代码
 * 实际用到的符号，逐条对应上游实现（见各函数注释中的来源路径），不引入
 * 依赖、不做行为改造。
 */

/** 上游 `utils/src/json.ts:tryParseJson`。 */
export function tryParseJson<T = unknown>(content: string): T | null {
	try {
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

/** 上游 `utils/src/type-guards.ts:isRecord`。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `Promise.withResolvers` 的等价物。
 *
 * 该静态方法在 Node 22 运行时可用，但本仓库的 `lib` 停留在 ES2022，类型层拿不到
 * 它。为保持 tsconfig 约定不动，这里给出一个同语义的本地构造。
 */
export function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T | PromiseLike<T>) => void;
	readonly reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * 上游 `utils/src/dirs.ts:USER_AGENT`（`omp/<version>`）是包版本派生的标识；
 * RunLedger 侧固定为自己的标识，不伪装成上游客户端。
 */
export const USER_AGENT = "RunLedger-websource/0.0.1";

/** abort 时 `untilAborted` 抛出的错误类型（上游 `utils/src/abortable.ts:AbortError`）。 */
export class AbortError extends Error {
	public readonly signal: AbortSignal;

	public constructor(signal: AbortSignal) {
		super("The operation was aborted");
		this.name = "AbortError";
		this.signal = signal;
	}
}

/** 上游 `utils/src/abortable.ts:untilAborted`。 */
export function untilAborted<T>(
	signal: AbortSignal | undefined | null,
	operation: Promise<T> | (() => Promise<T>),
): Promise<T> {
	if (!signal) return typeof operation === "function" ? operation() : operation;
	if (signal.aborted) return Promise.reject(new AbortError(signal));

	const { promise, resolve, reject } = deferred<T>();
	const onAbort = () => reject(new AbortError(signal));
	signal.addEventListener("abort", onAbort, { once: true });

	void (async () => {
		try {
			resolve(await (typeof operation === "function" ? operation() : operation));
		} catch (error) {
			reject(error);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	})();

	return promise;
}

/**
 * 上游 `utils/src/ptree.ts:combineSignals` 的等价值：调用方 signal 与硬超时
 * 合并，调用方已 abort 时直接返回它（保持「用户取消优先于超时」语义）。
 */
export function combineSignals(
	signal: AbortSignal | undefined,
	timeoutMs: number | undefined,
): AbortSignal | undefined {
	const timeout = timeoutMs !== undefined && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
	if (signal === undefined) return timeout;
	if (timeout === undefined) return signal;
	if (signal.aborted) return signal;
	return AbortSignal.any([signal, timeout]);
}

/** `setTimeout` 的可中止等待（替代上游的 `Bun.sleep` / `scheduler.wait`）。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new AbortError(signal));
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		// 不 unref:调用方通常 await 这个 backoff,若计时器不阻止事件循环退出,
		// 进程可能在等待期间直接退出(top-level await 未结算)。
		function onAbort(): void {
			clearTimeout(timer);
			reject(new AbortError(signal as AbortSignal));
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** 上游 `utils/src/format.ts:trim1`。 */
function trim1(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

/** 上游 `utils/src/format.ts:formatNumber`：`999` / `1.5K` / `25M` / `1.5B`。 */
export function formatNumber(n: number): string {
	if (n < 1_000) return n.toString();
	if (n < 10_000) return `${trim1(n / 1_000)}K`;
	if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
	if (n < 10_000_000) return `${trim1(n / 1_000_000)}M`;
	if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)}M`;
	if (n < 10_000_000_000) return `${trim1(n / 1_000_000_000)}B`;
	return `${Math.round(n / 1_000_000_000)}B`;
}

/** 上游 `utils/src/version.ts` 的完整比较器（自包含，无依赖）。 */
export function compareVersions(a: string, b: string): number {
	const core = compareNumericParts(parseVersion(a).core, parseVersion(b).core);
	if (core !== 0) return core;
	return comparePrerelease(parseVersion(a).prerelease, parseVersion(b).prerelease);
}

const DIGITS = /^\d+$/;

interface ParsedVersion {
	readonly core: readonly string[];
	readonly prerelease: readonly string[] | null;
}

function parseVersion(version: string): ParsedVersion {
	const trimmed = version.trim();
	const stripped = trimmed.startsWith("v") || trimmed.startsWith("V") ? trimmed.slice(1) : trimmed;
	const plusIndex = stripped.indexOf("+");
	const withoutBuild = plusIndex === -1 ? stripped : stripped.slice(0, plusIndex);
	const dashIndex = withoutBuild.indexOf("-");
	if (dashIndex === -1) return { core: withoutBuild.split("."), prerelease: null };
	return {
		core: withoutBuild.slice(0, dashIndex).split("."),
		prerelease: withoutBuild.slice(dashIndex + 1).split("."),
	};
}

function compareNumericParts(a: readonly string[], b: readonly string[]): number {
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) {
		const sa = a[i];
		const sb = b[i];
		const result = compareDigits(
			sa !== undefined && DIGITS.test(sa) ? sa : "0",
			sb !== undefined && DIGITS.test(sb) ? sb : "0",
		);
		if (result !== 0) return result;
	}
	return 0;
}

function compareDigits(a: string, b: string): number {
	const na = a.replace(/^0+/, "") || "0";
	const nb = b.replace(/^0+/, "") || "0";
	if (na.length !== nb.length) return na.length < nb.length ? -1 : 1;
	if (na < nb) return -1;
	if (na > nb) return 1;
	return 0;
}

function comparePrerelease(a: readonly string[] | null, b: readonly string[] | null): number {
	if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) {
		const ia = a[i];
		const ib = b[i];
		if (ia === undefined) return -1;
		if (ib === undefined) return 1;
		const aNumeric = DIGITS.test(ia);
		const bNumeric = DIGITS.test(ib);
		if (aNumeric && bNumeric) {
			const result = compareDigits(ia, ib);
			if (result !== 0) return result;
		} else if (aNumeric !== bNumeric) {
			return aNumeric ? -1 : 1;
		} else if (ia !== ib) {
			return ia < ib ? -1 : 1;
		}
	}
	return 0;
}

/**
 * choosealicense scraper 需要的 YAML frontmatter 子集解析。
 *
 * 上游用 `bun` 的 `YAML.parse`（`utils/src/frontmatter.ts`），Node 下不可用，
 * 而该 handler 只消费 `key: 标量`、`key:` + `- item` 列表与 `[a, b]` 内联列表
 * 三种形状，因此这里实现恰好覆盖该子集的解析，不做通用 YAML。
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
	const normalized = content.replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---")) return { frontmatter: {}, body: normalized };
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return { frontmatter: {}, body: normalized };
	const metadata = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();
	return { frontmatter: parseSimpleYaml(metadata), body };
}

function parseSimpleYaml(metadata: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	let currentKey: string | undefined;
	let currentList: string[] | undefined;

	const flush = (): void => {
		if (currentKey !== undefined && currentList !== undefined) result[currentKey] = currentList;
		currentKey = undefined;
		currentList = undefined;
	};

	const strip = (value: string): string =>
		value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
			? value.slice(1, -1)
			: value;

	for (const rawLine of metadata.split("\n")) {
		const listMatch = /^\s*-\s*(.*)$/.exec(rawLine);
		if (listMatch && currentKey !== undefined) {
			currentList ??= [];
			const value = strip(listMatch[1].trim());
			if (value.length > 0) currentList.push(value);
			continue;
		}
		const keyMatch = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(rawLine);
		if (!keyMatch) continue;
		flush();
		const key = keyMatch[1];
		const rawValue = keyMatch[2].trim();
		if (rawValue.length === 0) {
			currentKey = key;
			continue;
		}
		result[key] = parseScalar(rawValue, strip);
	}
	flush();
	return result;
}

function parseScalar(raw: string, strip: (value: string) => string): unknown {
	if (raw.startsWith("[") && raw.endsWith("]")) {
		return raw
			.slice(1, -1)
			.split(",")
			.map((item) => strip(item.trim()))
			.filter((item) => item.length > 0);
	}
	return strip(raw);
}
