import { TextRenderable, type RenderContext, type TextOptions } from "@opentui/core";
import { highlightResultToStyledText } from "../highlight/contracts.ts";
import type { SyntaxHighlightPriority, SyntaxHighlightService } from "../highlight/service.ts";
import type { SyntaxThemeController, SyntaxThemeSnapshot } from "../highlight/theme-controller.ts";

export type SyntectCodeBlockRenderableOptions = Omit<TextOptions, "content"> & {
	readonly source: string;
	readonly language: string;
	readonly highlightService: SyntaxHighlightService;
	readonly themeController: SyntaxThemeController;
};

export type HighlightAdmission = "visible" | "overscan" | "offscreen";

/** plaintext-first 的稳定 code block；异步 completion 只更新 derived StyledText。 */
export class SyntectCodeBlockRenderable extends TextRenderable {
	readonly source: string;
	readonly language: string;
	private readonly highlightService: SyntaxHighlightService;
	private readonly themeController: SyntaxThemeController;
	private readonly unsubscribeTheme: () => void;
	private requestGeneration = 0;
	private admission: HighlightAdmission = "offscreen";
	private pendingTheme: SyntaxThemeSnapshot;
	private scheduledSignature: string | undefined;

	constructor(ctx: RenderContext, options: SyntectCodeBlockRenderableOptions) {
		const { source, language, highlightService, themeController, ...renderableOptions } = options;
		super(ctx, {
			...renderableOptions,
			content: source,
			selectable: true,
			wrapMode: "none",
		});
		this.source = source;
		this.language = language;
		this.highlightService = highlightService;
		this.themeController = themeController;
		this.pendingTheme = themeController.snapshot();
		this.unsubscribeTheme = themeController.subscribe((snapshot) => {
			this.pendingTheme = snapshot;
			this.scheduleIfAdmitted();
		});
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
		const signature = `${theme.activeName}\u0000${theme.revision}`;
		if (signature === this.scheduledSignature) return;
		this.scheduledSignature = signature;
		const generation = ++this.requestGeneration;
		void this.highlightService.highlight({
			key: this.id,
			source: this.source,
			language: this.language,
			themeName: theme.activeName,
			themeRevision: theme.revision,
			priority: priorityForAdmission(this.admission),
		}).then((result) => {
			if (this.isDestroyed || generation !== this.requestGeneration) return;
			if (!result.ok || result.themeRevision !== this.themeController.snapshot().revision) {
				this.content = this.source;
				return;
			}
			const styled = highlightResultToStyledText(result);
			this.content = styled ?? this.source;
			this.requestRender();
		});
	}
}

function priorityForAdmission(admission: Exclude<HighlightAdmission, "offscreen">): SyntaxHighlightPriority {
	return admission;
}
