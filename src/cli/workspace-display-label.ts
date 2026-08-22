import { sanitizeLabel } from "../tui/presentation/projectors.ts";
import type { GitCommandPort } from "../worktree/ports.ts";

/** agent 运行时绝对地址：只 sanitize + 有界，不做 home-relative/basename 降级（用户显式要求展示）。 */
export function workspaceDisplayAbsolutePath(cwd: string): string {
	return sanitizeLabel(cwd) || "unknown";
}

export function workspaceDisplayAbsolutePathForView(
	view: { readonly effectiveCwd: string | undefined },
): string | undefined {
	return view.effectiveCwd === undefined ? undefined : workspaceDisplayAbsolutePath(view.effectiveCwd);
}

export interface GitWorkspaceDisplayFacts {
	readonly branchLabel?: string;
}

/** 只读 Git branch fact；失败时省略，不伪造分支。 */
export async function gitWorkspaceDisplayFacts(cwd: string, git: GitCommandPort, enabled = true): Promise<GitWorkspaceDisplayFacts> {
	if (!enabled) return {};
	const branch = await git.run({ cwd, arguments: ["symbolic-ref", "--quiet", "--short", "HEAD"], stdin: "", timeoutMs: 2_000 });
	const branchLabel = branch.exitCode === 0 ? sanitizeLabel(branch.stdout) : "";
	return {
		...(branchLabel.length === 0 ? {} : { branchLabel }),
	};
}
