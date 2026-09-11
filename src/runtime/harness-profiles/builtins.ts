/** 版本化 builtin Harness Profile；模型可见行为变化必须新增 version。 */

import type { HarnessProfileDescriptor } from "./types.ts";
import { STANDARD_EXECUTION_SYSTEM_PROMPT } from "./standard-prompt.ts";

export const MINIMAL_HARNESS_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";

const STANDARD_HARNESS_PROFILE = Object.freeze({
	id: "standard",
	version: 1,
	prompt: Object.freeze({ mode: "assembled" }),
	tools: Object.freeze({
		mode: "standard",
		allowlist: Object.freeze([]),
		allowBackgroundHandle: true,
	}),
	extensions: Object.freeze({
		tools: true,
		context: true,
		hooks: true,
		lifecycle: true,
	}),
	multiAgent: true,
} satisfies HarnessProfileDescriptor);

const STANDARD_EXECUTION_HARNESS_PROFILE = Object.freeze({
	...STANDARD_HARNESS_PROFILE,
	version: 2,
	prompt: Object.freeze({ mode: "assembled", text: STANDARD_EXECUTION_SYSTEM_PROMPT }),
} satisfies HarnessProfileDescriptor);

const MINIMAL_HARNESS_PROFILE = Object.freeze({
	id: "minimal",
	version: 1,
	prompt: Object.freeze({
		mode: "complete",
		text: MINIMAL_HARNESS_SYSTEM_PROMPT,
	}),
	tools: Object.freeze({
		mode: "allowlist",
		allowlist: Object.freeze(["bash", "edit"]),
		allowBackgroundHandle: false,
	}),
	extensions: Object.freeze({
		tools: false,
		context: false,
		hooks: false,
		lifecycle: false,
	}),
	multiAgent: false,
} satisfies HarnessProfileDescriptor);

const SHELL_ONLY_HARNESS_PROFILE = Object.freeze({
	...MINIMAL_HARNESS_PROFILE,
	version: 2,
	tools: Object.freeze({
		mode: "allowlist",
		allowlist: Object.freeze(["bash"]),
		allowBackgroundHandle: false,
	}),
} satisfies HarnessProfileDescriptor);

const PLAN_HARNESS_PROFILE = Object.freeze({
	id: "plan",
	version: 1,
	prompt: Object.freeze({
		mode: "complete",
		text: "You are RunLedger's planning assistant. Read and analyze the workspace without modifying it. Use plan_read to inspect the current plan and its revisions, then plan_write to maintain the plan artifact. Request user approval before implementation. You cannot execute shell commands or modify workspace files.",
	}),
	tools: Object.freeze({ mode: "allowlist", allowlist: Object.freeze(["read", "glob", "ls", "plan_read", "plan_write"]), allowBackgroundHandle: false }),
	extensions: MINIMAL_HARNESS_PROFILE.extensions,
	multiAgent: false,
} satisfies HarnessProfileDescriptor);

const BUILTIN_HARNESS_PROFILES = Object.freeze([
	STANDARD_HARNESS_PROFILE,
	MINIMAL_HARNESS_PROFILE,
	SHELL_ONLY_HARNESS_PROFILE,
	PLAN_HARNESS_PROFILE,
	STANDARD_EXECUTION_HARNESS_PROFILE,
] satisfies readonly HarnessProfileDescriptor[]);

export function builtinHarnessProfiles(): readonly HarnessProfileDescriptor[] {
	return BUILTIN_HARNESS_PROFILES;
}
