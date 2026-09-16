import { describe, expect, it } from "vitest";
import {
	MINIMAL_HARNESS_SYSTEM_PROMPT,
	builtinHarnessProfiles,
	harnessProfileDescriptorDigest,
	minimalHarnessProfileRef,
	standardHarnessProfileRef,
} from "../../../src/runtime/harness-profiles/index.ts";

const STANDARD_DIGEST = "377be8e8b88ac2f1f34122eb57592e300af62b375e6b6e01edc85d9d25de6238";
const MINIMAL_DIGEST = "f77ad882678905487fc76b109d8c88dac16622174553ae7bd08772f8a1a15fa7";

describe("builtin HarnessProfiles", () => {
	it("freezes every builtin in stable registry order", () => {
		const builtins = builtinHarnessProfiles();
		// plan@2 与 plan@1 并存:plan@1 只为既有 Session 的 receipt 重放保留。
		expect(builtins.map(({ id, version }) => `${id}@${version}`)).toEqual(["standard@1", "minimal@1", "minimal@2", "plan@1", "plan@2", "standard@2"]);
		expect(builtins.every((descriptor) => Object.isFrozen(descriptor))).toBe(true);
		expect(builtins.every((descriptor) => Object.isFrozen(descriptor.prompt)
			&& Object.isFrozen(descriptor.tools)
			&& Object.isFrozen(descriptor.tools.allowlist)
			&& Object.isFrozen(descriptor.extensions))).toBe(true);
	});

	it("defines minimal@1 as a complete fixed prompt with exactly bash and edit", () => {
		const minimal = builtinHarnessProfiles()[1];
		expect(MINIMAL_HARNESS_SYSTEM_PROMPT).toBe("You are a helpful software engineer assistant.");
		expect(minimal).toEqual({
			id: "minimal",
			version: 1,
			prompt: { mode: "complete", text: "You are a helpful software engineer assistant." },
			tools: { mode: "allowlist", allowlist: ["bash", "edit"], allowBackgroundHandle: false },
			extensions: { tools: false, context: false, hooks: false, lifecycle: false },
			multiAgent: false,
		});
	});

	it("keeps plan@1 and plan@2 on the same allowlist with distinct versions", () => {
		const plans = builtinHarnessProfiles().filter((descriptor) => descriptor.id === "plan");
		expect(plans.map((descriptor) => descriptor.version)).toEqual([1, 2]);
		expect(plans[1]!.tools).toEqual(plans[0]!.tools);
		expect(plans[1]!.prompt).toEqual(plans[0]!.prompt);
		expect(harnessProfileDescriptorDigest(plans[0]!).digest)
			.not.toBe(harnessProfileDescriptorDigest(plans[1]!).digest);
	});

	it("pins canonical descriptor digests", () => {
		const [standard, minimal] = builtinHarnessProfiles();
		expect(harnessProfileDescriptorDigest(standard!).digest).toBe(STANDARD_DIGEST);
		expect(harnessProfileDescriptorDigest(minimal!).digest).toBe(MINIMAL_DIGEST);
		expect(standardHarnessProfileRef().descriptorDigest.digest).toBe(STANDARD_DIGEST);
		expect(minimalHarnessProfileRef().descriptorDigest.digest).toBe(MINIMAL_DIGEST);
	});
});
