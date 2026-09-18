/**
 * R2 CLI:`runledger migrate schema --confirm` 显式离线 schema 升级入口。
 *
 * 崩溃的 owner 会永久停在 active state(没有进程能再 release 它),而 schema
 * gate 又在会话选择之前,旧库因此既打不开也迁不动。这里在 gate 之前补一步
 * 「死亡证明」:只有 heartbeat 过期且记录的 loopback 端点被内核拒绝连接的
 * owner 才从 active 计数中排除,其余照旧阻塞。
 */

import { stat } from "node:fs/promises";
import { resolveRunledgerHome } from "../storage/runledger-home.ts";
import { openSessionDatabase, type SessionDatabase } from "../storage/session-store/database.ts";
import {
	type DeadOwnerEvidence,
	listActiveOwners,
	migrateSessionStoreToCurrent,
} from "../storage/session-store/schema-compatibility.ts";
import { isHeartbeatStale } from "../runtime/session-owner/fence.ts";
import { SESSION_OWNER_HEARTBEAT_PARAMS } from "../runtime/session-owner/types.ts";
import { probeEndpointLiveness, type OwnerEndpointLiveness } from "../runtime/session-server/owner-probe.ts";
import { validateLegacyCliEnvironment } from "./authority.ts";

/** 死亡证明的注入点:生产用真实 loopback 探测,测试替换为确定性的实现。 */
export interface DeadOwnerProofDeps {
	readonly probeLiveness: (endpoint: { readonly host: "127.0.0.1"; readonly port: number }) => Promise<OwnerEndpointLiveness>;
	readonly now?: () => number;
}

/**
 * 证明哪些 active owner 已经死亡,供 offline migration gate 排除。
 *
 * 判据必须全部成立:heartbeat 已过期(或从未写入),且记录的 loopback 端点在
 * 全部 `takeoverProbes` 次探测中都被拒绝(`ECONNREFUSED`)。任一次得到
 * `listening` 或 `unreachable` 都视为「无法证明已死」——被 SIGSTOP 的进程内核
 * 仍会完成握手,超时也可能只是 backlog 满,都不能当作死亡证据。
 *
 * 返回的 identity 绑定 runtime_id + generation:gate 事务内若该 Session 已被新
 * runtime 重新 claim,行 identity 变化会让证据自动失效并重新阻塞迁移。
 */
export async function proveDeadOwners(db: SessionDatabase, deps: DeadOwnerProofDeps): Promise<readonly DeadOwnerEvidence[]> {
	const nowMs = (deps.now ?? Date.now)();
	const dead: DeadOwnerEvidence[] = [];
	for (const owner of listActiveOwners(db)) {
		if (!isHeartbeatStale(owner.heartbeatAtMs, nowMs)) continue;
		if (owner.endpoint === undefined) continue;
		let refusedEveryAttempt = true;
		for (let attempt = 0; attempt < SESSION_OWNER_HEARTBEAT_PARAMS.takeoverProbes; attempt += 1) {
			if ((await deps.probeLiveness(owner.endpoint)) !== "refused") {
				refusedEveryAttempt = false;
				break;
			}
		}
		if (!refusedEveryAttempt) continue;
		dead.push({ sessionId: owner.sessionId, runtimeId: owner.runtimeId, generation: owner.generation });
	}
	return dead;
}

/** 显式离线 schema 迁移；不创建空库、不变更既有 Session 的 profile。 */
export async function runMigrateSchemaCommand(argv: readonly string[]): Promise<void> {
	if (argv.length !== 1 || argv[0] !== "--confirm") {
		process.stderr.write("[runledger] Usage: runledger migrate schema --confirm\nStop all active Sessions before upgrading the existing state.db.\n");
		process.exitCode = 2;
		return;
	}
	try {
		const environmentError = validateLegacyCliEnvironment();
		if (environmentError !== undefined) throw new Error(environmentError);
		const { layout } = await resolveRunledgerHome();
		if (!(await stat(layout.database)).isFile()) throw new Error("state.db is not an existing file");
		const db = openSessionDatabase(layout.database);
		try {
			const deadOwners = await proveDeadOwners(db, {
				probeLiveness: (endpoint) => probeEndpointLiveness(endpoint, SESSION_OWNER_HEARTBEAT_PARAMS.connectTimeoutMs),
			});
			for (const owner of deadOwners) {
				process.stdout.write(
					`[runledger] ignoring provably dead owner ${owner.sessionId} generation ${owner.generation}: stale heartbeat and refused loopback endpoint\n`,
				);
			}
			const result = migrateSessionStoreToCurrent(db, { deadOwners });
			if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
			process.stdout.write(`[runledger] session store schema ${result.storeVersion} ready; existing Session profiles preserved\n`);
		} finally { db.close(); }
	} catch (error) {
		process.stderr.write(`[runledger] schema migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	}
}
