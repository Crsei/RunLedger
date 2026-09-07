/**
 * S7 拆分:input controller —— submit/follow-up/Ctrl+C/Ctrl+D 与 slash 补全弹窗。
 *
 * 编辑器文本变化驱动 slash 弹窗状态;Tab/`/` 补全、Enter 接受统一经
 * dispatchCommand 派发(与 handleSubmit 同源)。主题选择与 scrollbar 切换
 * 也归本 controller(presentation 输入面)。
 */

import { SecondarySelectionView } from "../components/list-selection-modal.ts";
import { SlashCommandPopup } from "../components/slash-command-popup.ts";
import { matchesKey } from "../primitives.ts";
import { makeSelectListTheme } from "../theme/factories.ts";
import { findCommand, commandsForContext, type RegisteredSlashCommand } from "../commands/registry.ts";
import type { OverlayHandle } from "../primitives.ts";
import type { InteractiveModePorts } from "./types.ts";

export class InputController {
	private readonly port: InteractiveModePorts;
	/** 弹窗状态机测试读取;hideSlashPopup 只清引用不销毁实例。 */
	slashPopup: SlashCommandPopup | undefined;
	private slashOverlayHandle: OverlayHandle | undefined;
	/** Esc 关闭后记忆当前命令 token;token 变化才恢复弹窗(对照 codex dismissed_command_token)。 */
	dismissedCommandToken: string | undefined;

	public constructor(port: InteractiveModePorts) {
		this.port = port;
	}

	/** Editor.onSubmit 回调;空闲时作为 user prompt 投递,运行中自动排队为 follow-up 不打断当前 turn。 */
	public handleSubmit(text: string): void {
		if (text.length === 0) return;
		this.port.clearIdleRecapStatus();
		if (text.startsWith("/")) {
			const [rawCommand, ...argParts] = text.slice(1).trim().split(/\s+/);
			const name = rawCommand ?? "";
			const arg = argParts.join(" ");
			this.hideSlashPopup();
			// 注册表唯一事实源:未知命令 → 原 default 分支行为(报错提示)
			const command = findCommand(name);
			if (command === undefined) {
				this.port.showNotice(`Unknown command: /${name}. Type "/" for a list of supported commands.`, "error");
				return;
			}
			this.port.dispatchCommand(command, arg);
			return;
		}

		if (this.port.hostConnectionState !== "ready") {
			this.port.showNotice(this.port.hostConnectionState === "reconnecting" ? "host_reconnecting" : `host_${this.port.hostConnectionState}`, "error");
			return;
		}
		this.port.setStreaming(true);
		this.port.setStopReason(undefined);
		this.port.uiRequestRender();
		const prompt = this.port.controller
			? this.port.controller.prompt(text, this.port.inFlight() ? "followUp" : undefined)
			: this.port.inFlight()
				? Promise.resolve(this.port.agent!.followUp(text))
				: this.port.agent!.prompt(text).then(() => undefined);
		void prompt.then(
			() => {
				// 最终状态由 agent_end 路径写入。
			},
			(err: unknown) => {
				this.port.setStreaming(false);
				this.port.showNotice(String(err), "error");
			},
		);
	}

	public handleFollowUpSubmit(text: string): void {
		if (this.port.hostConnectionState !== "ready") {
			this.port.showNotice(this.port.hostConnectionState === "reconnecting" ? "host_reconnecting" : `host_${this.port.hostConnectionState}`, "error");
			return;
		}
		if (!this.port.inFlight()) {
			this.handleSubmit(text);
			return;
		}
		const prompt = this.port.controller
			? this.port.controller.prompt(text, "followUp")
			: Promise.resolve(this.port.agent!.followUp(text));
		void prompt.catch((error: unknown) => this.port.showNotice(String(error), "error"));
	}

	public restoreQueuesToEditor(): void {
		const queues = this.port.controller?.clearAllQueues();
		if (!queues) {
			this.port.showNotice("No queued messages to restore.");
			return;
		}
		const queued = [...queues.steering, ...queues.followUp]
			.map((message) => messageText(message))
			.filter((text) => text.length > 0);
		if (queued.length === 0) {
			this.port.showNotice("No queued messages to restore.");
			return;
		}
		const current = this.port.refs.editor.getText();
		this.port.refs.editor.setText([...queued, current].filter((text) => text.trim()).join("\n\n"));
		this.port.showNotice(`Restored ${queued.length} queued message${queued.length === 1 ? "" : "s"}.`);
	}

