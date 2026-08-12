import type { CorrelatedRequestRef } from "./common.ts";
import type { CommandIntent } from "../commands/types.ts";
import type { TuiOverlayState } from "./state.ts";
import type { TimelineEvent } from "../timeline/types.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";
import type { TuiEffect } from "./effect.ts";
import type { TuiResult } from "./result.ts";

export type TuiAction =
	| { readonly type: "overlay.open"; readonly overlay: TuiOverlayState }
	| { readonly type: "overlay.close" }
	| { readonly type: "command.submit"; readonly intent: CommandIntent }
	| { readonly type: "timeline.event"; readonly event: TimelineEvent }
	| { readonly type: "query.cancel"; readonly ref: CorrelatedRequestRef }
	| { readonly type: "query.start"; readonly effect: TuiEffect }
	| { readonly type: "query.result"; readonly result: TuiResult }
	| { readonly type: "recovery.set"; readonly required: boolean }
	| { readonly type: "session.replace"; readonly generation: number; readonly sessionId: string }
	| { readonly type: "composer.changed"; readonly draft: SafeBoundedText }
	| { readonly type: "interaction.select"; readonly id: string }
	| { readonly type: "interaction.search-changed"; readonly query: string }
	| { readonly type: "interaction.viewport-clear" }
	| { readonly type: "interaction.transcript-scrollbar-set"; readonly visible: boolean }
	| { readonly type: "interaction.focus-changed"; readonly focused: boolean }
	| { readonly type: "interaction.viewport-resized"; readonly columns: number; readonly rows: number };
