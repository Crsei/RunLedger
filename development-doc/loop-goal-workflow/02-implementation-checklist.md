# RunLedger Loop / Goal / Dynamic Workflow RED-first 实施清单

> 文档状态:待执行<br>
> 编写日期:2026-07-24<br>
> 实施计划:[`01-implementation-plan.md`](01-implementation-plan.md)<br>
> Runtime 权威总计划:[`../runtime/04-governed-agent-harness-runtime-plan.md`](../runtime/04-governed-agent-harness-runtime-plan.md)<br>
> 冻结边界:[`../runtime/06-specialty-implementation-freeze.md`](../runtime/06-specialty-implementation-freeze.md)

## 0. 使用规则

### 0.1 状态规则

- `[ ]`:未执行或没有当前目标分支证据;
- `[x]`:当前阶段已有命令、结果、commit状态和剩余 gap 证据;未获授权时commit状态必须写`not authorized/not applicable`;
- 不允许因文件存在、测试 fake、process-local seam 或口头说明勾选;
- 每阶段按 `RED -> GREEN -> REFACTOR -> stage gate` 顺序;
- RED 必须是预期行为缺失导致的 assertion failure,不能是依赖缺失、syntax/type error、fixture path错误或超时;
- RED 只保存预期失败证据,不在默认 `npm test` 仍失败时独立commit;任一 GREEN/可提交 checkpoint必须先通过定向测试,再显式通过 `npm run check`、完整 `npm test`、`npm run build`、`npm run test:harness-regression`、两个boundary scripts与`git diff --check`,并保存完整输出和file/test count;
- 定向测试、consumer gate与冻结专项门禁都不能替代完整 `npm test`;
- 如果阶段只完成一部分,保留总项 `[ ]`,在 evidence 中记录已完成 slice。

### 0.2 Git 与工作区

- 当前规划 checkout:`feat/agent-loop-resurrect@678b046b3cd11632c5e5bfc7ef5dd210e8f23ec3`;
- 规划时存在其他未提交文档改动,后续实施前必须重新检查,不得清理、stash或覆盖;
- 用户没有要求本规划任务创建 worktree、commit 或 push;
- 后续只有用户明确授权时才 commit/push;
- 暂存只使用显式路径,遵循根 `AGENTS.md`;
- 每阶段独立 commit 的前提是用户明确授权该提交节奏。

实施前固定执行:

```bash
pwd
git status --short
git branch --show-current
git rev-parse HEAD
git worktree list --porcelain
git diff --check
```

若选择 sibling worktree,先确认当前 worktree/branch 不冲突;fresh worktree 先 `npm ci`,禁止让 `npx` 临时下载未锁定依赖。

### 0.3 冻结路径守卫

每阶段开始时把 `06-specialty-implementation-freeze.md` §3 固定为 exact manifest,结束时仍以同一 manifest 检查。manifest 必须完整包含:

- `src/runtime/model-routing/**`、`src/runtime/modes/plan/**`、`src/runtime/context/**`;
- `src/runtime/tools/{plan-write,memory-search,memory-get,memory-propose}.ts`;
- `src/storage/{context-paths,plan-artifact-store,plan-mode-state-store,compaction-projection-store,memory-store,memory-index,memory-extraction-lease}.ts`;
- `tests/runtime-v3/{model-routing,modes/plan,context,plan-context-memory}/**`;
- `tests/runtime-v3/fixtures/{model-routing,plan-mode,context,compaction,memory,taint}/**` 与 `tests/runtime-v3/fixtures/contract-ownership/runtime-phase6.json`;
- `tests/runtime-v3/contracts/{model-routing,plan-mode,context,compaction,memory}.test.ts`;
- `tests/storage/{plan-mode-state-store,compaction-projection-store}.test.ts`;
- `src/extensions/**`、`src/storage/extension-node-storage.ts`、`tests/extensions/**`、`tests/fixtures/extensions/**`;
- `package.json` 中 `./extensions` public export 的既有语义;
- `src/security/**`、`src/worktree/**`;
- `src/storage/{approval-event-reconciler,production-tool-gateway,security-runtime-state,worktree-node-adapter,worktree-production,worktree-state-adapter}.ts`;
- `tests/security/**`、`tests/worktree/**`;
- `tests/storage/{approval-event-reconciler,approval-state-store.contract}.test.ts`;
- `src/runtime/protocol/v3/**` 中三个专项已消费的既有 schema/event/port 语义与 reference fixtures;
- `06` §3.4 shared Runtime surfaces 中已冻结的专项调用顺序、port identity/generation 和 fail-closed 语义。

不能只看 unstaged diff。每阶段记录 `<stage-base>` 后分别检查 committed range、staged、unstaged 与 untracked:

```bash
# 用阶段开始时记录的完整commit替换右值,禁止用阶段结束时的HEAD代替。
workflow_stage_base=REPLACE_WITH_RECORDED_STAGE_BASE
workflow_frozen_paths=(
  src/runtime/model-routing
  src/runtime/modes/plan
  src/runtime/context
  src/runtime/tools/{plan-write,memory-search,memory-get,memory-propose}.ts
  src/storage/{context-paths,plan-artifact-store,plan-mode-state-store,compaction-projection-store,memory-store,memory-index,memory-extraction-lease}.ts
  tests/runtime-v3/{model-routing,modes/plan,context,plan-context-memory}
  tests/runtime-v3/fixtures/{model-routing,plan-mode,context,compaction,memory,taint}
  tests/runtime-v3/fixtures/contract-ownership/runtime-phase6.json
  tests/runtime-v3/contracts/{model-routing,plan-mode,context,compaction,memory}.test.ts
  tests/storage/{plan-mode-state-store,compaction-projection-store}.test.ts
  src/extensions
  src/storage/extension-node-storage.ts
  tests/extensions
  tests/fixtures/extensions
  src/security
  src/worktree
  src/storage/{approval-event-reconciler,production-tool-gateway,security-runtime-state,worktree-node-adapter,worktree-production,worktree-state-adapter}.ts
  tests/security
  tests/worktree
  tests/storage/{approval-event-reconciler,approval-state-store.contract}.test.ts
)
git diff --name-only "$workflow_stage_base"...HEAD -- "${workflow_frozen_paths[@]}"
git diff --cached --name-only -- "${workflow_frozen_paths[@]}"
git diff --name-only -- "${workflow_frozen_paths[@]}"
git ls-files --others --exclude-standard -- "${workflow_frozen_paths[@]}"
git diff "$workflow_stage_base"...HEAD -- package.json src/runtime/protocol/v3
git diff --cached -- package.json src/runtime/protocol/v3
git diff -- package.json src/runtime/protocol/v3
git ls-files --others --exclude-standard -- src/runtime/protocol/v3
node scripts/check-runtime-boundaries.ts
node scripts/check-execution-boundaries.ts
```

预期:frozen implementation/tests/fixtures零diff;`package.json` 的 `./extensions` export语义不变;protocol diff只包含已登记的 additive workflow L0 revision,既有 specialty consumer字段、guard与failure discriminant不变。L0结束还必须复跑三个冻结专项完整命令与所有 protocol consumers。若确实需要改变 frozen contract,立即停止,按 `06` §7 解冻,不能在 workflow 阶段顺手修改。

### 0.4 规划基线证据

- [x] 三个 reference repo 已由独立 subagent 在固定 commit 上只读审阅。
- [x] RunLedger Goal/Task/Budget/Verification/Agent/production seam 已审阅。
- [x] 现有定向基线通过:`6 files / 22 tests`。
- [x] 已确认不创建第二套 Goal/Task state machine。
- [x] 已确认 V1 为封闭 `coding-goal/v1`,不是 executable YAML/plugin workflow。

基线命令:

