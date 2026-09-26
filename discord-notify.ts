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

import {chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
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
const DEBOUNCE_MS = 2000; // identical notifications inside this window collapse
const REQUEST_TIMEOUT_MS = 5000;
const PROMPT_MAX = 300; // how much of your request to quote back

const CONFIG_PATH = join(homedir(), '.commandcode', 'discord-notify.json');

const COLOR = {
	needsYou: 0xfee75c,
	done: 0x57f287,
	error: 0xed4245,
	info: 0x5865f2,
} as const;

// Raw stop reasons are internal vocabulary; say what they mean instead.
const STOP_REASON_TEXT: Record<string, string> = {
	end_turn: 'Completed normally',
	max_turns: 'Stopped at the turn limit',
	permission_denied: 'Stopped — you denied a permission request',
	terminate: 'Stopped early',
	stop_hook: 'Stopped by a hook',
	interrupted: 'Interrupted',
	error: 'Failed',
};

type Reason = 'needs-you' | 'done' | 'error' | 'info';
type Source = 'flag' | 'env' | 'config file' | 'none';

interface EmbedField {
	readonly name: string;
	readonly value: string;
}

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
	readonly enabled?: boolean;
}

interface Settings {
	readonly webhook?: string;
	readonly webhookSource: Source;
	readonly mention?: string;
	readonly mentionSource: Source;
	readonly quiet: boolean;
	readonly verbose: boolean;
	readonly enabled: boolean;
}

interface Ping {
	readonly reason: Reason;
	readonly title: string;
	readonly description?: string;
	readonly fields?: readonly EmbedField[];
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

// Keep content from breaking out of the fenced code block we render it in.
function fenceSafe(text: string): string {
	return text.replaceAll('```', "'''");
}

function codeBlock(text: string, max = 1800): string {
	return '```\n' + fenceSafe(truncate(text, max)) + '\n```';
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

function humanDuration(ms: number): string {
	if (ms < 1000) return 'under a second';
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

// Node's fetch buries the real reason in `cause`, so a bare failure reads only
// "fetch failed" — precisely the unhelpful message this is meant to avoid.
function describeFetchError(error: unknown): string {
	if (!(error instanceof Error)) return 'send failed';
	if (error.name === 'AbortError') return 'timed out';
	const cause = (error as {cause?: unknown}).cause;
	let code: unknown;
	if (cause && typeof cause === 'object') {
		code = (cause as {code?: unknown}).code ?? (cause as {message?: unknown}).message;
	}
	const suffix = typeof code === 'string' && code !== '' ? ` (${code})` : '';
	return `${error.message}${suffix}`;
}

function humanStopReason(raw: string): string {
	return STOP_REASON_TEXT[raw] ?? raw.replaceAll('_', ' ');
}

// Describe what a waiting tool is about to do, so the ping is actionable without
// switching back to the terminal.
function toolIntent(toolName: string, input: unknown): string | undefined {
	const record =
		input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
	if (toolName === 'shell_command') {
		const command = nonEmptyString(record.command);
		if (command !== undefined) return `wants to run this command:\n${codeBlock(command, 500)}`;
	}
	if (toolName === 'write_file' || toolName === 'edit_file') {
		const path = nonEmptyString(record.file_path);
		if (path !== undefined) {
			const verb = toolName === 'write_file' ? 'create' : 'edit';
			return `wants to ${verb} \`${fenceSafe(path)}\``;
		}
	}
	if (toolName === 'read_file') {
		const path = nonEmptyString(record.absolute_path) ?? nonEmptyString(record.file_path);
		if (path !== undefined) return `wants to read \`${fenceSafe(path)}\``;
	}
	return undefined;
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
	// Keyed by the whole notification, so only byte-identical repeats are collapsed and
	// any genuinely different event still lands. Dropping a distinct "needs you" ping
	// would defeat the point of the mod, so this errs toward delivering.
	const lastSentAt = new Map<string, number>();
	// Deliveries still in flight. The process exits the moment the run ends, so a send
	// that isn't awaited here is silently lost — see flush().
	const inFlight = new Set<Promise<void>>();

	let permissionMode = 'default';
	let lastOutcome: SendOutcome | undefined;
	let warnedUnconfigured = false;
	let warnedDeliveryFailure = false;
	let cachedConfig: {mtimeMs: number; value: FileConfig} | undefined;

	// Run context, so a ping can say what it was about rather than just that it happened.
	let lastUserPrompt: string | undefined;
	let runStartedAt: number | undefined;
	let toolCallsThisRun = 0;
	let reportedEnd: 'none' | 'success' | 'failure' = 'none';

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
					enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
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
			// Muting is a file-only setting, and an absent field means "on", so an existing
			// config without it keeps working exactly as before.
			enabled: file.enabled !== false,
		};
	}

	// Rewrite the config with a patch applied. Reads the raw JSON first so keys this mod
	// doesn't know about survive, and writes via a temp file + rename so an interrupted
	// write can't leave a truncated config behind.
	function updateConfigFile(patch: Record<string, unknown>): void {
		let current: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				current = parsed as Record<string, unknown>;
			}
		} catch {
			// Missing or malformed: start fresh rather than fail the command.
		}

