import { agentModeIdentityPresentation } from "../../runtime/harness-profiles/agent-mode.ts";
import { agentModeBadge } from "../presentation/projectors.ts";
/** 当前 Session 的只读 Harness/Security/Thinking 身份条。 */

import type { Component } from "../primitives.ts";
import { fitToWidth } from "./render-width.ts";

export interface SessionProfileHeaderProps {
	readonly harnessProfile: {
		readonly id: "standard" | "minimal" | "plan";
		readonly version: 1 | 2;
	};
	readonly permissionProfile: string;
	readonly thinkingLevel: () => string;
}

export class SessionProfileHeaderComponent implements Component {
	private readonly props: SessionProfileHeaderProps;

	public constructor(props: SessionProfileHeaderProps) {
		this.props = props;
	}

	public invalidate(): void {
		// 所有字段均在 render 时从只读投影获取，无缓存。
	}

	public render(width: number): string[] {
		const badge = agentModeBadge(agentModeIdentityPresentation(this.props.harnessProfile)?.mode);
		const line = [
			...(badge === undefined ? [] : [badge]),
			`Harness: ${this.props.harnessProfile.id}@${this.props.harnessProfile.version}`,
			`Permission: ${this.props.permissionProfile}`,
			`Thinking: ${this.props.thinkingLevel()}`,
		].join("  ");
		return [fitToWidth(line, width)];
	}
}
