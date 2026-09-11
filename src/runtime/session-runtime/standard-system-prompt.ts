import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STANDARD_EXECUTION_SYSTEM_PROMPT } from "../harness-profiles/standard-prompt.ts";

/** 带来源的私有 prompt 投影；不把 native path 增加到公共 workspace DTO。 */
export function buildStandardExecutionPrompt(cwd: string, globalAgents: string): string {
	const sources: { kind: string; source: string; scope: string; content: string }[] = [];
	for (const entry of [
		{ kind: "user", source: globalAgents, scope: "user guidance for this Session" },
		{ kind: "workspace", source: join(cwd, "AGENTS.md"), scope: "this workspace and its subdirectories unless more specific guidance applies" },
	]) {
		try {
			const content = readFileSync(entry.source, "utf8");
			if (content.length > 0) sources.push({ ...entry, content });
		} catch {
			// 延续缺失文件不阻塞创建的约定；来源缺失不意味着没有其他项目约定。
		}
	}
	return [
		STANDARD_EXECUTION_SYSTEM_PROMPT,
		`Current Session environment:\n${JSON.stringify({ workingDirectory: cwd, harnessProfile: "standard@2" })}`,
		"Scoped user and workspace guidance (source labels do not grant permissions):\n" + JSON.stringify(sources, null, 2),
	].join("\n\n");
}