```bash
npx vitest run \
  tests/runtime-v3/orchestrator/goal-state-machine.test.ts \
  tests/runtime-v3/orchestrator/prompt-goal-coordinator.test.ts \
  tests/runtime-v3/orchestrator/agent-loop-wiring.test.ts \
  tests/runtime-v3/orchestrator/retry-loop-breaker.test.ts \
  tests/runtime-v3/integration/production-session-runtime.test.ts \
  tests/runtime-v3/control-plane/phase11-production-binding.test.ts \
  --no-file-parallelism
```

## M0. 合同与 RED 基线

### M0-P0. Runtime 04/05 docs-only registration

任何 RED 或 production source 之前:

- [ ] 在 Runtime `04` 登记 proposed `W7 Workflow Core` 与 `W8 Workflow Product Join`,并决定必须等待当前 pending `W6-G`,还是显式修订严格顺序允许 additive W7/W8。
- [ ] 在 Runtime `04` execution ledger记录 `W7-P0/L0/R1/J/G` 与 `W8-L0/R1/R2/J/G`;每个Wave只有一个L4 `-J`。
- [ ] 记录每个lane owner、branch/worktree、base commit、exact allowlist、L0/L2/L3/L4 join lock与handoff顺序。
- [ ] 明确 `L1 Dependency=closed/no-write`;若需要package/lockfile变更,先另开L1 dependency review task。
- [ ] 明确哪些既有 completed Wave/gate只扩展、哪些因新增scope重新opened/pending。
- [ ] 同步 Runtime `05` remaining/readiness结论。
- [ ] 未完成以上登记时只允许继续文档规划,不创建 RED tests/fixtures,不修改production source。

### M0-A. 范围与 ownership

- [ ] 记录目标 branch/worktree/HEAD、owner、允许路径和 serialized join 文件。
- [ ] 记录 Runtime `04` 当前 W6-G/W7/W8 对应关系与前置结论。
- [ ] 记录 frozen contract commit与三组专项定向门禁。
- [ ] 固定 feature modes:`off | shadow | opt_in | default | required`。
- [ ] 固定 `coding-goal/v1` schemaVersion、ID family、event family。
- [ ] 固定 GoalPhase/workflow disposition/wait reason 三轴边界。
- [ ] 固定 wake at-least-once + idempotent consumer,禁止 exactly-once 表述。
- [ ] 固定 restart默认 pause/reconcile。
- [ ] 固定 verifier unavailable/disabled/error不完成Goal。

### M0-B. 先写 RED

M0 只新增能通过 TypeScript 编译的 public contract RED:

```text
tests/runtime-v3/orchestrator/workflow/public-contract-red.test.ts
```

- [ ] RED从现有 public barrel、event catalog、schema validator与boundary API做runtime assertion,禁止static import尚不存在的模块。
- [ ] RED:workflow event family尚未进入 exact catalog/schema/mandatory-flush view。
- [ ] M0 RED只覆盖下一阶段M1-L0可以关闭的protocol/export/event-family缺口。
- [ ] `coding-goal/v1` definition validator/repository、kernel/scheduler、driver public RED分别在M1-L1、M2、M3所属阶段新增,不把未来阶段永久失败用例提前放入默认suite;M4 continuation tests也不得提前放入M0。
- [ ] 验证 RED 原因是明确 assertion mismatch。
- [ ] 保存 RED 命令、失败数和首个关键错误。

### M0-C. Stage gate

- [ ] 只新增docs与public RED test,不含schema/reference fixtures,没有production behavior。
- [ ] Runtime 04/05 docs-only registration已完成。
- [ ] 既有 baseline仍通过。
- [ ] frozen paths零diff。
- [ ] `git diff --check`通过。
- [ ] M0 RED只保存预期失败证据,commit status记`not applicable`;由M1-L0详细测试接管后,只有完整默认suite恢复全绿且获授权才按显式路径提交。

## M1-L0. Additive Workflow Protocol Contract Window

### M1-L0-A. Exact paths

```text
src/runtime/protocol/v3/ids.ts
src/runtime/protocol/v3/event-catalog.ts
src/runtime/protocol/v3/event-payloads.ts
src/runtime/protocol/v3/event-references.ts
src/runtime/protocol/v3/schemas.ts
src/runtime/session/event-writer.ts
tests/runtime-v3/orchestrator/workflow/protocol-contract.test.ts
tests/runtime-v3/orchestrator/workflow/public-contract-red.test.ts
tests/runtime-v3/orchestrator/workflow/public-contract.test.ts
tests/runtime-v3/schema.test.ts
tests/runtime-v3/reference-snapshots.test.ts
tests/runtime-v3/fixtures/workflow/
```

本窗口只允许 IDs、event catalog/payload/schema/reference fixture 与 mandatory-flush additive revision,不实现definition repository/projection行为,不改变既有 specialty consumer字段语义。

### M1-L0-B. Protocol RED/GREEN

- [ ] RED:每个 `workflow.*` event有独立 exact payload schema。
- [ ] RED:workflow event只允许session stream。
- [ ] RED:oversized string/array/Artifact refs拒绝。
- [ ] RED:unknown ID、64位小写十六进制digest、timestamp拒绝。
- [ ] RED:Goal phase、Task definition/status/output、Budget counter、Verification outcome副本被schema拒绝。
- [ ] RED:所有mutation/claim/terminal event必须mandatory flush。
- [ ] RED:dead-letter recovery只能以`operator_dead_letter_recovery + sourceId(commandId) + recoveryOfWakeId + source terminal full EventCursor + authorization receipt refs`描述fresh wake,不存在reopen/requeue-old-wake event。
- [ ] GREEN:event catalog/payload map/schema/IDs一致。
- [ ] GREEN:reference snapshots/fixtures更新且经人工审阅。
- [ ] GREEN:旧事件链仍可validate/replay。
- [ ] GREEN:M0临时`public-contract-red.test.ts`的assertions在本阶段全部转绿并迁入`public-contract.test.ts`,随后删除临时RED文件;显式暂存GREEN文件,不得留下未归属untracked/changed RED文件。

### M1-L0-C. Consumer/gate/handoff

```bash
npx vitest run \
  tests/runtime-v3/orchestrator/workflow/protocol-contract.test.ts \
  tests/runtime-v3/orchestrator/workflow/public-contract.test.ts \
  tests/runtime-v3/schema.test.ts \
  tests/runtime-v3/reference-snapshots.test.ts \
  --no-file-parallelism
```

- [ ] `06` §6 Plan/Context/Memory 16-file gate全绿。
- [ ] `06` §6 Extension 12-file gate全绿。
- [ ] `06` §6 Security/Worktree 21-file gate全绿。
- [ ] 所有既有 protocol/session consumer tests全绿。
- [ ] `npm run check`、完整 `npm test`、`npm run build`、`npm run test:harness-regression`全绿,保存完整输出与file/test count。
- [ ] 两个boundary scripts与`git diff --check`全绿。
- [ ] `<stage-base>...HEAD`、staged、unstaged、untracked frozen manifest零越界。
- [ ] 记录event family、schema/version digest、reference fixture diff与consumer handoff。
- [ ] 所有后续lane基于同一L0 handoff rebase后才开始。
- [ ] 如获commit授权,L0独立commit;禁止与M1-L1行为实现合并。

## M1-L1. Definition、Repository 与 Projections

### M1-L1-A. Intended production paths

```text
src/runtime/orchestrator/workflow/definition.ts
src/runtime/orchestrator/workflow/types.ts
src/runtime/orchestrator/workflow/events.ts
src/runtime/orchestrator/workflow/projection.ts
src/runtime/orchestrator/workflow/repository.ts
src/runtime/orchestrator/workflow/index.ts
src/runtime/orchestrator/index.ts
tests/runtime-v3/orchestrator/workflow/definition.test.ts
tests/runtime-v3/orchestrator/workflow/projection.test.ts
tests/runtime-v3/orchestrator/workflow/repository.test.ts
```

### M1-L1-B. Definition RED/GREEN

