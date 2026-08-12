export type SyntaxTerminalMode = "dark" | "light" | "unknown";

export interface SyntaxThemeSnapshot {
	readonly activeName: string;
	readonly configuredName: string | undefined;
	readonly previewName: string | undefined;
	readonly revision: number;
}

export interface SyntaxThemeControllerOptions {
	readonly availableThemes: readonly string[];
	readonly configuredName?: string;
	readonly terminalMode?: SyntaxTerminalMode;
}

export interface SyntaxThemeEntry {
	readonly name: string;
	readonly kind: "built-in" | "custom";
	readonly available: boolean;
	readonly error?: string;
}

type ThemeListener = (snapshot: SyntaxThemeSnapshot) => void;

const DARK_ADAPTIVE_THEME = "catppuccin-mocha";
const LIGHT_ADAPTIVE_THEME = "catppuccin-latte";

export const BUILTIN_SYNTAX_THEME_NAMES = [
	"1337", "ansi", "base16", "base16-256", "base16-eighties-dark", "base16-mocha-dark",
	"base16-ocean-dark", "base16-ocean-light", "catppuccin-frappe", "catppuccin-latte",
	"catppuccin-macchiato", "catppuccin-mocha", "coldark-cold", "coldark-dark", "dark-neon",
	"dracula", "github", "gruvbox-dark", "gruvbox-light", "inspired-github", "monokai-extended",
	"monokai-extended-bright", "monokai-extended-light", "monokai-extended-origin", "nord",
	"one-half-dark", "one-half-light", "solarized-dark", "solarized-light", "sublime-snazzy",
	"two-dark", "zenburn",
] as const;

/** syntax theme 的单一进程内 owner；preview 不会覆盖 configured authority。 */
export class SyntaxThemeController {
	private readonly availableThemes: Set<string>;
	private readonly entries = new Map<string, SyntaxThemeEntry>();
	private configuredName: string | undefined;
	private previewName: string | undefined;
	private terminalMode: SyntaxTerminalMode;
	private activeName: string;
	private revision = 0;
	private readonly listeners = new Set<ThemeListener>();

	constructor(options: SyntaxThemeControllerOptions) {
		this.availableThemes = new Set(options.availableThemes);
		for (const name of options.availableThemes) {
			this.entries.set(name, { name, kind: "built-in", available: true });
		}
		this.terminalMode = options.terminalMode ?? "unknown";
		this.configuredName = this.resolveConfigured(options.configuredName);
		this.activeName = this.configuredName ?? this.adaptiveName();
	}

	snapshot(): SyntaxThemeSnapshot {
		return {
			activeName: this.activeName,
			configuredName: this.configuredName,
			previewName: this.previewName,
			revision: this.revision,
		};
	}

	subscribe(listener: ThemeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	themeNames(): readonly string[] {
		return [...this.availableThemes].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
	}

	themeEntries(): readonly SyntaxThemeEntry[] {
		return [...this.entries.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
	}

	addAvailableTheme(
		name: string,
		kind: SyntaxThemeEntry["kind"] = "built-in",
	): { readonly ok: true } | { readonly ok: false; readonly reason: "theme_invalid" } {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name) || name.includes("..")) return { ok: false, reason: "theme_invalid" };
		this.availableThemes.add(name);
		this.entries.set(name, { name, kind, available: true });
		return { ok: true };
	}

	addLoadError(name: string, error: string): { readonly ok: true } | { readonly ok: false; readonly reason: "theme_invalid" } {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name) || name.includes("..")) return { ok: false, reason: "theme_invalid" };
		if (this.availableThemes.has(name)) return { ok: true };
		this.entries.set(name, { name, kind: "custom", available: false, error });
		return { ok: true };
	}

	setTerminalMode(mode: SyntaxTerminalMode): void {
		if (mode === this.terminalMode) return;
		this.terminalMode = mode;
		if (this.configuredName !== undefined || this.previewName !== undefined) return;
		this.activate(this.adaptiveName());
	}

	preview(name: string): { readonly ok: true } | { readonly ok: false; readonly reason: "theme_invalid" } {
		const resolved = this.resolveNamed(name);
		if (resolved === undefined) return { ok: false, reason: "theme_invalid" };
		this.previewName = resolved;
		this.activate(resolved);
		return { ok: true };
	}

	cancelPreview(): void {
		if (this.previewName === undefined) return;
		this.previewName = undefined;
		this.activate(this.configuredName ?? this.adaptiveName());
	}

	commitPreview(): void {
		if (this.previewName === undefined) return;
		this.configuredName = this.previewName;
		this.previewName = undefined;
		this.emit();
	}

	private resolveConfigured(name: string | undefined): string | undefined {
		if (name === "dark") return this.resolveNamed(DARK_ADAPTIVE_THEME);
		if (name === "light") return this.resolveNamed(LIGHT_ADAPTIVE_THEME);
		return name === undefined ? undefined : this.resolveNamed(name);
	}

	private resolveNamed(name: string): string | undefined {
		return this.availableThemes.has(name) ? name : undefined;
	}

	private adaptiveName(): string {
		const preferred = this.terminalMode === "light" ? LIGHT_ADAPTIVE_THEME : DARK_ADAPTIVE_THEME;
		if (this.availableThemes.has(preferred)) return preferred;
		return this.availableThemes.values().next().value ?? preferred;
	}

	private activate(name: string): void {
		if (name === this.activeName) return;
		this.activeName = name;
		this.revision += 1;
		this.emit();
	}

	private emit(): void {
		const snapshot = this.snapshot();
		for (const listener of this.listeners) listener(snapshot);
	}
}
