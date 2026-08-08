/**
 * R6/credential reverse-request:把 AuthInteraction 经 Session 协议
 * reverse-request 通道投递给 driver 连接的 TUI。
 *
 * - `prompt(AuthPrompt)` → reverse_request{ kind:"credential_prompt" } →
 *   TUI 渲染 secret/select/text/manual_code 输入 → reverse_response{ ok, value };
 * - `notify(AuthEvent)` → reverse_request{ kind:"credential_event" }(fire-and-forget);
 * - headless client(未注入 reverseRequestHandler)会回
 *   { ok:false, code:"reverse_request_unhandled" },login fail closed。
 */

import type { SessionFrameEnvelope } from "../session-server/protocol.ts";
import type { ConnectionId } from "../protocol/ids.ts";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "../../auth/types.ts";

export type CredentialPromptBody =
	| { readonly promptType: "text" | "secret" | "manual_code"; readonly message: string; readonly placeholder?: string }
	| {
			readonly promptType: "select";
			readonly message: string;
			readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
	  };

export type CredentialEventBody =
	| { readonly eventType: "info"; readonly message: string; readonly links?: readonly { readonly url: string; readonly label?: string }[] }
	| { readonly eventType: "auth_url"; readonly url: string; readonly instructions?: string }
	| {
			readonly eventType: "device_code";
			readonly userCode: string;
			readonly verificationUri: string;
			readonly intervalSeconds?: number;
			readonly expiresInSeconds?: number;
	  }
	| { readonly eventType: "progress"; readonly message: string };

export const CREDENTIAL_REVERSE_REQUEST_KIND = {
	prompt: "credential_prompt",
	event: "credential_event",
} as const;

export function encodeAuthPrompt(prompt: AuthPrompt): CredentialPromptBody {
	if (prompt.type === "select") {
		return { promptType: "select", message: prompt.message, options: prompt.options };
	}
	return {
		promptType: prompt.type,
		message: prompt.message,
		...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
	};
}

export function decodeAuthPrompt(value: unknown): AuthPrompt | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const message = typeof record.message === "string" ? record.message : "";
	if (message.length === 0) return undefined;
	if (record.promptType === "select") {
		if (!Array.isArray(record.options) || record.options.length === 0) return undefined;
		const options = record.options.map((entry) => {
			const item = entry as Record<string, unknown>;
			return {
				id: typeof item.id === "string" ? item.id : "",
				label: typeof item.label === "string" ? item.label : "",
				...(typeof item.description === "string" ? { description: item.description } : {}),
			};
		}).filter((option) => option.id.length > 0 && option.label.length > 0);
		if (options.length === 0) return undefined;
		return { type: "select", message, options };
	}
	if (record.promptType !== "text" && record.promptType !== "secret" && record.promptType !== "manual_code") return undefined;
	return {
		type: record.promptType,
		message,
		...(typeof record.placeholder === "string" ? { placeholder: record.placeholder } : {}),
	};
}

export function encodeAuthEvent(event: AuthEvent): CredentialEventBody {
	switch (event.type) {
		case "info":
			return { eventType: "info", message: event.message, ...(event.links === undefined ? {} : { links: event.links }) };
		case "auth_url":
			return { eventType: "auth_url", url: event.url, ...(event.instructions === undefined ? {} : { instructions: event.instructions }) };
		case "device_code":
			return {
				eventType: "device_code",
				userCode: event.userCode,
				verificationUri: event.verificationUri,
				...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
				...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
			};
		case "progress":
			return { eventType: "progress", message: event.message };
	}
}

