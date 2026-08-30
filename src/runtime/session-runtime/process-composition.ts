/**
 * Session-owned managed process composition —— 公共入口 facade。
 *
 * S3 拆分后实现位于 `process/`:
 * - `process/composition.ts`       facade(装配 + lifecycle + toolClient);
 * - `process/query-handler.ts`     list/output/wait 查询;
 * - `process/mutation-handler.ts`  spawn/stdin/eof/resize/stop;
 * - `process/foreground-execution.ts` stdlib 前台 Bash 桥;
 * - `process/output-materializer.ts` 输出/Trace 物化与恢复读回;
 * - `process/completion-settlement.ts` authorization/attempt 结算;
 * - `process/recovery.ts`          lost/uncertain 恢复投影;
 * - `process/composite-backend.ts` pipe/PTY 后端选择。
 *
 * 本文件只重导出,不复制实现;公共 import 路径不变。
 */

export {
	createSessionProcessComposition,
	SessionManagedProcessComposition,
	type SessionProcessCompositionOptions,
} from "./process/composition.ts";
