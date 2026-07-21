/**
 * PromptSelector —— 预设 prompt 模板选择器(由 /prompt 触发)。
 *
 * 占位实现:M5 阶段只暴露类型;真实模板列表来自 ~/.runledger/prompts/M7+ 阶段接通。
 */

import { SelectorModal, type SelectorModalProps } from "./selector-modal.ts";

export type PromptSelectorProps = SelectorModalProps;

export class PromptSelector extends SelectorModal {
  constructor(props: PromptSelectorProps) {
    super(props);
  }
}
