/** 当前 Session 的只读 Harness/Security/Thinking 身份条。 */

import type { Component } from "../primitives.ts";
import { fitToWidth } from "./render-width.ts";

export interface SessionProfileHeaderProps {
	readonly harnessProfile: {
		readonly id: "standard" | "minimal";
		readonly version: 1;
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
		const line = `Harness: ${this.props.harnessProfile.id}@${this.props.harnessProfile.version}`
			+ `  Permission: ${this.props.permissionProfile}`
			+ `  Thinking: ${this.props.thinkingLevel()}`;
		return [fitToWidth(line, width)];
	}
}
