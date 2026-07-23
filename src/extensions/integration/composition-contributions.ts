/** 共享 controller/CLI/TUI/ToolRegistry 的串行接线清单与 public handles。 */

import type { ExtensionManager } from "../extension-manager.ts";
import type { ExtensionControlPlane } from "../control-plane/control-plane.ts";
import { extensionViewModels } from "../control-plane/view-model.ts";
import { skillCatalogPromptFragment } from "../skills/renderer.ts";
import type { SkillToolResolver } from "../skills/skill-tool.ts";
import { McpCallTool, McpSearchTool, pinnedMcpTools } from "../mcp/tool-adapter.ts";
import type { RuntimeHookAdapter } from "./runtime-hook-adapter.ts";

export interface ExtensionCompositionContributions {
	snapshotId: string;
	systemPromptFragment: string;
	skillResolver: SkillToolResolver;
	mcpSearch: McpSearchTool;
	mcpCall: McpCallTool;
	pinnedTools: ReturnType<typeof pinnedMcpTools>;
	hooks: RuntimeHookAdapter;
	controlPlane: ExtensionControlPlane;
	viewModels: ReturnType<typeof extensionViewModels>;
	requestReload(): void;
	close(): Promise<void>;
}

export function createExtensionCompositionContributions(options: {
	manager: ExtensionManager;
	skillResolver: SkillToolResolver;
	hooks: RuntimeHookAdapter;
	controlPlane: ExtensionControlPlane;
	modelContextChars: number;
}): ExtensionCompositionContributions {
	const current = options.manager.current();
	if (!current) throw new Error("extension manager must be initialized before composition");
	return {
		snapshotId: current.snapshot.snapshotId,
		systemPromptFragment: skillCatalogPromptFragment(current.skills, options.modelContextChars),
		skillResolver: options.skillResolver,
		mcpSearch: new McpSearchTool(current.mcp),
		mcpCall: new McpCallTool(current.mcp),
		pinnedTools: pinnedMcpTools(current.mcp),
		hooks: options.hooks,
		controlPlane: options.controlPlane,
		viewModels: extensionViewModels(current),
		requestReload: () => { options.manager.requestReload(); },
		close: () => options.manager.close(),
	};
}
