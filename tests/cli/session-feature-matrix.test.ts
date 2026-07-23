import { describe, expect, it } from "vitest";
import {
	SESSION_CLI_ACTIONS,
	SESSION_CLI_DIAGNOSTIC_CODES,
	SESSION_V3_FEATURE_STATES,
	resolveSessionCliCompatibility,
	resolveSessionV3Rollout,
	type SessionCliAction,
	type SessionFormatVersion,
	type SessionV3FeatureState,
} from "../../src/runtime/runtime-features.ts";
import { resolveCliRuntimeConfiguration } from "../../src/cli/v3-session-commands.ts";

const EXISTING_ACTIONS = [
	"inspect",
	"export",
	"read",
	"append",
	"migrate_to_v3",
	"fork_to_v3",
	"downgrade",
] as const satisfies readonly SessionCliAction[];

const ALLOWED: Readonly<
	Record<SessionV3FeatureState, Readonly<Record<SessionFormatVersion, readonly SessionCliAction[]>>>
> = {
	off: {
		1: ["inspect", "export"],
		2: ["inspect", "export", "read", "append"],
		3: ["inspect", "export"],
	},
	opt_in: {
		1: ["inspect", "export", "migrate_to_v3"],
		2: ["inspect", "export", "read", "append", "migrate_to_v3", "fork_to_v3"],
		3: ["inspect", "export", "read", "append", "fork_to_v3"],
	},
	default: {
		1: ["inspect", "export", "migrate_to_v3"],
		2: ["inspect", "export", "migrate_to_v3", "fork_to_v3"],
		3: ["inspect", "export", "read", "append", "fork_to_v3"],
	},
	required: {
		1: ["inspect", "export", "migrate_to_v3"],
		2: ["inspect", "export", "migrate_to_v3", "fork_to_v3"],
		3: ["inspect", "export", "read", "append", "fork_to_v3"],
	},
};

describe("sessionV3 feature-state CLI matrix", () => {
	it("maps the legacy boolean to default and preserves the monotonic rollback fence", () => {
		expect(resolveSessionV3Rollout({ legacyEnabled: true })).toEqual({
			state: "default",
			highestActivatedState: "default",
			enabled: true,
			requiresHistoryPersistence: true,
		});
		expect(resolveSessionV3Rollout({
			requestedState: "off",
			highestActivatedState: "required",
		})).toEqual({
			state: "off",
			highestActivatedState: "required",
			enabled: false,
			requiresHistoryPersistence: false,
		});
	});

	it("derives boolean runtime dependencies from the authoritative feature state", () => {
		expect(resolveCliRuntimeConfiguration({
			sessionV3FeatureState: "opt_in",
			runtimeFeatures: { workspaceContracts: true },
		})).toMatchObject({
			features: { sessionV3: true, workspaceContracts: true },
			sessionV3State: "opt_in",
			sessionV3HighestActivatedState: "opt_in",
		});
		expect(resolveCliRuntimeConfiguration({
			sessionV3FeatureState: "off",
			sessionV3HighestActivatedState: "default",
			runtimeFeatures: { sessionV3: true },
		})).toMatchObject({
			features: { sessionV3: false },
			sessionV3State: "off",
			sessionV3HighestActivatedState: "default",
		});
	});
	it("matches the frozen off/opt_in/default/required matrix for every existing session version", () => {
		for (const featureState of SESSION_V3_FEATURE_STATES) {
			for (const sessionVersion of [1, 2, 3] as const) {
				for (const action of EXISTING_ACTIONS) {
					const decision = resolveSessionCliCompatibility({ featureState, sessionVersion, action });
					expect(decision.allowed, `${featureState}/v${sessionVersion}/${action}`).toBe(
						ALLOWED[featureState][sessionVersion].includes(action),
					);
					expect(SESSION_CLI_DIAGNOSTIC_CODES).toContain(decision.diagnostic);
				}
			}
		}
	});

	it("selects the only permitted new-session format", () => {
		expect(resolveSessionCliCompatibility({ featureState: "off", sessionVersion: "new", action: "create_default" })).toMatchObject({ allowed: true, writeVersion: 2 });
		expect(resolveSessionCliCompatibility({ featureState: "opt_in", sessionVersion: "new", action: "create_default" })).toMatchObject({ allowed: true, writeVersion: 2 });
		expect(resolveSessionCliCompatibility({ featureState: "opt_in", sessionVersion: "new", action: "create_v3" })).toMatchObject({ allowed: true, writeVersion: 3 });
		expect(resolveSessionCliCompatibility({ featureState: "default", sessionVersion: "new", action: "create_default" })).toMatchObject({ allowed: true, writeVersion: 3 });
		expect(resolveSessionCliCompatibility({ featureState: "required", sessionVersion: "new", action: "create_v2" })).toMatchObject({ allowed: false, diagnostic: "v2_creation_disabled" });
	});

	it("keeps emergency rollback inspect/export-only after default was activated", () => {
		for (const version of [1, 2, 3] as const) {
			for (const action of EXISTING_ACTIONS) {
				const decision = resolveSessionCliCompatibility({
					featureState: "off",
					highestActivatedState: "default",
					sessionVersion: version,
					action,
				});
				expect(decision.allowed, `rollback/v${version}/${action}`).toBe(action === "inspect" || action === "export");
				expect(decision.diagnostic).toBe("rollback_read_only");
			}
		}
	});

	it("returns a typed diagnostic for every state/version/action combination", () => {
		for (const featureState of SESSION_V3_FEATURE_STATES) {
			for (const sessionVersion of ["new", 1, 2, 3] as const) {
				for (const action of SESSION_CLI_ACTIONS) {
					const decision = resolveSessionCliCompatibility({ featureState, sessionVersion, action });
					expect(SESSION_CLI_DIAGNOSTIC_CODES).toContain(decision.diagnostic);
				}
			}
		}
	});
});
