import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import path from "node:path";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type SpotifyTrack = {
	playing: boolean;
	artist: string;
	title: string;
	album: string;
	position: number;
	duration: number;
	volume: number;
};

type FooterState = {
	loaded: boolean;
	track: SpotifyTrack | null;
	error: string | null;
	fetchedAtMs: number | null;
};

const POLL_MS = 3000;
const SCROLL_MS = 200;

const IS_DARWIN = process.platform === "darwin";

function runAppleScript(script: string): Promise<string> {
	return new Promise((resolve, reject) => {
		if (!IS_DARWIN) {
			reject(new Error("This extension only works on macOS"));
			return;
		}

		execFile("osascript", ["-e", script], { timeout: 3000 }, (error, stdout, stderr) => {
			if (error) {
				const message = String(stderr || error.message || "AppleScript failed").trim();
				reject(new Error(message));
				return;
			}

			resolve(String(stdout).trim());
		});
	});
}

function friendlyError(message: string): string {
	if (/not authorized|not permitted|automation|permission/i.test(message)) {
		return "Automation permission required";
	}
	return message;
}

function parseAppleScriptNumber(raw: string): number {
	const normalized = raw.trim().replace(/,/g, ".");
	const value = Number(normalized);
	return Number.isFinite(value) ? value : 0;
}

async function getSpotifyTrack(): Promise<SpotifyTrack | null> {
	const script = `
tell application "Spotify"
	if it is running then
		set stateText to player state as string
		if stateText is "stopped" then
			return "stopped"
		end if

		set trackName to name of current track
		set trackArtist to artist of current track
		set trackAlbum to album of current track
		set trackPos to player position
		set trackDur to duration of current track
		set trackVol to sound volume

		return stateText & linefeed & trackName & linefeed & trackArtist & linefeed & trackAlbum & linefeed & (trackPos as text) & linefeed & (trackDur as text) & linefeed & (trackVol as text)
	else
		return "not_running"
	end if
end tell`;

	const raw = await runAppleScript(script);

	if (!raw || raw === "not_running" || raw === "stopped") {
		return null;
	}

	const [stateText, title, artist, album, posStr, durStr, volStr] = raw.split(/\r?\n/);

	if (!stateText || !title || !artist || !album || posStr == null || durStr == null || volStr == null) {
		return null;
	}

	return {
		playing: stateText === "playing",
		title,
		artist,
		album,
		position: parseAppleScriptNumber(posStr),
		duration: parseAppleScriptNumber(durStr) / 1000,
		volume: parseAppleScriptNumber(volStr),
	};
}

function fmtTime(totalSeconds: number): string {
	const s = Math.max(0, Math.floor(totalSeconds));
	const m = Math.floor(s / 60);
	const r = String(s % 60).padStart(2, "0");
	return `${m}:${r}`;
}

const SPOTIFY_GREEN = "\x1b[38;2;29;185;84m";
const SPOTIFY_YELLOW = "\x1b[38;2;255;205;60m";
const SPOTIFY_RED = "\x1b[38;2;255;90;90m";
const RESET_FG = "\x1b[39m";
const DIM = "\x1b[2m";
const DIM_RESET = "\x1b[22m";
const METER_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function volumeColor(volume: number): string {
	if (volume >= 80) return SPOTIFY_RED;
	if (volume >= 50) return SPOTIFY_YELLOW;
	return SPOTIFY_GREEN;
}