export function decodeAuthEvent(value: unknown): AuthEvent | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	switch (record.eventType) {
		case "info": {
			const message = typeof record.message === "string" ? record.message : "";
			if (message.length === 0) return undefined;
			const links = Array.isArray(record.links) ? record.links.map((entry) => {
				const item = entry as Record<string, unknown>;
				return { url: typeof item.url === "string" ? item.url : "", ...(typeof item.label === "string" ? { label: item.label } : {}) };
			}).filter((link) => link.url.length > 0) : undefined;
			return { type: "info", message, ...(links === undefined || links.length === 0 ? {} : { links }) };
		}
		case "auth_url": {
			const url = typeof record.url === "string" ? record.url : "";
			if (url.length === 0) return undefined;
			return { type: "auth_url", url, ...(typeof record.instructions === "string" ? { instructions: record.instructions } : {}) };
		}
		case "device_code": {
			const userCode = typeof record.userCode === "string" ? record.userCode : "";
			const verificationUri = typeof record.verificationUri === "string" ? record.verificationUri : "";
			if (userCode.length === 0 || verificationUri.length === 0) return undefined;
			return {
				type: "device_code",
				userCode,
				verificationUri,
				...(typeof record.intervalSeconds === "number" ? { intervalSeconds: record.intervalSeconds } : {}),
				...(typeof record.expiresInSeconds === "number" ? { expiresInSeconds: record.expiresInSeconds } : {}),
			};
		}
		case "progress": {
			const message = typeof record.message === "string" ? record.message : "";
			if (message.length === 0) return undefined;
			return { type: "progress", message };
		}
		default:
			return undefined;
	}
}

/** Login 失败的类型化错误,便于 session-runtime 映射 typed code。 */
export class CredentialLoginError extends Error {
	public readonly code: "aborted" | "timeout" | "invalid_response" | "unhandled";

	public constructor(code: CredentialLoginError["code"], message: string, cause?: unknown) {
		super(message);
		this.name = "CredentialLoginError";
		this.code = code;
		this.cause = cause;
	}
}

/** reverse-request 发送方;SessionRuntimeServer.requestToConnection 满足该形状。 */
export interface ReverseRequestSender {
	requestToConnection(
		connectionId: ConnectionId,
		request: { readonly kind: string; readonly body: Record<string, unknown> },
		timeoutMs?: number,
	): Promise<SessionFrameEnvelope>;
}

/**
 * 构造 server 侧 AuthInteraction:prompt/notify 都经 driver 连接的
 * reverse-request 投递给 TUI,不依赖本地 modal。
 */
export function createReverseRequestAuthInteraction(options: {
	readonly sender: ReverseRequestSender;
	readonly connectionId: ConnectionId;
	readonly signal?: AbortSignal;
}): AuthInteraction {
	return {
		signal: options.signal,
		prompt: async (prompt) => {
			let frame: SessionFrameEnvelope;
			try {
				frame = await options.sender.requestToConnection(options.connectionId, {
					kind: CREDENTIAL_REVERSE_REQUEST_KIND.prompt,
					body: encodeAuthPrompt(prompt) as unknown as Record<string, unknown>,
				});
			} catch (error) {
				const timedOut = error instanceof Error && error.message.includes("timed out");
				throw new CredentialLoginError(
					timedOut ? "timeout" : "unhandled",
					timedOut ? "credential prompt timed out" : `credential prompt could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
					error,
				);
			}
			if (frame.body.ok === true) {
				if (typeof frame.body.value !== "string") throw new CredentialLoginError("invalid_response", "credential prompt returned a non-string value");
				return frame.body.value;
			}
			const code = typeof frame.body.code === "string" ? frame.body.code : "unhandled";
			throw new CredentialLoginError(code === "aborted" ? "aborted" : "unhandled", code === "aborted" ? "login cancelled by user" : `credential prompt rejected: ${code}`);
		},
		notify: (event) => {
			void options.sender
				.requestToConnection(options.connectionId, {
					kind: CREDENTIAL_REVERSE_REQUEST_KIND.event,
					body: encodeAuthEvent(event) as unknown as Record<string, unknown>,
				})
				.catch(() => undefined);
		},
	};
}
