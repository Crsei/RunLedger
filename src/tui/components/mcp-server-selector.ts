/**
 * McpServerSelector —— /mcp 触发的 server 配置选择器。
 *
 * 占位实现:M5 阶段为空 items list,等真实 mcp 注册表(M5+ 远期)接通后再填入。
 */

import { SelectorModal, type SelectorModalProps } from "./selector-modal.ts";

export type McpServerSelectorProps = SelectorModalProps;

export class McpServerSelector extends SelectorModal {
  constructor(props: McpServerSelectorProps) {
    super(props);
  }
}
