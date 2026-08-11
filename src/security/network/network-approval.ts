/** host + protocol + port 精确绑定的 session 网络 review 服务。 */

import { canonicalDigest } from "../../runtime/contracts/public.ts";
import type { NetworkApprovalProtocol, SecurityResult } from "../types.ts";

export interface NetworkApprovalKeyInput {
	readonly host: string;
	readonly protocol: NetworkApprovalProtocol;
	readonly port?: number;
}

export interface NetworkApprovalKey {
	readonly host: string;
	readonly protocol: NetworkApprovalProtocol;
	readonly port: number;
}

export type NetworkReviewDecision = "allow" | "deny";

export interface NetworkApprovalReviewer {
	review(key: NetworkApprovalKey, signal?: AbortSignal): Promise<NetworkReviewDecision>;
}

export interface NetworkApprovalReviewPort {
	authorize(key: NetworkApprovalKeyInput, signal?: AbortSignal): Promise<SecurityResult<NetworkReviewDecision>>;
}

const DEFAULT_PORTS: Readonly<Record<NetworkApprovalProtocol, number>> = {
	http: 80,
	https: 443,
	"socks5-tcp": 1080,
	"socks5-udp": 1080,
};

function failure(message: string, retryable = false): SecurityResult<never> {
	return { ok: false, error: { code: "network_denied", message, retryable } };
}

export function normalizeNetworkApprovalKey(input: NetworkApprovalKeyInput): NetworkApprovalKey | undefined {
	const host = input.host.trim().toLowerCase().replace(/\.$/u, "");
	if (!host || host.includes("\0") || host.includes("/") || host.includes("://") || host.includes("@")) return undefined;
	const port = input.port ?? DEFAULT_PORTS[input.protocol];
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;
	return { host, protocol: input.protocol, port };
}

export function networkApprovalKeyDigest(input: NetworkApprovalKeyInput): string | undefined {
	const normalized = normalizeNetworkApprovalKey(input);
	return normalized === undefined ? undefined : canonicalDigest(normalized);
}

export class NetworkApprovalService implements NetworkApprovalReviewPort {
	readonly #reviewer: NetworkApprovalReviewer;
	readonly #approved = new Set<string>();
	readonly #denied = new Set<string>();
	readonly #pending = new Map<string, Promise<SecurityResult<NetworkReviewDecision>>>();

	public constructor(reviewer: NetworkApprovalReviewer) {
		this.#reviewer = reviewer;
	}

	public authorize(input: NetworkApprovalKeyInput, signal?: AbortSignal): Promise<SecurityResult<NetworkReviewDecision>> {
		const key = normalizeNetworkApprovalKey(input);
		if (key === undefined) return Promise.resolve(failure("network approval key is invalid"));
		const digest = canonicalDigest(key);
		if (this.#approved.has(digest)) return Promise.resolve({ ok: true, value: "allow" });
		if (this.#denied.has(digest)) return Promise.resolve({ ok: true, value: "deny" });
		const existing = this.#pending.get(digest);
		if (existing !== undefined) return existing;
		const pending = this.#review(key, digest, signal);
		this.#pending.set(digest, pending);
		void pending.finally(() => {
			if (this.#pending.get(digest) === pending) this.#pending.delete(digest);
		});
		return pending;
	}

	async #review(key: NetworkApprovalKey, digest: string, signal?: AbortSignal): Promise<SecurityResult<NetworkReviewDecision>> {
		let decision: NetworkReviewDecision;
		try {
			decision = await this.#reviewer.review(key, signal);
		} catch {
			return failure("network review channel is unavailable", true);
		}
		if (decision !== "allow" && decision !== "deny") return failure("network review returned an invalid decision");
		(decision === "allow" ? this.#approved : this.#denied).add(digest);
		return { ok: true, value: decision };
	}
}
