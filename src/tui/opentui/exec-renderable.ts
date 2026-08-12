import { RGBA, StyledText, TextAttributes, TextRenderable, type RenderContext, type TextChunk, type TextOptions } from "@opentui/core";
import { highlightResultToStyledText } from "../highlight/contracts.ts";
import type { SyntaxHighlightService } from "../highlight/service.ts";
import type { SyntaxThemeController, SyntaxThemeSnapshot } from "../highlight/theme-controller.ts";
import type { PresentationBlock } from "../presentation.ts";
import { ansiToStyledText } from "./ansi-styled-text.ts";
import type { HighlightAdmission } from "./syntect-code-block-renderable.ts";

type ExecBlock = Extract<PresentationBlock, { readonly kind: "exec" }>;
type CommandBlock = Extract<PresentationBlock, { readonly kind: "command" }>;
type CommandPresentationBlock = ExecBlock | CommandBlock;

export type ExecRenderableOptions = Omit<TextOptions, "content"> & {
	readonly block: CommandPresentationBlock;
	readonly highlightService: SyntaxHighlightService;
	readonly themeController: SyntaxThemeController;
};

export class ExecRenderable extends TextRenderable {
	private block: CommandPresentationBlock;
	private readonly highlightService: SyntaxHighlightService;
	private readonly themeController: SyntaxThemeController;
	private readonly unsubscribeTheme: () => void;
	private requestGeneration = 0;
	private admission: HighlightAdmission = "offscreen";
	private pendingTheme: SyntaxThemeSnapshot;
	private scheduledSignature: string | undefined;

	constructor(ctx: RenderContext, options: ExecRenderableOptions) {
		const { block, highlightService, themeController, ...renderableOptions } = options;
		super(ctx, { ...renderableOptions, content: plainExecText(block), selectable: true, wrapMode: "none" });
		this.block = block;
		this.highlightService = highlightService;
		this.themeController = themeController;
		this.pendingTheme = themeController.snapshot();
		this.unsubscribeTheme = themeController.subscribe((snapshot) => {
			this.pendingTheme = snapshot;
			this.scheduleIfAdmitted();
		});
	}

	updateBlock(block: CommandPresentationBlock): void {
		this.block = block;
		this.content = plainExecText(block);
		this.scheduledSignature = undefined;
		this.scheduleIfAdmitted();
	}

	setHighlightAdmission(admission: HighlightAdmission): void {
		if (this.isDestroyed || admission === this.admission) return;
		this.admission = admission;
		if (admission === "offscreen") {
			this.requestGeneration += 1;
			this.scheduledSignature = undefined;
			this.highlightService.cancel(this.id);
			return;
		}
		this.scheduleIfAdmitted();
	}

	override destroy(): void {
		if (this.isDestroyed) return;
		this.requestGeneration += 1;
		this.unsubscribeTheme();
		super.destroy();
	}

	private scheduleIfAdmitted(): void {
		if (this.isDestroyed || this.admission === "offscreen") return;
		const theme = this.pendingTheme;
		const signature = `${theme.activeName}\u0000${theme.revision}\u0000${this.block.command}`;
		if (signature === this.scheduledSignature) return;
		this.scheduledSignature = signature;
		const generation = ++this.requestGeneration;
		const command = stripShellLoginWrapper(this.block.command);
		void this.highlightService.highlight({
			key: this.id,
			source: command,
			language: "bash",
			themeName: theme.activeName,
			themeRevision: theme.revision,
			priority: this.admission,
		}).then((result) => {
			if (this.isDestroyed || generation !== this.requestGeneration) return;
			const highlighted = result.ok && result.themeRevision === this.themeController.snapshot().revision
				? highlightResultToStyledText(result)
				: undefined;
			this.content = styledExecText(this.block, command, highlighted);
			this.requestRender();
		});
	}
}

export function stripShellLoginWrapper(command: string): string {
	if (/^[A-Za-z]:\\/u.test(command)) return command;
	const match = /^(?:\/[^\s'"]+\/)?(?:bash|zsh)\s+-lc\s+([\s\S]+)$/u.exec(command.trim());
	if (!match) return command;
	const script = match[1]!;
	if (script.length < 2) return script;
	const quote = script[0];
	if ((quote !== "'" && quote !== '"') || script.at(-1) !== quote) return script;
	const inner = script.slice(1, -1);
	return quote === "'" ? inner.replace(/\\'/gu, "'") : inner.replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
}

function styledExecText(block: CommandPresentationBlock, command: string, highlighted: StyledText | undefined): StyledText {
	const chunks: TextChunk[] = [semanticChunk("$ ", 5)];
	chunks.push(...(highlighted?.chunks ?? [{ __isChunk: true, text: command }]));
	if (block.kind === "command") return new StyledText(chunks);
	chunks.push(statusChunk(block));
	for (const output of block.output) {
		chunks.push({ __isChunk: true, text: "\n" });
		for (const chunk of ansiToStyledText(output.text).chunks) {
			chunks.push({ ...chunk, attributes: (chunk.attributes ?? TextAttributes.NONE) | TextAttributes.DIM });
		}
	}
	return new StyledText(chunks);
}

function statusChunk(block: ExecBlock): TextChunk {
	const duration = block.durationMs === undefined ? "" : ` · ${Math.round(block.durationMs)}ms`;
	if (block.status === "succeeded") return semanticChunk(`  ✓${duration}`, 2, TextAttributes.BOLD);
	if (["failed", "cancelled", "aborted"].includes(block.status)) {
		const exit = block.exitCode === undefined ? "" : ` exit ${block.exitCode}`;
		return semanticChunk(`  ✗${exit}${duration}`, 1, TextAttributes.BOLD);
	}
	return { __isChunk: true, text: `  ${block.status}${duration}`, attributes: TextAttributes.DIM };
}

function semanticChunk(text: string, index: number, attributes?: number): TextChunk {
	return { __isChunk: true, text, fg: RGBA.fromIndex(index), ...(attributes === undefined ? {} : { attributes }) };
}

function plainExecText(block: CommandPresentationBlock): string {
	const command = stripShellLoginWrapper(block.command);
	if (block.kind === "command") return `$ ${command}`;
	const status = block.status === "succeeded" ? "✓" : ["failed", "cancelled", "aborted"].includes(block.status) ? "✗" : block.status;
	const duration = block.durationMs === undefined ? "" : ` · ${Math.round(block.durationMs)}ms`;
	return [`$ ${command}  ${status}${duration}`, ...block.output.map((chunk) => chunk.text)].join("\n");
}
