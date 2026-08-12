# Mermaid M0 corpus

这些 Mermaid source 是 RunLedger 的最小行为 fixture，由本仓库独立编写，不是参考实现的代码或逐字样例复制。

每个 diagram kind 至少包含：

- `success.mmd`：计划支持的闭合子集；
- `unsupported.mmd`：必须整体回退的结构/交互语句；
- `malformed.mmd`：不完整或无法安全理解的 source；
- `cjk.mmd`：CJK/宽字符 label；
- `oversize-prefix.mmd`：用于测试中重复到 source limit 以上的最小前缀。

oversize fixture 使用短前缀是为了让 corpus 可读；边界测试会按 `limits.ts` 的 source byte limit 构造超过上限的输入。
