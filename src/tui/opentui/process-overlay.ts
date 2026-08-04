/** Native OpenTUI managed-process terminal overlay. */

import {
	BoxRenderable,
	TextRenderable,
	TextareaRenderable,
	type CliRenderer,
	type KeyEvent,
} from "@opentui/core";
import { fitToWidth } from "../components/render-width.ts";
import { ansiToStyledText } from "./ansi-styled-text.ts";
import type { OutputCursor } from "../../runtime/process/output.ts";

export interface ManagedProcessOverlayFrame {
	readonly title: string;
	readonly state: string;
	readonly output: readonly string[];
	readonly cursor: OutputCursor;
	readonly driver: boolean;
	readonly canWrite: boolean;
	readonly canResize: boolean;
	readonly canStop: boolean;
}

export interface ManagedProcessOverlayOptions {
	onInput(value: string): void;
	restoreFocus(): void;
}

export interface ManagedProcessOverlayRuntime {
	update(frame: ManagedProcessOverlayFrame): void;
	close(): void;
}

export function createManagedProcessOverlayFromRenderer(
	renderer: CliRenderer,
	options: ManagedProcessOverlayOptions,
): ManagedProcessOverlayRuntime {
	let overlay: BoxRenderable | undefined;
	let input: TextareaRenderable | undefined;
	let active = false;
	const onKeypress = (key: KeyEvent): void => {
		if (!active || input === undefined) return;
		key.preventDefault();
		key.stopPropagation();
		const value = key.sequence || key.raw || key.name;
		if (value.length > 0) options.onInput(value);
	};
	const onPaste = (event: { readonly bytes: Uint8Array; preventDefault(): void; stopPropagation(): void }): void => {
		if (!active || input === undefined) return;
		event.preventDefault();
		event.stopPropagation();
		options.onInput(new TextDecoder().decode(event.bytes));
	};
	renderer.keyInput.on("keypress", onKeypress);
	renderer.keyInput.on("paste", onPaste);

	const close = (): void => {
		if (!active) return;
		active = false;
		input = undefined;
		overlay?.destroyRecursively();
		overlay = undefined;
		options.restoreFocus();
		renderer.requestRender();
	};

	return {
		update: (frame) => {
			active = true;
			overlay?.destroyRecursively();
			input = undefined;
			const width = Math.max(1, renderer.width - 4);
			overlay = new BoxRenderable(renderer, {
				id: "runledger-process-overlay",
				position: "absolute",
				left: 1,
				top: 1,
				width: "95%",
				maxHeight: "90%",
				zIndex: 200,
				borderStyle: "rounded",
				padding: 1,
				flexDirection: "column",
			});
			overlay.add(new TextRenderable(renderer, {
				id: "runledger-process-overlay-title",
				width: "100%",
				height: 1,
				content: fitToWidth(`${frame.title} · ${frame.state}`, width),
			}));
			overlay.add(new TextRenderable(renderer, {
				id: "runledger-process-overlay-status",
				width: "100%",
				height: 1,
				content: `${frame.driver ? "driver" : "observer · read only"} · cursor ${frame.cursor.sequence}:${frame.cursor.byteOffset}${frame.canResize ? " · resize" : ""}${frame.canStop ? " · stop" : ""}`,
			}));
			const output = frame.output.slice(-Math.max(1, renderer.height - 8)).map((line) => fitToWidth(line, width)).join("\n");
			overlay.add(new TextRenderable(renderer, {
				id: "runledger-process-overlay-output",
				width: "100%",
				flexGrow: 1,
				content: ansiToStyledText(output),
			}));
			if (frame.driver && frame.canWrite) {
				input = new TextareaRenderable(renderer, {
					id: "runledger-process-overlay-input",
					width: "100%",
					height: 2,
					placeholder: "stdin…",
					wrapMode: "word",
				});
				overlay.add(input);
				input.focus();
			}
			renderer.root.add(overlay);
			renderer.requestRender();
		},
		close,
	};
}
