import type { AgentMessage } from "../../runtime/types.ts";
import { projectReplay } from "../timeline/projector.ts";
import { createTimelineState, reduceTimeline } from "../timeline/tool-reducer.ts";
import type { TimelineState } from "../timeline/types.ts";

/** Preview 与主会话共享同一 message/tool projector 和 Timeline reducer。 */
export function projectSessionPreview(messages: readonly AgentMessage[]): TimelineState {
  let state = createTimelineState();
  for (const event of projectReplay(messages)) state = reduceTimeline(state, event);
  return state;
}
