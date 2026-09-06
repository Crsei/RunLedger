# 界面主题配置片段

将任一 JSON 中的 `uiTheme` 合并进用户级 `~/.runledger/settings.json`（使用 `RUNLEDGER_DIR` 时为该目录的 settings），重启生效。不要用示例覆盖整个已有配置。

- [default](default.json)：原界面配色与灰色思考。
- [neutral](neutral.json)：中性灰表面。
- [high-contrast](high-contrast.json)：更亮的暗色正文和思考，或更深的亮色正文。

每套均含 dark/light；`mode` 支持 auto、dark、light。详细色槽和优先级见 [主题说明](../../development-doc/tui/05-theme.md)。
