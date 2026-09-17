/**
 * 扩展运行时动作的 owner 侧处理器（D4）。
 *
 * host 只能**请求**动作；本模块校验请求形状、把它交给 actor port（Session
 * protocol + attempt barrier 的边界，由 composition root 注入），并按
 * `(generation, action, requestId)` 记回执。扩展没有任何直接写 store /
 * settings / trust 的通道——它连 port 都拿不到，只能发帧。
 *
 * response-loss 语义沿用 `01` §10：同 ID 同体重放命中回执、同 ID 异体是
 * conflict、无法判定是否已生效记为 `uncertain_outcome`；绝不在不确定时重放
 * 副作用。
 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import { ExtensionIntentSchema } from "../../contracts/extensions/intent.ts";
import type { ExtensionIntent } from "../../contracts/extensions/intent.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import { redactDiagnosticText, type ExtensionDiagnostic } from "../diagnostics.ts";
import { resolveActiveToolSelection } from "../tools/admission.ts";
import { ExtensionActionLedger, type ExtensionActionReceipt } from "./receipts.ts";
import type { ExtensionHostActionHandler, ExtensionHostActionRequest } from "../host/client.ts";
import type { ExtensionActionResult } from "../host/runtime-api.ts";

export const EXTENSION_THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);

const MAX_TEXT = 64 * 1024;
const MAX_NAME = 256;
const MAX_COMMAND = 8 * 1024;
const MAX_ENTRY_BYTES = 32 * 1024;

const TextSchema = Type.String({ minLength: 1, maxLength: MAX_TEXT });
const NameSchema = Type.String({ minLength: 1, maxLength: MAX_NAME });
const ToolNameSchema = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" });

const SendMessagePayloadSchema = Type.Object({ text: TextSchema }, { additionalProperties: false });
const AppendEntryPayloadSchema = Type.Object({ entry: Type.Record(Type.String(), Type.Unknown(), { maxProperties: 32 }) }, { additionalProperties: false });
const SetActiveToolsPayloadSchema = Type.Object({ names: Type.Array(ToolNameSchema, { maxItems: 128 }) }, { additionalProperties: false });
const SetModelPayloadSchema = Type.Object({ providerId: NameSchema, modelId: NameSchema }, { additionalProperties: false });
const SetThinkingLevelPayloadSchema = Type.Object({
	level: Type.Unsafe<(typeof EXTENSION_THINKING_LEVELS)[number]>({ type: "string", enum: [...EXTENSION_THINKING_LEVELS] }),
}, { additionalProperties: false });
const SetSessionNamePayloadSchema = Type.Object({ name: NameSchema }, { additionalProperties: false });
const ExecPayloadSchema = Type.Object({
	command: Type.String({ minLength: 1, maxLength: MAX_COMMAND }),
	cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
}, { additionalProperties: false });

/**
 * actor port：每个方法都是 Session protocol 上的一次读或 mutation。实现方
 * （composition root）负责 attempt barrier、expected revision 与 durable
 * receipt；本模块不复制这些机制，只做形状校验、幂等与投影。
 */
export interface ExtensionActionActorPort {
	readonly sendMessage: (input: { readonly text: string; readonly origin: "extension" }) => Promise<ExtensionActionResult>;
	readonly appendEntry: (input: { readonly entry: Record<string, unknown> }) => Promise<ExtensionActionResult>;
	readonly setActiveTools: (input: { readonly names: readonly string[] }) => Promise<ExtensionActionResult>;
	readonly setModel: (input: { readonly providerId: string; readonly modelId: string }) => Promise<ExtensionActionResult>;
	readonly setThinkingLevel: (input: { readonly level: (typeof EXTENSION_THINKING_LEVELS)[number] }) => Promise<ExtensionActionResult>;
	readonly setSessionName: (input: { readonly name: string }) => Promise<ExtensionActionResult>;
	readonly exec: (input: { readonly command: string; readonly cwd?: string; readonly timeoutMs?: number }) => Promise<ExtensionActionResult>;
	/** intent 是投影而非副作用：owner 决定是否呈现。 */
	readonly emitIntent: (input: { readonly intent: ExtensionIntent }) => Promise<ExtensionActionResult>;
}

