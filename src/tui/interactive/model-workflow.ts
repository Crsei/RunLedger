/**
 * S7 拆分:model workflow —— provider/model/thinking 选择。
 *
 * 一级弹窗(quick pick)与二级全量列表共用 workflow ready 快照投影;
 * authoritative selection 由 controller/Host 返回后更新 view。
 */

import { SecondarySelectionView, type SecondarySelectionItem } from "../components/list-selection-modal.ts";
import { SelectorModal } from "../components/selector-modal.ts";
import { makeSelectListTheme } from "../theme/factories.ts";
import type { SelectItem } from "../primitives.ts";
import type { ModelThinkingLevel } from "../../types.ts";
import type { InteractiveModePorts } from "./types.ts";

export interface ModelPickerModel {
	readonly providerId: string;
	readonly modelId: string;
	readonly label: string;
}

export class ModelWorkflow {
	private readonly port: InteractiveModePorts;
	private modelPickSource: {
		readonly models: readonly ModelPickerModel[];
		readonly currentProviderId?: string;
		readonly currentModelId?: string;
	} | undefined;

	public constructor(port: InteractiveModePorts) {
		this.port = port;
	}

	/**
	 * B5:/model 选择器走 model workflow；controller 返回 authoritative selection
	 * 后再更新 view。local demo（无 controller）显示 unavailable，不回退假 registry。
	 */
	public openModelSelector(provider?: string): void {
		void this.openModelWorkflowSelector(provider);
	}

	/** /model 二级弹窗的模型快照(workflow ready 值的投影)。 */
	private async openModelWorkflowSelector(provider?: string): Promise<void> {
		const port = this.port;
		if (port.store.getState().capabilities.model.state !== "available") {
			port.showNotice("Model selection is unavailable in this session.", "error");
			return;
		}
		const effect = port.createEffect("model.list", { providerId: provider ?? "" });
		port.store.dispatch({ type: "query.start", effect });
		port.runner.dispatch(effect);
		const workflow = await port.waitForWorkflow("modelWorkflow", effect.correlationId);
		if (workflow.state === "ready") {
			const value = workflow.value as {
				readonly models?: readonly { readonly providerId: string; readonly modelId: string; readonly label: { readonly text: string } }[];
				readonly currentProviderId?: string;
				readonly currentModelId?: string;
			};
			const models: ModelPickerModel[] = (value.models ?? []).map((model) => ({
				providerId: model.providerId,
				modelId: model.modelId,
				label: model.label.text,
			}));
			if (models.length === 0) {
				port.showNotice(provider
					? `No available models for ${provider}. Configure authentication first.`
					: "No available models. Use /provider or /login first.", "error");
				return;
			}
			this.modelPickSource = {
				models,
				currentProviderId: value.currentProviderId,
				currentModelId: value.currentModelId,
			};
			if (provider !== undefined) this.openModelListModal(provider, { back: false });
			else this.openModelQuickPickModal();
			return;
		}
		if (workflow.state === "empty") {
			port.showNotice("No available models. Use /provider or /login first.", "error");
			return;
		}
		if (workflow.state === "error") {
			port.showNotice(`Model discovery failed: ${workflow.message}`, "error");
			return;
		}
		port.showNotice(`Model selection is unavailable: ${workflow.state === "unavailable" ? workflow.reason : "unknown outcome"}`, "error");
	}

	/**
	 * 一级弹窗(对照 codex open_model_popup_with_presets):配置了模型的 provider
	 * 作为快速选择项,末尾固定 "All models" 进入全量列表。
	 */
	private openModelQuickPickModal(): void {
		const source = this.modelPickSource;
		if (!source) return;
		const counts = new Map<string, number>();
		for (const model of source.models) {
			counts.set(model.providerId, (counts.get(model.providerId) ?? 0) + 1);
		}
		const providers = [...counts.keys()];
		const items: SecondarySelectionItem[] = providers.map((providerId) => ({
			value: providerId,
			name: providerId,
			description: `${counts.get(providerId) ?? 0} available models`,
			isCurrent: source.currentProviderId === providerId,
		}));
		const currentLabel = this.currentModelLabel(source);
		items.push({
			value: "all",
			name: "All models",
			description: currentLabel === undefined
				? "Choose a specific model and provider"
				: `Choose a specific model and provider (current: ${currentLabel})`,
		});
		const modal = new SecondarySelectionView({
			title: "Select Model",
			subtitle: "Pick a quick provider or browse all models.",
			items,
			selectListTheme: this.selectListTheme(),
			onSelect: (item) => {
				this.port.closeOverlay();
				if (item.value === "all") this.openModelListModal(undefined, { back: true });
				else this.openModelListModal(item.value, { back: true });
			},
			onCancel: () => this.port.closeOverlay(),
		});
		this.port.showOverlayModal(modal, { anchor: "bottom-left" });
	}

