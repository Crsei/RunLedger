import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as spawnPty, type IPty } from "node-pty";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";

const SHAPES = [
	{ label: "Rounded Box (Default)", down: 0 },
	{ label: "Claude Code", down: 1 },
	{ label: "Pi", down: 2 },
	{ label: "Borderless", down: 3 },
	{ label: "Top Rule Dock", down: 4 },
	{ label: "Compact Field", down: 5 },
	{ label: "Accent Rail", down: 6 },
] as const;

const TMUX_AVAILABLE = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const RUNLEDGER_PATH = String(spawnSync("which", ["runledger"], { encoding: "utf8" }).stdout ?? "").trim();
const RESOLVED_RUNLEDGER_PATH = resolvePath(RUNLEDGER_PATH);
const EXPECTED_RUNLEDGER_PATH = resolvePath(join(process.cwd(), "bin/runledger.js"));

function resolvePath(path: string): string {
	try {
		return path.length === 0 ? "" : realpathSync(path);
	} catch {
		return "";
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/gu, "'\\''")}'`;
}

function captureTmuxPane(session: string): string {
	return String(execFileSync("tmux", ["capture-pane", "-t", session, "-p", "-S", "-24"], { encoding: "utf8" }));
}

async function waitForTmuxPane(
	session: string,
	predicate: (screen: string) => boolean,
	timeoutMs = 10_000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let last = "";
	while (Date.now() < deadline) {
		try {
			last = captureTmuxPane(session);
			if (predicate(last)) return last;
		} catch {
			// tmux may not have materialized the pane during the first poll.
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`tmux pane predicate timed out; tail=${last.slice(-2_000)}`);
}

async function waitForTmuxExit(session: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = spawnSync("tmux", ["has-session", "-t", session], { stdio: "ignore" });
		if (result.status !== 0) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`tmux session ${session} did not exit`);
}

function waitForOutput(
	pty: IPty,
	predicate: (output: string) => boolean,
	timeoutMs = 10_000,
	trigger?: () => void,
	description = "predicate",
): Promise<string> {
	return new Promise((resolve, reject) => {
		let output = "";
		let timer: ReturnType<typeof setTimeout> | undefined;
		const subscription = pty.onData((chunk) => {
			output += chunk;
			if (!predicate(output)) return;
			if (timer !== undefined) clearTimeout(timer);
			subscription.dispose();
			resolve(output);
		});
		timer = setTimeout(() => {
			subscription.dispose();
			reject(new Error(`PTY output predicate timed out after ${timeoutMs}ms (${description}); tail=${output.slice(-1_000)}`));
		}, timeoutMs);
		trigger?.();
	});
}

function plainOutput(output: string): string {
	return stripAnsi(output).replace(/[╭╮╰╯│┃▐▌▎─░█]/gu, " ").replace(/\s+/gu, " ");
}

function hasPreviewLabel(output: string, label: string): boolean {
	const normalize = (value: string): string => value.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
	return normalize(plainOutput(output)).includes(`preview${normalize(label)}`);
}

async function waitForTmuxPreview(session: string, label: string): Promise<string> {
	return waitForTmuxPane(
		session,
		(screen) => /Composer\s+Shape/u.test(screen) && hasPreviewLabel(screen, label),
		10_000,
	);
}

