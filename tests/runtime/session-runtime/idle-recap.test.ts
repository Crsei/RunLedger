import { afterEach, describe, expect, it, vi } from "vitest";
import { IdleRecapCoordinator, type IdleRecapActivity } from "../../../src/runtime/session-runtime/idle-recap.ts";

const eligibleActivity: IdleRecapActivity = {
	sessionId: "session_fixture",
	ownerGeneration: 4,
	driverRevision: 9,
	driverAttached: true,
	editorEmpty: true,
	streaming: false,
	maintenance: "idle",
	hasModel: true,
	hasHistory: true,
	selectionDigest: "selection_fixture",
};

describe("IdleRecapCoordinator", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not arm when the recap gate is disabled or maintenance is unknown", async () => {
		vi.useFakeTimers();
		const onFire = vi.fn().mockResolvedValue("should not display");
		const onStatus = vi.fn();
		const coordinator = new IdleRecapCoordinator({
			settings: { enabled: false, idleSeconds: 1 },
			onFire,
			onStatus,
		});

		coordinator.arm(eligibleActivity);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(onFire).not.toHaveBeenCalled();

		coordinator.updateSettings({ enabled: true, idleSeconds: 1 });
		coordinator.arm({ ...eligibleActivity, maintenance: "unknown" });
		await vi.advanceTimersByTimeAsync(2_000);
		expect(onFire).not.toHaveBeenCalled();
		expect(onStatus).not.toHaveBeenCalled();
	});

	it("fires once after the effective delay and captures owner/activity selection fencing", async () => {
		vi.useFakeTimers();
		const onFire = vi.fn().mockResolvedValue("goal next action");
		const onStatus = vi.fn();
		const coordinator = new IdleRecapCoordinator({
			settings: { enabled: true, idleSeconds: 2 },
			onFire,
			onStatus,
			requestIdFactory: () => "recap_request_fixture",
		});

		coordinator.arm(eligibleActivity);
		await vi.advanceTimersByTimeAsync(1_999);
		expect(onFire).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		expect(onFire).toHaveBeenCalledWith(expect.objectContaining({
			requestId: "recap_request_fixture",
			ownerGeneration: 4,
			activityGeneration: 1,
			driverRevision: 9,
			expectedSelectionDigest: "selection_fixture",
		}));
		await Promise.resolve();
		expect(onStatus).toHaveBeenCalledWith("goal next action", expect.any(Object));
		expect(coordinator.state).toBe("settled");

		await vi.advanceTimersByTimeAsync(4_000);
		expect(onFire).toHaveBeenCalledTimes(1);
	});

	it("cancels in-flight work on activity and discards a stale completion", async () => {
		vi.useFakeTimers();
		let resolveReply!: (reply: string) => void;
		const onFire = vi.fn(() => new Promise<string>((resolve) => {
			resolveReply = resolve;
		}));
		const onStatus = vi.fn();
		const coordinator = new IdleRecapCoordinator({
			settings: { enabled: true, idleSeconds: 1 },
			onFire,
			onStatus,
		});

		coordinator.arm(eligibleActivity);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(onFire).toHaveBeenCalledTimes(1);

		coordinator.notifyActivity({ ...eligibleActivity, editorEmpty: false });
		resolveReply("stale reply");
		await Promise.resolve();
		await Promise.resolve();

		expect(coordinator.state).toBe("cancelled");
		expect(onStatus).not.toHaveBeenCalled();
	});

	it("normalizes a provider reply before projecting the transient status", async () => {
		vi.useFakeTimers();
		const onFire = vi.fn().mockResolvedValue("\u001b[31mGoal: ship recap\u001b[0m\nNext: run tests");
		const onStatus = vi.fn();
		const coordinator = new IdleRecapCoordinator({
			settings: { enabled: true, idleSeconds: 1 },
			onFire,
			onStatus,
		});

		coordinator.arm(eligibleActivity);
		await vi.advanceTimersByTimeAsync(1_000);
		await Promise.resolve();

		expect(onStatus).toHaveBeenCalledWith("Goal: ship recap", expect.any(Object));
	});

	it("does not reuse the default request lineage after an owner generation changes", async () => {
		vi.useFakeTimers();
		const requests: string[] = [];
		const createCoordinator = () => new IdleRecapCoordinator({
			settings: { enabled: true, idleSeconds: 1 },
			onFire: (request) => {
				requests.push(request.requestId);
				return "recap";
			},
			onStatus: () => undefined,
		});
		const first = createCoordinator();
		const second = createCoordinator();

		first.arm({ ...eligibleActivity, ownerGeneration: 4 });
		await vi.advanceTimersByTimeAsync(1_000);
		second.arm({ ...eligibleActivity, ownerGeneration: 5 });
		await vi.advanceTimersByTimeAsync(1_000);

		expect(requests).toHaveLength(2);
		expect(requests[0]).not.toBe(requests[1]);
		expect(requests[0]).toContain("owner-4-activity-1");
		expect(requests[1]).toContain("owner-5-activity-1");
	});
});
