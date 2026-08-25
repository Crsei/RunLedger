import type { Component, SelectListTheme } from "../primitives.ts";
import { fitLinesToWidth } from "../components/render-width.ts";
import { ListSelectionModal, type ListSelectionItem } from "../components/list-selection-modal.ts";
import { renderComposerShapePreview } from "../composer/preview.ts";
import type { ComposerShapeRegistry } from "../composer/registry.ts";
import type { ComposerShapeSettingsPort } from "../composer/types.ts";

export interface ComposerSetupWizardProps {
	readonly registry: ComposerShapeRegistry;
	readonly initialShape: string;
	readonly selectListTheme: SelectListTheme;
	readonly settingsPort: ComposerShapeSettingsPort;
	readonly onCommitted: (shape: string) => void;
	readonly onCancel: () => void;
	readonly onSaveFailure: (code: string) => void;
}

/** setup wizard 的单一 composer-shape scene；options 不另存一份。 */
export class ComposerSetupWizardScene implements Component {
	readonly sceneId = "composer-shape";
	private readonly props: ComposerSetupWizardProps;
	private readonly registry: ComposerShapeRegistry;
	private readonly settingsPort: ComposerShapeSettingsPort;
	private readonly list: ListSelectionModal;
	private previewValue: string;
	private committing = false;

	constructor(props: ComposerSetupWizardProps) {
		this.props = props;
		this.registry = props.registry;
		this.settingsPort = props.settingsPort;
		const options = props.registry.getComposerShapeOptions();
		const initial = options.some((option) => option.id === props.initialShape)
			? props.initialShape
			: options[0]?.id ?? "box";
		this.previewValue = initial;
		const items: ListSelectionItem[] = options.map((option) => ({
			value: option.id,
			name: option.label,
			description: option.description,
			isCurrent: option.id === initial,
		}));
		this.list = new ListSelectionModal({
			title: "Setup · Composer Shape",
			subtitle: "Choose the prompt and status layout for this user.",
			items,
			initialSelectedValue: initial,
			selectListTheme: props.selectListTheme,
			footerHint: "Press Enter to save or Esc to skip setup",
			onSelectionChange: (item) => { this.previewValue = item.value; },
			onSelect: (item) => { void this.commit(item.value); },
			onCancel: props.onCancel,
		});
	}

	invalidate(): void {
		this.list.invalidate();
	}

	handleInput(data: string): void {
		if (!this.committing) this.list.handleInput(data);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const style = this.registry.getComposerStyle(this.previewValue);
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
			const result = await this.settingsPort.save(shape);
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

/** Overlay runner；InteractiveMode 只拥有提交后的 sync/close authority。 */
export class ComposerSetupWizard implements Component {
	readonly sceneId = "composer-shape";
	private readonly scene: ComposerSetupWizardScene;

	constructor(props: ComposerSetupWizardProps) {
		this.scene = new ComposerSetupWizardScene(props);
	}

	invalidate(): void {
		this.scene.invalidate();
	}

	handleInput(data: string): void {
		this.scene.handleInput(data);
	}

	render(width: number): string[] {
		return this.scene.render(width);
	}
}