describe("standard PATH composer shape PTY", () => {
	it("uses the standard PATH executable linked to this worktree", () => {
		if (process.platform === "win32") return;
		expect(RUNLEDGER_PATH).not.toBe("");
		expect(RESOLVED_RUNLEDGER_PATH).toBe(EXPECTED_RUNLEDGER_PATH);
	});

	it("keeps a Unicode draft across resize and clears it through the native input path", async () => {
		if (process.platform === "win32") return;
		const home = await mkdtemp(join(tmpdir(), "runledger-composer-shape-unicode-pty-"));
		let pty: IPty | undefined;
		try {
			pty = spawnPty("runledger", [], {
				name: "xterm-256color",
				cols: 80,
				rows: 24,
				cwd: process.cwd(),
				env: { ...process.env, RUNLEDGER_DIR: home, TERM: "xterm-256color", COLORTERM: "truecolor" },
			});
			const exit = new Promise<{ readonly exitCode: number; readonly signal?: number }>((resolve) => {
				pty?.onExit((event) => resolve({ exitCode: event.exitCode, signal: event.signal }));
			});
			await waitForOutput(pty, (output) => plainOutput(output).includes("Message RunLedger"), 10_000, undefined, "welcome");

			const draft = "中文 👋 e\u0301";
			const entered = await waitForOutput(
				pty,
				(output) => plainOutput(output).includes("中文") && plainOutput(output).includes("👋"),
				10_000,
				() => pty.write(draft),
				"Unicode draft",
			);
			expect(plainOutput(entered)).toContain("中文");

			const resized = await waitForOutput(
				pty,
				(output) => plainOutput(output).includes("中文") && plainOutput(output).includes("👋"),
				10_000,
				() => pty.resize(40, 24),
				"Unicode draft after resize",
			);
			expect(plainOutput(resized)).toContain("中文");

			const cleared = await waitForOutput(
				pty,
				(output) => plainOutput(output).includes("Message RunLedger"),
				10_000,
				() => pty.write("\u0015"),
				"Ctrl+U clears Unicode draft",
			);
			expect(plainOutput(cleared)).toContain("Message RunLedger");

			pty.write("\u0004");
			await expect(Promise.race([
				exit,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Unicode PTY did not exit")), 10_000)),
			])).resolves.toMatchObject({ exitCode: 0 });
		} finally {
			pty?.kill();
			await rm(home, { recursive: true, force: true });
		}
	}, 45_000);

	it("copies a real PTY mouse selection through OSC52 without disturbing the composer", async () => {
		if (process.platform === "win32") return;
		const home = await mkdtemp(join(tmpdir(), "runledger-composer-shape-selection-pty-"));
		let pty: IPty | undefined;
		try {
			pty = spawnPty("runledger", [], {
				name: "xterm-256color",
				cols: 80,
				rows: 24,
				cwd: process.cwd(),
				env: { ...process.env, RUNLEDGER_DIR: home, TERM: "xterm-256color", COLORTERM: "truecolor" },
			});
			const exit = new Promise<{ readonly exitCode: number; readonly signal?: number }>((resolve) => {
				pty?.onExit((event) => resolve({ exitCode: event.exitCode, signal: event.signal }));
			});
			await waitForOutput(pty, (output) => plainOutput(output).includes("Message RunLedger"), 10_000, undefined, "selection welcome");

			const copied = await waitForOutput(
				pty,
				(output) => /\u001b\]52;c;[A-Za-z0-9+/=]+(?:\u0007|\u001b\\)/u.test(output),
				10_000,
				() => {
					// SGR mouse press/drag/release over the welcome text, followed by
					// the native Ctrl+C selection path.
					pty.write("\u001b[<0;1;3M\u001b[<32;24;3M\u001b[<0;24;3m");
					setTimeout(() => pty?.write("\u0003"), 100);
				},
				"PTY mouse selection OSC52",
			);
			expect(copied).toMatch(/\u001b\]52;c;[A-Za-z0-9+/=]+(?:\u0007|\u001b\\)/u);
			expect(plainOutput(copied)).not.toContain("Unknown composer shape");

			pty.write("\u0004");
			await expect(Promise.race([
				exit,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("selection PTY did not exit")), 10_000)),
			])).resolves.toMatchObject({ exitCode: 0 });
		} finally {
			pty?.kill();
			await rm(home, { recursive: true, force: true });
		}
	}, 30_000);

	it("browses all seven shapes at 80 and 143 columns and persists the final selection", async () => {
		if (process.platform === "win32") return;
		const home = await mkdtemp(join(tmpdir(), "runledger-composer-shape-pty-"));
		let pty: IPty | undefined;
		try {
			pty = spawnPty("runledger", [], {
				name: "xterm-256color",
				cols: 80,
				rows: 24,
				cwd: process.cwd(),
				env: { ...process.env, RUNLEDGER_DIR: home, TERM: "xterm-256color", COLORTERM: "truecolor" },
			});
			const exit = new Promise<{ readonly exitCode: number; readonly signal?: number }>((resolve) => {
				pty?.onExit((event) => resolve({ exitCode: event.exitCode, signal: event.signal }));
			});
			await waitForOutput(pty, (output) => plainOutput(output).includes("Message RunLedger"), 10_000, undefined, "welcome");
			let currentIndex = 0;

			for (const width of [80, 143]) {
				pty.resize(width, 24);
				await new Promise((resolve) => setTimeout(resolve, 2_000));
				for (const [targetIndex] of SHAPES.entries()) {
					const selector = await waitForOutput(
						pty,
						(output) => {
							const text = plainOutput(output);
							return /Composer\s+Shape/u.test(text)
								&& hasPreviewLabel(output, SHAPES[currentIndex]!.label)
								&& /composer\s*preview/u.test(text);
						},
						10_000,
						() => pty.write("/shape\r"),
						`selector width=${width} current=${SHAPES[currentIndex]!.label} target=${SHAPES[targetIndex]!.label}`,
					);
					await new Promise((resolve) => setTimeout(resolve, 100));
					expect(hasPreviewLabel(selector, SHAPES[currentIndex]!.label)).toBe(true);
					const steps = (targetIndex - currentIndex + SHAPES.length) % SHAPES.length;
					for (let step = 1; step <= steps; step += 1) {
						const previewIndex = (currentIndex + step) % SHAPES.length;
						const preview = await waitForOutput(
							pty,
							(output) => output.length > 0,
							10_000,
							() => pty.write("\u001b[B"),
							`preview width=${width} current=${SHAPES[currentIndex]!.label} target=${SHAPES[previewIndex]!.label}`,
						);
						// OpenTUI differential redraws may split the preview label across
						// cursor-addressed chunks; the next full selector frame asserts the
						// complete target label, and the final persisted value proves every
						// navigation was applied.
						expect(preview.length).toBeGreaterThan(0);
					}
					pty.write("\r");
					currentIndex = targetIndex;
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
			}

			const settings = JSON.parse(await readFile(join(home, "settings.json"), "utf8")) as { readonly composer?: { readonly shape?: unknown } };
			expect(settings.composer?.shape).toBe("rail");
			pty.write("\u0004");
			await expect(Promise.race([
				exit,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("runledger PTY did not exit")), 10_000)),
			])).resolves.toMatchObject({ exitCode: 0 });

			pty = spawnPty("runledger", [], {
				name: "xterm-256color",
				cols: 80,
				rows: 24,
				cwd: process.cwd(),
				env: { ...process.env, RUNLEDGER_DIR: home, TERM: "xterm-256color", COLORTERM: "truecolor" },
			});
			const resumedExit = new Promise<{ readonly exitCode: number; readonly signal?: number }>((resolve) => {
				pty?.onExit((event) => resolve({ exitCode: event.exitCode, signal: event.signal }));
			});
			await waitForOutput(pty, (output) => plainOutput(output).includes("Message RunLedger"), 10_000, undefined, "resumed welcome");
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			const resumedSelector = await waitForOutput(
				pty,
				(output) => /Composer\s+Shape/u.test(plainOutput(output)) && hasPreviewLabel(output, "Accent Rail"),
				10_000,
				() => pty.write("/shape\r"),
				"resumed persisted shape",
			);
			expect(hasPreviewLabel(resumedSelector, "Accent Rail")).toBe(true);
			pty.write("\u001b");
			await new Promise((resolve) => setTimeout(resolve, 250));
			pty.write("\u0004");
			await expect(Promise.race([
				resumedExit,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("resumed runledger PTY did not exit")), 10_000)),
			])).resolves.toMatchObject({ exitCode: 0 });
		} finally {
			pty?.kill();
			await rm(home, { recursive: true, force: true });
		}
	}, 60_000);

	it("opens the production setup wizard and commits through the same user settings port", async () => {
		if (process.platform === "win32") return;
		const home = await mkdtemp(join(tmpdir(), "runledger-composer-setup-pty-"));
		let pty: IPty | undefined;
		try {
			pty = spawnPty("runledger", [], {
				name: "xterm-256color",
				cols: 80,
				rows: 24,
				cwd: process.cwd(),
				env: { ...process.env, RUNLEDGER_DIR: home, TERM: "xterm-256color", COLORTERM: "truecolor" },
			});
			const exit = new Promise<{ readonly exitCode: number; readonly signal?: number }>((resolve) => {
				pty?.onExit((event) => resolve({ exitCode: event.exitCode, signal: event.signal }));
			});
			await waitForOutput(pty, (output) => plainOutput(output).includes("Message RunLedger"), 10_000, undefined, "setup welcome");
			const opened = await waitForOutput(
				pty,
				(output) => /Setup\s+·\s+Composer\s+Shape/u.test(plainOutput(output)) && hasPreviewLabel(output, "Rounded Box (Default)"),
				10_000,
				() => pty.write("/setup\r"),
				"setup wizard",
			);
			expect(hasPreviewLabel(opened, "Rounded Box (Default)")).toBe(true);
			await waitForOutput(
				pty,
				(output) => output.length > 0,
				10_000,
				() => pty.write("\u001b[B\r"),
				"setup wizard commit",
			);
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toMatchObject({ composer: { shape: "claude" } });
			pty.write("\u0004");
			await expect(Promise.race([
				exit,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("setup wizard PTY did not exit")), 10_000)),
			])).resolves.toMatchObject({ exitCode: 0 });
		} finally {
			pty?.kill();
			await rm(home, { recursive: true, force: true });
		}
	}, 30_000);

	it.skipIf(process.platform === "win32" || !TMUX_AVAILABLE || RUNLEDGER_PATH.length === 0)(
		"renders a clean final tmux screen when the shape selector replaces the live frame",
		async () => {
			const home = await mkdtemp(join(tmpdir(), "runledger-composer-shape-tmux-"));
			const session = `rl-composer-shape-${process.pid}-${Date.now()}`;
			try {
				execFileSync("tmux", [
					"new-session",
					"-d",
					"-s",
					session,
					"-x",
					"80",
					"-y",
					"24",
					"-c",
					process.cwd(),
					`env RUNLEDGER_DIR=${shellQuote(home)} TERM=xterm-256color COLORTERM=truecolor ${shellQuote(RUNLEDGER_PATH)}`,
				]);
				await waitForTmuxPane(session, (screen) => screen.includes("Message RunLedger"));
				execFileSync("tmux", ["send-keys", "-t", session, "/shape", "Enter"]);
				await waitForTmuxPane(session, (screen) => screen.includes("Composer Shape"));
				await new Promise((resolve) => setTimeout(resolve, 500));

				let screen = captureTmuxPane(session);
				expect(screen).toContain("Preview the input frame, then press Enter to save.");
				expect(screen).not.toContain("pressiEnterfto save");
				expect(screen).not.toContain("StatusDlineAembedded");

				execFileSync("tmux", ["send-keys", "-t", session, "Down"]);
				await new Promise((resolve) => setTimeout(resolve, 500));
				screen = captureTmuxPane(session);
				expect(screen).toContain("› 2. Claude Code");
				expect(screen).toContain("Preview the input frame, then press Enter to save.");

				execFileSync("tmux", ["send-keys", "-t", session, "Escape"]);
				await new Promise((resolve) => setTimeout(resolve, 100));
				execFileSync("tmux", ["send-keys", "-t", session, "C-d"]);
				await waitForTmuxExit(session);
			} finally {
				spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
				await rm(home, { recursive: true, force: true });
			}
		},
		30_000,
	);

	it.skipIf(process.platform === "win32" || !TMUX_AVAILABLE || RUNLEDGER_PATH.length === 0)(
		"confirms every shape preview after each real terminal Down at 80 and 143 columns",
		async () => {
			const home = await mkdtemp(join(tmpdir(), "runledger-composer-shape-tmux-matrix-"));
			const session = `rl-composer-shape-matrix-${process.pid}-${Date.now()}`;
			try {
				execFileSync("tmux", [
					"new-session",
					"-d",
					"-s",
					session,
					"-x",
					"80",
					"-y",
					"24",
					"-c",
					process.cwd(),
					`env RUNLEDGER_DIR=${shellQuote(home)} TERM=xterm-256color COLORTERM=truecolor ${shellQuote(RUNLEDGER_PATH)}`,
				]);
				await waitForTmuxPane(session, (screen) => screen.includes("Message RunLedger"));

				let currentIndex = 0;
				for (const width of [80, 143]) {
					execFileSync("tmux", ["resize-pane", "-t", session, "-x", String(width), "-y", "24"]);
					for (const [targetIndex] of SHAPES.entries()) {
						execFileSync("tmux", ["send-keys", "-t", session, "/shape", "Enter"]);
						await waitForTmuxPreview(session, SHAPES[currentIndex]!.label);

						const steps = (targetIndex - currentIndex + SHAPES.length) % SHAPES.length;
						for (let step = 1; step <= steps; step += 1) {
							const previewIndex = (currentIndex + step) % SHAPES.length;
							execFileSync("tmux", ["send-keys", "-t", session, "Down"]);
							await waitForTmuxPreview(session, SHAPES[previewIndex]!.label);
						}

						execFileSync("tmux", ["send-keys", "-t", session, "Enter"]);
						await waitForTmuxPane(session, (screen) => !screen.includes("Composer Shape"), 5_000);
						currentIndex = targetIndex;
					}
				}

				const settings = JSON.parse(await readFile(join(home, "settings.json"), "utf8")) as { readonly composer?: { readonly shape?: unknown } };
				expect(settings.composer?.shape).toBe("rail");
				execFileSync("tmux", ["send-keys", "-t", session, "C-d"]);
				await waitForTmuxExit(session);
			} finally {
				spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
				await rm(home, { recursive: true, force: true });
			}
		},
		60_000,
	);
});
