/** Codex 风格 permission 请求；复用统一二级选择结构。 */

import { matchesKey, wrapTextWithAnsi } from "../primitives.ts";
import type { PresentationBlock } from "../presentation.ts";
import type { ApprovalChoice, ApprovalReverseRequestView } from "../approval.ts";
import { SecondarySelectionView } from "./list-selection-modal.ts";

export interface PermissionRequestViewProps {
	readonly request: ApprovalReverseRequestView;
	readonly choices: readonly ApprovalChoice[];
	readonly onSelect: (choice: ApprovalChoice) => void;
	readonly onCancel: () => void;
	readonly onChange?: () => void;
	readonly onPermissions?: () => void;
}

const PLAIN_SELECT_THEME = {
	selectedPrefix: (text: string): string => text,
	selectedText: (text: string): string => text,
	description: (text: string): string => text,
	scrollInfo: (text: string): string => text,
	noMatch: (text: string): string => text,
	matchHighlight: (text: string): string => text,
};

export class PermissionRequestView extends SecondarySelectionView {
	readonly #request: ApprovalReverseRequestView;
	readonly #choices: readonly ApprovalChoice[];
	readonly #onPermissions?: () => void;
	/** 权限页异步加载期间的挂起态:到达的按键不触发任何决策,也不落到 composer。 */
	#inputSuspended = false;

	public constructor(props: PermissionRequestViewProps) {
		const choices = codexPermissionChoices(props.choices);
		const command = shellCommand(props.request);
		super({
			title: command === undefined ? "Would you like to allow the following request?" : "Would you like to run the following command?",
			detailLines: [
				"",
				"  Environment: local",
				`  Reason: ${safeLine(props.request.summary)}`,
				"",
				...(command === undefined ? requestLines(props.request) : [`  $ ${command}`]),
				"",
			],
			items: choices.map((choice) => ({
				value: choice.id,
				name: choiceLabel(choice),
				description: choice.description,
			})),
			selectListTheme: PLAIN_SELECT_THEME,
			footerHint: props.onPermissions === undefined ? "Press Enter to confirm; Esc denies the request" : "Enter confirms; Esc denies; / changes Session permissions",
			onSelect: (item) => {
				const choice = choices.find((candidate) => candidate.id === item.value);
				if (choice !== undefined) props.onSelect(choice);
			},
			onCancel: props.onCancel,
			onSelectionChange: () => props.onChange?.(),
			shortcutValue: (data) => shortcutChoiceId(data, choices),
		});
		this.#request = props.request;
		this.#choices = choices;
		this.#onPermissions = props.onPermissions;
	}

	/**
	 * `/` 打开权限页是异步的(先查询 Host 再换 overlay)。在页面接管前挂起输入,
	 * 否则后续按键仍会被解析成 y/p/数字快捷键,造成未经确认的 allow-session。
	 */
	public suspendInput(): void {
		this.#inputSuspended = true;
	}

	public resumeInput(): void {
		this.#inputSuspended = false;
	}

	public override handleInput(data: string): void {
		if (this.#inputSuspended) return;
		if (data === "/" && this.#onPermissions !== undefined) { this.#onPermissions(); return; }
		super.handleInput(data);
	}

	public present(width: number): PresentationBlock[] {
		const command = shellCommand(this.#request);
		const footer = this.#inputSuspended
			? "Opening Session permissions…"
			: this.#onPermissions === undefined
				? undefined
				: "Enter confirms; Esc denies; / changes Session permissions";
		return [
			{
				kind: "text",
				content: [
					command === undefined ? "Would you like to allow the following request?" : "Would you like to run the following command?",
					"",
					"  Environment: local",
					`  Reason: ${safeLine(this.#request.summary)}`,
				].flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width))).join("\n"),
			},
			...(command === undefined
				? [{ kind: "text" as const, content: requestLines(this.#request).join("\n") }]
				: [{ kind: "command" as const, command }]),
			{
				kind: "select",
				title: "",
				options: this.#choices.map((choice, index) => ({
					value: choice.id,
					label: `${index + 1}. ${choiceLabel(choice)}`,
				})),
				selectedIndex: this.selectedIndex,
			},
			...(footer === undefined ? [] : [{ kind: "text" as const, content: footer }]),
		];
	}
}

/** Codex permission prompt 每次只展示 proceed、持久规则/session、deny 三项。 */
function codexPermissionChoices(choices: readonly ApprovalChoice[]): readonly ApprovalChoice[] {
	const once = choices.find((choice) => choice.decision.decision === "allow-once");
	const persistent = choices.find((choice) => choice.decision.decision === "allow-with-prefix-rule")
		?? choices.find((choice) => choice.decision.decision === "allow-with-network-rule")
		?? choices.find((choice) => choice.decision.decision === "allow-session");
	const deny = choices.find((choice) => choice.decision.decision === "deny");
	return [once, persistent, deny].filter((choice): choice is ApprovalChoice => choice !== undefined);
}

function shellCommand(request: ApprovalReverseRequestView): string | undefined {
	return request.requests?.length === 1 && request.requests[0]?.kind === "shell"
		? safeLine(request.requests[0].command)
		: undefined;
}

function shortcutChoiceId(data: string, choices: readonly ApprovalChoice[]): string | undefined {
	const decision = data === "y" || data === "Y"
		? "allow-once"
		: data === "p" || data === "P"
			? "persistent"
			: matchesKey(data, "escape")
				? "deny"
				: undefined;
	if (decision === undefined) return undefined;
	const choice = decision === "persistent"
		? choices.find((candidate) => candidate.decision.decision === "allow-with-prefix-rule" || candidate.decision.decision === "allow-with-network-rule" || candidate.decision.decision === "allow-session")
		: choices.find((candidate) => candidate.decision.decision === decision);
	return choice?.id;
}

function requestLines(request: ApprovalReverseRequestView): string[] {
	return (request.requests ?? []).map((item) => {
		switch (item.kind) {
			case "filesystem": return `  ${item.operation}: ${safeLine(item.path)}`;
			case "network": return `  ${item.operation}: ${safeLine(item.protocol === undefined ? item.host : `${item.protocol}://${item.host}${item.port === undefined ? "" : `:${item.port}`}`)}`;
			case "worktree": return `  ${item.operation}: ${safeLine(item.target)}`;
			case "tool": return `  tool: ${safeLine(item.provider === undefined ? item.toolName : `${item.provider}/${item.toolName}`)}`;
			case "shell": return `  $ ${safeLine(item.command)}`;
		}
	});
}

function choiceLabel(choice: ApprovalChoice): string {
	switch (choice.decision.decision) {
		case "allow-once": return "Yes, proceed (y)";
		case "allow-with-prefix-rule": return `Yes, and don't ask again for commands that start with \`${safeLine(choice.decision.prefixRule.join(" "))}\` (p)`;
		case "allow-with-network-rule": return `Yes, and don't ask again for ${choice.decision.protocol}://${safeLine(choice.decision.host)}${choice.decision.port === undefined ? "" : `:${choice.decision.port}`} (p)`;
		case "allow-session": return "Yes, allow this request for the session (p)";
		case "deny": return "No, and tell RunLedger what to do differently (esc)";
		case "cancel": return "Cancel";
	}
}

function safeLine(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
}
