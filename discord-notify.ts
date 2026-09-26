// Discord notifications for Command Code — ping your phone when the agent needs you.
//
// Event detection is adapted from the MIT-licensed `cmd-mod-completion-bell` mod
// (github.com/timuela/commandcode-mods), which solved the hard part of this problem:
// working out WHICH events indicate the agent is blocked on a human. This swaps its
// local WAV playback for a Discord webhook so the ping reaches your phone.
//
// Everything is configured in ONE place — ~/.commandcode/discord-notify.json:
//
//   {
//     "webhook": "https://discord.com/api/webhooks/...",
//     "mention": "123456789012345678",   // your user id; bare digits are fine
//     "quiet": false,                     // true = only ping when blocked on you
//     "verbose": false                    // true = also sub-agent + session pings
//   }
//
// Only "webhook" is required. The file is re-read when it changes, so you can edit it
// and run /notify-test without restarting Command Code.
//
// Two launch-time overrides exist for one-off use, and both beat the file:
//   --mod-option discord-webhook=...   and   --mod-option discord-mention=...
// COMMANDCODE_DISCORD_WEBHOOK is also honoured as an environment fallback.
//
// `mention` matters because Discord's default channel setting is "@mentions only", and
// a webhook mentions nobody — so without it the POST succeeds but your phone stays
// silent. Either set a mention here, or set the channel's notification level to
// "All Messages". Then run /notify-test to confirm it reaches your phone.