	public async toggleTranscriptScrollbar(): Promise<void> {
		const visible = !this.port.store.getState().interaction.transcriptScrollbarVisible;
		this.port.store.dispatch({ type: "interaction.transcript-scrollbar-set", visible });
		this.port.uiRequestRender();
		if (this.port.preferencesPort === undefined) return;
		const result = await this.port.preferencesPort.save({
			version: 2,
			transcript: { scrollbar: visible ? "visible" : "hidden" },
			display: { shimmer: this.port.shimmerMode },
		});
		if (!result.ok) {
			this.port.showNotice("Scrollbar changed for this run but could not be saved.", "error");
		}
	}

	public async persistThinkingVisibility(hidden: boolean): Promise<void> {
		if (this.port.hideThinkingSettingsPort === undefined) {
			this.port.showNotice("Thinking visibility changed for this run but could not be saved.", "error");
			return;
		}
		const result = await this.port.hideThinkingSettingsPort.save(hidden);
		if (!result.ok) {
			this.port.showNotice("Thinking visibility changed for this run but could not be saved.", "error");
		}
	}

	public openSyntaxThemePicker(): void {
		this.hideSlashPopup();
		this.port.syntaxThemeController.cancelPreview();
		const opening = this.port.syntaxThemeController.snapshot();
		const modal = new SecondarySelectionView({
			title: "Select Syntax Theme",
			subtitle: "Preview with arrows; Enter saves, Esc restores.",
			items: this.port.syntaxThemeController.themeEntries().map((entry) => ({
				value: entry.name,
				name: entry.name,
				description: entry.available ? entry.kind : "load error",
				isCurrent: entry.name === opening.activeName,
				disabled: !entry.available,
			})),
			initialSelectedValue: opening.activeName,
			onSelectionChange: (item) => {
				this.port.syntaxThemeController.preview(item.value);
				this.port.uiRequestRender();
			},
			selectListTheme: this.selectListTheme(),
			onSelect: (item) => { void this.persistSyntaxTheme(item.value); },
			onCancel: () => {
				this.port.syntaxThemeController.cancelPreview();
				this.port.closeOverlay();
				this.port.uiRequestRender();
			},
		});
		this.port.showOverlayModal(modal, { anchor: "bottom-left" });
	}

	private async persistSyntaxTheme(name: string): Promise<void> {
		if (this.port.syntaxThemeController.snapshot().previewName !== name) {
			const preview = this.port.syntaxThemeController.preview(name);
			if (!preview.ok) return;
		}
		const saved = this.port.syntaxThemeSettingsPort === undefined
			? { ok: false as const, code: "theme_settings_unavailable" }
			: await this.port.syntaxThemeSettingsPort.save(name);
		if (!saved.ok) {
			this.port.syntaxThemeController.cancelPreview();
			this.port.closeOverlay();
			this.port.showNotice("Syntax theme could not be saved; the previous theme was restored.", "error");
			return;
		}
		this.port.syntaxThemeController.commitPreview();
		this.port.closeOverlay();
		this.port.uiRequestRender();
	}

	// ─── P3:slash 输入期补全弹窗(对照 codex sync_command_popup / slash_input) ───

	/** 编辑器文本变化后同步弹窗状态:是否在编辑首行命令名、过滤串、dismiss 记忆。 */
	public syncSlashPopup(): void {
		const editing = this.editingSlashCommandName();
		if (editing === undefined) {
			this.hideSlashPopup();
			return;
		}
		// Esc 关闭后同一 token 不再弹,token 变化才恢复
		if (this.dismissedCommandToken !== undefined && editing.token === this.dismissedCommandToken) return;
		this.dismissedCommandToken = undefined;
		const popup = this.slashPopup ?? this.createSlashPopup();
		popup.setFilter(editing.filter);
		this.port.uiRequestRender();
	}

	/** 解析首行 `/name` 片段:光标在命令名编辑态返回 { token, filter },否则 undefined。 */
	private editingSlashCommandName(): { readonly token: string; readonly filter: string } | undefined {
		const text = this.port.refs.editor.getText();
		const cursor = this.port.refs.editor.getCursor();
		const firstLine = text.split("\n")[0] ?? "";
		if (!firstLine.startsWith("/")) return undefined;
		if (cursor.line !== 0) return undefined;
		const nameEnd = firstLine.indexOf(" ", 1) === -1 ? firstLine.length : firstLine.indexOf(" ", 1);
		if (cursor.col > nameEnd) return undefined;
		const fragment = firstLine.slice(1, Math.min(nameEnd, cursor.col === 0 ? nameEnd : cursor.col));
		return { token: firstLine.slice(1, nameEnd), filter: `/${fragment}` };
	}

