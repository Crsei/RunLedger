/**
 * R2:Session-scoped Security/ExecutionGateway composition —— 公共入口 facade。
 *
 * S2 拆分后实现位于 `src/security/composition/`:
 * - `session-security.ts`     composition root(createSessionSecurity + 选项/结果类型);
 * - `snapshot-loader.ts`      managed/project/user config source 加载;
 * - `permission-requester.ts` request_permissions 翻译 + authorization request/authorizer;
 * - `managed-process-security.ts` managed process prepare/complete 生命周期;
 * - `governed-filesystem.ts` / `governed-network.ts` / `governed-shell.ts` 三个 governed leaf;
 * - `constraint-providers.ts` execution/sandbox 约束与 workspace envelope;
 * - `audit-settlement.ts`     gateway effect 结算与 bash classification audit 关联。
 *
 * 本文件只重导出,不复制实现;公共 import 路径不变。
 * `resolveToolAccessRequestsWithBashAnalyzer` 在此重导出,保持
 * bash-ast-security-boundaries 对“composition 入口路由经统一 access resolver”
 * 的静态检查语义(不引入第二个 bash access resolver)。
 */

export {
	createSessionSecurity,
	type SessionSecurityConfigSource,
	type SessionSecurityCompositionOptions,
	type SessionSecurityComposition,
	type SessionIdentity,
} from "./composition/session-security.ts";
export type {
	SessionManagedProcessSecurityRequest,
	PreparedSessionManagedProcessSecurity,
	SessionManagedProcessSecurity,
} from "./composition/managed-process-security.ts";
export { resolveToolAccessRequestsWithBashAnalyzer } from "./permission/access-resolver.ts";
export type { SessionProcessIo, SessionProcessLeaf } from "./integration/session-local-leaves.ts";
