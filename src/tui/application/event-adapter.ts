import type { AgentEvent } from "../../runtime/types.ts";
import { adaptAgentEvent, type TuiEvent } from "../types.ts";

/** Runtime callback 只做类型归一，状态推进留给 reducer。 */
export function adaptRuntimeEvent(event: AgentEvent): TuiEvent {
  return adaptAgentEvent(event);
}
