/** Codex 风格的 transcript 内 permission 请求；不使用 overlay。 */

import type { Component } from "../primitives.ts";
import { matchesKey, wrapTextWithAnsi } from "../primitives.ts";
import type { PresentationBlock } from "../presentation.ts";
import type { ApprovalChoice, ApprovalReverseRequestView } from "../approval.ts";

export interface PermissionRequestViewProps {
	readonly request: ApprovalReverseRequestView;
	readonly choices: readonly ApprovalChoice[];
	readonly onSelect: (choice: ApprovalChoice) => void;
	readonly onCancel: () => void;
	readonly onChange?: () => void;
}

export class PermissionRequestView implements Component {
	readonly #request: ApprovalReverseRequestView;
	readonly #choices: readonly ApprovalChoice[];
	readonly #onSelect: (choice: ApprovalChoice) => void;
	readonly #onCancel: () => void;
	readonly #onChange: (() => void) | undefined;
	#selectedIndex = 0;

	public constructor(props: PermissionRequestViewProps) {
		this.#request = props.request;
		this.#choices = codexPermissionChoices(props.choices);
		this.#onSelect = props.onSelect;
		this.#onCancel = props.onCancel;
		this.#onChange = props.onChange;
	}

	public invalidate(): void {}

	public handleInput(data: string): void {
		if (this.#choices.length === 0) {
			this.#onCancel();
			return;
		}
		if (matchesKey(data, "up")) this.#move(-1);
		else if (matchesKey(data, "down")) this.#move(1);
		else if (matchesKey(data, "enter")) this.#select(this.#selectedIndex);
		else if (matchesKey(data, "escape")) this.#selectDecision("deny");
		else if (matchesKey(data, "ctrl+c")) this.#onCancel();
		else if (data === "y" || data === "Y") this.#selectDecision("allow-once");
		else if (data === "p" || data === "P") this.#selectPersistent();
		else if (/^[1-9]$/u.test(data)) this.#select(Number(data) - 1);
	}

	public render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		return permissionLines(this.#request, this.#choices, this.#selectedIndex)
			.flatMap((line) => wrapTextWithAnsi(line, safeWidth));
	}

	public present(width: number): PresentationBlock[] {
		const command = shellCommand(this.#request);
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
					description: choice.description,
				})),
				selectedIndex: this.#selectedIndex,
			},
		];
	}

	#move(delta: number): void {
		this.#selectedIndex = (this.#selectedIndex + delta + this.#choices.length) % this.#choices.length;
		this.#onChange?.();
	}

	#select(index: number): void {
		const choice = this.#choices[index];
		if (choice !== undefined) this.#onSelect(choice);
	}

	#selectDecision(decision: string): void {
		const index = this.#choices.findIndex((choice) => choice.decision.decision === decision);
		if (index >= 0) this.#select(index);
		else this.#onCancel();
	}

	#selectPersistent(): void {
		const index = this.#choices.findIndex((choice) => choice.decision.decision === "allow-with-prefix-rule" || choice.decision.decision === "allow-with-network-rule" || choice.decision.decision === "allow-session");
		if (index >= 0) this.#select(index);
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

function permissionLines(request: ApprovalReverseRequestView, choices: readonly ApprovalChoice[], selectedIndex: number): string[] {
	const command = shellCommand(request);
	const lines = [
		command === undefined ? "Would you like to allow the following request?" : "Would you like to run the following command?",
		"",
		"  Environment: local",
		`  Reason: ${safeLine(request.summary)}`,
	];
	if (command !== undefined) lines.push("", `  $ ${command}`);
	else lines.push("", ...requestLines(request));
	lines.push("");
	for (const [index, choice] of choices.entries()) {
		const marker = index === selectedIndex ? "›" : " ";
		lines.push(`${marker} ${index + 1}. ${choiceLabel(choice)}`);
	}
	return lines;
}

function shellCommand(request: ApprovalReverseRequestView): string | undefined {
	return request.requests?.length === 1 && request.requests[0]?.kind === "shell"
		? safeLine(request.requests[0].command)
		: undefined;
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
		case "deny": return "No, and tell Codex what to do differently (esc)";
		case "cancel": return "Cancel";
	}
}

function safeLine(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
}
