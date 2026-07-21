/**
 * ImagePasteOverlay —— 粘贴 image 后的确认/取消 overlay。
 *
 * 对照 development-doc/tui/02-component-spec.md §8 与 04-rendering.md §5 overlay。
 *
 * 设计:
 *   - 持有 imagePreview(mime + base64 摘要,M5 阶段仅展示 mime + size 占位);
 *   - 单 SelectItem 列表:["Confirm: Send"， "Cancel"];
 *   - onSelect 回接 InteractiveMode 把 image 注入对 agent 的 attachToLastUser prompt;
 *
 * 本 M5 阶段 ImagePasteOverlay 不接入真实 paste 流;pi-tui Editor 自带 paste 处理逻辑,
 * 我们后续 polish 阶段再切到这里。
 */

import { SelectorModal } from "./selector-modal.ts";
import type { SelectListTheme, SelectItem } from "../index.ts";

export interface ImagePasteOverlayProps {
  selectListTheme: SelectListTheme;
  /** 占位:mime type + 字节数。 */
  preview: string;
  onConfirm?: () => void;
  onCancel?: () => void;
}

export class ImagePasteOverlay extends SelectorModal {
  constructor(props: ImagePasteOverlayProps) {
    const items: SelectItem[] = [
      { value: "confirm", label: "Confirm: Send image" },
      { value: "cancel", label: "Cancel" },
    ];
    super({
      selectListTheme: props.selectListTheme,
      title: `image:${props.preview}`,
      items,
      onSelect: (item) => {
        if (item.value === "confirm") props.onConfirm?.();
        else props.onCancel?.();
      },
      onCancel: () => props.onCancel?.(),
    });
  }
}