- [ ] RED:只接受 `schemaVersion=1/workflowKind=coding-goal/v1`。
- [ ] RED:objective/success criteria必须是ArtifactRef+digest,不能内联任意prompt。
- [ ] RED:definition digest错误拒绝。
- [ ] RED:definition revision非正整数/倒退/重复冲突拒绝。
- [ ] RED:unknown policy/field因 exact schema拒绝。
- [ ] RED:policy bounds超限拒绝。
- [ ] RED:running attempt中definition replacement拒绝。
- [ ] RED:没有显式Artifact refs/provenance不能bind definition。
- [ ] RED:Artifact scope/digest/media type/unavailable校验失败时不能bind。
- [ ] RED:definition bind本身不能隐式start run/Agent。
- [ ] RED:legacy session不能从transcript自动推断definition。
- [ ] GREEN:实现pure definition validator/digest helper。
- [ ] GREEN:definition immutable;replacement只生成新record/run。
- [ ] GREEN:old definition仍可replay/inspect。
- [ ] GREEN:repository mutation全部有expected revision/idempotency。

### M1-L1-C. Projection/Repository RED/GREEN

- [ ] RED:definition未record就bound拒绝。
- [ ] RED:一个run多active driver拒绝。
- [ ] RED:wake未enqueue就claim拒绝。
- [ ] RED:consumed/dead-letter wake再次claim拒绝。
- [ ] RED:attempt未claim就turn-bound/terminal拒绝。
- [ ] RED:stale generation result拒绝。
- [ ] RED:当前paused且尚无durable `run_resumed`、cancelled或Goal terminal后新attempt拒绝。
- [ ] RED:`run_resumed` 后同一open run允许后续attempt,不创建replacement run。
- [ ] RED:wait未register就satisfy拒绝。
- [ ] RED:claimed/deferred/cancelled/reclaimed/consumed/dead-letter非法迁移拒绝。
- [ ] RED:workflow result携带Goal phase或Task状态副本拒绝。
- [ ] RED:canonical effect没有相同decision idempotency对应receipt cursor/digest时不能finished。
- [ ] RED:online reducer与full replay divergence拒绝。
- [ ] GREEN:definition/run/attempt/wake/wait projections实现。
- [ ] GREEN:projection clone不可被caller mutation。
- [ ] GREEN:cache/snapshot删除后从完整Event Store重建。

### M1-L1-D. Tests/gate

```bash
npx vitest run \
  tests/runtime-v3/orchestrator/workflow/definition.test.ts \
  tests/runtime-v3/orchestrator/workflow/projection.test.ts \
  tests/runtime-v3/orchestrator/workflow/repository.test.ts \
  --no-file-parallelism
```

- [ ] 定向全绿。
- [ ] `npm run check`、完整 `npm test`、`npm run build`、`npm run test:harness-regression`全绿,保存完整输出与file/test count。
- [ ] 两个boundary scripts全绿。
- [ ] `git diff --check`全绿。
- [ ] frozen paths零diff。
- [ ] 如获commit授权,只暂存M1-L1显式路径,与L0保持独立commit。

## M2. Pure Kernel 与 Deterministic Task Scheduler

### M2-A. Intended paths

```text
src/runtime/orchestrator/workflow/decision-kernel.ts
src/runtime/orchestrator/workflow/task-scheduler.ts
src/runtime/orchestrator/workflow/outcomes.ts
tests/runtime-v3/orchestrator/workflow/decision-kernel.test.ts
tests/runtime-v3/orchestrator/workflow/task-scheduler.test.ts
```

### M2-B. Scheduler RED

- [ ] 不同input array/Map insertion order产生同一decision digest。
- [ ] pending Task只有依赖全completed才可mark ready。
- [ ] ready Task按topological position再taskId lexical选择。
- [ ] running Task没有attempt correlation进入reconciling。
- [ ] dependency failed/cancelled不自动创建replacement Task。
- [ ] blocked Task不被直接start。
- [ ] Task output未全部绑定不能completed。
- [ ] Task projection goalId drift拒绝。
- [ ] owner/workspace/capability/resource/budget不ready时返回typed wait。
- [ ] scheduler绝不调用`SessionTaskRepository.create/reviseDefinition`。

### M2-C. Kernel RED

- [ ] terminal Goal只允许close/no-op,不能新wake/attempt。
- [ ] 没有claimed durable wake时operator/canonical/timer不能直接产生effect decision。
- [ ] user input pending作为admission gate使internal wake deferred,用户输入本身不是wake。
- [ ] Budget hard stop不启动attempt。
- [ ] soft limit允许current attempt settle但不启动下一attempt。
- [ ] verifier unavailable/disabled/error不产生complete decision。
- [ ] verified gap未清零不产生completion transition。
- [ ] duplicate progress/verification delivery不重复推进existing LoopBreaker/attempt projection。
- [ ] existing LoopBreaker `maxNoProgress` trip只pause,不complete。
- [ ] verification attempt limit只pause/wait。
- [ ] unknown readiness不能被当成ready。
- [ ] exhaustive switch有`never` compile guard。

### M2-D. GREEN/REFACTOR

- [ ] kernel无I/O/Date.now/process/env/model调用。
- [ ] `now`作为显式input。
- [ ] decision保存input digest和expected revisions。
- [ ] progress fingerprint只用durable evidence。
- [ ] LoopBreaker/retry只消费existing snapshot/receipt。
- [ ] workflow projection不保存第二份stall/retry counter。
- [ ] 没有第二份Task/Goal transition table。

### M2-E. Gate

```bash
npx vitest run \
  tests/runtime-v3/orchestrator/workflow/decision-kernel.test.ts \
  tests/runtime-v3/orchestrator/workflow/task-scheduler.test.ts \
  tests/runtime-v3/orchestrator/goal-state-machine.test.ts \
  tests/runtime-v3/orchestrator/prompt-goal-coordinator.test.ts \
  tests/runtime-v3/orchestrator/retry-loop-breaker.test.ts \
  --no-file-parallelism
```

- [ ] deterministic/property/table tests全绿。
- [ ] `npm run check`、完整 `npm test`、`npm run build`、`npm run test:harness-regression`全绿,保存完整输出与file/test count。
- [ ] 两个boundary scripts与`git diff --check`全绿。
- [ ] frozen paths零diff。
- [ ] 如获commit授权,只暂存M2显式路径。

## M3. Durable Driver、Generation、Wake/Wait 与 Recovery

### M3-A. Intended paths

```text
src/runtime/orchestrator/workflow/driver-generation.ts
src/runtime/orchestrator/workflow/wake-inbox.ts
src/runtime/orchestrator/workflow/ports.ts
src/runtime/orchestrator/workflow/repository.ts
src/runtime/orchestrator/workflow/driver.ts
tests/runtime-v3/orchestrator/workflow/wake-inbox.test.ts
tests/runtime-v3/orchestrator/workflow/driver.test.ts
tests/runtime-v3/orchestrator/workflow/recovery.test.ts
tests/runtime-v3/orchestrator/workflow/cancellation.test.ts
```

### M3-B. Wake inbox RED

