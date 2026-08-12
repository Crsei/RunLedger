import { posix, win32 } from "node:path";
import { sanitizeLabel } from "../tui/presentation/projectors.ts";
import type { GitCommandPort } from "../worktree/ports.ts";

const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/u;

/** composition root 专用：把 native cwd 降为安全的 home-relative/basename label。 */
export function workspaceDisplayLabel(cwd: string, userHome: string): string {
	const pathApi = WINDOWS_ABSOLUTE_PATH.test(cwd) || WINDOWS_ABSOLUTE_PATH.test(userHome) ? win32 : posix;
	const absoluteCwd = pathApi.resolve(cwd);
	const absoluteHome = pathApi.resolve(userHome);
	const sameRoot = pathApi.parse(absoluteCwd).root.toLowerCase() === pathApi.parse(absoluteHome).root.toLowerCase();
	const fromHome = sameRoot ? pathApi.relative(absoluteHome, absoluteCwd) : absoluteCwd;
	if (fromHome === "") return "~";
	if (sameRoot && !pathApi.isAbsolute(fromHome) && fromHome !== ".." && !fromHome.startsWith(`..${pathApi.sep}`)) {
		return sanitizeLabel(`~/${fromHome.replaceAll("\\", "/")}`) || "unknown";
	}
	return sanitizeLabel(pathApi.basename(absoluteCwd) || pathApi.basename(pathApi.dirname(absoluteCwd))) || "unknown";
}

export function workspaceDisplayLabelForView(
	view: { readonly effectiveCwd: string | undefined },
	userHome: string,
): string | undefined {
	return view.effectiveCwd === undefined ? undefined : workspaceDisplayLabel(view.effectiveCwd, userHome);
}

export interface GitWorkspaceDisplayFacts {
	readonly projectRootLabel?: string;
	readonly branchLabel?: string;
}

/** 只读 Git facts；失败时省略，不伪造 root/branch，也不返回原始 root。 */
export async function gitWorkspaceDisplayFacts(cwd: string, git: GitCommandPort): Promise<GitWorkspaceDisplayFacts> {
	const root = await git.run({ cwd, arguments: ["rev-parse", "--show-toplevel"], stdin: "", timeoutMs: 2_000 });
	const branch = await git.run({ cwd, arguments: ["symbolic-ref", "--quiet", "--short", "HEAD"], stdin: "", timeoutMs: 2_000 });
	const rootLabel = root.exitCode === 0 ? sanitizeLabel(posix.basename(root.stdout.trim().replaceAll("\\", "/"))) : "";
	const branchLabel = branch.exitCode === 0 ? sanitizeLabel(branch.stdout) : "";
	return {
		...(rootLabel.length === 0 ? {} : { projectRootLabel: rootLabel }),
		...(branchLabel.length === 0 ? {} : { branchLabel }),
	};
}
