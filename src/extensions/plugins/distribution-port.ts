/**
 * Plugin 分发用的文件系统端口（P5）。
 *
 * 它比 `ExtensionStoragePort` 多了安装真正需要的**变更**操作：创建目录、
 * 原子 rename、递归删除与 symlink。所有变更操作都必须在 canonical home
 * 之下，并且由 composition root 注入实现；扩展域自身不 import `node:fs`。
 *
 * 安装路径固定为 staging → 校验 → 原子激活（D7）：绝不原地写目标目录，
 * 也绝不在目标目录里解包。
 */

import type { ExtensionStoragePort, ExtensionStorageResult } from "../storage-port.ts";

export interface ExtensionDistributionEntry {
	readonly name: string;
	readonly kind: "file" | "directory" | "symlink" | "other";
}

export interface ExtensionCopyTreeResult {
	readonly entries: number;
	readonly bytes: number;
}

export interface ExtensionDistributionPort extends ExtensionStoragePort {
	mkdirp(path: string): Promise<ExtensionStorageResult<void>>;
	/** 同设备原子改名；跨设备应由实现方拒绝而不是退化复制。 */
	rename(from: string, to: string): Promise<ExtensionStorageResult<void>>;
	remove(path: string, options: { readonly recursive: boolean }): Promise<ExtensionStorageResult<void>>;
	symlink(target: string, path: string): Promise<ExtensionStorageResult<void>>;
	/**
	 * 受 bounded 的递归复制。条目数与总字节数超限时**中途失败并返回 oversize**，
	 * 调用方负责清掉 staging；不允许静默截断。
	 */
	copyTree(from: string, to: string, limits: { readonly maxEntries: number; readonly maxBytes: number }): Promise<ExtensionStorageResult<ExtensionCopyTreeResult>>;
}

export const EXTENSION_DISTRIBUTION_LIMITS = Object.freeze({
	/** 单个 package 解包后的条目数上限。 */
	maxEntries: 20_000,
	/** 单个 package 解包后的总字节上限。 */
	maxBytes: 256 * 1024 * 1024,
	/** 单个 package 内单文件上限。 */
	maxFileBytes: 16 * 1024 * 1024,
	/** package.json 读取上限。 */
	maxManifestBytes: 256 * 1024,
});