import {readFileSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {ModApi} from '@commandcode/harness';

// Tools whose panels live in the TUI and fire no tool events of their own — the
// only way to catch them is to spot the tool_use in the finished message.
const USER_BLOCKING_TOOLS = new Set([
	'ask_user_question',
	'enter_plan_mode',
	'exit_plan_mode',
	'plan_review',
]);

// Permission modes where a queued tool can actually sit waiting for approval.
const PROMPTING_MODES = new Set(['default', 'plan', 'auto-accept']);

const PENDING_MS = 5000; // a tool queued this long unanswered means you're away
const DEBOUNCE_MS = 2000; // at most one ping per cause per window
const REQUEST_TIMEOUT_MS = 5000;

const CONFIG_PATH = join(homedir(), '.commandcode', 'discord-notify.json');

const COLOR = {
	needsYou: 0xfee75c,
	done: 0x57f287,
	error: 0xed4245,
	info: 0x5865f2,
} as const;

type Reason = 'needs-you' | 'done' | 'error' | 'info';
type Source = 'flag' | 'env' | 'config file' | 'none';

interface SendOutcome {
	readonly ok: boolean;
	readonly detail: string;
	readonly at: number;
}

interface FileConfig {
	readonly webhook?: string;
	readonly mention?: string;
	readonly quiet?: boolean;
	readonly verbose?: boolean;
}

interface Settings {
	readonly webhook?: string;
	readonly webhookSource: Source;
	readonly mention?: string;
	readonly mentionSource: Source;
	readonly quiet: boolean;
	readonly verbose: boolean;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

// Keep content from breaking out of the fenced code block we render it in.
function fenceSafe(text: string): string {
	return text.replaceAll('```', "'''");
}

function projectName(cwd: string): string {
	const parts = cwd.split('/').filter(Boolean);
	return parts.at(-1) ?? cwd;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

// Accept a bare user id and turn it into a real mention — pasting the raw id is the
// obvious mistake, and it silently fails to notify.
function normalizeMention(value: unknown): string | undefined {
	const raw = nonEmptyString(value);
	if (raw === undefined) return undefined;
	return /^\d+$/.test(raw) ? `<@${raw}>` : raw;
}

export default function (cmd: ModApi): void {
	// No defaults on the booleans, so getFlag returns undefined when the flag was not
	// passed — that is how we tell "flag absent" from "flag explicitly false" and let
	// the config file win when the flag is absent.
	cmd.addFlag('discord-webhook', {
		type: 'string',
		description: 'Discord webhook URL. Overrides the config file.',
	});
	cmd.addFlag('discord-mention', {
		type: 'string',
		description: 'Mention to include so Discord pushes to your phone. Overrides the config file.',
	});
	cmd.addFlag('discord-quiet', {
		type: 'boolean',
		description: 'Only ping when the agent is blocked on you (no done/error pings).',
	});
	cmd.addFlag('discord-verbose', {
		type: 'boolean',
		description: 'Also ping on sub-agent activity and session start/end.',
	});

	const pending = new Map<string, ReturnType<typeof setTimeout>>();
	const lastSentAt = new Map<Reason, number>();

	let permissionMode = 'default';
	let lastOutcome: SendOutcome | undefined;
	let warnedUnconfigured = false;
	let cachedConfig: {mtimeMs: number; value: FileConfig} | undefined;

	// Re-read when the file changes so edits land without a /reload.
	function readConfigFile(): FileConfig {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(CONFIG_PATH).mtimeMs;
		} catch {
			cachedConfig = undefined;
			return {};
		}
		if (cachedConfig?.mtimeMs === mtimeMs) return cachedConfig.value;

		let value: FileConfig = {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
			if (parsed && typeof parsed === 'object') {
				const raw = parsed as Record<string, unknown>;
				value = {
					webhook: nonEmptyString(raw.webhook),
					mention: nonEmptyString(raw.mention),
					quiet: typeof raw.quiet === 'boolean' ? raw.quiet : undefined,
					verbose: typeof raw.verbose === 'boolean' ? raw.verbose : undefined,
				};
			}
		} catch {
			// Malformed JSON is treated as "not configured" rather than a crash — the mod
			// should never take the session down over a stray comma.
			value = {};
		}
		cachedConfig = {mtimeMs, value};
		return value;
	}

	function resolveSettings(): Settings {
		const file = readConfigFile();

		const flagWebhook = nonEmptyString(cmd.getFlag('discord-webhook'));
		const envWebhook = nonEmptyString(process.env.COMMANDCODE_DISCORD_WEBHOOK);
		const webhook = flagWebhook ?? envWebhook ?? file.webhook;
		const webhookSource: Source = flagWebhook
			? 'flag'
			: envWebhook
				? 'env'
				: file.webhook
					? 'config file'
					: 'none';

		const flagMention = nonEmptyString(cmd.getFlag('discord-mention'));
		const mention = normalizeMention(flagMention ?? file.mention);
		const mentionSource: Source = flagMention ? 'flag' : file.mention ? 'config file' : 'none';

		const flagQuiet = cmd.getFlag('discord-quiet');
		const flagVerbose = cmd.getFlag('discord-verbose');

		return {
			webhook,
			webhookSource,
			mention,
			mentionSource,
			quiet: typeof flagQuiet === 'boolean' ? flagQuiet : file.quiet === true,
			verbose: typeof flagVerbose === 'boolean' ? flagVerbose : file.verbose === true,
		};
	}

	async function deliver(reason: Reason, title: string, description: string): Promise<void> {
		const settings = resolveSettings();
		if (!settings.webhook) {
			if (!warnedUnconfigured) {
				warnedUnconfigured = true;
				cmd.ui.notify(
					`discord-notify: no webhook yet — add one to ${CONFIG_PATH}, then run /notify-test.`,
				);
			}
			lastOutcome = {ok: false, detail: 'no webhook configured', at: Date.now()};
			return;
		}

		const mention = settings.mention;
		const payload = {
			username: 'Command Code',
			...(mention ? {content: mention} : {}),
			// Discord suppresses pushes for non-mentioning messages unless the channel is
			// set to all messages; this lets the explicit mention actually deliver.
			...(mention ? {allowed_mentions: {parse: ['users', 'roles', 'everyone']}} : {}),
			embeds: [
				{
					title: truncate(title, 256),
					description: truncate(description, 4096) || undefined,
					color: COLOR[reason],
					timestamp: new Date().toISOString(),
					footer: {text: `${projectName(cmd.cwd)} · ${reason}`},
				},
			],
		};

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(settings.webhook, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
			lastOutcome = {
				ok: response.ok,
				detail: response.ok ? 'delivered' : `HTTP ${response.status}`,
				at: Date.now(),
			};
		} catch (error) {
			lastOutcome = {
				ok: false,
				detail: error instanceof Error ? error.message : 'send failed',
				at: Date.now(),
			};
		} finally {
			clearTimeout(timer);
		}
	}

	// Debounced, fire-and-forget. A notification must never stall the agent loop,
	// so nothing here is awaited by a caller on the hot path.
	function ping(reason: Reason, title: string, description: string): void {
		const now = Date.now();
		const previous = lastSentAt.get(reason) ?? 0;
		if (now - previous < DEBOUNCE_MS) return;
		lastSentAt.set(reason, now);
		void deliver(reason, title, description);
	}

	function clearPending(id: string): void {
		const timer = pending.get(id);
		if (timer) clearTimeout(timer);
		pending.delete(id);
	}

	function clearAllPending(): void {
		for (const timer of pending.values()) clearTimeout(timer);
		pending.clear();
	}

	function summarizeRequest(name: string, input: unknown): string {
		if (name === 'ask_user_question' && input && typeof input === 'object') {
			const questions = (input as {questions?: unknown}).questions;
			if (Array.isArray(questions)) {
				const first = questions[0];
				if (first && typeof first === 'object' && 'question' in first) {
					const text = (first as {question?: unknown}).question;
					if (typeof text === 'string' && text.trim() !== '') {
						const extra = questions.length > 1 ? ` (+${questions.length - 1} more)` : '';
						return `Question: ${text}${extra}`;
					}
				}
			}
		}
		if (name === 'enter_plan_mode' || name === 'exit_plan_mode') {
			return 'A plan is waiting for your approval.';
		}
		if (name === 'plan_review') {
			return 'A plan is ready for review.';
		}
		return 'The agent is waiting on your input.';
	}

	cmd.on('permission_mode_changed', ({mode}) => {
		permissionMode = mode;
	});

	// Plan approval and question panels are TUI-side and emit no tool events, so
	// the only signal is the tool_use block in the finished message.
	cmd.on('message_end', ({content}) => {
		const blocks = Array.isArray(content) ? content : [];
		for (const block of blocks) {
			if (!block || typeof block !== 'object') continue;
			const typed = block as {type?: unknown; name?: unknown; input?: unknown};
			if (typed.type !== 'tool_use') continue;
			if (typeof typed.name !== 'string') continue;
			if (!USER_BLOCKING_TOOLS.has(typed.name)) continue;
			ping('needs-you', '🙋 Needs you', summarizeRequest(typed.name, typed.input));
			return;
		}
	});

	// A queued tool that never starts means an approval modal is sitting there.
	// Answer it quickly and you never get pinged.
	cmd.on('tool_queued', ({toolCallId, toolName}) => {
		if (!PROMPTING_MODES.has(permissionMode)) return;
		if (USER_BLOCKING_TOOLS.has(toolName)) return;
		pending.set(
			toolCallId,
			setTimeout(() => {
				pending.delete(toolCallId);
				ping(
					'needs-you',
					'🔐 Waiting for approval',
					'`' + fenceSafe(toolName) + '` is waiting for your permission.',
				);
			}, PENDING_MS),
		);
	});

	cmd.on('tool_running', ({toolCallId}) => clearPending(toolCallId));
	cmd.on('tool_denied', ({toolCallId}) => clearPending(toolCallId));
	cmd.on('interrupted', clearAllPending);

	cmd.on('run_end', ({result}) => {
		clearAllPending();
		if (resolveSettings().quiet) return;
		const finalText = typeof result?.finalText === 'string' ? result.finalText.trim() : '';
		const stopReason = result?.stopReason ?? 'unknown';
		const turns = typeof result?.turnCount === 'number' ? result.turnCount : undefined;
		const header =
			turns === undefined
				? `stopped: ${stopReason}`
				: `stopped: ${stopReason} · ${turns} turn(s)`;
		const body =
			finalText === ''
				? '_No final message._'
				: '```\n' + fenceSafe(truncate(finalText, 1800)) + '\n```';
		ping('done', '✅ Finished', `${header}\n\n${body}`);
	});

	cmd.on('run_error', ({error}) => {
		clearAllPending();
		if (resolveSettings().quiet) return;
		const message = error instanceof Error ? error.message : String(error);
		ping('error', '❌ Run failed', '```\n' + fenceSafe(truncate(message, 1800)) + '\n```');
	});

	cmd.on('subagent_start', ({subagentType}) => {
		if (!resolveSettings().verbose) return;
		ping('info', '🤖 Sub-agent started', '`' + fenceSafe(String(subagentType)) + '`');
	});

	cmd.on('subagent_stop', ({subagentType, tokensUsed}) => {
		if (!resolveSettings().verbose) return;
		const tokens = typeof tokensUsed === 'number' ? ` · ${tokensUsed} tokens` : '';
		ping('info', '🤖 Sub-agent done', '`' + fenceSafe(String(subagentType)) + '`' + tokens);
	});

	cmd.on('session_start', () => {
		if (!resolveSettings().verbose) return;
		ping('info', '▶️ Session started', '`' + fenceSafe(projectName(cmd.cwd)) + '`');
	});

	cmd.on('session_shutdown', () => {
		if (!resolveSettings().verbose) return;
		ping('info', '⏹ Session ended', '`' + fenceSafe(projectName(cmd.cwd)) + '`');
	});

	cmd.addCommand({
		name: 'notify-test',
		description: 'Send a test notification to your Discord webhook',
		handler: () => {
			const settings = resolveSettings();
			if (!settings.webhook) {
				return {
					message: `No webhook configured. Add {"webhook": "https://discord.com/api/webhooks/..."} to ${CONFIG_PATH} and run /notify-test again.`,
				};
			}
			lastSentAt.clear();
			void deliver(
				'info',
				'👋 Test notification',
				'If you can read this on your phone, Command Code pings are working.',
			).then(() => {
				if (!lastOutcome) return;
				cmd.ui.notify(
					lastOutcome.ok
						? 'discord-notify: test delivered ✓'
						: `discord-notify: test failed — ${lastOutcome.detail}`,
				);
			});
			return {message: 'Sending a test notification to Discord…'};
		},
	});

	cmd.addCommand({
		name: 'notify-status',
		description: 'Show Discord notification config and the last delivery result',
		handler: () => {
			const settings = resolveSettings();
			const lines = [
				`config file: ${CONFIG_PATH}`,
				`webhook: ${settings.webhook ? 'configured ✓' : 'NOT configured'} (${settings.webhookSource})`,
				`mention: ${settings.mention ?? 'none'} (${settings.mentionSource})`,
				`quiet: ${settings.quiet ? 'on' : 'off'}   verbose: ${settings.verbose ? 'on' : 'off'}`,
				`permission mode: ${permissionMode}`,
				lastOutcome
					? `last send: ${lastOutcome.ok ? '✓' : '✗'} ${lastOutcome.detail} at ${new Date(lastOutcome.at).toLocaleTimeString()}`
					: 'last send: nothing sent yet this session',
			];
			return {message: lines.join('\n')};
		},
	});
}
