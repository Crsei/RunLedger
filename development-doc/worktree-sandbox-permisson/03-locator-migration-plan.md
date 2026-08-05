# P5 私有 workspace locator 迁移计划（显式计划，未执行）

> 状态：**PLAN ONLY，不执行**。migration 只有在 digest/TOCTOU/rollback 方案
> 获批后才允许执行；当前只提供 read-only audit（`src/workspace/locator-audit.ts`）
> 与本计划。
>
> 关联：[`01-multiplatform-workspace-path-adaptation-plan.md`](01-multiplatform-workspace-path-adaptation-plan.md) P5、
> [`02-path-locator-adr.md`](02-path-locator-adr.md) D4。

## 1. 背景与目标记录形态

- 目标形态（current，version=1）：`{ "version": 1, "platform", "kind", "path" }`；
  private store 只写该形态，读取只接受 version=1（`decodePrivateLocator`）。
- 旧形态（legacy）：未版本化 native absolute path 字符串或对象（pre-adapter
  时期的 registry/session 记录）。**不猜测转换**：无法无损解释 → typed
  `migration_required` / `invalid`。

## 2. 迁移流程（获批后执行顺序）

1. **read-only audit**：`auditLocatorCollection` 对全部候选记录分类
   （current / migration_required / invalid），输出审计报告与逐条 reason；
2. **digest manifest**：审计前对每个记录文件计算 SHA-256 并持久化 manifest，
   迁移写入前再次比对，任何 drift 立即中止；
3. **TOCTOU 窗口控制**：audit 与 migrate 之间持有迁移独占锁（proper-lockfile），
   锁内重读并重比对 manifest；窗口内记录被修改 → 中止并标记
   `migration_conflict`，不覆盖；
4. **迁移写入**：current 记录原样保留；migration_required 记录按平台规则
   re-encode 为 version=1（仅同平台、kind 明确时）；invalid 记录不迁移；
5. **rollback**：迁移是 append-only journal：写入前把原始内容连同 digest 追加
   到 `migration-journal.jsonl`，任一步失败按 journal 逆序恢复原始内容并
   标记 `migration_rollback`；
6. **终态校验**：迁移后全部记录重新 audit，任何一条非 current → 整体视为
   失败并回滚，不部分成功。

## 3. 本阶段（P5）只做

- [x] `PrivateLocatorV1` schema version 固定（P3/P4 已交付）；
- [x] read-only audit：`src/workspace/locator-audit.ts` + fixture 测试；
- [x] cold resume 重验：`src/workspace/resume.ts`（platform/root/Git 注册
   同一性/HEAD==base/effective subdir/lease），失败 fail closed，不回退
   source repo；
- [x] mismatch negative tests（platform_mismatch / invalid_path /
   stale_registration / base_drift / cross_root_containment / lease）；
- [ ] **迁移执行**：未获批，不执行（digest/TOCTOU/rollback 方案批准后再
   单独立项）。

## 4. 停止条件

- audit 出现任何无法分类的记录；
- manifest digest 与磁盘内容不一致；
- 目标平台与 locator 平台不一致（`platform_mismatch`）；
- 任一记录在迁移窗口内被修改；
- rollback 无法恢复到原始字节。
