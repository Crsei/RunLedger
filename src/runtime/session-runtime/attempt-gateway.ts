/**
 * R7-fix(P0-2):工具副作用 → recovery barrier 的 attempt gateway(06 §7.3)。
 *
 * - 生产领域组合(domain.ts)把 localExecutionEnv 包成 gatedExecutionEnv,
 *   单个 Write/Bash/WebFetch 不再只被 prompt 级别的 readonly attempt 掩盖:
 *   - fs.writeFile / fs.rm / fs.mkdir → workspace_mutation
 *   - shell.exec → process_spawn
 *   - network.request → external_mutation
 *   - readFile / stat / readdir → readonly,原样透传
 * - 每个副作用调用:beginAttempt(admission 在 barrier open 时拒绝,
 *   typed recovery_barrier_active)→ 执行底层操作 → settleAttempt
 *   (成功 committed / 失败 rejected,均 append-only receipt);
 * - 进程在 begin 与 settle 之间崩溃时留下 unresolved "started" receipt,
 *   新 owner 的 assess() 必须保持 barrier open(不误判 clean);
 * - AttemptPort 由 SessionRuntime 实现(LateBoundAttemptPort 解循环依赖:
 *   domain 在 SessionRuntime 构造前装配,绑定发生在构造时)。
 */

import type { CommandAttemptOutcome, CommandEffectClass } from "../session-owner/types.ts";
import type { ExecutionEnv } from "../execution-env.ts";
import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import type { AttemptId, CommandId, SessionId } from "../protocol/ids.ts";

/** SessionRuntime 暴露给 gateway 的 attempt 生命周期入口。 */
export interface AttemptPort {
	beginAttempt(effectClass: CommandEffectClass, requestDigest?: RuntimeDigest): { readonly attemptId: AttemptId; readonly commandId: CommandId } | { readonly error: "recovery_barrier_active" | "owner_fenced" };
	settleAttempt(attemptId: AttemptId, outcome: CommandAttemptOutcome, resultDigest?: RuntimeDigest, evidenceDigest?: RuntimeDigest): { readonly ok: true } | { readonly ok: false; readonly code: string };
}

export class AttemptSettlementError extends Error {
	public readonly code: string;
	public constructor(code: string) {
		super(`attempt_settlement_failed: ${code}`);
		this.name = "AttemptSettlementError";
		this.code = code;
	}
}

/**
 * 解循环依赖:domain 装配发生在 SessionRuntime 构造之前,工具执行必然发生在
 * 构造之后;gateway 持有一个可绑定引用,构造时由 SessionRuntime 写入。
 */
export class LateBoundAttemptPort {
	private current: AttemptPort | undefined;

	public bind(port: AttemptPort): void {
		this.current = port;
	}

	public get(): AttemptPort | undefined {
		return this.current;
	}
}

const SIDE_EFFECT_TOOL_CALLS = new Set(["fs_write", "fs_rm", "fs_mkdir", "fs_rename", "shell_exec", "network_request"]);

/**
 * 包装 ExecutionEnv:副作用调用进入 attempt 生命周期。unbound/不可用时
 * fail closed(抛错),不允许绕过 gateway 直接落地副作用。
 */
