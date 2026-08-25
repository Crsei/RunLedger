import type { ComposerShapeId, ComposerStyle } from "./types.ts";
import { borderlessComposerStyle } from "./styles/borderless.ts";
import { boxComposerStyle } from "./styles/box.ts";
import { claudeComposerStyle } from "./styles/claude.ts";
import { fieldComposerStyle } from "./styles/field.ts";
import { piComposerStyle } from "./styles/pi.ts";
import { railComposerStyle } from "./styles/rail.ts";
import { ruleComposerStyle } from "./styles/rule.ts";

export const BUILTIN_COMPOSER_SHAPE_IDS = [
	"box",
	"claude",
	"pi",
	"borderless",
	"rule",
	"field",
	"rail",
] as const;

export type BuiltinComposerShapeId = (typeof BUILTIN_COMPOSER_SHAPE_IDS)[number];

export interface ComposerShapeOption {
	readonly id: ComposerShapeId;
	readonly label: string;
	readonly description: string;
}

export interface ComposerShapeDiagnostic {
	readonly code: "unknown_style" | "invalid_registration" | "duplicate_registration" | "builtin_replacement";
	readonly fallback: "box";
}

export interface ComposerShapeDefinition {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly style: ComposerStyle;
}

export type ComposerShapeInstallResult =
	| { readonly ok: true; readonly dispose: () => void }
	| { readonly ok: false; readonly diagnostic: ComposerShapeDiagnostic };

export interface ComposerShapeRegistry {
	getComposerStyle(id: unknown, onDiagnostic?: (diagnostic: ComposerShapeDiagnostic) => void): ComposerStyle;
	getComposerShapeOptions(): readonly ComposerShapeOption[];
	installExtensionComposerShape(definition: ComposerShapeDefinition): ComposerShapeInstallResult;
}

export const BUILTIN_COMPOSER_STYLES: Readonly<Record<BuiltinComposerShapeId, ComposerStyle>> = Object.freeze({
	box: boxComposerStyle,
	claude: claudeComposerStyle,
	pi: piComposerStyle,
	borderless: borderlessComposerStyle,
	rule: ruleComposerStyle,
	field: fieldComposerStyle,
	rail: railComposerStyle,
});

const BUILTIN_COMPOSER_OPTIONS: readonly ComposerShapeOption[] = Object.freeze(
	BUILTIN_COMPOSER_SHAPE_IDS.map((id) => {
		const style = BUILTIN_COMPOSER_STYLES[id];
		return Object.freeze({ id: style.id, label: style.label, description: style.description });
	}),
);

export function getComposerStyle(
	id: unknown,
	onDiagnostic?: (diagnostic: ComposerShapeDiagnostic) => void,
): ComposerStyle {
	const style = typeof id === "string" && Object.prototype.hasOwnProperty.call(BUILTIN_COMPOSER_STYLES, id)
		? BUILTIN_COMPOSER_STYLES[id as BuiltinComposerShapeId]
		: undefined;
	if (style !== undefined) return style;
	onDiagnostic?.({ code: "unknown_style", fallback: "box" });
	return boxComposerStyle;
}

export function getComposerShapeOptions(): readonly ComposerShapeOption[] {
	return BUILTIN_COMPOSER_OPTIONS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isComposerStyle(value: unknown): value is ComposerStyle {
	if (!isRecord(value)) return false;
	return typeof value.id === "string"
		&& typeof value.label === "string"
		&& typeof value.description === "string"
		&& typeof value.sideBorders === "boolean"
		&& (value.verticalChrome === 0 || value.verticalChrome === 1 || value.verticalChrome === 2)
		&& (value.statusAttachment === "top-border" || value.statusAttachment === "top-rule-chip" || value.statusAttachment === "none")
		&& (value.bottomBar === "none" || value.bottomBar === "left" || value.bottomBar === "full")
		&& typeof value.bottomBarGap === "number"
		&& Number.isFinite(value.bottomBarGap)
		&& value.bottomBarGap >= 0
		&& typeof value.defaultPromptGutter === "number"
		&& Number.isFinite(value.defaultPromptGutter)
		&& value.defaultPromptGutter >= 0
		&& typeof value.defaultPaddingX === "function"
		&& typeof value.sideChromeWidth === "function"
		&& typeof value.renderTop === "function"
		&& typeof value.renderRow === "function"
		&& typeof value.renderBottom === "function"
		&& typeof value.renderBottomBar === "function";
}

export function createComposerShapeRegistry(): ComposerShapeRegistry {
	const extensions = new Map<string, ComposerShapeDefinition>();

	const getStyle = (
		id: unknown,
		onDiagnostic?: (diagnostic: ComposerShapeDiagnostic) => void,
	): ComposerStyle => {
		if (typeof id === "string") {
			const extension = extensions.get(id);
			if (extension !== undefined) return extension.style;
		}
		return getComposerStyle(id, onDiagnostic);
	};

	const getOptions = (): readonly ComposerShapeOption[] => Object.freeze([
		...BUILTIN_COMPOSER_OPTIONS,
		...Array.from(extensions.values(), (definition) => Object.freeze({
			id: definition.id,
			label: definition.label,
			description: definition.description ?? "Extension composer shape.",
		})),
	]);

	const install = (definition: ComposerShapeDefinition): ComposerShapeInstallResult => {
		const candidate: unknown = definition;
		if (!isRecord(candidate)) {
			return { ok: false, diagnostic: { code: "invalid_registration", fallback: "box" } };
		}
		const id = candidate.id;
		const label = candidate.label;
		const description = candidate.description;
		const style = candidate.style;
		if (
			typeof id !== "string"
			|| typeof label !== "string"
			|| (description !== undefined && typeof description !== "string")
			|| !isComposerStyle(style)
			|| id.length === 0
			|| id !== id.trim()
			|| label.trim().length === 0
			|| style.id !== id
		) {
			return { ok: false, diagnostic: { code: "invalid_registration", fallback: "box" } };
		}
		const safeDefinition: ComposerShapeDefinition = Object.freeze({
			id,
			label,
			...(description === undefined ? {} : { description }),
			style,
		});
		if (Object.prototype.hasOwnProperty.call(BUILTIN_COMPOSER_STYLES, id)) {
			return { ok: false, diagnostic: { code: "builtin_replacement", fallback: "box" } };
		}
		if (extensions.has(id)) {
			return { ok: false, diagnostic: { code: "duplicate_registration", fallback: "box" } };
		}
		extensions.set(id, safeDefinition);
		let disposed = false;
		return {
			ok: true,
			dispose: () => {
				if (disposed) return;
				disposed = true;
				extensions.delete(id);
			},
		};
	};

	return Object.freeze({
		getComposerStyle: getStyle,
		getComposerShapeOptions: getOptions,
		installExtensionComposerShape: install,
	});
}
