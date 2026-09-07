/** 自身策略文件只允许经用户设置入口修改；本模块不把 shell 文本检查当成 OS 隔离。 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SecuritySnapshot } from "../types.ts";
import { analyzeShellCommand } from "./shell-analyzer.ts";

export const POLICY_CONTROL_REASON = "agent policy configuration is write-protected; propose the change and use the user-controlled permissions/settings workflow";

function within(root: string, target: string): boolean {
	const offset = relative(resolve(root), resolve(target));
	return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}

export function isPolicyControlMutation(path: string, snapshot: SecuritySnapshot, includeAncestors = true): boolean {
	const target = resolve(snapshot.workspaceRoot, path);
	// 保护父目录删除/替换，避免通过 rename/rm 上级目录替换 policy。
	return snapshot.policyControlPaths?.some((control) => within(control, target) || (includeAncestors && within(target, control))) ?? false;
}

const READ_COMMANDS = new Set(["cat", "head", "tail", "less", "more", "wc", "ls", "stat", "readlink", "realpath", "diff", "cmp", "cd", "pwd", "echo", "printf", "grep", "jq"]);
const REPLACE_COMMANDS = new Set(["rm", "rmdir", "mv", "cp", "install", "ln"]);

function isReadCommand(executable: string, args: readonly string[]): boolean {
	if (READ_COMMANDS.has(executable)) return true;
	if (executable === "rg") return !args.some((arg) => arg === "--pre" || arg.startsWith("--pre="));
	if (executable === "find") return !args.some((arg) => ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(arg));
	return false;
}

export function shellPolicyControlMutation(command: string, snapshot: SecuritySnapshot, cwd: string, protectAncestors = true): boolean {
	if (!snapshot.policyControlPaths?.length) return false;
	for (const home of snapshot.homeDirectories ?? []) {
		const expanded = command.replace(/\$\{HOME\}|\$HOME\b|~(?=\/)/gu, home);
		if (expanded !== command && shellPolicyControlMutation(expanded, { ...snapshot, homeDirectories: [] }, cwd, protectAncestors)) return true;
	}
	for (const segment of analyzeShellCommand(command).segments) {
		const readOnly = isReadCommand(segment.executable, segment.arguments) && !/[<>`]|\$\(/u.test(segment.raw);
		if (readOnly) continue;
		// 对包含控制路径的脚本/未知语法保守拒绝；不读取或执行脚本来推断意图。
		for (const control of snapshot.policyControlPaths) {
			if (segment.raw.includes(control)) return true;
		}
		for (const argument of segment.arguments) {
			const target = argument.replace(/^[0-9]*[<>]+/u, "");
			if (!target || target.startsWith("-") || [">", ">>", "<"].includes(target)) continue;
			if (isPolicyControlMutation(resolve(cwd, target), snapshot, protectAncestors && REPLACE_COMMANDS.has(segment.executable))) return true;
		}
	}
	return false;
}
