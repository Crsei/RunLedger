/** Storage/CLI composition seam for the single governed RunLedger home. */

import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
	buildRunledgerLayout,
	resolveRunledgerHomeContract,
	type RunledgerHomeOverrideProbe,
	type RunledgerHomeResolution,
	type RunledgerLayout,
	type RuntimePathFlavor,
} from "../runtime/contracts/public.ts";

const RUNLEDGER_DIR_ENV = "RUNLEDGER_DIR";

export interface RunledgerHomeResolverOptions {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly userHome?: string;
	readonly pathFlavor?: RuntimePathFlavor;
	readonly probeOverride?: (rawValue: string) => RunledgerHomeOverrideProbe | Promise<RunledgerHomeOverrideProbe>;
}

export interface ResolvedRunledgerHome {
	readonly resolution: Extract<RunledgerHomeResolution, { ok: true }>;
	readonly layout: RunledgerLayout;
}

export class RunledgerHomeError extends Error {
	readonly code: Extract<RunledgerHomeResolution, { ok: false }>["code"];

	constructor(code: Extract<RunledgerHomeResolution, { ok: false }>["code"]) {
		super(`unable to resolve RunLedger home: ${code}`);
		this.name = "RunledgerHomeError";
		this.code = code;
	}
}

/** 解析一次 home 与固定 layout；不创建目录、不读取旧项目目录，也不回退到 cwd。 */
export async function resolveRunledgerHome(
	options: RunledgerHomeResolverOptions = {},
): Promise<ResolvedRunledgerHome> {
	const env = options.env ?? process.env;
	const pathFlavor = options.pathFlavor ?? (process.platform === "win32" ? "win32" : "posix");
	const rawOverride = env[RUNLEDGER_DIR_ENV];
	const override = rawOverride === undefined
		? undefined
		: await (options.probeOverride ?? probeOverride)(rawOverride);
	const resolution = resolveRunledgerHomeContract({
		override,
		userHome: options.userHome ?? homedir(),
		pathFlavor,
	});
	if (!resolution.ok) throw new RunledgerHomeError(resolution.code);
	return {
		resolution,
		layout: buildRunledgerLayout(resolution.runledgerHome, pathFlavor),
	};
}

async function probeOverride(rawValue: string): Promise<RunledgerHomeOverrideProbe> {
	try {
		const info = await stat(rawValue);
		if (!info.isDirectory()) return { rawValue, state: "not_directory" };
		return { rawValue, state: "directory", canonicalPath: await realpath(rawValue) };
	} catch (error) {
		const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		return { rawValue, state: code === "ENOENT" ? "missing" : "unavailable" };
	}
}
