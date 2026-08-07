/**
 * 跨平台测试守卫。
 *
 * 项目运行时以 Linux 为 verified 平台(Windows/macOS 为 unverified_platform)。
 * POSIX-only 能力(Unix domain socket、symlink、文件 mode 位、sandbox 强制执行)
 * 在对应平台上以 `describe.skipIf(...)` 明确跳过,而不是假装跨平台等价。
 */

import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const IS_WINDOWS = process.platform === "win32";
export const IS_LINUX = process.platform === "linux";
export const IS_MACOS = process.platform === "darwin";
export const IS_POSIX = !IS_WINDOWS;

/** Windows 无 POSIX mode 语义,chmod 位恒为 0666;只有 POSIX 才断言 0600。 */
export const CAN_ASSERT_FILE_MODE = IS_POSIX;

/** Windows 上创建 symlink 需要开发者模式/管理员权限,失败即跳过 symlink 用例。 */
export function canCreateSymlink(): boolean {
	if (IS_WINDOWS) {
		const dir = mkdtempSync(join(tmpdir(), "runledger-symlink-probe-"));
		try {
			const target = join(dir, "target");
			const link = join(dir, "link");
			symlinkSync(target, link);
			return true;
		} catch {
			return false;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	return true;
}
