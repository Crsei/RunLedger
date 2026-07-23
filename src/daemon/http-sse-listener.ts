/** Real loopback HTTP command + SSE listener；schema/dispatch truth仍由HeadlessDaemonServer拥有。 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { canonicalDigest, canonicalJson } from "../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../runtime/protocol/v3/ids.ts";
import { controlPlaneFailure, type ControlPlaneResult } from "../runtime/control-plane/errors.ts";
import {
	isPeerCredentialAttestationReceipt,
	isPeerCredentialAttestorDescriptor,
	type PeerCredentialAttestorPort,
} from "../runtime/control-plane/peer-attestor.ts";
import { SseAdapterContract, validateLocalSseBindTarget } from "../runtime/control-plane/sse-transport.ts";
import { errorResponse } from "../runtime/control-plane/types.ts";
import type { HeadlessDaemonServer } from "./server.ts";

export interface HttpSseListenerOptions {
	environment: "production" | "test";
	server: HeadlessDaemonServer;
	attestor?: PeerCredentialAttestorPort;
	host?: string;
	port?: number;
	maxRequestBytes?: number;
	maxInFlightRequests?: number;
}

export interface HttpSseListenerAddress {
	host: string;
	port: number;
	commandUrl: string;
	eventUrl: string;
}

const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;

function response(
	target: ServerResponse,
	status: number,
	value: unknown,
): void {
	const body = canonicalJson(value);
	target.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
	});
	target.end(body);
}

async function boundedBody(
	request: IncomingMessage,
	maxBytes: number,
): Promise<ControlPlaneResult<unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	let tooLarge = false;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.byteLength;
		if (size > maxBytes) {
			tooLarge = true;
			continue;
		}
		chunks.push(bytes);
	}
	if (tooLarge) {
		return controlPlaneFailure("frame_too_large", "HTTP Control Plane request exceeds its byte bound");
	}
	try {
		return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
	} catch {
		return controlPlaneFailure("malformed_frame", "HTTP Control Plane body is not valid JSON");
	}
}

export class HttpSseControlPlaneListener {
	readonly #options: HttpSseListenerOptions;
	readonly #maxRequestBytes: number;
	readonly #maxInFlightRequests: number;
	readonly #responses = new Set<ServerResponse>();
	#server: Server | undefined;
	#address: HttpSseListenerAddress | undefined;
	#inFlight = 0;
	#closing = false;

	public constructor(options: HttpSseListenerOptions) {
		this.#options = options;
		this.#maxRequestBytes = options.maxRequestBytes ?? 1024 * 1024;
		this.#maxInFlightRequests = options.maxInFlightRequests ?? 64;
		if (
			!Number.isSafeInteger(this.#maxRequestBytes) ||
			this.#maxRequestBytes < 1024 ||
			this.#maxRequestBytes > 16 * 1024 * 1024 ||
			!Number.isSafeInteger(this.#maxInFlightRequests) ||
			this.#maxInFlightRequests < 1 ||
			this.#maxInFlightRequests > 4_096
		) throw new TypeError("HTTP Control Plane listener bounds are invalid");
	}

	public address(): HttpSseListenerAddress | undefined {
		return this.#address ? { ...this.#address } : undefined;
	}

	public async start(): Promise<ControlPlaneResult<HttpSseListenerAddress>> {
		if (this.#address) return { ok: true, value: { ...this.#address } };
		const host = this.#options.host ?? "127.0.0.1";
		const port = this.#options.port ?? 0;
		const target = validateLocalSseBindTarget({ kind: "tcp", host, port });
		if (!target.ok) return target;
		const attestor = this.#options.attestor;
		if (!attestor) {
			return controlPlaneFailure(
				"unsupported_feature",
				"HTTP/SSE listener requires a peer credential attestor",
			);
		}
		if (
			attestor.environment !== this.#options.environment ||
			!isPeerCredentialAttestorDescriptor(attestor.descriptor) ||
			(this.#options.environment === "production" &&
				attestor.descriptor.environment !== "production")
		) {
			return controlPlaneFailure(
				"adapter_contract_violation",
				"HTTP/SSE peer attestor is not valid for this environment",
			);
		}
		const preflight = await attestor.preflight();
		if (
			!preflight.ok ||
			preflight.value.descriptorDigest !== attestor.descriptor.descriptorDigest ||
			!/^[a-f0-9]{64}$/u.test(preflight.value.recoveryEvidenceDigest)
		) {
			return preflight.ok
				? controlPlaneFailure("adapter_contract_violation", "peer attestor preflight is uncorrelated")
				: preflight;
		}
		this.#closing = false;
		const server = createServer((request, targetResponse) => {
			void this.#handle(request, targetResponse, attestor);
		});
		this.#server = server;
		server.listen(port, host);
		try {
			await once(server, "listening");
		} catch {
			server.close();
			this.#server = undefined;
			return controlPlaneFailure("adapter_unavailable", "HTTP/SSE listener failed to bind", true);
		}
		const bound = server.address();
		if (!bound || typeof bound === "string") {
			await this.close();
			return controlPlaneFailure("adapter_unavailable", "HTTP/SSE listener address is unavailable");
		}
		this.#address = {
			host,
			port: bound.port,
			commandUrl: `http://${host}:${bound.port}/v1/control`,
			eventUrl: `http://${host}:${bound.port}/v1/events`,
		};
		return { ok: true, value: { ...this.#address } };
	}

	async #attest(
		request: IncomingMessage,
		connectionId: string,
		attestor: PeerCredentialAttestorPort,
	): Promise<ControlPlaneResult<ReturnType<HeadlessDaemonServer["createDispatcher"]>>> {
		const remoteAddress = request.socket.remoteAddress;
		const attestationRequest = {
			requestId: createRuntimeId("command", `peer-${canonicalDigest({
				connectionId,
				remoteAddress,
				remotePort: request.socket.remotePort ?? null,
			}).slice(0, 48)}`),
			transport: "sse" as const,
			...(remoteAddress ? { remoteAddress } : {}),
			channelBindingDigest: canonicalDigest({
				connectionId,
				remoteAddress: remoteAddress ?? null,
				remotePort: request.socket.remotePort ?? null,
				localAddress: request.socket.localAddress,
				localPort: request.socket.localPort,
			}),
		};
		const attested = await attestor.attest(attestationRequest);
		if (!attested.ok) return attested;
		if (!isPeerCredentialAttestationReceipt(
			attested.value,
			attestationRequest,
			attestor.descriptor,
			new Date(),
		)) {
			return controlPlaneFailure("unauthorized_peer", "peer attestation receipt is forged or stale");
		}
		return {
			ok: true,
			value: this.#options.server.createDispatcher(
				connectionId,
				attested.value.evidence,
			),
		};
	}

	async #handle(
		request: IncomingMessage,
		target: ServerResponse,
		attestor: PeerCredentialAttestorPort,
	): Promise<void> {
		if (this.#closing) {
			response(target, 503, errorResponse(null, {
				code: "daemon_shutting_down",
				message: "HTTP Control Plane listener is draining",
				retryable: true,
			}));
			return;
		}
		if (this.#inFlight >= this.#maxInFlightRequests) {
			response(target, 503, errorResponse(null, {
				code: "overloaded",
				message: "HTTP Control Plane input queue is full",
				retryable: true,
			}));
			return;
		}
		this.#inFlight += 1;
		try {
			const url = new URL(request.url ?? "/", "http://localhost");
			const connectionId =
				request.headers["x-runledger-connection-id"] ?? url.searchParams.get("connectionId");
			if (typeof connectionId !== "string" || !CONNECTION_ID.test(connectionId)) {
				response(target, 400, errorResponse(null, {
					code: "invalid_request",
					message: "bounded x-runledger-connection-id is required",
					retryable: false,
				}));
				return;
			}
			const attested = await this.#attest(request, connectionId, attestor);
			if (!attested.ok) {
				response(target, 401, errorResponse(null, attested.error));
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/control") {
				const body = await boundedBody(request, this.#maxRequestBytes);
				if (!body.ok) {
					response(target, body.error.code === "frame_too_large" ? 413 : 400, errorResponse(null, body.error));
					return;
				}
				const result = await attested.value.dispatch(body.value);
				response(target, result.kind === "error" ? 400 : 200, result);
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/events") {
				const subscriptionId = url.searchParams.get("subscriptionId");
				if (!subscriptionId || !CONNECTION_ID.test(subscriptionId)) {
					response(target, 400, errorResponse(null, {
						code: "invalid_request",
						message: "bounded subscriptionId is required",
						retryable: false,
					}));
					return;
				}
				const subscription = this.#options.server.subscription(connectionId, subscriptionId);
				if (!subscription) {
					response(target, 404, errorResponse(subscriptionId, {
						code: "invalid_request",
						message: "subscription is not active",
						retryable: false,
					}));
					return;
				}
				target.writeHead(200, {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache, no-store",
					connection: "keep-alive",
				});
				target.flushHeaders();
				this.#responses.add(target);
				const closeSubscription = () => subscription.close();
				target.once("close", closeSubscription);
				const adapter = SseAdapterContract.create({
					target: { kind: "tcp", host: this.#address?.host ?? "127.0.0.1", port: this.#address?.port ?? 0 },
					dispatcher: attested.value,
				});
				if (!adapter.ok) throw new Error(adapter.error.message);
				try {
					for await (const delivery of subscription) {
						if (!target.write(adapter.value.encodeEvent(delivery))) {
							await once(target, "drain");
						}
					}
				} catch (error) {
					if (!target.destroyed) {
						target.write(`event: control.error\ndata: ${canonicalJson({
							code: error instanceof Error && "code" in error
								? String(error.code)
								: "slow_consumer",
							retryable: true,
						})}\n\n`);
					}
				} finally {
					target.off("close", closeSubscription);
					this.#responses.delete(target);
					await this.#options.server.releaseSubscription(connectionId, subscriptionId, subscription);
					if (!target.writableEnded) target.end();
				}
				return;
			}
			response(target, 404, errorResponse(null, {
				code: "invalid_request",
				message: "unknown HTTP Control Plane endpoint",
				retryable: false,
			}));
		} catch {
			if (!target.headersSent) {
				response(target, 500, errorResponse(null, {
					code: "internal_error",
					message: "HTTP Control Plane request failed",
					retryable: false,
				}));
			} else {
				target.destroy();
			}
		} finally {
			this.#inFlight -= 1;
		}
	}

	public async close(): Promise<void> {
		if (!this.#server) return;
		this.#closing = true;
		for (const target of this.#responses) target.destroy();
		this.#responses.clear();
		const server = this.#server;
		this.#server = undefined;
		this.#address = undefined;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}
