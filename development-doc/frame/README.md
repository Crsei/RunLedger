# 界面框架术语记录

本目录保存面向产品、设计、测试与实现协作的界面术语记录；它描述当前源码中的名称、层级与位置，不替代各专题计划的实施状态。

- [00-tui-and-security-terminology.md](00-tui-and-security-terminology.md)：TUI、工具展示、输入/参数区域、统一二级选择界面、审批与安全配置术语。

当前二级选择规范：普通命令选择、Full Access 确认和执行前权限请求共用 `SecondarySelectionView` 结构；捕获输入的二级界面以 `bottom-left` 锚定到 Composer 上方，其底部偏移跟随运行状态行、Composer 和 Footer 的实际高度。

维护规则：新增用户可见区域或变更既有术语时，同步更新对应条目；以 `src/` 当前实现为准，并把计划中或工作树候选能力明确标为非已验收能力。
