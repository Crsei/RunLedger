/**
 * 扩展侧 `ExtensionAPI` 实现：注册记录 + 动作 RPC 桩。
 *
 * 注册期与运行期严格分离：所有 `register*` / `on` 只写内存记录；所有动作
 * 方法在 `initialize` 之前抛 `ExtensionRuntimeNotInitializedError`。这与 omp
 * 的工厂契约一致，但动作是跨进程 RPC（D1），因此返回值是异步结果而非
 * 直接改变宿主状态。
 *
 * 本模块在 host 进程内运行，不持有任何 owner authority：它只能经动作
 * 通道**请求**副作用，由 owner 决定是否执行并回执（D4）。
 */

import { Value } from "typebox/value";
import {
	ExtensionCommandRegistrationSchema,
	ExtensionFlagRegistrationSchema,
	ExtensionToolRegistrationSchema,
} from "../../contracts/extensions/registry.ts";
import type {
	ExtensionCommandRegistration,
	ExtensionEventSubscription,
	ExtensionFlagRegistration,
	ExtensionHostLimits,
	ExtensionToolRegistration,
} from "../../contracts/extensions/registry.ts";
import type { ExtensionHostActionName } from "../../contracts/extensions/host-protocol.ts";
import { ExtensionIntentSchema } from "../../contracts/extensions/intent.ts";
import type { ExtensionIntent } from "../../contracts/extensions/intent.ts";
import { EXTENSION_DEFAULT_HOST_LIMITS } from "../../contracts/extensions/registry.ts";
import { isExtensionEventName } from "../../contracts/extensions/events.ts";
import type { ExtensionEventName } from "../../contracts/extensions/events.ts";

/** 在 `initialize` 之前调用动作方法的结果；与 omp 同名。 */
export class ExtensionRuntimeNotInitializedError extends Error {
	public readonly code = "extension_runtime_not_initialized";

	public constructor(action: string) {
		super(`extension action requires an initialized runtime: ${action}`);
		this.name = "ExtensionRuntimeNotInitializedError";
	}
}

export type ExtensionActionResult =
	| { readonly ok: true; readonly value?: Record<string, unknown> }
	| { readonly ok: false; readonly code: string; readonly message: string };

export interface ExtensionEventDelivery {
	/** 已按事件投影裁剪的载荷；owner 侧只送白名单字段。 */
	readonly name: string;
	readonly cancelable: boolean;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly signal?: AbortSignal;
}

/** handler 返回值按事件 `resultKind` 在 owner 侧解释（P3）；这里只搬运形状合法的值。 */
export type ExtensionEventHandlerResult = Record<string, unknown> | undefined | void;
export type ExtensionEventHandler = (event: ExtensionEventDelivery) => ExtensionEventHandlerResult | Promise<ExtensionEventHandlerResult>;

export interface ExtensionRegistrations {
	readonly tools: readonly ExtensionToolRegistration[];
	readonly commands: readonly ExtensionCommandRegistration[];
	readonly flags: readonly ExtensionFlagRegistration[];
	readonly subscriptions: readonly ExtensionEventSubscription[];
}

export interface ExtensionActionRequest {
	readonly action: ExtensionHostActionName;
	readonly payload: Record<string, unknown>;
	/** 仅 `intent` 动作携带；帧层与 payload 分离，避免和普通载荷混淆。 */
	readonly intent?: ExtensionIntent;
	readonly signal?: AbortSignal;
}

export interface ExtensionActionDispatcher {
	dispatch(request: ExtensionActionRequest): Promise<ExtensionActionResult>;
}

export interface ExtensionApiOptions {
	readonly limits?: ExtensionHostLimits;
	/** 动作在运行期未绑定时调用；用于把初始化前的调用变成可诊断失败而非静默丢弃。 */
	readonly onNotInitialized?: (action: string) => void;
}

export interface ExtensionApi {
	readonly registrations: ExtensionRegistrations;
	registerTool(definition: ExtensionToolRegistration): void;
	registerCommand(definition: ExtensionCommandRegistration): void;
	registerFlag(definition: ExtensionFlagRegistration): void;
	on(name: string, handler: ExtensionEventHandler): void;
	sendMessage(text: string): Promise<ExtensionActionResult>;
	sendUserMessage(text: string): Promise<ExtensionActionResult>;
	/** 需要用户输入时走既有审批 UI，而不是扩展自定义对话框（D9）。 */
	requestUserDecision(question: string, options: readonly string[]): Promise<ExtensionActionResult>;
	appendEntry(entry: Record<string, unknown>): Promise<ExtensionActionResult>;
	setActiveTools(names: readonly string[]): Promise<ExtensionActionResult>;
	setModel(model: { readonly providerId: string; readonly modelId: string }): Promise<ExtensionActionResult>;
	setThinkingLevel(level: string): Promise<ExtensionActionResult>;
	setSessionName(name: string): Promise<ExtensionActionResult>;
	exec(request: { readonly command: string; readonly cwd?: string; readonly timeoutMs?: number }): Promise<ExtensionActionResult>;
	emitIntent(intent: ExtensionIntent): Promise<ExtensionActionResult>;
}

export interface ExtensionApiRuntime {
	readonly api: ExtensionApi;
	/** 绑定动作分发器；重复绑定不是错误，最后一次生效（用于换 generation）。 */
	initialize(dispatcher: ExtensionActionDispatcher): void;
	handlersFor(name: string): readonly ExtensionEventHandler[];
}