export function gatedExecutionEnv(base: ExecutionEnv, port: () => AttemptPort | undefined, sessionId: SessionId): ExecutionEnv {
	const attempt = async <T,>(effectClass: CommandEffectClass, requestDigest: RuntimeDigest, operation: () => Promise<T>): Promise<T> => {
		const target = port();
		if (target === undefined) throw new Error("attempt port unavailable; side effect not executed");
		const begun = target.beginAttempt(effectClass, requestDigest);
		if ("error" in begun) {
			throw new Error(`recovery barrier active (${begun.error}); side effect not executed`);
		}
		let result: T;
		try {
			result = await operation();
		} catch (error) {
			// leaf 已被调用后无法一般性证明零副作用；保守记录 uncertain。
			const settled = target.settleAttempt(
				begun.attemptId,
				"uncertain",
				runtimeDigest({ ok: false, code: error instanceof Error ? error.message.slice(0, 200) : String(error) }),
			);
			if (!settled.ok) throw new AttemptSettlementError(settled.code);
			throw error;
		}
		const settled = target.settleAttempt(begun.attemptId, "committed", runtimeDigest({ ok: true, sessionId }));
		if (!settled.ok) throw new AttemptSettlementError(settled.code);
		return result;
	};

	return {
		fs: {
			readFile: (p) => base.fs.readFile(p),
			stat: (p) => base.fs.stat(p),
			readdir: (p) => base.fs.readdir(p),
			writeFile: (p, data) => attempt("workspace_mutation", digestWrite(p, data), () => base.fs.writeFile(p, data)),
			mkdir: (p, opts) => attempt("workspace_mutation", digestPathOperation("fs.mkdir", p, opts ?? {}), () => base.fs.mkdir(p, opts)),
			rm: (p, opts) => attempt("workspace_mutation", digestPathOperation("fs.rm", p, opts ?? {}), () => base.fs.rm(p, opts)),
			rename: (from, to) => attempt("workspace_mutation", runtimeDigest({
				operation: "fs.rename",
				fromDigest: runtimeDigest(from).digest,
				toDigest: runtimeDigest(to).digest,
			}), () => base.fs.rename(from, to)),
		},
		shell: {
			exec: (cmd, opts) => attempt("process_spawn", digestShell(cmd, opts), () => base.shell.exec(cmd, opts)),
		},
		network: base.network === undefined ? undefined : {
			request: (request, signal) => attempt("external_mutation", digestNetwork(request), () => base.network!.request(request, signal)),
		},
		cwd: base.cwd,
	};
}

function digestWrite(path: string, data: string | Buffer): RuntimeDigest {
	const content = typeof data === "string" ? data : data.toString("base64");
	return runtimeDigest({ operation: "fs.writeFile", pathDigest: runtimeDigest(path).digest, contentDigest: runtimeDigest(content).digest });
}

function digestPathOperation(operation: string, path: string, options: Record<string, boolean>): RuntimeDigest {
	return runtimeDigest({ operation, pathDigest: runtimeDigest(path).digest, options });
}

function digestShell(command: string, options: Parameters<ExecutionEnv["shell"]["exec"]>[1]): RuntimeDigest {
	return runtimeDigest({
		operation: "shell.exec",
		commandDigest: runtimeDigest(command).digest,
		cwdDigest: runtimeDigest(options?.cwd ?? "").digest,
		envDigest: runtimeDigest(options?.env ?? {}).digest,
		stdinDigest: runtimeDigest(options?.stdin ?? "").digest,
		timeoutMs: options?.timeoutMs ?? null,
		maxOutputChars: options?.maxOutputChars ?? null,
	});
}

function digestNetwork(request: Parameters<NonNullable<ExecutionEnv["network"]>["request"]>[0]): RuntimeDigest {
	const body = request.body === undefined ? "" : typeof request.body === "string" ? request.body : request.body.toString("base64");
	return runtimeDigest({
		operation: "network.request",
		method: request.method,
		urlDigest: runtimeDigest(request.url).digest,
		headersDigest: runtimeDigest(request.headers).digest,
		bodyDigest: runtimeDigest(body).digest,
		maxBytes: request.maxBytes,
	});
}

/** 只读效果类不进入 attempt;副作用类判定供测试/装配复用。 */
export function isSideEffectClass(effectClass: CommandEffectClass): boolean {
	return effectClass !== "readonly";
}

/** 测试证据:gateway 当前可路由的工具调用名。 */
export function sideEffectToolCallIds(): readonly string[] {
	return [...SIDE_EFFECT_TOOL_CALLS];
}
