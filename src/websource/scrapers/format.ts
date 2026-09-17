/**
 * scraper 展示小工具。
 *
 * 上游 `web/scrapers/{dockerhub,ollama}.ts` 从 `tools/render-utils` 取
 * `formatBytes`（该文件本身只是从 `@oh-my-pi/pi-utils` 的转发）。这里保留
 * 同一实现，避免把 TUI 渲染模块拖进库层。
 */

/** 与上游 `utils/src/format.ts:formatBytes` 一致：`512B` / `1.5KB` / `2.3MB` / `1.2GB`。 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/** 与上游 `utils/src/format.ts:formatAge` 一致：`3d ago` / `just now` 等。 */
export function formatAge(ageSeconds: number | null | undefined): string {
	if (!ageSeconds) return "";
	const mins = Math.floor(ageSeconds / 60);
	const hours = Math.floor(mins / 60);
	const days = Math.floor(hours / 24);
	const weeks = Math.floor(days / 7);
	const months = Math.floor(days / 30);

	if (months > 0) return `${months}mo ago`;
	if (weeks > 0) return `${weeks}w ago`;
	if (days > 0) return `${days}d ago`;
	if (hours > 0) return `${hours}h ago`;
	if (mins > 0) return `${mins}m ago`;
	return "just now";
}
