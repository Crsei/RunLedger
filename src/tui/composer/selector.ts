import type { Component, SelectListTheme } from "../primitives.ts";
import { fitLinesToWidth } from "../components/render-width.ts";
import { ListSelectionModal, type ListSelectionItem } from "../components/list-selection-modal.ts";
import { renderComposerShapePreview } from "./preview.ts";
import type { ComposerShapeOption, ComposerShapeRegistry } from "./registry.ts";
import type { ComposerShapeSettingsPort } from "./types.ts";

export interface ComposerShapeSelectorProps {
	readonly registry: ComposerShapeRegistry;
	readonly options: readonly ComposerShapeOption[];
	readonly initialShape: string;
	readonly selectListTheme: SelectListTheme;
	readonly settingsPort: ComposerShapeSettingsPort;
	readonly onCommitted: (shape: string) => void;
	readonly onCancel: () => void;
	readonly onSaveFailure: (code: string) => void;
}

/** `/shape` 的最小 selector；列表导航委托给既有 ListSelectionModal。 */
export class ComposerShapeSelector implements Component {
	private readonly props: ComposerShapeSelectorProps;
	private readonly list: ListSelectionModal;
	private previewValue: string;
	private committing = false;

	constructor(props: ComposerShapeSelectorProps) {
		this.props = props;
		const initial = props.options.some((option) => option.id === props.initialShape)
			? props.initialShape
			: props.options[0]?.id ?? "box";
		this.previewValue = initial;
		const items: ListSelectionItem[] = props.options.map((option) => ({
			value: option.id,
			name: option.label,
			description: option.description,
			isCurrent: option.id === initial,
		}));
		this.list = new ListSelectionModal({
			title: "Composer Shape",
			subtitle: "Preview the input frame, then press Enter to save.",
			items,
			initialSelectedValue: initial,
			selectListTheme: props.selectListTheme,
			onSelectionChange: (item) => {
				this.previewValue = item.value;
			},
			onSelect: (item) => {
				void this.commit(item.value);
			},
			onCancel: props.onCancel,
		});
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (!this.committing) this.list.handleInput(data);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const style = this.props.registry.getComposerStyle(this.previewValue);
		const preview = renderComposerShapePreview(style, safeWidth);
		return fitLinesToWidth([
			...this.list.render(safeWidth),
			"",
			`Preview: ${style.label}`,
			...preview.lines,
		], safeWidth);
	}

	private async commit(shape: string): Promise<void> {
		if (this.committing) return;
		this.committing = true;
		try {
			const result = await this.props.settingsPort.save(shape);
			if (result.ok) this.props.onCommitted(shape);
			else {
				this.committing = false;
				this.props.onSaveFailure(result.code);
			}
		} catch {
			this.committing = false;
			this.props.onSaveFailure("composer_shape_settings_save_failed");
		}
	}
}
