/** Width-bounded process overlay presentation. */

import { fitToWidth } from "../components/render-width.ts";
import type { ProcessOverlayState } from "./types.ts";

export function renderProcessOverlay(state: ProcessOverlayState, width: number, height: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const safeHeight = Math.max(1, Math.floor(height));
	const selected = state.selectedExecutionId === undefined
		? undefined
		: state.processes.find((process) => process.executionId === state.selectedExecutionId);
	const lines: string[] = [];
	lines.push(`${state.mode === "list" ? "Processes" : state.mode === "terminal" ? "Terminal" : "Process"}${state.driver ? " · driver" : " · observer"}`);
	if (state.mode === "list") {
		for (const process of state.processes) {
			lines.push(`${process.executionId}  ${process.state}  out=${process.outputCursor.sequence}:${process.outputCursor.byteOffset}/${process.outputSize}`);
		}
		if (state.processes.length === 0) lines.push("No managed processes");
	} else if (selected) {
		lines.push(`${selected.executionId}  ${selected.state}`);
		lines.push(selected.commandDisplay === undefined || selected.commandDisplay.authority === "unavailable"
			? "command unavailable"
			: `${selected.commandDisplay.label} · ${selected.commandDisplay.authority}`);
		lines.push(`output cursor ${state.cursor}${state.truncated ? " · truncated" : ""}`);
		if (state.mode === "terminal") lines.push(state.driver ? "stdin/resize/stop enabled" : "observer · read only");
		for (const line of state.output.split("\n")) lines.push(line);
	} else {
		lines.push("Process is no longer available");
	}
	const clipped = lines.slice(0, safeHeight).map((line) => fitToWidth(line, safeWidth));
	while (clipped.length < safeHeight) clipped.push("");
	return clipped;
}
