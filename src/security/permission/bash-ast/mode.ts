import { canonicalDigest } from "../../../runtime/contracts/public.ts";
import type {
	BashAnalyzerResolution,
	BashSecurityAnalyzerMode,
} from "./types.ts";

const STRENGTH: Readonly<Record<BashSecurityAnalyzerMode, number>> = {
	legacy: 0,
	shadow: 1,
	ast: 2,
};
const SOURCE_STRENGTH: Readonly<Record<BashAnalyzerResolution["source"], number>> = {
	default: 0,
	user: 1,
	project: 2,
	cli: 3,
	managed: 4,
};

function strongest(
	values: readonly {
		mode?: BashSecurityAnalyzerMode;
		source: BashAnalyzerResolution["source"];
	}[],
): { mode: BashSecurityAnalyzerMode; source: BashAnalyzerResolution["source"] } {
	let selected: {
		mode: BashSecurityAnalyzerMode;
		source: BashAnalyzerResolution["source"];
	} = { mode: "legacy", source: "default" };
	for (const value of values) {
		if (
			value.mode &&
			(
				STRENGTH[value.mode] > STRENGTH[selected.mode] ||
				(
					STRENGTH[value.mode] === STRENGTH[selected.mode] &&
					SOURCE_STRENGTH[value.source] > SOURCE_STRENGTH[selected.source]
				)
			)
		) {
			selected = { mode: value.mode, source: value.source };
		}
	}
	return selected;
}

export function resolveBashSecurityAnalyzerMode(input: {
	user?: BashSecurityAnalyzerMode;
	project?: BashSecurityAnalyzerMode;
	cli?: BashSecurityAnalyzerMode;
	managedMinimum?: BashSecurityAnalyzerMode;
}): BashAnalyzerResolution {
	const selected = strongest([
		{ mode: input.user, source: "user" },
		{ mode: input.project, source: "project" },
		{ mode: input.cli, source: "cli" },
		{ mode: input.managedMinimum, source: "managed" },
	]);
	return {
		...selected,
		configDigest: canonicalDigest({
			...(input.user ? { user: input.user } : {}),
			...(input.project ? { project: input.project } : {}),
			...(input.cli ? { cli: input.cli } : {}),
			...(input.managedMinimum
				? { managedMinimum: input.managedMinimum }
				: {}),
			resolved: selected.mode,
			source: selected.source,
		}),
	};
}