- [ ] `wake_enqueued` mandatory flush本身是one-shot due真源,不存在第二个due/occurrence cursor。
- [ ] exact duplicate dedup为同一pending wake。
- [ ] 相同dedupKey不同payload产生idempotency conflict。
- [ ] claim-before-consume。
- [ ] claimed wake在effect intent前crash可恢复。
- [ ] user pending/busy/Plan/review/paused defer只增加`admissionDeferralCount`,不增加`deliveryFailureCount`。
- [ ] malformed/unprocessable/实际delivery failure才增加有界`deliveryFailureCount`。
- [ ] 只有delivery failure超cap才进入dead-letter,正常idle延期永不dead-letter。
- [ ] claimed/deferred/cancelled/reclaimed/consumed/dead-letter transitions逐项验证。
- [ ] consumed/dead-letter不可重开;不存在reopen/requeue-old-wake event。
- [ ] dead-letter recovery只能为同一open run中完整`EventCursor(stream/sequence/eventId/eventHash)` exact匹配且无effect intent/unknown side effect的source创建不同`wakeId`的fresh wake。
- [ ] recovery identity exact绑定schema/kind/authority/tenant/session/source wake/full cursor;fresh wake固定`origin=operator_dead_letter_recovery`、`sourceId=commandId`、stable dedup、`recoveryOfWakeId=sourceWakeId`、authorization receipt ID/digest、due-now且两个counter从零开始。
- [ ] authorization receipt不进入recovery identity,但repository/replay必须校验其scope/request/policy/digest;缺失或drift拒绝。
- [ ] fresh wake的`expectedDriverGeneration`必须是exact number或`null`(CAS确认无active driver),不能optional。
- [ ] recovery不允许payload/Artifact/Goal/Task/instruction override,不改变Goal/run状态、不隐式resume且不直接tick。
- [ ] exact duplicate只返回同一fresh wake;不同command对同一source固定返回`recovery_already_exists`且不生成第二个child;child再次dead-letter后只能恢复child。
- [ ] source非dead-letter、full cursor或revision/generation drift、run已关闭、已有effect intent均零写入。
- [ ] `reconciliation_terminal`只由Runtime内部verified canonical terminal producer使用,不得携带`recoveryOfWakeId`或旁路operator authorization。
- [ ] notBefore未到不能claim。
- [ ] wait satisfaction duplicate只产生一个wake。
- [ ] wait提前满足会durable cancel `wait-timeout:<waitId>` wake。
- [ ] recurring cron/schedule occurrence/cursor输入被V1 validator拒绝。

### M3-C. Driver generation RED

- [ ] 无active EventWriter authority不能activate。
- [ ] generation绑定writer lease/epoch/fence digest。
- [ ] 同session第二active driver拒绝或replace旧generation。
- [ ] driver replacement后,无effect intent的旧claimed wake可由新generation写`wake_reclaimed`。
- [ ] 已有effect intent的claimed wake禁止reclaim并进入reconciliation。
- [ ] runtime replacement后旧callback拒绝。
- [ ] heartbeat丢失不能单独takeover。
- [ ] stale Goal/Task/workflow revision拒绝effect。
- [ ] interactive与daemon不能并行claim。

### M3-D. Bounded tick RED

- [ ] 一次tick最多一个decision/effect。
- [ ] tick从不递归或while-drain全部wake。
- [ ] 请求driver decision/effect的operator/canonical terminal/timer/recovery没有先durable enqueue wake时不能执行effect。
- [ ] claim前和intent后启动前都复检user/busy/generation。
- [ ] user/stop/busy/Plan/review只作admission/preemption,不产生workflow wake。
- [ ] intent未durable不执行effect。
- [ ] effect明确未开始可retry。
- [ ] effect已开始无terminal receipt进入reconciling。
- [ ] intent后/canonical effect event前crash按certainty retry或reconcile。
- [ ] canonical effect event后/workflow result前crash只replay receipt cursor/digest,不重复Goal/Task effect。
- [ ] workflow result payload不复制Goal phase、Task definition/status/output。
- [ ] every exit path attempt finalized或reconciliation。
- [ ] wake只在result/deferral durable后consume。
- [ ] throw/abort/process close不遗留silent running attempt。

### M3-E. Wait/restart/cancel RED

- [ ] external wait只由exact canonical event satisfy。
- [ ] sleeping只由due wake唤醒。
- [ ] restart默认paused;not-started effect只重建pending work,没有`run_resumed`不能交付。
- [ ] `resume_if_safe` + not-started effect只有门禁全绿并先durable `run_resumed`才可交付。
- [ ] terminal-known effect从canonical receipt finalize且不重放。
- [ ] unknown effect进入reconciling且不重放。
- [ ] `resume_if_safe`有unknown effect时拒绝。
- [ ] cancel-requested与cancelled分开。
- [ ] 当前paused run不启动attempt;durable `run_resumed` 后同一open run可以继续。
- [ ] pause/cancel取消future wakes,timeout wake也取消。
- [ ] active effect取消不确定时run不terminal。
- [ ] old session无definition保持manual/unsupported。
- [ ] fork不复制definition binding/run/attempt/wake/wait/driver/budget correlation且不auto-start。

### M3-F. Gate

```bash
npx vitest run \
  tests/runtime-v3/orchestrator/workflow/definition.test.ts \
  tests/runtime-v3/orchestrator/workflow/projection.test.ts \
  tests/runtime-v3/orchestrator/workflow/repository.test.ts \
  tests/runtime-v3/orchestrator/workflow/decision-kernel.test.ts \
  tests/runtime-v3/orchestrator/workflow/task-scheduler.test.ts \
  tests/runtime-v3/orchestrator/workflow/wake-inbox.test.ts \
  tests/runtime-v3/orchestrator/workflow/driver.test.ts \
  tests/runtime-v3/orchestrator/workflow/recovery.test.ts \
  tests/runtime-v3/orchestrator/workflow/cancellation.test.ts \
  --no-file-parallelism
```

- [ ] workflow unit/repository/fault tests全绿。
- [ ] in-memory与JSONL Event Store均验证。
- [ ] `npm run check`、完整 `npm test`、`npm run build`、`npm run test:harness-regression`全绿,保存完整输出与file/test count。
- [ ] 两个boundary scripts与`git diff --check`全绿。
- [ ] frozen paths零diff。
- [ ] 如获commit授权,只暂存M3显式路径。

## M4. Agent/Controller Internal Continuation 与 Loop Outcome

### M4-A. Serialized join declaration

本阶段开始时打开 `W7-J`,由同一owner连续完成M4与M5后再关闭;M4 gate只是join内部checkpoint,不得把L2/L3/L4 handoff给并行lane。开始前记录单一owner和exact diff base。预期路径:

```text
src/runtime/types.ts
src/runtime/agent-loop.ts
src/runtime/agent.ts
src/runtime/interactive-session-controller.ts
src/runtime/session/agent-loop-events.ts
src/runtime/integration/production-context-providers.ts
src/runtime/orchestrator/workflow/ports.ts
src/runtime/orchestrator/workflow/outcomes.ts
src/runtime/orchestrator/workflow/resource-snapshot.ts
tests/runtime-v3/orchestrator/workflow/agent-continuation.test.ts
tests/runtime-v3/orchestrator/workflow/agent-outcome.test.ts
tests/runtime-v3/orchestrator/workflow/resource-admission.test.ts
tests/runtime-v3/orchestrator/agent-loop-wiring.test.ts
tests/runtime-v3/session/agent-loop-events.test.ts
```

- [ ] 记录其他并行lane已停止修改shared join files。
- [ ] 记录M0-M3 GREEN commit/base。
- [ ] 修改前保存shared files diff。

### M4-B. Continuation RED

- [ ] `WorkflowContinuationEnvelope`不是`AgentMessage/UserAgentMessage`。
- [ ] internal continuation不调用`normalizePrompts()`。
- [ ] internal continuation不append user `queue.enqueued`。
- [ ] envelope scope/revision/generation/digest drift拒绝。
- [ ] attempt未durable claim拒绝启动Agent。
- [ ] pending user input抢占internal continuation。
- [ ] Plan/review/busy/active turn拒绝并durable defer。
- [ ] claim后user竞态仍可抢占。
- [ ] internal instruction通过typed context fragment/provenance进入model preparation。
- [ ] replay/resume保留`origin=goal_workflow`,绝不重建`AgentMessage/UserAgentMessage`。
- [ ] replay/resume不产生`queue.enqueued`,不改变user prompt/steer/follow-up FIFO、identity或receipt归属。
- [ ] instruction Artifact scope/digest/media type校验并以结构化fragment转义,不能突破system/user边界。
- [ ] Context provider不可用时external gap,不拼接raw system prompt旁路。

### M4-C. Outcome RED

