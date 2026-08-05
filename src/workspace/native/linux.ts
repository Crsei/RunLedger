/** Linux native workspace adapters（P4，真实 runner 证据已采集：tests/fixtures/platform-evidence/linux/）。 */

import { createNativeWorkspaceAdapters } from "./adapters.ts";
import type { NativeAdapterDeps, WorkspaceAdapters } from "./types.ts";

export function createLinuxWorkspaceAdapters(deps: NativeAdapterDeps): WorkspaceAdapters {
	return createNativeWorkspaceAdapters("linux", deps);
}
