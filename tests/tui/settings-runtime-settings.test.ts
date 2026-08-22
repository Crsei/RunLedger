import { describe, expect, it } from "vitest";
import { Agent } from "../../src/runtime/agent.ts";
import { mockModel } from "../../src/runtime/providers/mock-stream.ts";
import { SettingsResolver } from "../../src/storage/settings-resolver.ts";
import type { SettingsRuntimeChange } from "../../src/storage/settings-runtime-store.ts";
import { InteractiveMode } from "../../src/tui/interactive-mode.ts";
import { ContractTerminal } from "./fixtures/contract-integration.ts";

describe("InteractiveMode settings presentation boundary", () => {
	it("refreshes only the presentation projection when the runtime store adopts a live snapshot", () => {
		let subscriber: ((change: SettingsRuntimeChange) => void) | undefined;
		let unsubscribed = false;
		const settingsRuntimeStore = {
			subscribe: (listener: (change: SettingsRuntimeChange) => void): (() => void) => {
				subscriber = listener;
				return () => {
					unsubscribed = true;
					subscriber = undefined;
				};
			},
		};
		const initial = new SettingsResolver({ user: { display: { showTokenUsage: true } } }).effectiveRuntimeSnapshot();
		const next = new SettingsResolver({ user: { display: { showTokenUsage: false } } }).effectiveRuntimeSnapshot();
		const mode = new InteractiveMode({
			agent: new Agent({ initialState: { systemPrompt: "test", model: mockModel }, streamFn: () => { throw new Error("unused"); } }),
			terminal: new ContractTerminal(),
			runtimeSettings: initial,
			settingsRuntimeStore,
		});

		expect(mode.getDisplaySettings().display?.showTokenUsage).toBe(true);
		subscriber?.({
			reason: "reload",
			previous: initial,
			current: next,
			changedPaths: ["display.showTokenUsage"],
			appliedPaths: ["display.showTokenUsage"],
			pendingPaths: [],
		});
		expect(mode.getDisplaySettings().display?.showTokenUsage).toBe(false);
		mode.quit();
		expect(unsubscribed).toBe(true);
	});

	it("does not project a non-presentation boundary into the current TUI", () => {
		let subscriber: ((change: SettingsRuntimeChange) => void) | undefined;
		const settingsRuntimeStore = {
			subscribe: (listener: (change: SettingsRuntimeChange) => void): (() => void) => {
				subscriber = listener;
				return () => {
					subscriber = undefined;
				};
			},
		};
		const initial = new SettingsResolver({ user: { display: { showTokenUsage: true } } }).effectiveRuntimeSnapshot();
		const nextTurn = new SettingsResolver({ user: { display: { showTokenUsage: false }, retry: { maxRetries: 3 } } }).effectiveRuntimeSnapshot();
		const mode = new InteractiveMode({
			agent: new Agent({ initialState: { systemPrompt: "test", model: mockModel }, streamFn: () => { throw new Error("unused"); } }),
			terminal: new ContractTerminal(),
			runtimeSettings: initial,
			settingsRuntimeStore,
		});

		subscriber?.({
			reason: "next-turn",
			previous: initial,
			current: nextTurn,
			changedPaths: ["display.showTokenUsage", "retry.maxRetries"],
			appliedPaths: ["retry.maxRetries"],
			pendingPaths: [],
		});
		expect(mode.getDisplaySettings().display?.showTokenUsage).toBe(true);
		mode.quit();
	});
});