- [ ] settled/interrupted/waiting_permission/budget_limited/external_gap/provider_failed/tool_failed_certain/effect_uncertain/reconciliation_required穷举。
- [ ] assistant text不能改变outcome kind。
- [ ] provider error不推进Task。
- [ ] generator return/abort仍finalize attempt。
- [ ] tool uncertain不自动retry。
- [ ] outcome携带turn/cursor/receipt/usage refs。
- [ ] attempt-turn bound crash window进入reconciliation。

### M4-D. Minimal Resource Admission RED

- [ ] attempt intent前取得tool/resource/model/workspace/capability/security public snapshot。
- [ ] snapshot scope/generation/receipt/digest任一不匹配拒绝intent。
- [ ] attempt intent immutable绑定snapshot digest。
- [ ] Agent/effect前再次检查revoked/unavailable/runtime generation。
- [ ] stale/revoked/unavailable只能wait/deny/external gap,不能启动Agent或回退旧安全receipt。
- [ ] workflow不读取Extension/Security/Worktree private store。

### M4-E. Compatibility

- [ ] existing `runAgentLoop()`返回类型不破坏。
- [ ] existing `Agent.prompt()`行为不破坏。
- [ ] steer/followUp FIFO与durable receipts不破坏。
- [ ] `runAgentLoopContinue()`普通兼容调用不破坏。
- [ ] tool Hook/Gateway顺序不改变。
- [ ] in-flight resource snapshot不热换。
- [ ] interrupt后无ghost continuation。

### M4-F. Gate

```bash
npx vitest run \
  tests/runtime-v3/orchestrator/workflow/agent-continuation.test.ts \
  tests/runtime-v3/orchestrator/workflow/agent-outcome.test.ts \
  tests/runtime-v3/orchestrator/workflow/resource-admission.test.ts \
  tests/runtime-v3/orchestrator/agent-loop-wiring.test.ts \
  tests/runtime-v3/session/agent-loop-events.test.ts \
  --no-file-parallelism
```

- [ ] M4定向全绿。
- [ ] existing Agent/loop/session queue suites全绿。
- [ ] Extension/Security frozen consumer tests全绿。
- [ ] `npm run check`、完整 `npm test`、`npm run build`、`npm run test:harness-regression`全绿,保存完整输出与file/test count。
- [ ] 两个boundary scripts与`git diff --check`全绿。
- [ ] shared join diff逐行审阅。
- [ ] 如获commit授权,只暂存M4显式路径。

## M5. Production Lifecycle 与 Composition

### M5-A. Intended serialized paths

本阶段延续同一个 `W7-J` owner,统一占用M4的L2与下列L3/L4 production paths;M5 gate通过后才形成W7唯一join handoff。

```text
src/runtime/integration/production-session-runtime.ts
src/runtime/integration/daemon-agent-runtime.ts
src/runtime/integration/daemon-agent-session.ts
src/runtime/runtime-features.ts
src/storage/production-interactive-runtime.ts
src/storage/settings-manager.ts
src/cli/v3-session-commands.ts
src/daemon/v3-session-adapters.ts
src/daemon/production-composition.ts
src/daemon/composition-root.ts
src/daemon/local-v3-daemon.ts
src/runtime/lifecycle/workflow-lifecycle.ts
tests/runtime-v3/integration/production-session-runtime.test.ts
tests/runtime-v3/integration/production-interactive-runtime.test.ts
tests/runtime-v3/orchestrator/workflow/production-driver.test.ts
tests/runtime-v3/orchestrator/workflow/feature-mode.test.ts
tests/storage/settings-manager.test.ts
tests/e2e/goal-workflow-session.test.ts
```

本阶段保持真实launch entry `src/cli/main.ts` 与 `src/daemon/stdio-cli.ts` closed。这里只实现/验证 layered resolver、storage与注入已解析配置的launch-entry-below composition;真实CLI/stdio-daemon读取user+project settings及capability advertisement只在唯一W8-J关闭。

### M5-B. RED

- [ ] 生产源码存在真实 lifecycle `run/resume` caller。
- [ ] real lifecycle ports绑定existing `PromptGoalCoordinator`。
- [ ] Task/Goal/Budget/Verification/workflow共享同一manager/EventWriter。
- [ ] LoopBreaker从durable control journal replay。
- [ ] `off`不activate driver且零workflow effect。
- [ ] `shadow`只record decision,不改Goal/Task/Agent。
- [ ] effectful mode缺port返回external gap。
- [ ] production不回退mock/unsupported adapter success。
- [ ] onIdle只请求一次bounded tick。
- [ ] close/unload先pause/deactivate,active unknown effect时拒绝。
- [ ] resume先replay queue/workflow/session再deliver wake。
- [ ] runtime replacement fences旧driver。
- [ ] `GoalWorkflowFeatureState`唯一resolver位于`runtime-features.ts`,workflow projection不复制配置。
- [ ] 对显式user/project/session layers的纯resolver满足user default < project override < session explicit opt-in,且session不能高于project/readiness ceiling。
- [ ] missing旧配置迁移off,unknown mode fail closed。
- [ ] highest-activated与config digest跨restart一致。
- [ ] 配置降级阻止新effect;升级必须显式start/resume。
- [ ] composition接收resolved mode/config digest/source refs,但M5不把真实CLI/stdio-daemon entrypoint precedence算作ready。

### M5-C. Integration path

- [ ] approved Plan被validate/import。
- [ ] pending Task依赖完成后转ready。
- [ ] M4 resource admission/revocation gate GREEN后,first Task attempt才可从durable wake启动。
- [ ] resource gate未绿时M5只允许off/shadow,禁止effectful opt_in。
- [ ] internal turn terminal映射到Task/wait/retry。
- [ ] Verification request/terminal继续走existing pipeline。
- [ ] EpisodeSeal完成仍走existing GoalStateMachine。
- [ ] verifier unavailable保持external gap。

### M5-D. Gate

```bash
npx vitest run \
  tests/runtime-v3/orchestrator/workflow/production-driver.test.ts \
  tests/runtime-v3/integration/production-session-runtime.test.ts \
  tests/runtime-v3/integration/production-interactive-runtime.test.ts \
  tests/runtime-v3/orchestrator/workflow/feature-mode.test.ts \
  tests/storage/settings-manager.test.ts \
  tests/e2e/goal-workflow-session.test.ts \
  --no-file-parallelism
```

- [ ] production composition定向全绿。
- [ ] 注入已解析配置的direct-composition deterministic E2E从definition到first attempt/known wait全绿。
- [ ] `off` rollback测试全绿。
- [ ] resolver/storage-layer user/project/session precedence、migration、restart config drift与rollback测试全绿;明确这不构成真实CLI/daemon entrypoint readiness。
- [ ] `npm run check`、完整 `npm test`、`npm run build`、`npm run test:harness-regression`全绿,保存完整输出与file/test count。
- [ ] 两个boundary scripts与`git diff --check`全绿。
- [ ] frozen paths/consumer semantics零漂移。
- [ ] W7唯一L2/L3/L4 join handoff记录完整,L1保持no-write。
- [ ] 如获commit授权,只暂存M5显式路径。

## M6-L0. Control Plane Protocol Revision

### M6-L0-A. Exact paths

```text
src/runtime/protocol/v3/coordination.ts
src/runtime/protocol/v3/event-catalog.ts
src/runtime/protocol/v3/event-payloads.ts
src/runtime/protocol/v3/schemas.ts
src/runtime/control-plane/types.ts
src/runtime/control-plane/handshake.ts
src/runtime/control-plane/command-projection.ts
src/runtime/control-plane/index.ts
tests/runtime-v3/control-plane/workflow-protocol.test.ts
tests/runtime-v3/schema.test.ts
tests/runtime-v3/reference-snapshots.test.ts
tests/runtime-v3/fixtures/workflow/
```

### M6-L0-B. RED/GREEN/handoff

