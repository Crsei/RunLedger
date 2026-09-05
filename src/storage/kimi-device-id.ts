/** Kimi 安装设备标识的 canonical 用户布局存储；不读取旧 agent 目录。 */
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";

/** 每个注入实例只缓存一个 ID，持久化不可用时仍可构造 OAuth 请求头。 */
export function createKimiCodeDeviceIdProvider(layout: RunledgerLayout): () => string {
	const path = join(layout.home, "kimi-device-id");
	let cached: string | undefined;
	const read = (): string | undefined => {
		try {
			const value = readFileSync(path, "utf8").trim();
			return /^[a-f0-9]{32}$/u.test(value) ? value : undefined;
		} catch { return undefined; }
	};
	return () => {
		cached ??= read();
		if (cached !== undefined) return cached;
		const candidate = randomUUID().replaceAll("-", "");
		cached = candidate;
		const temporary = join(layout.home, `.kimi-device-id-${randomUUID()}.tmp`);
		try {
			mkdirSync(layout.home, { recursive: true, mode: 0o700 });
			writeFileSync(temporary, `${candidate}\n`, { flag: "wx", mode: 0o600 });
			// 完整文件发布后才可见；并发创建不会覆盖已发布的安装标识。
			linkSync(temporary, path);
		} catch (error: unknown) {
			// 只有并发发布赢家时需要重读；其他存储失败保持本实例临时 ID。
			if (error instanceof Error && "code" in error && error.code === "EEXIST") cached = read() ?? candidate;
		} finally {
			try { unlinkSync(temporary); } catch { /* 临时文件可能未创建。 */ }
		}
		return cached;
	};
}
