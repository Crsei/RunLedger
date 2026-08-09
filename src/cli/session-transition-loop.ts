import type { InteractiveExitIntent } from "../tui/interactive-mode.ts";

export interface SessionTransitionView {
	readonly sessionId: string;
}

export interface SessionSwitchFailure {
	readonly fromSessionId: string;
	readonly targetSessionId: string;
	readonly error: unknown;
}

export interface SessionTransitionLoopOptions<TView extends SessionTransitionView> {
	readonly initialSessionId: string;
	readonly open: (sessionId: string) => Promise<TView>;
	readonly run: (view: TView) => Promise<InteractiveExitIntent>;
	readonly detach: (view: TView) => Promise<void>;
	readonly onSwitchFailure?: (failure: SessionSwitchFailure) => void;
}

/** S2:canonical open -> TUI -> detach -> switch/quit；失败只用同一 open 回原 Session。 */
export async function runSessionTransitionLoop<TView extends SessionTransitionView>(
	options: SessionTransitionLoopOptions<TView>,
): Promise<void> {
	let current = await options.open(options.initialSessionId);
	while (true) {
		let intent: InteractiveExitIntent;
		try {
			intent = await options.run(current);
		} catch (error) {
			await options.detach(current);
			throw error;
		}
		const fromSessionId = current.sessionId;
		await options.detach(current);
		if (intent.kind === "quit") return;
		try {
			current = await options.open(intent.target.sessionId);
		} catch (error) {
			options.onSwitchFailure?.({ fromSessionId, targetSessionId: intent.target.sessionId, error });
			current = await options.open(fromSessionId);
		}
	}
}
