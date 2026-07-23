# Phase 8:独立 Verification Pipeline、Finding 生命周期与可信基线

> 权威总入口:[`04-governed-agent-harness-runtime-plan.md`](../04-governed-agent-harness-runtime-plan.md)
> 分阶段索引:[`README.md`](README.md)
> 导航:[Phase 7](phase-07-orchestrator-budget.md) / [Phase 9](phase-09-multi-agent.md)
> 状态规则:当前实现状态以主计划 §0.0 为唯一汇总真源;严格开发顺序、并行 lane 与 join gate 以主计划 §12 为准。本文件只承载本 Phase 的完整需求、门槛、故障注入与历史证据。

目标:把“确实完成”变成独立、可重复、可审计的系统判断。

前置:Phase 2–5、Phase 7 的 Runtime contracts。独立 verifier 模块和 fake-port tests 可继续开发;production composition只消费冻结专项的现有receipt。缺trusted-checkout/ExecutionGateway/Sandbox/Artifact或PCM readiness时,Runtime实现unsupported路径且Phase 8/Runtime-M1保持未完成,不能用fake port解锁。

## Runtime-owned 状态账本（2026-07-24）

基线:`worktree/governed-agent-harness-runtime@bdd09c9 + 当前未提交工作树`。Runtime-owned verification/completion composition已闭合;真实 Browser backend 与冻结专项联合 readiness 仍是 external gap,所以 Phase 8 产品里程碑状态为 `blocked`,Runtime-M1不关闭。

| ID | 状态 | 实现与证据 |
|---|---|---|
| P8-C1 | completed | production readiness receipt 对六个 scope 输出 `ready/unsupported/external_gap` |
| P8-C2 | completed | trusted-base checkout、GateManifest 和 candidate isolation 保持现有 fail-closed 实现 |
| P8-C3 | completed | DependencyAdmission + SecretScan 为 production required adapter/preflight |
| P8-C4 | completed | typed argv、trusted PATH/env、Gateway/Workspace/Sandbox/Artifact receipt 共同决定结果;stdout不签发pass |
| P8-C5 | completed | 新增 production-only Browser descriptor、generation、identity 与 preflight;协议级 `BrowserBackendPort` 保持不变 |
| P8-C6 | blocked | Browser gate 的固定 profile/origin/network/assertion和四类Artifact合同/受控E2E已通过;仓库没有可登记为 production 的真实 Browser backend |
| P8-C7 | completed | production issuer只接受OS-keyring composition;unknown/test-only/expired/cross-candidate均拒绝 |
| P8-C8 | completed | VerificationReport 以 Artifact + started/finished event唯一恢复 |
| P8-C9 | completed | test generator/reviewer/security reviewer profile、workspace、diff/commit/inspected-files binding保持隔离 |
| P8-C10 | completed | plain text、Markdown、伪/截断JSON和schema/correlation失败只能inconclusive |
| P8-C11 | completed | `SessionFindingRepository` 以 `finding.transitioned` + content-addressed immutable Artifact snapshot重建 |
| P8-C12 | completed | blocking Finding/remediation/reverification仍由现有policy、BudgetGuard/LoopBreaker和Goal gate消费 |
| P8-C13 | completed | EpisodeManifestBody 继续从pre-seal evidence head构造,无自引用 |
| P8-C14 | completed | body Artifact、manifest commit、seal record、completed四边界保持幂等恢复 |
| P8-C15 | completed | completed只接受durable、可解析且trusted issuer签发的EpisodeSeal |
| P8-C16 | completed | coordinator联合测试覆盖 approved Plan → Task DAG → build/test/security/review → EpisodeSeal → completed |
| P8-C17 | completed | ChangeProposal/HumanGate只保留合同与unsupported behavior,不参与Goal completion |
| P8-C18 | completed | composition receipt写入readiness;Browser/external specialty gap使completion不advertise |
| P8-C19 | completed | candidate gate/PATH/secret/dependency/review/browser/receipt/crash攻击矩阵保持通过 |
| P8-C20 | completed | Runtime-owned门禁与三组冻结门禁通过且冻结实现路径零diff;完整Phase 8仍受P8-C6阻塞 |

验证:

- Phase 7/8 + production session + readiness + public surface:34 files / 170 tests PASS。
- PCM、Extension、Security/Worktree:16/95、12/52、21/119 PASS。

计划文件:

- 新增 `src/runtime/verification/{types,baseline,gate-loader,runner,pipeline,evidence,test-generator,review-evidence,findings,reviewer,security,report}.ts`。
- 新增 `src/verification-runner/` 独立进程入口,以及 `src/verification-runner/browser/{provider,profile,evidence}.ts` 这一仅供 verification gate 使用的内置受限 Browser provider;它不是通用浏览工具或第二套 capability runtime。
- 新增 `src/runtime/change-proposals/{types,ports}.ts`;本阶段只冻结 proposal/human-gate contract,生产 service/provider/coordinator 归 Phase 10。
- 修改 `src/runtime/artifacts/episode-manifest.ts` 和 Orchestrator gate。
- 新增 `tests/runtime-v3/verification/`、`tests/e2e/verification-trust.test.ts`。

任务:

- [ ] verifier 通过注入的 Workspace 服务申请 trusted-base checkout/materialization receipt,候选分支只作为 input;Runtime verification 模块不创建 worktree。
- [ ] protected gate path、policy 和 schema 由独立 checkout 提供,candidate 修改不影响执行定义。
- [ ] GateManifest 固定 executable digest、typed argv、base-side config、dependency/lockfile policy、env allowlist、sandbox、network 和 expected Artifact schema。
- [ ] 不直接信任 candidate 的 package scripts、test config、PATH shim 或 dependency lifecycle script;candidate 新增测试先作为 untrusted evidence,经独立批准才可升级为 trusted gate。
- [ ] 定义 `DependencyAdmissionPolicy`:lockfile/digest/registry identity、允许源、minimum publish age/cooling period、审批例外和 lifecycle-script deny 均进入 GateManifest;刚发布、来源漂移、lockfile 外或 digest 不匹配的依赖默认阻塞,并产出 bounded evidence。
- [ ] 定义 trusted-base `SecretScanGate`:扫描 candidate diff、tracked/untracked workspace manifest、待发布 Artifact 与生成配置,规则/allowlist 来自 trusted base;命中只保存脱敏 finding 与位置/digest,不得把 secret 本文写入 event、Artifact 或 telemetry。
- [ ] deterministic build/test/lint/security command 生成 typed invocation request、固定 cwd/env-key allowlist/timeout,只调用注入的 CapabilityGateway/Workspace 端口,不直接 spawn 或实现 sandbox。
- [ ] VerificationResult 记录 gate digest、base/candidate identity、command、exit、Artifact refs、started/finished、runner identity。
- [ ] 内置 Browser provider 在独立 verification-runner 进程中实现固定版本/profile、进程生命周期和 evidence capture,所有 launch、filesystem、download/upload、cookie/credential 与 network 行为仍经 Resource port + Gateway/Sandbox;缺真实 backend/receipt 时 Browser gate 返回 unsupported/deny,不得回退宿主直跑。
- [ ] BrowserVerificationGate 固定浏览器/runtime/profile、入口 URL、network policy、step/schema digest 与可信断言;结果至少输出 screenshot、DOM/accessibility snapshot、console 和 bounded network evidence Artifact。
- [ ] 建立受信 verifier issuer registry 与签名/receipt schema;只有该 issuer 的有效 terminal result 才解锁 Orchestrator `completed` transition。
- [ ] Builder、test generator、reviewer、security reviewer 使用隔离 profile;test generator 不接收 Builder 私有 reasoning,只在独立 workspace/ref 中生成 test proposal Artifact,不得修改 trusted gate 或直接签发 pass;其测试只有经独立 policy/human review 纳入下一版 GateManifest 后才成为可信门禁。
- [ ] reviewer 默认 read-only/fresh context,输入绑定 candidate commit、diff digest 与 trusted-base receipt;定义结构化 `ReviewEvidence`/schema,至少记录 diffReadProof、inspectedFiles、verificationArtifacts、reverseAuditHypotheses、verdict、reviewer profile 与 producedAt,并作为 immutable Artifact/event ref 持久化。
- [ ] reviewer 未读完整 diff、证据不覆盖 candidate commit、跨 commit 复用或 inspectedFiles/Artifact 不可解析时 verdict 只能是 `inconclusive`,不能形成 approval 或 deterministic pass。
- [ ] LLM review 只产生 finding candidate,不能产生 deterministic pass;普通文本、解析失败、schema 外字段或看似 JSON 但缺 issuer/evidence binding 的输出统一为 `inconclusive`,不能包装成可信 review result。
- [ ] Finding 生命周期固定为 detected/drafted/verified/published/addressed/reverified/closed。
- [ ] 只有 verified 且满足 policy 的 finding 阻塞;inconclusive 不伪装通过。
- [ ] remediation 有最大轮次和 budget,每轮结束必须 reverification。
- [ ] 定义 `ChangeProposalRef`、`ChangeProposalProviderPort`、`HumanGateCoordinatorPort`、`draft_pr.requested/created/failed` 与 `human_gate.requested/decided` exact schema;本阶段只用 fake adapter 验证 correlation/replay,没有 Phase 10 production service/provider 时 feature 必须是 unsupported。外部 PR 最终只能经 Gateway 授权的 provider adapter,绑定 verified commit/workspace/EpisodeSeal;默认只创建 Draft PR,merge/deploy 必须由独立 human/organization gate 决定,Agent 不能自批 instruction、PR merge 或发布。
- [ ] 把 Episode 收尾拆为无自引用的三步:`EpisodeManifestBody` 固定 evidence/pre-seal head 与 workspace/base/final、artifact、permission、cost、verification、integrity refs;`episode.manifest_committed` 固定 body digest;`EpisodeSeal` 绑定 body digest、evidence head、manifest commit cursor 和 signer/attestation,随后以 `episode.seal_recorded` 持久化引用。
- [ ] Orchestrator 的 completed transition 只接受已 durable、可验证的 EpisodeSeal;completed terminal event 引用该 seal 并成为新的 terminal head,不得回写 manifest body 形成 digest/head 自引用。
- [ ] manifest body 写入后校验所有 digest/ref 可访问;在 body、manifest commit、seal record、completed transition 的每个边界 crash 时,recovery 只能幂等补记或 pause,不能产生两个有效 seal。