function progressBar(position: number, duration: number, width = 12, phase = 0, volume = 0): string {
	const safeWidth = Math.max(0, width);
	if (safeWidth === 0) return "";

	const meter = (level: number, color: string, reset = RESET_FG) => `${color}${METER_LEVELS[level] ?? "▁"}${reset}`;
	const activeColor = volumeColor(volume);

	if (!duration || duration <= 0) {
		return `[${DIM}${"▁".repeat(safeWidth)}${DIM_RESET}]`;
	}

	const ratio = Math.max(0, Math.min(1, position / duration));
	const activeIndex = Math.max(0, Math.min(safeWidth - 1, Math.round(ratio * (safeWidth - 1))));
	let out = "[";

	for (let i = 0; i < safeWidth; i++) {
		const wobble = (Math.sin((phase + i) * 0.75) + 1) / 2;

		if (i < activeIndex) {
			const progress = activeIndex <= 1 ? 1 : i / (activeIndex - 1);
			const level = Math.max(1, Math.min(7, Math.round(progress * 5 + wobble * 2)));
			out += meter(level, activeColor);
		} else if (i === activeIndex) {
			const level = Math.max(5, Math.min(7, Math.round(5 + wobble * 2)));
			out += meter(level, activeColor);
		} else {
			const level = Math.max(0, Math.min(2, Math.round(wobble * 2)));
			out += meter(level, DIM, DIM_RESET);
		}
	}

	return `${out}]`;
}

function marquee(text: string, width: number, offset: number): string {
	if (width <= 0) return "";
	const chars = Array.from(`${text}   `);
	if (chars.length <= width) return truncateToWidth(text, width);

	const start = offset % chars.length;
	let out = "";
	for (let i = 0; out.length < width; i++) {
		out += chars[(start + i) % chars.length] ?? " ";
	}
	return out.slice(0, width);
}

function getLivePosition(track: SpotifyTrack, fetchedAtMs: number | null): number {
	if (!track.playing || fetchedAtMs == null) {
		return track.position;
	}

	const elapsedSeconds = (Date.now() - fetchedAtMs) / 1000;
	return Math.min(track.duration || Number.POSITIVE_INFINITY, track.position + elapsedSeconds);
}

function formatTokenStats(ctx: ExtensionContext): string {
	let input = 0;
	let output = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const msg = entry.message as AssistantMessage;
			input += msg.usage?.input ?? 0;
			output += msg.usage?.output ?? 0;
			cost += msg.usage?.cost?.total ?? 0;
		}
	}

	const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
	return `↑${fmt(input)} ↓${fmt(output)} $${cost.toFixed(3)}`;
}

function renderPiLine(
	ctx: ExtensionContext,
	footerData: { getGitBranch(): string | null; getExtensionStatuses(): ReadonlyMap<string, string> },
	width: number,
): string {
	const cwd = path.basename(ctx.cwd);
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model";
	const branch = footerData.getGitBranch();
	const statuses = [...footerData.getExtensionStatuses().entries()]
		.map(([name, value]) => `${name}:${value}`)
		.join(" · ");

	const parts = ["π", model, cwd, formatTokenStats(ctx)];
	if (branch) parts.push(branch);
	if (statuses) parts.push(statuses);

	return truncateToWidth(ctx.ui.theme.fg("dim", parts.join(" · ")), width);
}

