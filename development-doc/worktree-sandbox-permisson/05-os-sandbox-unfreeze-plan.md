# OS Sandbox 解封重规划（PLAN ONLY，不执行）

> 状态：**PLAN ONLY**。仅在 ADR 04 的门禁全部满足后，由新 unfreeze ADR 授权
> 实施；本文件不授权任何代码、CI 或供应链变更。
>
> 关联：[`04-os-sandbox-reassessment-adr.md`](04-os-sandbox-reassessment-adr.md)。

## 1. 目标

为“解封后”的 OS sandbox 实施定义供应链与验证路径，覆盖 helper 构建、签名、
打包、capability probe 与 enforcement E2E；backend 选择与 enforcement 范围
由新 unfreeze ADR 决定（bwrap / Seatbelt / Windows native helper / external
containment 的组合）。

## 2. 供应链规划（Windows native helper 为例，解封后）

1. **构建**：helper 独立 crate（Rust，最小依赖），只暴露
   `spawn-limited-child` 能力；编译产物与 RunLedger 主包分离，禁止混入 npm
   tarball 的 JS 路径；构建在真实 Windows runner 上进行（GitHub Actions
   windows-2025 或等效，记录 runner image digest）；
2. **签名**：代码签名证书与 CI 密钥分离，签名步骤只读受控凭据；每次发布
   记录签名指纹与证书链，验证脚本在部署机重验 Authenticode；
3. **打包**：helper 与 RunLedger 版本耦合（同一 release），产物 sha256 写入
   发布 manifest；升级/降级回滚路径必须定义；
4. **capability probe**：运行时 probe 只回答“helper 存在、签名有效、可用
   API 集”，不允许 probe 失败自动降级 enforcement；
5. **enforcement E2E**：每个平台在真实 runner 上执行
   workspace 内读写 / 外写 deny / network deny / process-tree 终止 /
   symlink-junction 逃逸 / cleanup 重试 六类场景，输出可追溯 artifact
   evidence（OS、Node、Git、helper 版本 + fixture digest）。

## 3. 实施顺序（解封后）

1. unfreeze ADR 批准（明确 backend 组合与 enforcement 范围）；
2. helper 供应链 MVP（构建/签名/打包/probe 单平台闭环）；
3. 三平台 enforcement E2E 与能力矩阵更新；
4. 文档、help、发布能力声明与真实 runner 对齐。

## 4. 冻结期不变量（重申）

- `src/security/sandbox/**` 能力面不变更；
- backend unavailable 继续 fail closed；
- 不把 worktree/permission 描述为 OS sandbox enforced；
- external containment 必须有外部 attestation 才标记有效。
