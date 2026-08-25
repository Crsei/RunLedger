import {
	createTrustedComposerShapeLifecycle,
	type ComposerShapeLifecycle,
	type ComposerShapeLifecycleResult,
	type TrustedComposerShapeSource,
} from "../tui/composer/extension-lifecycle.ts";
import type { ComposerShapeRegistry } from "../tui/composer/registry.ts";

export interface CliComposerShapeCompositionOptions {
	readonly registry: ComposerShapeRegistry;
	/** 只允许 CLI composition root 显式提供 first-party sources。 */
	readonly trustedSources?: readonly TrustedComposerShapeSource[];
}

export interface CliComposerShapeComposition {
	readonly registry: ComposerShapeRegistry;
	load(): ComposerShapeLifecycleResult;
	reload(): ComposerShapeLifecycleResult;
	dispose(): void;
}

/**
 * TUI-local composer contribution composition。
 *
 * 这里不消费 SessionRuntime/Host extension snapshot，也不把 plugin manifest
 * 当作可执行 renderer source；任何 source 必须由当前 CLI 进程的可信组合代码
 * 显式传入，并且只通过 framework-neutral ComposerStyle 进入 registry。
 */
export function createCliComposerShapeComposition(
	options: CliComposerShapeCompositionOptions,
): CliComposerShapeComposition {
	const lifecycle: ComposerShapeLifecycle = createTrustedComposerShapeLifecycle(
		options.registry,
		options.trustedSources ?? [],
	);
	return Object.freeze({
		registry: options.registry,
		load: () => lifecycle.load(),
		reload: () => lifecycle.reload(),
		dispose: () => lifecycle.dispose(),
	});
}