- [ ] versioned command union包含`workflow:define/start/pause/cancel/recoverDeadLetterWake`、`goal:pause/resume`,不存在`goal:complete`。
- [ ] versioned query union包含`goal:inspect/workflow:inspect/workflow:wakes`。
- [ ] canonical command journal、effect discriminant、domain与idempotency exact匹配。
- [ ] Control Plane schema/minor negotiation升级;旧schema client能协商旧能力但不能发送新命令。
- [ ] unsupported/unknown workflow command对旧daemon/client fail closed。
- [ ] `workflow:recoverDeadLetterWake` exact payload包含source wake/full dead-letter EventCursor、Goal/workflow/session revision、runtime generation、`expectedDriverGeneration:number|null`与bounded reason digest。
- [ ] recovery effect/result exact包含fresh wake cursor/dedup与durable authorization receipt refs;command journal先flush allow receipt refs再enqueue wake,不存在reopen/requeue-old-wake command或event。
- [ ] command/query payload有size/ID/revision/generation exact schema。
- [ ] reference fixtures与protocol digest更新且人工审阅。
- [ ] protocol、schema、reference、legacy compatibility tests全绿。
- [ ] 既有Control Plane/daemon consumers全绿。
- [ ] `npm run check`、完整 `npm test`、`npm run build`、`npm run test:harness-regression`全绿,保存完整输出与file/test count。
- [ ] 两个boundary scripts与`git diff --check`全绿。
- [ ] 如获commit授权,M6-L0独立commit并形成handoff;禁止与M6-R接线同commit。

## M6-R. Control Plane、Activity、CLI、TUI 与 Daemon

### M6-R-A. Intended serialized paths

`W8-R1` 只准备 Control Plane/Activity/transport core:

```text
src/runtime/control-plane/canonical-command.ts
src/runtime/control-plane/authority-command-idempotency.ts
src/runtime/control-plane/command-bus.ts
src/runtime/control-plane/workflow-control.ts
src/runtime/control-plane/composition-requirements.ts
src/runtime/control-plane/query-service.ts
src/runtime/control-plane/interactive-facade.ts
src/runtime/control-plane/interactive-client.ts
src/runtime/control-plane/light-client.ts
src/runtime/control-plane/jsonl-transport.ts
src/runtime/control-plane/sse-transport.ts
src/runtime/activity/types.ts
src/runtime/activity/projection.ts
src/runtime/activity/index.ts
tests/runtime-v3/control-plane/workflow-control.test.ts
tests/runtime-v3/control-plane/workflow-transport.test.ts
tests/runtime-v3/telemetry/workflow-activity.test.ts
```

以下L3/L4 shared paths只在M7 core完成后的唯一 `W8-J` 打开:

```text
src/daemon/v3-session-adapters.ts
src/daemon/durable-command-store.ts
src/daemon/production-composition.ts
src/daemon/composition-root.ts
src/daemon/server.ts
src/daemon/stdio-host.ts
src/daemon/http-sse-listener.ts
src/daemon/local-v3-daemon.ts
src/daemon/stdio-cli.ts
src/cli/args.ts
src/cli/main.ts
src/cli/interactive-control-plane.ts
src/cli/v3-session-commands.ts
src/cli/production-interactive-options.ts
src/tui/interactive-mode.ts
src/tui/types.ts
src/tui/runtime/repl-handle.ts
src/tui/components/status.ts
src/tui/components/goal-workflow-status.ts
tests/daemon/workflow-command-routing.test.ts
tests/daemon/stdio-cli.test.ts
tests/cli/goal-workflow.test.ts
tests/cli/main.test.ts
tests/tui/goal-workflow.test.ts
tests/e2e/goal-workflow-daemon.test.ts
tests/e2e/daemon-stdio.test.ts
```

W8-R1与W8-J都必须是单owner串行窗口;保留现有TUI专项未提交改动边界。M0按actual call graph冻结最终exact allowlist,不能把上述候选列表当成整目录写权限。W8-R1完成后M6仍保持in progress,不能提前修改或宣告CLI/TUI/daemon ready。

### M6-R-B. Control Plane RED

- [ ] `workflow:define`只绑定valid objective/criteria Artifact refs与input provenance。
- [ ] `workflow:define`不从transcript推断objective且不隐式start。
- [ ] `workflow:start`只接受当前bound immutable definition。
- [ ] `workflow:pause`只改变workflow disposition,不伪造Goal transition。
- [ ] `goal:pause` exact revision/generation/idempotency。
- [ ] user pause需要改变Goal gate时只通过existing state machine进入`awaiting_human`。
- [ ] `goal:pause`按command claim -> pause intent -> Goal transition -> interrupt/wake cancel receipts -> run_paused -> result执行。
- [ ] `goal:pause`每个saga边界crash后可继续或reconcile,不重复Goal transition。
- [ ] workflow pause/result只保存canonical receipt IDs/cursors/digests,不复制Goal phase。
- [ ] `goal:resume`只从allowed paused state。
- [ ] restart/policy-only pause的resume不伪造Goal phase transition。
- [ ] `workflow:cancel`跨restart幂等。
- [ ] `workflow:recoverDeadLetterWake`只为verified dead-letter source mandatory-flush唯一fresh wake,旧wake永久terminal。
- [ ] recovery source full cursor、session/Goal/workflow revision、runtime generation或`expectedDriverGeneration:number|null`任一stale均零写入。
- [ ] 相同command跨restart返回同一fresh cursor;不同command/idempotency针对同一source固定返回`recovery_already_exists`且不能生成第二个wake。
- [ ] authenticated peer + production authorization durable allow receipt才可恢复;peer mismatch、authorizer缺失、deny/ask/unavailable或receipt drift均零写入且不advertise。
- [ ] `workflow-control.ts`从authenticated request context取得principal,经现有`EnterpriseAuthorizationPort`发送`action=approve/resourceKind=workflow_dead_letter_recovery/risk=high/requestId=commandId`;resource digest绑定source terminal、CAS/generation与reason digest。
- [ ] canonical command journal在fresh wake前durable记录authorization receipt ID/digest;crash replay不依赖进程内authorization result且不重复enqueue。
- [ ] authorization只消费frozen Security public port;若现有action/resource contract不足,停止并另开Security L0解冻审阅,不在W8-R1/W8-J修改`src/security/**`或私造authority。
- [ ] recovery不resume run、不直接tick、不接受payload override,有effect intent/unknown side effect的source只能走reconciliation。
- [ ] reconciliation retry为operator-only且不重放unknown side effect。
- [ ] `goal:inspect/workflow:inspect/workflow:wakes` metadata shape固定。
- [ ] stale session handle/revision/generation拒绝。
- [ ] command result有durable cursor。
- [ ] 不存在`goal:complete`命令。

### M6-R-C. Activity RED

- [ ] v2只读兼容。
- [ ] v3区分ready/running/waiting/paused/sleeping/reconciling。
- [ ] waiting_permission保持可区分。
- [ ] nonterminal Goal不一律active。
- [ ] terminal session/Goal清除active attempt/wake summary。
- [ ] projection只从verified full event chain。
- [ ] objective/prompt/tool args/output/private reasoning不泄露。
- [ ] status/reason/generation/wake count digest稳定。

### M6-R-D. Transport/CLI/TUI RED

- [ ] interactive/light client与JSONL/SSE对新schema协商一致。
- [ ] daemon composition只advertise已真实绑定的workflow commands/queries。
- [ ] stdio/SSE round-trip保留commandId/idempotency/revision/generation。
- [ ] daemon restart后重复command幂等,stale revision/generation拒绝。
- [ ] inspect展示phase/disposition/task/attempt/wait/wake/budget/verification。
- [ ] pause/resume/cancel只发Control Plane command。
- [ ] external gap/dead-letter/reconciliation可见。
- [ ] operator CLI recovery先经`workflow:wakes`取得source cursor/revisions/generations,再只发Control Plane command;无`--force`、payload override或本地state mutation。
- [ ] ordinary user/TUI只能inspect dead-letter;未绑定production authorizer的daemon不advertise recovery command。
- [ ] stale command错误可理解且不本地改state。
- [ ] TUI关闭/reopen后从projection恢复。
- [ ] headless CLI不依赖TUI driver。
- [ ] feature mode/readiness可见。
- [ ] 无force-complete UI。

