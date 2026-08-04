/** Worktree 低层命令 broker；实现目录不直接 spawn。 */

export interface GitCommandRequest {
	readonly cwd: string;
	readonly arguments: readonly string[];
	readonly stdin?: string;
	readonly timeoutMs: number;
}

export interface GitCommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly signaled: boolean;
}

export interface GitCommandPort {
	run(request: GitCommandRequest, signal?: AbortSignal): Promise<GitCommandResult>;
}
