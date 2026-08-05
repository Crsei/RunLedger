import type { CorrelatedRequestRef } from "./common.ts";
import type { CommandIntent } from "../commands/types.ts";
import type { TuiOverlayState } from "./state.ts";
import type { TimelineEvent } from "../timeline/types.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export type TuiAction =
	| { readonly type: "overlay.open"; readonly overlay: TuiOverlayState }
	| { readonly type: "overlay.close" }
	| { readonly type: "command.submit"; readonly intent: CommandIntent }
	| { readonly type: "timeline.event"; readonly event: TimelineEvent }
	| { readonly type: "query.cancel"; readonly ref: CorrelatedRequestRef }
	| { readonly type: "session.replace"; readonly generation: number; readonly sessionId: string }
	| { readonly type: "composer.changed"; readonly draft: SafeBoundedText };
