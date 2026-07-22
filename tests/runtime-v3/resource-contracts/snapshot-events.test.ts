import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	createResourceLifecycleEvent,
	resourceLifecycleEventDigest,
	toResourceLifecycleRecordedPayload,
	toResourceSnapshotPayload,
} from "../../../src/runtime/resources/events.ts";
import {
	ResourceCacheTicketSchema,
	ResourceLifecycleEventSchema,
	RuntimeResourceSnapshotSchema,
	createResourceCacheTicket,
	createRuntimeResourceSnapshot,
	isResourceCacheTicket,
	isResourceLifecycleEvent,
	isRuntimeResourceSnapshot,
	resourceCacheTicketMatches,
} from "../../../src/runtime/resources/schemas.ts";
import {
	ADAPTER_ID,
	NOW,
	SNAPSHOT_ID,
	TRACE_ID,
	authorizationContext,
	cacheTicket,
	descriptor,
	digest,
	snapshot,
} from "./fixtures.ts";

describe("resource snapshot, cache ticket, and lifecycle contracts", () => {
	it("builds an immutable-data snapshot bound to adapter generation", () => {
		const current = snapshot();
		expect(Check(RuntimeResourceSnapshotSchema, current)).toBe(true);
		expect(isRuntimeResourceSnapshot(current)).toBe(true);
		expect(current.adapterId).toBe(ADAPTER_ID);
		expect(current.adapterGeneration).toBe(7);
		expect(current.adapterGenerationDigest).toBe(digest("adapter-generation-7"));
		expect(current.resources).toHaveLength(1);
		expect(current).not.toHaveProperty("client");
		expect(current).not.toHaveProperty("handler");

		expect(isRuntimeResourceSnapshot({ ...current, schemaVersion: 2 })).toBe(false);
		expect(isRuntimeResourceSnapshot({ ...current, resources: [...current.resources, current.resources[0]!] })).toBe(false);
		expect(isRuntimeResourceSnapshot({ ...current, adapterGeneration: 8 })).toBe(false);
		expect(isRuntimeResourceSnapshot({ ...current, client: { close: () => undefined } })).toBe(false);
	});

	it("binds cache ticket to snapshot generation and exact content identity only", () => {
		const tool = descriptor();
		const current = snapshot(tool);
		const ticket = cacheTicket(tool, current);
		const { ticketDigest: _ticketDigest, ...ticketBody } = ticket;
		expect(Check(ResourceCacheTicketSchema, ticket)).toBe(true);
		expect(isResourceCacheTicket(ticket, NOW)).toBe(true);
		expect(resourceCacheTicketMatches(ticket, current, tool.identity, NOW)).toBe(true);
		expect(ticket.verification).toBe("content_identity_only");
		expect(ticket).not.toHaveProperty("trust");
		expect(ticket).not.toHaveProperty("approvalReceiptId");
		expect(ticket).not.toHaveProperty("decision");

		expect(
			resourceCacheTicketMatches(
				createResourceCacheTicket({ ...ticketBody, adapterGeneration: 8 }),
				current,
				tool.identity,
				NOW,
			),
		).toBe(false);
		expect(
			resourceCacheTicketMatches(ticket, current, { ...tool.identity, digest: digest("other-resource") }, NOW),
		).toBe(false);
		expect(isResourceCacheTicket(ticket, new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
		expect(isResourceCacheTicket({ ...ticket, trust: "trusted" }, NOW)).toBe(false);
	});

	it("emits only neutral lifecycle state plus receipt/correlation refs", () => {
		const tool = descriptor();
		const approved = createResourceLifecycleEvent({
			...authorizationContext(),
			identity: tool.identity,
			state: "approved",
			receiptId: createRuntimeId("receipt", "resource-approval"),
			snapshotId: SNAPSHOT_ID,
			adapterGeneration: 7,
			correlationId: TRACE_ID,
			occurredAt: "2026-07-22T00:00:00.000Z",
		});
		const failed = createResourceLifecycleEvent({
			...authorizationContext(),
			identity: tool.identity,
			state: "failed",
			reasonCode: "adapter_unavailable",
			reasonDigest: digest("adapter unavailable"),
			snapshotId: SNAPSHOT_ID,
			adapterGeneration: 7,
			correlationId: TRACE_ID,
			occurredAt: "2026-07-22T00:00:00.000Z",
		});

		expect(Check(ResourceLifecycleEventSchema, approved)).toBe(true);
		expect(isResourceLifecycleEvent(approved)).toBe(true);
		expect(isResourceLifecycleEvent(failed)).toBe(true);
		expect(resourceLifecycleEventDigest(approved)).toHaveLength(64);
		expect(approved).not.toHaveProperty("sequence");
		expect(approved).not.toHaveProperty("currentEventHash");
		expect(toResourceLifecycleRecordedPayload(approved)).toEqual({
			resourceId: tool.identity.resourceId,
			state: "approved",
			identityDigest: approved.identityDigest,
			receiptId: approved.receiptId,
		});
		expect(toResourceSnapshotPayload(snapshot(tool))).toEqual({
			snapshotId: SNAPSHOT_ID,
			generation: 7,
			resourceCount: 1,
			snapshotDigest: snapshot(tool).digest,
		});
	});

	it("rejects non-exhaustive lifecycle states and invalid state-specific fields", () => {
		const tool = descriptor();
		const common = {
			schemaVersion: 1 as const,
			...authorizationContext(),
			identity: tool.identity,
			identityDigest: digest("wrong until replaced"),
			snapshotId: SNAPSHOT_ID,
			adapterGeneration: 7,
			correlationId: TRACE_ID,
			occurredAt: "2026-07-22T00:00:00.000Z",
		};
		const discovered = createResourceLifecycleEvent({
			...authorizationContext(),
			identity: tool.identity,
			state: "discovered",
			snapshotId: SNAPSHOT_ID,
			adapterGeneration: 7,
			correlationId: TRACE_ID,
			occurredAt: "2026-07-22T00:00:00.000Z",
		});

		expect(isResourceLifecycleEvent({ ...discovered, state: "enabled" })).toBe(false);
		expect(isResourceLifecycleEvent({ ...discovered, receiptId: createRuntimeId("receipt", "extra") })).toBe(false);
		expect(isResourceLifecycleEvent({ ...common, state: "approved" })).toBe(false);
		expect(
			isResourceLifecycleEvent({ ...common, state: "failed", reasonCode: "failed", reasonDigest: undefined }),
		).toBe(false);
	});

	it("rejects snapshot digest drift instead of accepting a cache-generation mutation", () => {
		const current = snapshot();
		const { digest: _snapshotDigest, ...snapshotBody } = current;
		const changed = createRuntimeResourceSnapshot({
			...snapshotBody,
			adapterGeneration: current.adapterGeneration + 1,
		});
		expect(isRuntimeResourceSnapshot(changed)).toBe(true);
		expect(changed.digest).not.toBe(current.digest);
		expect(resourceCacheTicketMatches(cacheTicket(), changed, descriptor().identity, NOW)).toBe(false);
	});
});
