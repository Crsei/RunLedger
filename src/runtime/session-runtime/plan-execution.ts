/** Plan profile 的不可放宽效果边界；底层只读操作仍经 Security gateway。 */
import type { ExecutionEnv } from "../execution-env.ts";

export function planReadOnlyExecutionEnv(base: ExecutionEnv): ExecutionEnv {
	const denied = async (code: string): Promise<never> => { throw new Error(code); };
	return {
		cwd: base.cwd,
		fs: {
			readFile: (path) => base.fs.readFile(path),
			stat: (path) => base.fs.stat(path),
			readdir: (path) => base.fs.readdir(path),
			writeFile: () => denied("plan_mode_write_denied"),
			mkdir: () => denied("plan_mode_write_denied"),
			rm: () => denied("plan_mode_write_denied"),
			rename: () => denied("plan_mode_write_denied"),
		},
		shell: { exec: () => denied("plan_mode_process_denied") },
		network: { request: () => denied("plan_mode_network_denied") },
	};
}