export interface ExtensionActionHandlerOptions {
	readonly port: ExtensionActionActorPort;
	readonly generation: number;
	readonly ledger?: ExtensionActionLedger;
	/** 已准入的扩展工具名；`set-active-tools` 只能在这些名字里选。 */
	readonly admittedTools: () => readonly string[];
	readonly audit?: (event: { readonly eventType: string; readonly payload: Record<string, unknown> }) => Promise<void>;
}

function rejected(code: string, message: string, diagnostics: readonly ExtensionDiagnostic[] = []): ExtensionActionResult & { readonly diagnostics?: readonly ExtensionDiagnostic[] } {
	return { ok: false, code, message, ...(diagnostics.length === 0 ? {} : { diagnostics }) };
}

function payloadOf(request: ExtensionHostActionRequest): Record<string, unknown> {
	return { ...request.payload };
}

export interface ExtensionActionHandler {
	/** 直接作为 supervisor 的 `actionHandler` 使用。 */
	readonly handle: ExtensionHostActionHandler;
	readonly ledger: ExtensionActionLedger;
}

/**
 * 构造动作处理器。同一 requestId 的重放不会二次调用 port。
 */
export function createExtensionActionHandler(options: ExtensionActionHandlerOptions): ExtensionActionHandler {
	const ledger = options.ledger ?? new ExtensionActionLedger();
	const audit = async (eventType: string, payload: Record<string, unknown>): Promise<void> => {
		await options.audit?.({ eventType, payload });
	};

	const replayOrReject = async (request: ExtensionHostActionRequest, requestDigest: string): Promise<ExtensionActionResult | undefined> => {
		const replay = ledger.replay({ generation: options.generation, action: request.action, requestId: request.requestId, requestDigest });
		if (replay.status === "hit") {
			await audit("extension.action.replayed", { action: request.action, requestId: request.requestId, outcome: replay.receipt.outcome });
			return receiptToResult(replay.receipt);
		}
		if (replay.status === "conflict") {
			await audit("extension.action.rejected", { action: request.action, requestId: request.requestId, code: "request_conflict" });
			return rejected("request_conflict", "the same action request id was already used with a different body");
		}
		return undefined;
	};

	const settle = (request: ExtensionHostActionRequest, requestDigest: string, result: ExtensionActionResult): ExtensionActionResult => {
		if (!result.ok && (result.code === "uncertain_outcome" || result.code === "action_outcome_unknown")) {
			ledger.record({ requestId: request.requestId, action: request.action, generation: options.generation, requestDigest, outcome: "uncertain", code: result.code, message: result.message });
			return { ok: false, code: "uncertain_outcome", message: result.message };
		}
		if (!result.ok) {
			ledger.record({ requestId: request.requestId, action: request.action, generation: options.generation, requestDigest, outcome: "rejected", code: result.code, message: result.message });
			return result;
		}
		ledger.record({ requestId: request.requestId, action: request.action, generation: options.generation, requestDigest, outcome: "committed", ...(result.value === undefined ? {} : { value: result.value }) });
		return result;
	};

	const handle: ExtensionHostActionHandler = async (request) => {
		const payload = payloadOf(request);
		const requestDigest = runtimeDigest({ action: request.action, payload, intent: request.intent ?? null }).digest;
		const replayed = await replayOrReject(request, requestDigest);
		if (replayed !== undefined) return replayed;

		let result: ExtensionActionResult;
		try {
			result = await dispatchAction(request, payload);
		} catch {
			// port 抛错时无法判定副作用是否已经发生：记为 uncertain，绝不重试。
			result = { ok: false, code: "uncertain_outcome", message: "extension action outcome is unknown" };
		}
		const settled = settle(request, requestDigest, result);
		await audit(settled.ok ? "extension.action.committed" : "extension.action.rejected", {
			action: request.action,
			requestId: request.requestId,
			requestDigest,
			...(settled.ok ? {} : { code: settled.code }),
		});
		return settled;
	};

	const dispatchAction = async (request: ExtensionHostActionRequest, payload: Record<string, unknown>): Promise<ExtensionActionResult> => {
		switch (request.action) {
			case "send-message":
			case "send-user-message": {
				if (!Value.Check(SendMessagePayloadSchema, payload)) return rejected("invalid_payload", "message text must be bounded non-empty text");
				return options.port.sendMessage({ text: payload.text as string, origin: "extension" });
			}
			case "append-entry": {
				if (!Value.Check(AppendEntryPayloadSchema, payload)) return rejected("invalid_payload", "append-entry requires a bounded object");
				const entry = payload.entry as Record<string, unknown>;
				if (Buffer.byteLength(JSON.stringify(entry) ?? "null", "utf8") > MAX_ENTRY_BYTES) return rejected("invalid_payload", "append-entry exceeds the entry byte bound");
				return options.port.appendEntry({ entry });
			}
			case "set-active-tools": {
				if (!Value.Check(SetActiveToolsPayloadSchema, payload)) return rejected("invalid_payload", "set-active-tools requires a bounded tool name list");
				const selection = resolveActiveToolSelection({
					requested: payload.names as readonly string[],
					admittedNames: options.admittedTools(),
				});
				if (!selection.ok) {
					return rejected("unknown_tool", `set-active-tools references names the owner has not admitted: ${redactDiagnosticText(selection.names.join(","))}`);
				}
				return options.port.setActiveTools({ names: selection.active });
			}
			case "set-model": {
				if (!Value.Check(SetModelPayloadSchema, payload)) return rejected("invalid_payload", "set-model requires providerId and modelId");
				// 凭据解析由 owner 完成：扩展不能自带凭据，也不能在失败时改变状态。
				return options.port.setModel({ providerId: payload.providerId as string, modelId: payload.modelId as string });
			}
			case "set-thinking-level": {
				if (!Value.Check(SetThinkingLevelPayloadSchema, payload)) return rejected("invalid_payload", "set-thinking-level requires a known level");
				return options.port.setThinkingLevel({ level: payload.level as (typeof EXTENSION_THINKING_LEVELS)[number] });
			}
			case "set-session-name": {
				if (!Value.Check(SetSessionNamePayloadSchema, payload)) return rejected("invalid_payload", "set-session-name requires a bounded name");
				return options.port.setSessionName({ name: payload.name as string });
			}
			case "exec": {
				if (!Value.Check(ExecPayloadSchema, payload)) return rejected("invalid_payload", "exec requires a bounded command");
				return options.port.exec({
					command: payload.command as string,
					...(payload.cwd === undefined ? {} : { cwd: payload.cwd as string }),
					...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs as number }),
				});
			}
			case "intent": {
				if (request.intent === undefined || !Value.Check(ExtensionIntentSchema, request.intent)) {
					return rejected("invalid_intent", "intent action requires a valid intent payload");
				}
				// intent 无副作用：owner 只决定是否投影给 presentation。
				return options.port.emitIntent({ intent: request.intent });
			}
			default:
				return rejected("unsupported_action", "the owner does not support this extension action");
		}
	};

	return { handle, ledger };
}

function receiptToResult(receipt: ExtensionActionReceipt): ExtensionActionResult {
	if (receipt.outcome === "committed") return { ok: true, ...(receipt.value === undefined ? {} : { value: { ...receipt.value } }) };
	if (receipt.outcome === "uncertain") return { ok: false, code: "uncertain_outcome", message: receipt.message ?? "extension action outcome is unknown" };
	return { ok: false, code: receipt.code ?? "action_rejected", message: receipt.message ?? "extension action was rejected" };
}

/** 供 UI/审计使用的 bounded 诊断投影。 */
export function describeActionReceipt(receipt: ExtensionActionReceipt): string {
	return `${receipt.action}:${receipt.outcome}${receipt.code === undefined ? "" : `:${receipt.code}`}`;
}