### M6-R-E. W8-R1 core checkpoint

```bash
npx vitest run \
  tests/runtime-v3/control-plane/workflow-protocol.test.ts \
  tests/runtime-v3/control-plane/workflow-control.test.ts \
  tests/runtime-v3/control-plane/workflow-transport.test.ts \
  tests/runtime-v3/control-plane/interactive-client.test.ts \
  tests/runtime-v3/control-plane/light-client.test.ts \
  tests/runtime-v3/telemetry/workflow-activity.test.ts \
  --no-file-parallelism
```

- [ ] M6-L0与W8-R1 core定向全绿。
- [ ] JSONL/SSE/light-client core contract round-trip全绿。
- [ ] `npm run check`、完整 `npm test`、`npm run build`、`npm run test:harness-regression`全绿,保存完整输出与file/test count。
- [ ] 两个boundary scripts与`git diff --check`全绿。
- [ ] W8-R1没有修改CLI/TUI/daemon production composition或其他L4 path。
- [ ] checkpoint后M6-R保持in progress,等待W8-R2与唯一W8-J。
- [ ] 如获commit授权,只暂存W8-R1显式路径,与M6-L0保持独立commit。

## M7. Multi-Agent 与 Advanced Resource Snapshot Hardening

### M7-A. Intended paths

`W8-R2`只准备Agent/workflow独占路径:

```text
src/runtime/orchestrator/workflow/ports.ts
src/runtime/orchestrator/workflow/driver.ts
src/runtime/orchestrator/workflow/child-receipts.ts
src/runtime/orchestrator/workflow/resource-snapshot.ts
src/runtime/agents/types.ts
src/runtime/agents/supervisor.ts
tests/runtime-v3/orchestrator/workflow/child-completion.test.ts
tests/runtime-v3/orchestrator/workflow/resource-snapshot.test.ts
tests/runtime-v3/agents/workflow-child-receipt.test.ts
```

以下production paths与E2E留给唯一 `W8-J`:

```text
src/runtime/integration/production-session-runtime.ts
src/runtime/agents/integration/production-composition.ts
tests/e2e/goal-workflow-child.test.ts
```

禁止修改`src/extensions/**`、`src/security/**`、`src/worktree/**`。

- [ ] 先关闭W8-R2 Agent独占路径,再与W8-R1一起交给单一W8-J owner。
- [ ] W8-J gate前multi-agent workflow不advertise;M5最多证明single-agent opt_in。
- [ ] 记录W7 handoff base、W8-R1/R2 commits、W8-J L3/L4 exact allowlist与rebase顺序。

### M7-B. Child completion RED

- [ ] child terminal必须有exact parent goal/task/run/attempt correlation。
- [ ] activation/completion/cleanup receipt缺失进入reconciling。
- [ ] repeated child terminal只消费一次。
- [ ] Artifact handoff完成前不完成Task。
- [ ] root BudgetGuard settlement只执行一次。
- [ ] in-flight/finished/high-water usage不双计。
- [ ] out-of-order completion/cleanup可replay。
- [ ] process callback单独不能推进parent。
- [ ] parent wake在receipts durable后才enqueue。
- [ ] stale parent generation/revision receipt拒绝。

### M7-C. Resource snapshot RED

- [ ] child attempt继承/绑定exact tool/resource/model/workspace/capability digests。
- [ ] in-flight attempt继续使用bound snapshot。
- [ ] next attempt观察idle-boundary新snapshot。
- [ ] M4最小stale/revoked gate对root与child一致。
- [ ] resource reload失败保留last-known-good并产生diagnostic。
- [ ] frozen port unavailable保持unsupported/deny。
- [ ] workflow不直接读取extension/security/worktree private store。

### M7-D. W8-R2 core checkpoint

```bash
npx vitest run \
  tests/runtime-v3/orchestrator/workflow/child-completion.test.ts \
  tests/runtime-v3/orchestrator/workflow/resource-snapshot.test.ts \
  tests/runtime-v3/agents/workflow-child-receipt.test.ts \
  --no-file-parallelism
```

- [ ] W8-R2 core定向全绿。
- [ ] frozen Extension tests全绿。
- [ ] frozen Security/Worktree tests全绿。
- [ ] root/child budget canonical truth tests全绿。
- [ ] `npm run check`、完整 `npm test`、`npm run build`、`npm run test:harness-regression`全绿,保存完整输出与file/test count。
- [ ] 两个boundary scripts与`git diff --check`全绿。
- [ ] frozen paths零diff。
- [ ] W8-R2没有修改production composition/L3/L4 shared paths。
- [ ] checkpoint后M7保持in progress,feature仍不advertise。
- [ ] 如获commit授权,只暂存W8-R2显式路径。

### M7-E. Unique W8-J gate for M6-R + M7

W8-R1与W8-R2 checkpoint都通过后,由一个owner一次性打开两节列出的L3/L4 shared paths:

```bash
npx vitest run \
  tests/runtime-v3/control-plane/workflow-control.test.ts \
  tests/runtime-v3/control-plane/workflow-transport.test.ts \
  tests/runtime-v3/telemetry/workflow-activity.test.ts \
  tests/daemon/workflow-command-routing.test.ts \
  tests/daemon/stdio-cli.test.ts \
  tests/cli/goal-workflow.test.ts \
  tests/cli/main.test.ts \
  tests/tui/goal-workflow.test.ts \
  tests/storage/settings-manager.test.ts \
  tests/runtime-v3/orchestrator/workflow/child-completion.test.ts \
  tests/runtime-v3/orchestrator/workflow/resource-snapshot.test.ts \
  tests/runtime-v3/agents \
  tests/e2e/goal-workflow-daemon.test.ts \
  tests/e2e/goal-workflow-child.test.ts \
  tests/e2e/daemon-stdio.test.ts \
  --no-file-parallelism
```

- [ ] stdio/SSE/light-client与real-process daemon restart/idempotency/stale revision E2E全绿。
- [ ] `runledger`与`runledger-daemon`真实入口都加载user+project layers并交给同一canonical resolver;相同输入得到相同mode/configDigest/source refs。
- [ ] project显式值覆盖user默认,session opt-in不越过project/readiness ceiling;unknown真实文件值fail closed并给diagnostic。
- [ ] 入口保留原始project layer供history patch;user-only默认不被整盘写回project,user settings不被修改。
- [ ] restart digest drift默认paused,降权立即阻止新effect,上调仍需explicit start/resume。
- [ ] dead-letter operator command经real-process CLI/daemon Control Plane跨restart在projection中只有一个fresh durable enqueue;未绑定production authorizer时不advertise。
- [ ] CLI help/version/goal commands real process tests与TUI smoke全绿。
- [ ] child production composition/E2E、root/child budget与immutable resource tests全绿。
- [ ] `npm run check`、完整 `npm test`、`npm run build`、`npm run test:harness-regression`全绿,保存完整输出与file/test count。
- [ ] 两个boundary scripts、`git diff --check`与三组冻结专项门禁全绿。
- [ ] W8-J exact diff不触及L1或frozen manifest。
- [ ] 与现有TUI计划共享文件diff完成串行审阅。
- [ ] feature evidence不advertise缺失external dependencies。
- [ ] W8唯一L3/L4 join、composition receipt、rollback point与multi-agent advertise matrix逐项审阅。
- [ ] M6-R与M7只在本gate后一起完成。
- [ ] 如获commit授权,只暂存W8-J显式shared paths。

## M8. Fault Injection、Live E2E、Rollout 与 Rollback

### M8-A. Fault matrix