攻击测试:

- candidate 修改测试脚本、verification schema、policy、PATH、env 和 output 文本伪造“passed”。
- candidate 引入刚发布/换源/lockfile 外依赖、恶意 lifecycle script,或把 secret 放入 untracked file、生成配置、Artifact、日志与测试快照。
- Builder 提交只打印成功但 exit 非零/未执行测试的脚本。
- Reviewer 未读 diff、复用旧 Artifact、跨 commit result。
- Test generator 读取 Builder 私有 reasoning、修改 trusted gate、把 candidate test 自签为可信,以及 ReviewEvidence 伪造 diffReadProof/inspectedFiles。
- Review model 返回普通文本、markdown fence、伪 JSON/截断 JSON 或复用其他 candidate 的结构化结果;均不能形成 pass。
- Browser gate 伪造截图/DOM/console、复用旧 origin/cookie/commit evidence,或 backend 缺失后请求宿主直跑;ChangeProposal contract 测试 Agent 自批 instruction/PR/merge 与跨 EpisodeSeal 复用。
- 仅配置 `browser_use` prompt 或调用只读 PR status/view/merge-queue adapter,不得被 capability discovery 识别为 Browser verifier、Draft PR provider 或 HumanGate。
- 在 manifest body/commit/seal/completed 四个边界 kill 进程,并注入错误 evidence head、过期 signer 和重复 seal。

完成门槛:

- Builder 自报和伪造 stdout 均不能越过 gate。
- trusted baseline gate 在候选篡改下保持不变。
- 每个 pass 都能从 Episode Manifest 追到可重放 command 与 Artifact。
- Browser pass 可追到固定 gate、origin、browser profile、WorkspaceSecurity execution receipt 和四类证据 Artifact;没有内置 provider 的真实联合 E2E 时 Phase 8 保持未完成。
- ChangeProposal/human-gate schema、port、fake replay tests 完成,但本阶段明确记录 `behavior unavailable`;真实 Draft PR provider、持久 human-gate coordinator 与 credential/organization gate 分别由 Phase 10/11 验收,未获 human gate 永不发生 merge/deploy。
- Test generator 输出与 trusted gate 明确分层;ReviewEvidence 可证明对应 reviewer 确实读取目标 diff、检查指定文件并绑定当前 candidate commit,缺失证据时只能 inconclusive。
- model review 的 plain text、伪 JSON、schema/correlation 失败和截断 evidence 回归均只能产生 candidate/inconclusive;不存在 parser fallback 直接签发 pass 的路径。
- EpisodeManifestBody、seal 与 completed terminal head 可单向验证且没有自引用;任一半提交状态重启后都不会误报 completed。

建议 PR:

1. `runtime: verify candidates against trusted baseline gates`
2. `runtime: persist findings evidence and bounded remediation`
3. `runtime: require a valid episode manifest for completion`