const MAX_TEXT = 64 * 1024;

function actionFailure(code: string, message: string): ExtensionActionResult {
	return { ok: false, code, message };
}

/**
 * 构造注册/动作 API。`initialize` 只接受一个分发器；绑定之前的任何动作
 * 调用都被拒绝，不排队、不静默丢弃。
 */
export function createExtensionApi(options: ExtensionApiOptions = {}): ExtensionApiRuntime {
	const limits = options.limits ?? EXTENSION_DEFAULT_HOST_LIMITS;
	const tools: ExtensionToolRegistration[] = [];
	const commands: ExtensionCommandRegistration[] = [];
	const flags: ExtensionFlagRegistration[] = [];
	const handlersByEvent = new Map<ExtensionEventName, ExtensionEventHandler[]>();
	const subscriptionNames: ExtensionEventName[] = [];
	let dispatcher: ExtensionActionDispatcher | undefined;

	const registrations: ExtensionRegistrations = {
		get tools() { return tools; },
		get commands() { return commands; },
		get flags() { return flags; },
		get subscriptions() { return subscriptionNames.map((name) => ({ name })); },
	};

	const call = async (request: Omit<ExtensionActionRequest, "signal">): Promise<ExtensionActionResult> => {
		if (dispatcher === undefined) {
			options.onNotInitialized?.(request.action);
			throw new ExtensionRuntimeNotInitializedError(request.action);
		}
		return dispatcher.dispatch(request);
	};

	const api: ExtensionApi = {
		registrations,
		registerTool: (definition) => {
			if (tools.length >= limits.maxRegistrationsPerKind) throw new Error(`tool registration limit reached: ${limits.maxRegistrationsPerKind}`);
			if (!Value.Check(ExtensionToolRegistrationSchema, definition)) throw new Error("tool registration does not match the extension contract");
			if (tools.some((tool) => tool.name === definition.name)) throw new Error(`duplicate tool registration: ${definition.name}`);
			tools.push(Object.freeze({ ...definition, parameters: Object.freeze({ ...definition.parameters }) }));
		},
		registerCommand: (definition) => {
			if (commands.length >= limits.maxRegistrationsPerKind) throw new Error(`command registration limit reached: ${limits.maxRegistrationsPerKind}`);
			if (!Value.Check(ExtensionCommandRegistrationSchema, definition)) throw new Error("command registration does not match the extension contract");
			if (commands.some((command) => command.name === definition.name)) throw new Error(`duplicate command registration: ${definition.name}`);
			commands.push(Object.freeze({ ...definition }));
		},
		registerFlag: (definition) => {
			if (flags.length >= limits.maxRegistrationsPerKind) throw new Error(`flag registration limit reached: ${limits.maxRegistrationsPerKind}`);
			if (!Value.Check(ExtensionFlagRegistrationSchema, definition)) throw new Error("flag registration does not match the extension contract");
			if (flags.some((flag) => flag.name === definition.name)) throw new Error(`duplicate flag registration: ${definition.name}`);
			flags.push(Object.freeze({ ...definition }));
		},
		on: (name, handler) => {
			if (!isExtensionEventName(name)) throw new Error(`event is not in the extension projection whitelist: ${name}`);
			const handlers = handlersByEvent.get(name) ?? [];
			if (handlers.length >= limits.maxRegistrationsPerKind) throw new Error(`event handler limit reached for ${name}`);
			if (handlers.length === 0) subscriptionNames.push(name);
			handlers.push(handler);
			handlersByEvent.set(name, handlers);
		},
		sendMessage: (text) => {
			if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT) throw new Error("message text must be bounded non-empty text");
			return call({ action: "send-message", payload: { text } });
		},
		sendUserMessage: (text) => {
			if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT) throw new Error("message text must be bounded non-empty text");
			return call({ action: "send-user-message", payload: { text } });
		},
		requestUserDecision: async (question, choices) => {
			if (typeof question !== "string" || question.length === 0 || question.length > MAX_TEXT) return actionFailure("invalid_text", "decision request requires bounded non-empty text");
			if (choices.length === 0 || choices.length > 8) return actionFailure("invalid_options", "decision request requires 1..8 options");
			const intent: ExtensionIntent = { kind: "decision-request", level: "info", text: question, options: [...choices] };
			return call({ action: "intent", payload: {}, intent });
		},
		appendEntry: (entry) => call({ action: "append-entry", payload: { entry: { ...entry } } }),
		setActiveTools: (names) => call({ action: "set-active-tools", payload: { names: [...names] } }),
		setModel: (model) => call({ action: "set-model", payload: { providerId: model.providerId, modelId: model.modelId } }),
		setThinkingLevel: (level) => call({ action: "set-thinking-level", payload: { level } }),
		setSessionName: (name) => call({ action: "set-session-name", payload: { name } }),
		exec: (request) => call({
			action: "exec",
			payload: {
				command: request.command,
				...(request.cwd === undefined ? {} : { cwd: request.cwd }),
				...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
			},
		}),
		emitIntent: async (intent) => {
			if (!Value.Check(ExtensionIntentSchema, intent)) return actionFailure("invalid_intent", "intent does not match the extension contract");
			return call({ action: "intent", payload: {}, intent: { ...intent } });
		},
	};

	return {
		api,
		initialize: (next) => { dispatcher = next; },
		handlersFor: (name) => (isExtensionEventName(name) ? handlersByEvent.get(name) ?? [] : []),
	};
}
