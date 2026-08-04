/** R9 process list/detail/terminal overlay。
 *
 * 该组件只消费 ProcessOverlayController 的 safe DTO/page。它不读取 process
 * journal、output 文件或 backend handle；driver mutation 也只能通过 Host
 * facade adapter 发出。
 */

import type { Component } from "../index.ts";
import { matchesKey } from "../primitives.ts";
import type { PresentationBlock } from "../presentation.ts";
import type { ProcessOverlayController } from "./controller-adapter.ts";
import { renderProcessOverlay } from "./presentation.ts";

export interface ProcessOverlayComponentOptions {
	readonly controller: ProcessOverlayController;
	readonly onClose: () => void;
	readonly onChange?: () => void;
	readonly onNotice?: (message: string) => void;
	readonly getHeight?: () => number;
	readonly getTerminalSize?: () => { readonly columns: number; readonly rows: number };
}

export class ProcessOverlayComponent implements Component {
	private readonly controller: ProcessOverlayController;
	private readonly onClose: () => void;
	private readonly onChange?: () => void;
	private readonly onNotice?: (message: string) => void;
	private readonly getHeight: () => number;
	private readonly getTerminalSize: () => { readonly columns: number; readonly rows: number };
	private listIndex = 0;

	public constructor(options: ProcessOverlayComponentOptions) {
		this.controller = options.controller;
		this.onClose = options.onClose;
		this.onChange = options.onChange;
		this.onNotice = options.onNotice;
		this.getHeight = options.getHeight ?? (() => 16);
		this.getTerminalSize = options.getTerminalSize ?? (() => ({ columns: 80, rows: 24 }));
	}

	public async openList(): Promise<void> {
		try {
			await this.controller.refresh();
			this.listIndex = 0;
			this.controller.dispatch({ type: "open_list" });
			this.onChange?.();
		} catch (error) {
			this.onNotice?.(`Process list unavailable: ${String(error)}`);
		}
	}

	public async openTerminal(executionId: Parameters<ProcessOverlayController["openTerminal"]>[0]): Promise<void> {
		try {
			if (!this.controller.snapshot().processes.some((process) => process.executionId === executionId)) {
				await this.controller.refresh();
			}
			await this.controller.openTerminal(executionId);
			await this.controller.loadOutput();
			this.onChange?.();
		} catch (error) {
			this.onNotice?.(`Terminal unavailable: ${String(error)}`);
		}
	}

	public invalidate(): void {}

	public render(width: number): string[] {
		return renderProcessOverlay(this.controller.snapshot(), width, this.getHeight());
	}

	public present(width: number): PresentationBlock[] {
		const state = this.controller.snapshot();
		const blocks: PresentationBlock[] = [{
			kind: "text",
			content: renderProcessOverlay(state, width, this.getHeight()).join("\n"),
		}];
		if (state.mode === "terminal" && state.driver) {
			blocks.push({
				kind: "input",
				title: "stdin",
				message: "Enter sends a newline; Ctrl+S stops; Esc closes",
				value: "",
				placeholder: "type bounded stdin",
			});
		}
		return blocks;
	}

	public handleInput(data: string): void {
		const state = this.controller.snapshot();
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.controller.close();
			this.onClose();
			this.onChange?.();
			return;
		}
		if (state.mode === "list") {
			this.handleListInput(data, state.processes.length);
			return;
		}
		if (state.mode === "detail") {
			if (data === "t" || matchesKey(data, "enter")) {
				const executionId = state.selectedExecutionId;
				if (executionId !== undefined) void this.openTerminal(executionId);
			}
			if (data === "o") void this.loadOutput();
			return;
		}
		this.handleTerminalInput(data, state);
	}

	private handleListInput(data: string, count: number): void {
		if (count === 0) return;
		if (matchesKey(data, "up")) {
			this.listIndex = (this.listIndex - 1 + count) % count;
			this.onChange?.();
			return;
		}
		if (matchesKey(data, "down")) {
			this.listIndex = (this.listIndex + 1) % count;
			this.onChange?.();
			return;
		}
		if (matchesKey(data, "enter") || data === "d") {
			const process = this.controller.snapshot().processes[this.listIndex];
			if (process) {
				void this.controller.openDetail(process.executionId).then(() => this.onChange?.());
			}
			return;
		}
		if (data === "t") {
			const process = this.controller.snapshot().processes[this.listIndex];
			if (process) void this.openTerminal(process.executionId);
		}
	}

	private handleTerminalInput(data: string, state: ReturnType<ProcessOverlayController["snapshot"]>): void {
		if (matchesKey(data, "ctrl+s")) {
			void this.controller.stop().then((result) => {
				if (!result.ok) this.onNotice?.(`Process stop rejected: ${result.code}`);
				this.onChange?.();
			});
			return;
		}
		if (matchesKey(data, "ctrl+r")) {
			const size = this.getTerminalSize();
			void this.controller.resize(size.columns, size.rows).then((result) => {
				if (!result.ok) this.onNotice?.(`PTY resize rejected: ${result.code}`);
				this.onChange?.();
			});
			return;
		}
		if (matchesKey(data, "enter")) {
			void this.write("\n");
			return;
		}
		if (state.driver && !/[\u0000-\u001f\u007f]/u.test(data)) void this.write(data);
	}

	private async loadOutput(): Promise<void> {
		await this.controller.loadOutput();
		this.onChange?.();
	}

	private async write(input: string): Promise<void> {
		const result = await this.controller.write(input);
		if (!result.ok) this.onNotice?.(`Process input rejected: ${result.code}`);
		this.onChange?.();
	}
}