export default function (pi: ExtensionAPI) {
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let scrollTimer: ReturnType<typeof setInterval> | null = null;
	let active = false;
	let scrollOffset = 0;
	let footerTui: { requestRender: () => void } | null = null;

	const state: FooterState = {
		loaded: false,
		track: null,
		error: null,
		fetchedAtMs: null,
	};

	function renderFooter(ctx: ExtensionContext): void {
		ctx.ui.setFooter((tui, theme, footerData) => {
			footerTui = tui;
			const onBranchChange = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: onBranchChange,
				invalidate() {},
				render(width: number): string[] {
					const piLine = renderPiLine(ctx, footerData, width);

					if (!state.loaded) {
						return [piLine, truncateToWidth(theme.fg("dim", "Spotify: loading..."), width)];
					}

					if (state.error) {
						return [piLine, truncateToWidth(theme.fg("warning", `Spotify: ${state.error}`), width)];
					}

					if (!state.track) {
						return [piLine, truncateToWidth(theme.fg("dim", "Spotify: not running"), width)];
					}

					const track = state.track;
					const livePosition = getLivePosition(track, state.fetchedAtMs);
					const icon = track.playing ? theme.fg("success", "▶") : theme.fg("warning", "⏸");
					const rightRaw = ` ${progressBar(livePosition, track.duration, 14, scrollOffset, track.volume)} ${theme.fg(
						"dim",
						`${fmtTime(livePosition)} / ${fmtTime(track.duration)}  vol ${Math.round(track.volume)}%`,
					)}`;
					const fixedWidth = visibleWidth(`${icon}  — `) + visibleWidth(rightRaw);
					const available = Math.max(0, width - fixedWidth);
					const artistWidth = Math.max(8, Math.floor(available * 0.35));
					const titleWidth = Math.max(8, available - artistWidth);
					const artistText = marquee(track.artist, artistWidth, scrollOffset);
					const titleText = marquee(track.title, titleWidth, scrollOffset * 2);
					const middle = `${theme.fg("muted", artistText)} — ${theme.fg("accent", titleText)}`;

					return [piLine, truncateToWidth(`${icon} ${middle}${rightRaw}`, width)];
				},
			};
		});
	}

	async function refresh(ctx: ExtensionContext): Promise<void> {
		if (!active) return;

		try {
			const track = await getSpotifyTrack();
			state.track = track;
			state.error = null;
			state.fetchedAtMs = track ? Date.now() : null;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			state.track = null;
			state.error = friendlyError(message);
			state.fetchedAtMs = null;
		} finally {
			state.loaded = true;
			footerTui?.requestRender();
		}
	}

	async function runCommand(ctx: ExtensionContext, script: string): Promise<void> {
		try {
			await runAppleScript(script);
			await refresh(ctx);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(
				`Spotify error: ${friendlyError(message)}. If prompted, allow your terminal to control Spotify.`,
				"error",
			);
			state.error = friendlyError(message);
			footerTui?.requestRender();
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		active = true;
		renderFooter(ctx);
		ctx.ui.notify(
			"Spotify extension loaded. Use /spotify-test once to trigger the macOS permission prompt if needed.",
			"info",
		);

		await refresh(ctx);

		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(() => {
			void refresh(ctx);
		}, POLL_MS);

		if (scrollTimer) clearInterval(scrollTimer);
		scrollTimer = setInterval(() => {
			scrollOffset++;
			footerTui?.requestRender();
		}, SCROLL_MS);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		active = false;

		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}

		if (scrollTimer) {
			clearInterval(scrollTimer);
			scrollTimer = null;
		}

		footerTui = null;
		state.loaded = false;
		state.track = null;
		state.error = null;
		state.fetchedAtMs = null;

		ctx.ui.setFooter(undefined);
	});

	pi.registerCommand("spotify-test", {
		description: "Force AppleScript access to Spotify (triggers macOS permission prompt)",
		handler: async (_args, ctx) => {
			await runCommand(ctx, `tell application "Spotify" to get player state`);
			ctx.ui.notify("Spotify permission test ran. If macOS prompted, click Allow.", "info");
		},
	});

	pi.registerCommand("spotify-refresh", {
		description: "Refresh the Spotify bar",
		handler: async (_args, ctx) => {
			await refresh(ctx);
		},
	});

	pi.registerCommand("spotify-toggle", {
		description: "Play/pause Spotify",
		handler: async (_args, ctx) => {
			await runCommand(ctx, `tell application "Spotify" to playpause`);
		},
	});

	pi.registerCommand("spotify-next", {
		description: "Next Spotify track",
		handler: async (_args, ctx) => {
			await runCommand(ctx, `tell application "Spotify" to next track`);
		},
	});

	pi.registerCommand("spotify-prev", {
		description: "Previous Spotify track",
		handler: async (_args, ctx) => {
			await runCommand(ctx, `tell application "Spotify" to previous track`);
		},
	});
}
