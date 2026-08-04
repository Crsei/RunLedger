/** 根据平台选择 sandbox plan backend；未实现的平台显式 unavailable。 */

import { LinuxBwrapBackend } from "./linux-bwrap.ts";
import { MacOsSeatbeltBackend } from "./macos-seatbelt.ts";
import { UnavailableSandboxBackend } from "./unavailable.ts";
import type { SandboxBackend, SandboxPlatform, SandboxProbePort } from "./types.ts";

export type SandboxPlatformInput = SandboxPlatform | "darwin" | "win32";

export interface SandboxBackendFactoryOptions {
	readonly probe?: SandboxProbePort;
	readonly linuxShellProgram?: string;
	readonly macosShellProgram?: string;
}

const missingProbe: SandboxProbePort = { which: async () => undefined };

function normalizedPlatform(platform: SandboxPlatformInput): SandboxPlatform {
	if (platform === "darwin") return "macos";
	if (platform === "win32") return "windows";
	return platform;
}

export function createSandboxBackend(platform: SandboxPlatformInput, options: SandboxBackendFactoryOptions = {}): SandboxBackend {
	const selected = normalizedPlatform(platform);
	const probe = options.probe ?? missingProbe;
	if (selected === "linux") return new LinuxBwrapBackend(probe, options.linuxShellProgram);
	if (selected === "macos") return new MacOsSeatbeltBackend(probe, options.macosShellProgram);
	if (selected === "windows") return new UnavailableSandboxBackend("windows", "native Windows sandbox backend is unavailable; no implicit downgrade is allowed", "cmd.exe");
	return new UnavailableSandboxBackend("unknown", `sandbox backend is unavailable for platform ${platform}`);
}