	/**
	 * 二级弹窗(对照 codex open_all_models_popup):全量或单 provider 的模型列表,
	 * 行尾 (current) 标记当前选择;Esc 返回一级(back 时),否则关闭。
	 */
	private openModelListModal(providerId: string | undefined, opts: { readonly back: boolean }): void {
		const source = this.modelPickSource;
		if (!source) return;
		const models = providerId === undefined
			? source.models
			: source.models.filter((model) => model.providerId === providerId);
		if (models.length === 0) {
			this.port.showNotice(`No available models for ${providerId}. Configure authentication first.`, "error");
			return;
		}
		const currentLabel = this.currentModelLabel(source);
		const items: SecondarySelectionItem[] = models.map((model) => ({
			value: `${model.providerId}/${model.modelId}`,
			name: model.label,
			description: providerId === undefined ? `[${model.providerId}]` : model.modelId,
			isCurrent: source.currentProviderId === model.providerId && source.currentModelId === model.modelId,
		}));
		const suffix = currentLabel === undefined ? "" : ` (current: ${currentLabel})`;
		const modal = new SecondarySelectionView({
			title: providerId === undefined ? "Select Model and Provider" : `Select Model — ${providerId}`,
			subtitle: providerId === undefined
				? `Choose a specific model and provider${suffix}`
				: `Choose a specific model${suffix}`,
			items,
			selectListTheme: this.selectListTheme(),
			onSelect: (item) => {
				this.port.closeOverlay();
				void this.selectModelByKey(item.value);
			},
			onCancel: () => {
				this.port.closeOverlay();
				if (opts.back) this.openModelQuickPickModal();
			},
		});
		this.port.showOverlayModal(modal, { anchor: "bottom-left" });
	}

	/** 当前模型在列表中的 label；不在列表时回退 modelId；都没有返回 undefined。 */
	private currentModelLabel(source: { readonly models: readonly ModelPickerModel[]; readonly currentProviderId?: string; readonly currentModelId?: string }): string | undefined {
		if (source.currentProviderId === undefined || source.currentModelId === undefined) return undefined;
		const match = source.models.find((model) =>
			model.providerId === source.currentProviderId && model.modelId === source.currentModelId,
		);
		return match?.label ?? source.currentModelId;
	}

	private selectListTheme() {
		return makeSelectListTheme(this.port.theme);
	}

	/** B5:model.select effect；controller/Host 返回 authoritative selection 后 Footer 自动反映。 */
	public async selectModelByKey(key: string): Promise<void> {
		const slash = key.indexOf("/");
		if (slash <= 0) return;
		const providerId = key.slice(0, slash);
		const modelId = key.slice(slash + 1);
		if (providerId.length === 0 || modelId.length === 0) return;
		const effect = this.port.createEffect("model.select", { providerId, modelId });
		this.port.store.dispatch({ type: "query.start", effect });
		this.port.runner.dispatch(effect);
		const workflow = await this.port.waitForWorkflow("modelWorkflow", effect.correlationId);
		if (workflow.state === "ready") {
			await this.port.syncThinkingWorkflow();
			const selection = workflow.value as { readonly providerId?: string; readonly modelId?: string };
			this.port.refs.welcome?.setModel(selection.modelId ?? modelId, selection.providerId ?? providerId);
			this.port.showNotice(`Model: ${selection.providerId ?? providerId}/${selection.modelId ?? modelId}`);
		} else if (workflow.state === "error") {
			this.port.showNotice(`Model switch failed: ${workflow.message}`, "error");
		}
	}

	/**
	 * B5:/thinking 选择器走 thinking workflow；level 由 controller.setThinkingLevel
	 * 持久化（authority），Footer 从 workflow 读取。
	 */
	public openThinkingSelector(): void {
		void this.openThinkingWorkflowSelector();
	}

	private async openThinkingWorkflowSelector(): Promise<void> {
		const port = this.port;
		if (port.store.getState().capabilities.thinking.state !== "available") {
			port.showNotice("Thinking configuration is unavailable in this session.", "error");
			return;
		}
		const effect = port.createEffect("thinking.inspect");
		port.store.dispatch({ type: "query.start", effect });
		port.runner.dispatch(effect);
		const workflow = await port.waitForWorkflow("thinkingWorkflow", effect.correlationId);
		if (workflow.state !== "ready") {
			port.showNotice("Thinking configuration is unavailable in this session.", "error");
			return;
		}
		const snapshot = workflow.value as { readonly level: string; readonly availableLevels: readonly string[] };
		const levels = snapshot.availableLevels.length > 0 ? snapshot.availableLevels : [snapshot.level];
		const items: SelectItem[] = levels.map((level) => ({
			value: level,
			label: level,
			description: level === "off" ? "reasoning disabled" : "provider-supported reasoning",
		}));
		const modal = new SelectorModal({
			theme: port.theme,
			selectListTheme: makeSelectListTheme(port.theme),
			title: "/thinking — switch thinking level",
			items,
			onSelect: (item) => {
				port.closeOverlay();
				void this.setThinkingLevel(item.value as ModelThinkingLevel);
			},
			onCancel: () => port.closeOverlay(),
		});
		port.showOverlayModal(modal, { anchor: "bottom-left" });
	}

	/** B5:thinking.select effect；authoritative level 由 controller 返回。 */
	public async setThinkingLevel(level: ModelThinkingLevel): Promise<void> {
		const port = this.port;
		if (port.store.getState().capabilities.thinking.state !== "available") {
			port.showNotice("Thinking configuration is unavailable in this session.", "error");
			return;
		}
		const effect = port.createEffect("thinking.select", { level });
		port.store.dispatch({ type: "query.start", effect });
		port.runner.dispatch(effect);
		const workflow = await port.waitForWorkflow("thinkingWorkflow", effect.correlationId);
		if (workflow.state === "error") {
			port.showNotice(`Thinking switch failed: ${workflow.message}`, "error");
		}
		port.uiRequestRender();
	}

	/** FooterSnapshotProvider:thinking level 从 thinking workflow 读取（ready 时）。 */
	public getThinkingLevel(): ModelThinkingLevel {
		const workflow = this.port.store.getState().thinkingWorkflow;
		if (workflow.state === "ready") {
			const level = (workflow.value as { readonly level: ModelThinkingLevel | "unknown" }).level;
			if (level !== "unknown") return level;
		}
		return "off";
	}
}
