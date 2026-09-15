/**
 * 计划产物命名：从正文派生标题与导出文件名。
 *
 * 纯函数；不读文件系统、不读 session。导出文件是 canonical home 下的可删除
 * 重建投影，命名冲突由调用方按 `<stem>-N` 退避处理。
 */

const MAX_STEM_LENGTH = 32;
const MAX_TITLE_LENGTH = 120;
const INVALID_STEM_CHARS = /[^\p{L}\p{N}]+/gu;

/** 正文首个一级 heading 的文本；缺失、只有空白或全为空时返回 undefined。 */
function firstLevelOneHeading(content: string): string | undefined {
	for (const line of content.split("\n")) {
		// ATX 标题必须有 # 后的空白与至少一个非空白字符，否则视为装饰而不是标题。
		const match = /^#[ \t]+(\S.*?)[ \t]*$/u.exec(line);
		if (match?.[1] !== undefined) return match[1];
	}
	return undefined;
}

export interface PlanTitleInput {
	readonly content: string;
	/** 会话标题；正文没有 heading 时的回退。 */
	readonly sessionTitle?: string;
}

/** 标题只用于展示与命名，因此按最长 120 字符裁剪并压缩空白。 */
export function derivePlanTitle(input: PlanTitleInput): string {
	const heading = firstLevelOneHeading(input.content) ?? input.sessionTitle;
	if (heading === undefined) return "Plan";
	const collapsed = heading.replace(/[\s\u3000]+/gu, " ").trim();
	if (collapsed.length === 0) return "Plan";
	return collapsed.length > MAX_TITLE_LENGTH ? collapsed.slice(0, MAX_TITLE_LENGTH).trim() : collapsed;
}

/**
 * 导出文件名 `<STEM>_PLAN.md`：非字母数字（含 CJK 保留）压成下划线，
 * 超长在词边界截断，避免同一标题反复生成几乎相同的长名。
 */
export function planExportFileName(title: string): string {
	const stem = title
		.normalize("NFC")
		.replace(INVALID_STEM_CHARS, "_")
		.replace(/_+/gu, "_")
		.replace(/^_+|_+$/gu, "")
		.toUpperCase();
	if (stem.length === 0 || stem === "PLAN") return "PLAN.md";
	const bounded = stem.length > MAX_STEM_LENGTH
		? (() => {
			const cut = stem.lastIndexOf("_", MAX_STEM_LENGTH);
			return cut > 0 ? stem.slice(0, cut) : stem.slice(0, MAX_STEM_LENGTH);
		})()
		: stem;
	return `${bounded.endsWith("_PLAN") ? bounded : `${bounded}_PLAN`}.md`;
}

/** 冲突退避候选：第 0 个是原名，其后依次 `<stem>-N<ext>`。 */
export function planExportCandidates(fileName: string, limit: number): readonly string[] {
	const extension = fileName.slice(fileName.lastIndexOf("."));
	const stem = fileName.slice(0, fileName.length - extension.length);
	return Array.from({ length: limit }, (_value, index) => index === 0 ? fileName : `${stem}-${index}${extension}`);
}