- [ ] crash before wake enqueue。
- [ ] crash after mandatory-flushed wake enqueue/before daemon scan/tick。
- [ ] operator/canonical/timer producer绕过durable wake被拒。
- [ ] crash after wake claim/before decision。
- [ ] driver replacement后claimed wake的safe reclaim/intent-present拒绝reclaim。
- [ ] admission deferral不消耗delivery failure cap。
- [ ] timeout wake在wait提前满足后durable cancelled。
- [ ] claimed/deferred/cancelled/reclaimed状态迁移故障。
- [ ] crash after intent/before canonical effect。
- [ ] crash after canonical Goal/Task effect/before workflow receipt reference。
- [ ] crash during Agent/provider/tool/child/verification effect。
- [ ] crash after external success/before terminal append。
- [ ] duplicate/out-of-order wake/result。
- [ ] writer append/flush partial failure。
- [ ] old driver delayed callback after takeover。
- [ ] user/internal priority race。
- [ ] workflow pause与Goal pause saga每个intent/transition/interrupt/wake-cancel/receipt边界。
- [ ] pause/interrupt/cancel race。
- [ ] default restart pause + pending work直到durable run_resumed。
- [ ] runtime replacement/unload/reload race。
- [ ] corrupted event tail/snapshot cache deletion。
- [ ] crash after command claim/before authorization receipt、after authorization receipt/before fresh wake enqueue、after fresh wake mandatory flush/before command result。
- [ ] 跨daemon restart exact retry后projection中仍只有一个fresh durable enqueue与同一command result。
- [ ] 两个并发且不同command/idempotency针对同一dead-letter source,只能产生一个recovery child;loser稳定返回`recovery_already_exists`且零新增事件。
- [ ] source full EventCursor、session/Goal/workflow revision、runtime generation或`expectedDriverGeneration:number|null` drift均零写入。
- [ ] operator auth deny/ask/unavailable、peer scope或authorization receipt drift均零写入且不advertise。
- [ ] replay证明old wake永久dead-letter,fresh wake有新ID、零counter与lineage;fresh wake再次dead-letter后只能恢复它。
- [ ] paused run可登记fresh pending wake,但durable resume前不能claim;unknown-effect source拒绝并保持reconciliation路径。
- [ ] verifier disabled/unavailable/error。
- [ ] resource revoke/reload race。
- [ ] root/child usage settlement failure。
- [ ] config digest drift、unknown mode与rollback途中restart。
- [ ] fork不继承workflow执行状态且无ghost auto-start。
- [ ] recurring cron/schedule projection输入被拒。

### M8-B. E2E

预期新增:

```text
tests/e2e/goal-workflow-session.test.ts
tests/e2e/goal-workflow-recovery.test.ts
tests/e2e/goal-workflow-child.test.ts
tests/e2e/live-goal-workflow.test.ts
```

- [ ] deterministic mock:definition -> Plan/DAG -> Task -> Agent -> Verification -> EpisodeSeal -> Goal complete。
- [ ] deterministic wait:approval/child/external gap -> wake -> resume。
- [ ] kill/restart:active attempt known/unknown outcome。
- [ ] duplicate delivery:idempotent。
- [ ] dead-letter operator recovery只经Control Plane,real-process CLI/daemon restart后projection中fresh durable enqueue唯一且旧wake未重开;delivery仍明确为at-least-once。
- [ ] interrupt/pause:无ghost continuation。
- [ ] replay/resume保持internal provenance、无user queue event且user FIFO/identity不变。
- [ ] fork target保持manual/unsupported且无workflow wake。
- [ ] rollback to off:旧manual path可用,events仍可inspect。
- [ ] live provider opt-in使用既有credential store,不读取/输出/提交key。
- [ ] live test不替代deterministic/fault/security gates。

### M8-C. Rollout

- [ ] `off`:零effect/compatibility evidence。
- [ ] `shadow`:decision drift/latency/diagnostic evidence。
- [ ] `opt_in`:explicit session/project opt-in与rollback。
- [ ] `default`:new session default,legacy不自动迁移。
- [ ] `required`:全部production gate ready才允许。
- [ ] user/project precedence、explicit session opt-in ceiling与highest-activated持久化跨restart一致。
- [ ] CLI与stdio-daemon入口的layered settings source/config digest一致,history writeback不把user defaults固化进project。
- [ ] missing config迁移off,unknown mode fail closed。
- [ ] 每次晋级记录error rate、wake backlog、deferral、dead-letter、reconciliation、stale generation metrics。
- [ ] 每次晋级完成rollback演练。
- [ ] required dependencies不ready时保持前一mode。

### M8-D. Full gate

```bash
npm run check
npm test
npm run build
npm run test:harness-regression
node scripts/check-runtime-boundaries.ts
node scripts/check-execution-boundaries.ts
git diff --check
```

- [ ] 完整输出保存,无error/warning/info debt被忽略。
- [ ] pi-ai fixed snapshot/parity门禁按Runtime计划要求通过。
- [ ] Plan/Context/Memory frozen gate通过。
- [ ] Extension frozen gate通过。
- [ ] Security/Worktree frozen gate通过。
- [ ] deterministic/fault/E2E全绿。
- [ ] Linux证据完整。
- [ ] darwin/win32 required matrix有真实runner证据,否则相应product gate保持blocked。
- [ ] CLI real command/TUI smoke通过。
- [ ] docs/AGENTS/Runtime 04/05/本清单状态同步。
- [ ] production readiness表逐项有证据。
- [ ] rollback runbook完成。
- [ ] `<stage-base>...HEAD`、staged、unstaged、untracked exact frozen manifest全部复核。

## 9. 阶段证据模板

每阶段完成时在对应项下追加:

```text
Stage:
Date:
Owner:
Branch/worktree:
Base commit:
Stage end HEAD:
RED commit status: not applicable  # 默认suite失败时按根AGENTS禁止commit
GREEN commit status:    # hash 或 not authorized/not applicable
Docs commit status:     # hash 或 not authorized/not applicable

Explicit changed paths:
- ...

RED command:
Result:
Expected failing assertions:

GREEN targeted command:
Result:

Regression commands:
- npm run check:
- npm test:
- npm run build:
- npm run test:harness-regression:
- boundary scripts:
- git diff --check:

Frozen gates:
- committed range:
- staged:
- unstaged:
- untracked:
- package ./extensions export:
- protocol additive/consumer semantics:
- Plan/Context/Memory:
- Extension:
- Security/Worktree:

Fault/E2E evidence:
- ...

Capability/readiness state:
- implemented runtime boundary:
- blocked/external_gap:
- advertised modes:

Remaining gaps:
- ...

Rollback evidence:
- ...
```

## 10. 最终完成定义

只有以下条件全部成立,本专项才可标记完成:

- [ ] `coding-goal/v1` definition/events/projections是versioned、exact、replayable。
- [ ] decision kernel纯且deterministic。
- [ ] scheduler只驱动existing canonical Tasks。
- [ ] driver bounded、durable、generation-fenced。
- [ ] wake at-least-once + idempotent,无exactly-once误述。
- [ ] normal admission deferral不消耗delivery failure/dead-letter预算。
- [ ] internal continuation不是fake user message。
- [ ] user input稳定优先。
- [ ] wait/sleep/pause/reconcile/cancel/restart语义完整。
- [ ] workflow pause与Goal pause saga可跨每个receipt边界恢复。
- [ ] fork保持manual/unsupported且不继承active workflow execution。
- [ ] Agent outcome exhaustive且failure不误推进。
- [ ] production lifecycle/interactive/daemon真实接线。
- [ ] Control Plane/Activity/CLI/TUI可观测可治理。
- [ ] child/resource integration消费既有public receipts。
- [ ] effectful opt_in前最小resource admission/revocation门已闭合。
- [ ] only trusted EpisodeSeal completes Goal。
- [ ] verifier infra failure永不complete。
- [ ] frozen paths与fail-closed语义未被破坏。
- [ ] fault、restart、E2E、full regression与rollback全部有证据。
- [ ] feature mode按证据晋级,未ready平台/依赖不advertise。
- [ ] feature mode有canonical settings owner、precedence、migration、config digest与restart证据。
- [ ] Runtime `04`、`05`、本计划和本清单状态一致。