		let mode = 0o600; // it holds a webhook credential
		try {
			mode = statSync(CONFIG_PATH).mode & 0o777;
		} catch {
			// Brand new file — keep the 0600 default.
		}

		mkdirSync(dirname(CONFIG_PATH), {recursive: true});
		const temporary = `${CONFIG_PATH}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({...current, ...patch}, null, 2)}\n`, {mode});
		chmodSync(temporary, mode);
		renameSync(temporary, CONFIG_PATH);
		cachedConfig = undefined; // take effect at once, without waiting for an mtime change
	}

	// cmd.ui.notify draws a feed row in the interactive TUI but prints nothing at all under
	// `cmd -p` (despite the docs saying headless prints a notice), and print mode is exactly
	// where a delivery failure needs to be visible. So: feed row in the TUI, stderr
	// otherwise — never both, so a raw write can't garble the TUI.
	function warn(message: string): void {
		if (cmd.ui?.capabilities?.status === true) {
			cmd.ui.notify(message);
			return;
		}
		process.stderr.write(`\n${message}\n`);
	}

	async function deliver(content: Ping): Promise<void> {
		const settings = resolveSettings();
		// Muted: stay completely silent, which also means no failure warnings — being told
		// about a notification you asked not to receive would be noise.
		if (!settings.enabled) return;
		if (!settings.webhook) {
			if (!warnedUnconfigured) {
				warnedUnconfigured = true;
				warn(
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
					title: truncate(content.title, 256),
					description: content.description ? truncate(content.description, 4096) : undefined,
					color: COLOR[content.reason],
					timestamp: new Date().toISOString(),
					...(content.fields && content.fields.length > 0
						? {
								fields: content.fields.map((field) => ({
									name: truncate(field.name, 256),
									value: truncate(field.value, 1024),
								})),
							}
						: {}),
					footer: {text: projectName(cmd.cwd)},
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
				detail: describeFetchError(error),
				at: Date.now(),
			};
		} finally {
			clearTimeout(timer);
		}

		// A failed send used to be completely silent, which makes a broken webhook look
		// exactly like a working one — the bug this cost the most time to find. Warn once per
		// outage (a success re-arms it) so a misconfigured URL can't flood the feed.
		if (lastOutcome.ok) {
			warnedDeliveryFailure = false;
			return;
		}
		if (!warnedDeliveryFailure) {
			warnedDeliveryFailure = true;
			warn(
				`discord-notify: a notification could not be delivered (${lastOutcome.detail}). Run /notify-status for details.`,
			);
		}
	}

	// Debounced, fire-and-forget. A notification must never stall the agent loop,
	// so nothing here is awaited by a caller on the hot path.
	function ping(content: Ping): void {
		const now = Date.now();
		const key = JSON.stringify(content);
		const previous = lastSentAt.get(key) ?? 0;
		if (now - previous < DEBOUNCE_MS) return;
		lastSentAt.set(key, now);
		const task = deliver(content);
		inFlight.add(task);
		void task.finally(() => inFlight.delete(task));
	}

	// Wait for every delivery started so far. Command Code exits as soon as the run ends,
	// so a fire-and-forget fetch from an event observer dies mid-request and the ping is
	// lost. This is called from the awaited `onRunEnd` hook, which the harness waits for.
	async function flush(): Promise<void> {
		while (inFlight.size > 0) {
			await Promise.allSettled([...inFlight]);
		}
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

	// "What was this about?" — the single most useful piece of context on a phone.
	function promptField(): EmbedField[] {
		if (!lastUserPrompt) return [];
		return [{name: 'You asked', value: lastUserPrompt}];
	}

	function summarizeRequest(name: string, input: unknown): string {
		if (name === 'ask_user_question' && input && typeof input === 'object') {
			const questions = (input as {questions?: unknown}).questions;
			if (Array.isArray(questions)) {
				const first = questions[0];
				if (first && typeof first === 'object' && 'question' in first) {
					const text = (first as {question?: unknown}).question;
					if (typeof text === 'string' && text.trim() !== '') {
						const extra =
							questions.length > 1
								? `\n\n_${questions.length} questions in total._`
								: '';
						return `${text.trim()}${extra}`;
					}
				}
			}
		}
		if (name === 'enter_plan_mode' || name === 'exit_plan_mode') {
			return 'A plan is ready for you to approve.';
		}
		if (name === 'plan_review') {
			return 'A plan is ready for you to review.';
		}
		return 'The agent needs something from you.';
	}

	// Report how the run ended. Driven by the awaited onRunEnd hook, with the event
	// fallbacks below as a safety net.
	function reportEnd(options: {result?: any; error?: unknown}): void {
		const stopReason =
			typeof options.result?.stopReason === 'string' ? options.result.stopReason : undefined;
		const failure = options.error !== undefined || stopReason === 'error';
		// A late failure report is allowed to supersede a success one; never the reverse.
		if (failure ? reportedEnd === 'failure' : reportedEnd !== 'none') return;

		const elapsed = runStartedAt === undefined ? undefined : Date.now() - runStartedAt;
		const calls = toolCallsThisRun;
		if (reportedEnd === 'none') {
			runStartedAt = undefined;
			toolCallsThisRun = 0;
		}
		reportedEnd = failure ? 'failure' : 'success';

		if (resolveSettings().quiet) return;

		if (failure) {
			const finalText = typeof options.result?.finalText === 'string' ? options.result.finalText.trim() : '';
			const detail =
				options.error instanceof Error
					? options.error.message
					: options.error !== undefined
						? String(options.error)
						: finalText !== ''
							? finalText
							: 'No error detail available.';
			ping({
				reason: 'error',
				title: '❌ Run failed',
				description: codeBlock(detail),
				fields: promptField(),
			});
			return;
		}

		const finalText =
			typeof options.result?.finalText === 'string' ? options.result.finalText.trim() : '';
		ping({
			reason: 'done',
			title: elapsed === undefined ? '✅ Finished' : `✅ Finished in ${humanDuration(elapsed)}`,
			description: finalText === '' ? '_No final message._' : codeBlock(finalText),
			fields: [
				...promptField(),
				{name: 'Outcome', value: humanStopReason(stopReason ?? 'unknown')},
				...(calls === 0
					? []
					: [{name: 'Activity', value: calls === 1 ? '1 tool call' : `${calls} tool calls`}]),
			],
		});
	}

	// Remember what you typed, so later pings can quote it back. Returning undefined
	// leaves your input completely untouched — this only observes.
	cmd.hooks({
		transformInput: ({text}) => {
			const collapsed = text.replace(/\s+/g, ' ').trim();
			if (collapsed !== '') lastUserPrompt = truncate(collapsed, PROMPT_MAX);
			return undefined;
		},
		// This is why the mod works at all under `cmd -p`. The harness AWAITS onRunEnd, so a
		// send started here completes before the process exits. Event observers are never
		// awaited, and a delivery started from one gets killed mid-request.
		onRunEnd: async ({result}) => {
			clearAllPending();
			reportEnd({result});
			await flush();
		},
	});

	cmd.on('run_start', () => {
		runStartedAt = Date.now();
		toolCallsThisRun = 0;
		reportedEnd = 'none';
	});

	cmd.on('tool_completed', () => {
		toolCallsThisRun += 1;
	});
	cmd.on('tool_errored', () => {
		toolCallsThisRun += 1;
	});

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
			ping({
				reason: 'needs-you',
				title: '🙋 Needs your input',
				description: summarizeRequest(typed.name, typed.input),
				fields: promptField(),
			});
			return;
		}
	});

	// A queued tool that never starts means an approval modal is sitting there.
	// Answer it quickly and you never get pinged.
	cmd.on('tool_queued', ({toolCallId, toolName, input}) => {
		if (!PROMPTING_MODES.has(permissionMode)) return;
		if (USER_BLOCKING_TOOLS.has(toolName)) return;
		pending.set(
			toolCallId,
			setTimeout(() => {
				pending.delete(toolCallId);
				const intent = toolIntent(toolName, input);
				ping({
					reason: 'needs-you',
					title: '🔐 Waiting for your approval',
					description:
						intent === undefined
							? `\`${fenceSafe(toolName)}\` is waiting for your permission.`
							: `\`${fenceSafe(toolName)}\` ${intent}`,
					fields: promptField(),
				});
			}, PENDING_MS),
		);
	});

	cmd.on('tool_running', ({toolCallId}) => clearPending(toolCallId));
	cmd.on('tool_denied', ({toolCallId}) => clearPending(toolCallId));
	cmd.on('interrupted', clearAllPending);

	// Safety nets only — onRunEnd above fires first and normally handles this. Event
	// observers cannot await delivery, so a fallback ping may still be lost under `cmd -p`;
	// it exists so that a miss is at worst silent rather than always silent.
	cmd.on('run_end', ({result}) => {
		clearAllPending();
		reportEnd({result});
	});

	cmd.on('run_error', ({error}) => {
		clearAllPending();
		reportEnd({error});
	});

	cmd.on('subagent_start', ({subagentType}) => {
		if (!resolveSettings().verbose) return;
		ping({
			reason: 'info',
			title: '🤖 Sub-agent started',
			description: `\`${fenceSafe(String(subagentType))}\` is working on it.`,
			fields: promptField(),
		});
	});

	cmd.on('subagent_stop', ({subagentType, tokensUsed}) => {
		if (!resolveSettings().verbose) return;
		const tokens = typeof tokensUsed === 'number' ? `\n_${tokensUsed} tokens used._` : '';
		ping({
			reason: 'info',
			title: '🤖 Sub-agent finished',
			description: `\`${fenceSafe(String(subagentType))}\` is done.${tokens}`,
			fields: promptField(),
		});
	});

	cmd.on('session_start', () => {
		if (!resolveSettings().verbose) return;
		ping({
			reason: 'info',
			title: '▶️ Session started',
			description: `Working in \`${fenceSafe(projectName(cmd.cwd))}\`.`,
		});
	});

	cmd.on('session_shutdown', () => {
		if (!resolveSettings().verbose) return;
		ping({
			reason: 'info',
			title: '⏹ Session ended',
			description: `Finished in \`${fenceSafe(projectName(cmd.cwd))}\`.`,
		});
	});

	cmd.addCommand({
		name: 'notify-enable',
		description: 'Unmute Discord notifications',
		handler: () => {
			const wasEnabled = resolveSettings().enabled;
			updateConfigFile({enabled: true});
			return {message: wasEnabled ? 'Notifications are already on.' : 'Notifications on.'};
		},
	});

	cmd.addCommand({
		name: 'notify-disable',
		description: 'Mute Discord notifications until you turn them back on',
		handler: () => {
			const settings = resolveSettings();
			updateConfigFile({enabled: false});
			if (!settings.enabled) return {message: 'Notifications are already muted.'};
			const note = settings.webhook
				? ''
				: ' No webhook is configured, so nothing was being sent anyway.';
			return {
				message: `Notifications muted — run /notify-enable to unmute.${note}`,
			};
		},
	});

	cmd.addCommand({
		name: 'notify-test',
		description: 'Send a test notification to your Discord webhook',
		handler: () => {
			const settings = resolveSettings();
			if (!settings.enabled) {
				return {
					message: 'Notifications are muted, so nothing was sent. Run /notify-enable first.',
				};
			}
			if (!settings.webhook) {
				return {
					message: `No webhook configured. Add {"webhook": "https://discord.com/api/webhooks/..."} to ${CONFIG_PATH} and run /notify-test again.`,
				};
			}
			lastSentAt.clear();
			void deliver({
				reason: 'info',
				title: '👋 Test notification',
				description: 'If you can read this on your phone, Command Code pings are working.',
				fields: promptField(),
			}).then(() => {
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
				`notifications: ${settings.enabled ? 'on' : 'MUTED'} — ${settings.enabled ? '/notify-disable to mute' : '/notify-enable to unmute'}`,
				`webhook: ${settings.webhook ? 'configured ✓' : 'NOT configured'} (${settings.webhookSource})`,
				`mention: ${settings.mention ?? 'none'} (${settings.mentionSource})`,
				`quiet: ${settings.quiet ? 'on' : 'off'}   verbose: ${settings.verbose ? 'on' : 'off'}`,
				`permission mode: ${permissionMode}`,
				`last request: ${lastUserPrompt ?? 'nothing captured yet'}`,
				lastOutcome
					? `last send: ${lastOutcome.ok ? '✓' : '✗'} ${lastOutcome.detail} at ${new Date(lastOutcome.at).toLocaleTimeString()}`
					: 'last send: nothing sent yet this session',
			];
			return {message: lines.join('\n')};
		},
	});
}
