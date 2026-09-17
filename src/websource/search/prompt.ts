/**
 * `web_search` 的工具描述。
 *
 * 来源：oh-my-pi `prompts/tools/web-search.md`（快照 `1c0303b1`）。上游以 `.md`
 * 资源形式随包分发并由 `prompt.render(...)` 渲染；RunLedger 的 `src/` 不引入
 * markdown 资源加载机制，因此按等价语义内联为常量。
 */

export const WEB_SEARCH_DESCRIPTION = [
	"检索互联网上的最新信息（超出知识截止时间的内容）。",
	"",
	"规则：",
	"- 优先一手来源（论文、官方文档），关键结论用多个来源交叉验证。",
	"- 最终回答必须给出引用链接。",
	"- 不要用于可程序化获取的内容或已知 URL（GitHub 仓库/issue、已知 arXiv 论文、Wikipedia 页面、官方文档）——这些直接用 read/WebFetch 抓取。",
	"- query 支持所有 provider 通用的 Google 风格语法：site:/-site:、after:/before:（YYYY-MM-DD）、inurl:、intitle:、filetype:、\"exact phrase\"、-term、OR。",
	 "  能映射成 provider 原生过滤条件时优先映射，否则在结果上宽松过滤；某条约束命中为空时放宽并说明，不要返回空结果。",
].join("\n");