	/** 当前首行 `/token`(Esc dismiss 记忆用)。 */
	private currentSlashToken(): string | undefined {
		const firstLine = (this.port.refs.editor.getText().split("\n")[0] ?? "");
		if (!firstLine.startsWith("/")) return undefined;
		const nameEnd = firstLine.indexOf(" ", 1) === -1 ? firstLine.length : firstLine.indexOf(" ", 1);
		return firstLine.slice(1, nameEnd);
	}

	private createSlashPopup(): SlashCommandPopup {
		const popup = new SlashCommandPopup({
			commands: commandsForContext({ supportsOperation: (operation) => this.port.controller?.supports?.(operation) === true }),
			theme: this.selectListTheme(),
		});
		this.slashPopup = popup;
		this.slashOverlayHandle = this.port.ui.showOverlay(popup, { anchor: "bottom-left", nonCapturing: true });
		this.port.uiRequestRender();
		return popup;
	}

	public hideSlashPopup(): void {
		this.slashOverlayHandle = undefined;
		if (this.port.ui.getOverlay() !== this.slashPopup) {
			// overlay 槽已被真实 modal 抢占,只清引用
			this.slashPopup = undefined;
			return;
		}
		this.slashPopup = undefined;
		this.port.ui.hideOverlay();
		this.port.uiRequestRender();
	}

	/** 弹窗激活期按键拦截(挂在 CustomEditor.handleInput 最前);返回 true 表示已消费。 */
	public handleSlashPopupKey(data: string): boolean {
		const popup = this.slashPopup;
		if (popup === undefined) return false;
		if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
			popup.moveUp();
			this.port.uiRequestRender();
			return true;
		}
		if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
			popup.moveDown();
			this.port.uiRequestRender();
			return true;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "/")) {
			this.completeSelectedSlashCommand(popup.selectedItem(), popup.selectedName());
			this.port.uiRequestRender();
			return true;
		}
		if (matchesKey(data, "enter")) {
			const selected = popup.selectedItem();
			if (selected === undefined) return false; // 无选中回退默认提交路径
			this.acceptSelectedSlashCommand(selected, popup.selectedName());
			this.port.uiRequestRender();
			return true;
		}
		if (matchesKey(data, "escape")) {
			this.dismissedCommandToken = this.currentSlashToken();
			this.hideSlashPopup();
			this.port.uiRequestRender();
			return true;
		}
		return false;
	}

	/**
	 * Tab/`/` 补全:内联参数命令保留草稿尾(/re + "view the diff" → /review view the diff),
	 * 其余命令整串替换为 `/cmd `(对照 codex selected_command_completion)。
	 */
	private completeSelectedSlashCommand(command: RegisteredSlashCommand | undefined, selectedName?: string): void {
		if (command === undefined) return;
		const completionName = selectedName ?? command.canonicalName;
		const editor = this.port.refs.editor;
		const text = editor.getText();
		const firstLineEnd = text.indexOf("\n") === -1 ? text.length : text.indexOf("\n");
		const whitespace = text.indexOf(" ", 1);
		const tokenEnd = whitespace === -1 ? firstLineEnd : Math.min(whitespace, firstLineEnd);
		const tail = text.slice(tokenEnd);
		if (command.supportsInlineArgs && tail.trim().length > 0) {
			const tailStartsWithSpace = /^\s/u.test(tail);
			editor.setText(tailStartsWithSpace
				? `/${completionName}${tail}`
				: `/${completionName} ${tail}`);
			return;
		}
		editor.setText(`/${completionName} `);
	}

	/**
	 * Enter 接受高亮命令:内联参数命令先补全再带参派发,其余直接派发;
	 * 派发统一走 dispatchCommand(对照 codex InputResult::Command / CommandWithArgs)。
	 */
	private acceptSelectedSlashCommand(command: RegisteredSlashCommand, selectedName?: string): void {
		const editor = this.port.refs.editor;
		if (command.supportsInlineArgs) {
			const text = editor.getText();
			const firstLineEnd = text.indexOf("\n") === -1 ? text.length : text.indexOf("\n");
			const whitespace = text.indexOf(" ", 1);
			const tokenEnd = whitespace === -1 ? firstLineEnd : Math.min(whitespace, firstLineEnd);
			const arg = text.slice(tokenEnd).trim();
			this.hideSlashPopup();
			editor.addToHistory(`/${selectedName ?? command.canonicalName}${arg.length > 0 ? ` ${arg}` : ""}`);
			editor.setText("");
			this.port.dispatchCommand(command, arg);
			return;
		}
		this.hideSlashPopup();
		editor.setText("");
		this.port.dispatchCommand(command, "");
	}

	private selectListTheme() {
		return makeSelectListTheme(this.port.theme);
	}
}

function messageText(message: { role: string; content: readonly { readonly text: string }[] }): string {
	if (message.role !== "user") return "";
	return message.content.map((content) => content.text).join("");
}
