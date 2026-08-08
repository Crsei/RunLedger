/**
 * R6/credential reverse-request:编码/解码与 server 侧 AuthInteraction。
 */

import { describe, expect, it } from "vitest";
import type { SessionFrameEnvelope } from "../../../src/runtime/session-server/protocol.ts";
import type { ConnectionId } from "../../../src/runtime/protocol/ids.ts";
import {
	CredentialLoginError,
	createReverseRequestAuthInteraction,
	decodeAuthEvent,
	decodeAuthPrompt,
	encodeAuthEvent,
	encodeAuthPrompt,
	type ReverseRequestSender,
} from "../../../src/runtime/session-runtime/credential-reverse-request.ts";

function stubSender(reply: (frame: SessionFrameEnvelope) => Record<string, unknown>): { sender: ReverseRequestSender; requests: Array<{ kind: string; body: Record<string, unknown> }> } {
	const requests: Array<{ kind: string; body: Record<string, unknown> }> = [];
	return {
		requests,
		sender: {
			requestToConnection: async (_connectionId: ConnectionId, request: { kind: string; body: Record<string, unknown> }): Promise<SessionFrameEnvelope> => {
				requests.push({ kind: request.kind, body: request.body });
				return { frameId: "reverse_response_1", kind: "reverse_response" as const, protocolVersion: 1, body: reply({ kind: request.kind, body: request.body }) };
			},
		},
	};
}

const connectionId = "connection_test" as ConnectionId;

describe("credential reverse-request encode/decode", () => {
	it("round-trips a secret prompt", () => {
		const encoded = encodeAuthPrompt({ type: "secret", message: "Enter DeepSeek API key", placeholder: "sk-..." });
		const decoded = decodeAuthPrompt(encoded);
		expect(decoded).toEqual({ type: "secret", message: "Enter DeepSeek API key", placeholder: "sk-..." });
	});

	it("round-trips a select prompt", () => {
		const encoded = encodeAuthPrompt({ type: "select", message: "Pick an account", options: [{ id: "a", label: "Account A", description: "primary" }] });
		expect(decodeAuthPrompt(encoded)).toEqual({ type: "select", message: "Pick an account", options: [{ id: "a", label: "Account A", description: "primary" }] });
	});

	it("rejects malformed prompt bodies", () => {
		expect(decodeAuthPrompt({})).toBeUndefined();
		expect(decodeAuthPrompt({ promptType: "select", message: "x", options: [] })).toBeUndefined();
		expect(decodeAuthPrompt({ promptType: "unknown", message: "x" })).toBeUndefined();
	});

	it("round-trips info/auth_url/device_code events", () => {
		expect(decodeAuthEvent(encodeAuthEvent({ type: "info", message: "opening browser" }))).toEqual({ type: "info", message: "opening browser" });
		expect(decodeAuthEvent(encodeAuthEvent({ type: "auth_url", url: "https://x", instructions: "paste" }))).toEqual({ type: "auth_url", url: "https://x", instructions: "paste" });
		expect(decodeAuthEvent(encodeAuthEvent({ type: "device_code", userCode: "ABC", verificationUri: "https://v" }))).toEqual({ type: "device_code", userCode: "ABC", verificationUri: "https://v" });
		expect(decodeAuthEvent({ eventType: "unknown", message: "x" })).toBeUndefined();
	});
});

describe("createReverseRequestAuthInteraction", () => {
	it("prompt resolves with the user value from reverse_response", async () => {
		const { sender, requests } = stubSender(() => ({ ok: true, value: "sk-secret" }));
		const interaction = createReverseRequestAuthInteraction({ sender, connectionId });
		await expect(interaction.prompt({ type: "secret", message: "key" })).resolves.toBe("sk-secret");
		expect(requests[0]).toMatchObject({ kind: "credential_prompt" });
	});

	it("prompt rejects with aborted when the client cancels", async () => {
		const { sender } = stubSender(() => ({ ok: false, code: "aborted" }));
		const interaction = createReverseRequestAuthInteraction({ sender, connectionId });
		await expect(interaction.prompt({ type: "select", message: "pick", options: [{ id: "a", label: "A" }] })).rejects.toMatchObject({
			name: "CredentialLoginError",
			code: "aborted",
		});
	});

	it("prompt rejects with timeout when delivery times out", async () => {
		const sender: ReverseRequestSender = {
			requestToConnection: async () => {
				throw new Error("reverse request timed out");
			},
		};
		const interaction = createReverseRequestAuthInteraction({ sender, connectionId });
		await expect(interaction.prompt({ type: "secret", message: "key" })).rejects.toMatchObject({ name: "CredentialLoginError", code: "timeout" });
	});

	it("prompt rejects with unhandled when the client has no reverseRequestHandler", async () => {
		const { sender } = stubSender(() => ({ ok: false, code: "reverse_request_unhandled" }));
		const interaction = createReverseRequestAuthInteraction({ sender, connectionId });
		await expect(interaction.prompt({ type: "secret", message: "key" })).rejects.toBeInstanceOf(CredentialLoginError);
	});

	it("notify sends a fire-and-forget credential_event", async () => {
		const { sender, requests } = stubSender(() => ({ ok: true }));
		const interaction = createReverseRequestAuthInteraction({ sender, connectionId });
		interaction.notify({ type: "info", message: "opening browser" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(requests[0]).toMatchObject({ kind: "credential_event" });
	});
});
