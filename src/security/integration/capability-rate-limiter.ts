/** Capability Gateway 独立原子限流器；reservation 与 idempotency 均持久端口化。 */

import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import {
	isGatewayRateLimitRequest,
	type CapabilityRateLimitPort,
	type GatewayRateLimitReceipt,
	type GatewayRateLimitRequest,
} from "../../runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../../runtime/protocol/v3/ids.ts";

export interface CapabilityRateLimitPolicy {
	rateLimitId: GatewayRateLimitRequest["rateLimitId"];
	capability: GatewayRateLimitRequest["capability"];
	maxUnits: number;
	maxWindowMs: number;
}

interface RateLimitReservation {
	receipt: GatewayRateLimitReceipt;
	remainingUnits: number;
	terminal?: "committed" | "refunded";
}

export class MemoryCapabilityRateLimiter implements CapabilityRateLimitPort {
	readonly #policies: ReadonlyMap<GatewayRateLimitRequest["rateLimitId"], CapabilityRateLimitPolicy>;
	readonly #windows = new Map<string, number>();
	readonly #reservations = new Map<GatewayRateLimitRequest["reservationReceiptId"] & string, RateLimitReservation>();
	readonly #idempotency = new Map<string, { requestDigest: string; receipt: GatewayRateLimitReceipt }>();
	readonly #clock: () => Date;

	public constructor(policies: readonly CapabilityRateLimitPolicy[], clock: () => Date = () => new Date()) {
		this.#policies = new Map(policies.map((policy) => [policy.rateLimitId, policy]));
		this.#clock = clock;
	}

	#createReceipt(
		request: GatewayRateLimitRequest,
		outcome: GatewayRateLimitReceipt["outcome"],
		acceptedUnits: number,
		remainingUnits: number,
		policyDigest: string,
	): GatewayRateLimitReceipt {
		const body: Omit<GatewayRateLimitReceipt, "receiptDigest"> = {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			receiptId: createRuntimeId("receipt", `rate-limit-${canonicalDigest({ request, outcome, acceptedUnits, remainingUnits }).slice(0, 48)}`),
			rateLimitId: request.rateLimitId,
			requestId: request.requestId,
			operation: request.operation,
			outcome,
			capability: request.capability,
			resourceDigest: request.resourceDigest,
			windowStartedAt: request.windowStartedAt,
			windowExpiresAt: request.windowExpiresAt,
			requestedUnits: request.units,
			acceptedUnits,
			remainingUnits,
			policyDigest,
			issuedAt: this.#clock().toISOString(),
		};
		return { ...body, receiptDigest: canonicalDigest(body) };
	}

	public async apply(request: GatewayRateLimitRequest): Promise<GatewayRateLimitReceipt> {
		const requestDigest = canonicalDigest(request);
		const idempotencyKey = `${request.authorityId}/${request.tenantId}/${request.principalId}/${request.idempotencyKey}`;
		const previous = this.#idempotency.get(idempotencyKey);
		if (previous?.requestDigest === requestDigest) return previous.receipt;
		const policy = this.#policies.get(request.rateLimitId);
		const windowMs = Date.parse(request.windowExpiresAt) - Date.parse(request.windowStartedAt);
		const valid = isGatewayRateLimitRequest(request) && policy !== undefined && policy.capability === request.capability &&
			Number.isFinite(windowMs) && windowMs > 0 && windowMs <= policy.maxWindowMs;
		const policyDigest = canonicalDigest(policy ?? { unavailable: request.rateLimitId });
		if (!valid || previous) {
			const rejected = this.#createReceipt(request, "rejected", 0, 0, policyDigest);
			if (!previous) this.#idempotency.set(idempotencyKey, { requestDigest, receipt: rejected });
			return rejected;
		}
		const windowKey = [request.authorityId, request.tenantId, request.principalId, request.rateLimitId,
			request.resourceDigest, request.windowStartedAt, request.windowExpiresAt].join("/");
		const used = this.#windows.get(windowKey) ?? 0;
		let receipt: GatewayRateLimitReceipt;
		if (request.operation === "reserve") {
			const remainingBefore = Math.max(0, policy.maxUnits - used);
			if (request.units > remainingBefore) {
				receipt = this.#createReceipt(request, "rejected", 0, remainingBefore, policyDigest);
			} else {
				const remaining = remainingBefore - request.units;
				receipt = this.#createReceipt(request, "reserved", request.units, remaining, policyDigest);
				this.#windows.set(windowKey, used + request.units);
				this.#reservations.set(receipt.receiptId, { receipt, remainingUnits: remaining });
			}
		} else {
			const reservation = request.reservationReceiptId ? this.#reservations.get(request.reservationReceiptId) : undefined;
			if (!reservation || reservation.terminal || reservation.receipt.authorityId !== request.authorityId ||
				reservation.receipt.tenantId !== request.tenantId || reservation.receipt.principalId !== request.principalId ||
				reservation.receipt.capability !== request.capability || reservation.receipt.resourceDigest !== request.resourceDigest ||
				reservation.receipt.acceptedUnits !== request.units) {
				receipt = this.#createReceipt(request, "rejected", 0, Math.max(0, policy.maxUnits - used), policyDigest);
			} else if (request.operation === "commit") {
				reservation.terminal = "committed";
				receipt = this.#createReceipt(request, "committed", request.units, reservation.remainingUnits, policyDigest);
			} else {
				reservation.terminal = "refunded";
				const nextUsed = Math.max(0, used - request.units);
				this.#windows.set(windowKey, nextUsed);
				receipt = this.#createReceipt(request, "refunded", request.units, Math.max(0, policy.maxUnits - nextUsed), policyDigest);
			}
		}
		this.#idempotency.set(idempotencyKey, { requestDigest, receipt });
		return receipt;
	}
}
