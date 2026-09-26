// Unit tests for the discord-notify mod.
//
// These drive the real mod factory against a fake ModApi, so they exercise the actual
// event wiring and payload construction rather than a reimplementation of it. fetch is
// stubbed throughout, so nothing ever reaches the network.
//
// The mod resolves its config file from $HOME at import time, so this file points HOME at
// a throwaway directory BEFORE importing it. Without that, tests would read the developer's
// real ~/.commandcode/discord-notify.json and fire at their real Discord webhook.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'discord-notify-sandbox-'));
process.env.HOME = SANDBOX_HOME;
process.on('exit', () => rmSync(SANDBOX_HOME, {recursive: true, force: true}));

const {default: createMod} = await import('../discord-notify.ts');

const WEBHOOK = 'http://webhook.test/hook';

type ModFactory = typeof createMod;

interface SentRequest {
	url: string;
	payload: any;
}

interface FakeMod {
	cmd: any;
	emit: (event: string, payload?: any) => void;
	commands: Map<string, (args?: any) => any>;
	declaredFlags: Map<string, any>;
	events: Set<string>;
	notices: string[];
}

function makeFakeCmd(options: {cwd?: string; flags?: Record<string, any>} = {}): FakeMod {
	const handlers = new Map<string, ((payload: any) => void)[]>();
	const commands = new Map<string, (args?: any) => any>();
	const declaredFlags = new Map<string, any>();
	const events = new Set<string>();
	const notices: string[] = [];
	const flags = new Map<string, any>(Object.entries(options.flags ?? {}));

	return {
		cwd: options.cwd ?? '/Users/dev/projects/my-app',
		commands,
		declaredFlags,
		events,
		notices,
		cmd: {
			name: 'discord-notify',
			cwd: options.cwd ?? '/Users/dev/projects/my-app',
			ui: {notify: (message: string) => notices.push(message)},
			on: (event: string, handler: (payload: any) => void) => {
				events.add(event);
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			addFlag: (name: string, definition: any) => declaredFlags.set(name, definition),
			getFlag: (name: string) => flags.get(name),
			addCommand: ({name, handler}: {name: string; handler: (args?: any) => any}) =>
				commands.set(name, handler),
		},
		emit: (event, payload) => {
			for (const handler of handlers.get(event) ?? []) handler(payload);
		},
	};
}

// Captured before any stubbing so every restore puts the real built-in fetch back.
const REAL_FETCH = globalThis.fetch;

// Stub fetch and record what the mod tried to send. Always call this once per test.
function stubFetch(
	t: any,
	response: {ok: boolean; status: number} = {ok: true, status: 204},
): SentRequest[] {
	const requests: SentRequest[] = [];
	globalThis.fetch = (async (url: any, init: any) => {
		requests.push({url: String(url), payload: JSON.parse(init.body)});
		return {ok: response.ok, status: response.status} as any;
	}) as any;
	t.after(() => {
		globalThis.fetch = REAL_FETCH;
	});
	return requests;
}

function embedOf(request: SentRequest): any {
	return request.payload.embeds[0];
}

// A fresh mod instance per test — the factory holds per-instance state (pending timers,
// debounce windows) that must not leak between tests.
function setup(t: any, options: {flags?: Record<string, any>; cwd?: string; response?: {ok: boolean; status: number}} = {}) {
	const fake = makeFakeCmd({cwd: options.cwd, flags: options.flags});
	createMod(fake.cmd);
	const requests = stubFetch(t, options.response);
	return {fake, requests, commands: fake.commands, notices: fake.notices};
}

function withWebhook(t: any, extra: Record<string, any> = {}, response?: {ok: boolean; status: number}) {
	return setup(t, {flags: {'discord-webhook': WEBHOOK, ...extra}, response});
}

function useFakeTimers(t: any) {
	// Start at a realistic wall clock. Mocking from 0 would make the very first ping look
	// like it happened at t=0 and get debounced away.
	t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: Date.now()});
}

function settle() {
	return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test('registers the flags, commands and events it documents', () => {
	const fake = makeFakeCmd();
	createMod(fake.cmd);

	for (const flag of ['discord-webhook', 'discord-mention', 'discord-quiet', 'discord-verbose']) {
		assert.ok(fake.declaredFlags.has(flag), `missing flag ${flag}`);
	}
	// The boolean flags must NOT declare a default, or a config file value could never win:
	// getFlag would hand back the declared default instead of undefined.
	assert.equal(fake.declaredFlags.get('discord-quiet').default, undefined);
	assert.equal(fake.declaredFlags.get('discord-verbose').default, undefined);

	for (const command of ['notify-test', 'notify-status']) {
		assert.ok(fake.commands.has(command), `missing command ${command}`);
	}
	for (const event of [
		'permission_mode_changed',
		'message_end',
		'tool_queued',
		'tool_running',
		'tool_denied',
		'interrupted',
		'run_end',
		'run_error',
		'subagent_start',
		'subagent_stop',
		'session_start',
		'session_shutdown',
	]) {
		assert.ok(fake.events.has(event), `missing event subscription ${event}`);
	}
});

// ---------------------------------------------------------------------------
// run_end / run_error
// ---------------------------------------------------------------------------

test('run_end sends a Finished ping with stop reason, turns and final text', (t) => {
	const {fake, requests} = withWebhook(t);
	fake.emit('run_end', {
		result: {finalText: 'All done, tests pass.', stopReason: 'end_turn', turnCount: 3},
	});

	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, WEBHOOK);
	const embed = embedOf(requests[0]);
	assert.equal(embed.title, '✅ Finished');
	assert.match(embed.description, /stopped: end_turn · 3 turn\(s\)/);
	assert.match(embed.description, /All done, tests pass\./);
	assert.equal(embed.color, 0x57f287);
	assert.match(embed.footer.text, /my-app/);
});

test('run_end escapes backticks so the final text cannot break the code block', (t) => {
	const {fake, requests} = withWebhook(t);
	fake.emit('run_end', {
		result: {finalText: 'fence:\n```\ncode\n```\nend', stopReason: 'end_turn', turnCount: 1},
	});

	const description = embedOf(requests[0]).description;
	// Strip the outer fence we added; what remains must not contain a closing fence.
	const inner = description.slice(description.indexOf('```') + 3, description.lastIndexOf('\n```'));
	assert.ok(!inner.includes('```'), 'inner fences should be neutralised');
	assert.match(description, /'''/);
});

test('run_end truncates a very long final message', (t) => {
	const {fake, requests} = withWebhook(t);
	fake.emit('run_end', {
		result: {finalText: 'x'.repeat(5000), stopReason: 'end_turn', turnCount: 1},
	});

	const description = embedOf(requests[0]).description;
	assert.ok(description.length <= 4096, `description too long: ${description.length}`);
	assert.match(description, /…/);
});

test('run_end tolerates a result missing its fields', (t) => {
	const {fake, requests} = withWebhook(t);
	fake.emit('run_end', {});

	assert.equal(requests.length, 1);
	assert.match(embedOf(requests[0]).description, /stopped: unknown/);
	assert.match(embedOf(requests[0]).description, /_No final message\._/);
});

test('run_error includes the error message', (t) => {
	const {fake, requests} = withWebhook(t);
	fake.emit('run_error', {error: new Error('rate limit exceeded')});

	assert.equal(requests.length, 1);
	assert.equal(embedOf(requests[0]).title, '❌ Run failed');
	assert.match(embedOf(requests[0]).description, /rate limit exceeded/);
	assert.equal(embedOf(requests[0]).color, 0xed4245);
});

test('quiet mode suppresses finished and failed pings but not needs-you', (t) => {
	const {fake, requests} = withWebhook(t, {'discord-quiet': true});
	fake.emit('run_end', {result: {finalText: 'done', stopReason: 'end_turn', turnCount: 1}});
	fake.emit('run_error', {error: new Error('boom')});
	assert.equal(requests.length, 0, 'quiet mode should not ping on completion');

	fake.emit('message_end', {content: [{type: 'tool_use', name: 'ask_user_question', input: {}}]});
	assert.equal(requests.length, 1, 'quiet mode must still ping when blocked on you');
});

// ---------------------------------------------------------------------------
// Needs-you detection
// ---------------------------------------------------------------------------

test('an ask_user_question tool_use triggers a needs-you ping with the question text', (t) => {
	const {fake, requests} = withWebhook(t);
	fake.emit('message_end', {
		content: [
			{type: 'text', text: 'thinking'},
			{type: 'tool_use', name: 'ask_user_question', input: {questions: [{question: 'Tabs or spaces?'}]}},
		],
	});

	assert.equal(requests.length, 1);
	assert.equal(embedOf(requests[0]).title, '🙋 Needs you');
	assert.match(embedOf(requests[0]).description, /Tabs or spaces\?/);
});

test('an ask_user_question with several questions notes how many more there are', (t) => {
	const {fake, requests} = withWebhook(t);
	fake.emit('message_end', {
		content: [
			{
				type: 'tool_use',
				name: 'ask_user_question',
				input: {questions: [{question: 'First?'}, {question: 'Second?'}, {question: 'Third?'}]},
			},
		],
	});

	assert.match(embedOf(requests[0]).description, /First\? \(\+2 more\)/);
});

test('an ask_user_question falling back to the generic message still pings', (t) => {
	const {fake, requests} = withWebhook(t);
	// No usable questions array — must not throw, and must still get your attention.
	fake.emit('message_end', {content: [{type: 'tool_use', name: 'ask_user_question', input: {}}]});

	assert.equal(requests.length, 1);
	assert.match(embedOf(requests[0]).description, /waiting on your input/);
});

for (const [tool, expected] of [
	['enter_plan_mode', /plan is waiting for your approval/i],
	['exit_plan_mode', /plan is waiting for your approval/i],
	['plan_review', /plan is ready for review/i],
] as const) {
	test(`a ${tool} tool_use triggers a needs-you ping`, (t) => {
		const {fake, requests} = withWebhook(t);
		fake.emit('message_end', {content: [{type: 'tool_use', name: tool, input: {}}]});

		assert.equal(requests.length, 1);
		assert.match(embedOf(requests[0]).description, expected);
	});
}

test('two different needs-you pings in quick succession both land', (t) => {
	useFakeTimers(t);
	const {fake, requests} = withWebhook(t);

	// The debounce must be per notification, not per category — a question arriving right
	// after a plan approval must not be swallowed.
	fake.emit('message_end', {
		content: [{type: 'tool_use', name: 'ask_user_question', input: {questions: [{question: 'Pick one?'}]}}],
	});
	fake.emit('message_end', {content: [{type: 'tool_use', name: 'plan_review', input: {}}]});

	assert.equal(requests.length, 2);
	assert.equal(embedOf(requests[0]).title, '🙋 Needs you');
	assert.equal(embedOf(requests[1]).title, '🙋 Needs you');
	assert.match(embedOf(requests[1]).description, /ready for review/);
});

test('an ordinary tool_use does not trigger a ping', (t) => {
	const {fake, requests} = withWebhook(t);
	fake.emit('message_end', {content: [{type: 'tool_use', name: 'read_file', input: {}}]});
	fake.emit('message_end', {content: [{type: 'text', text: 'no tools here'}]});
	fake.emit('message_end', {});

	assert.equal(requests.length, 0);
});

// ---------------------------------------------------------------------------
// Approval prompts (a queued tool that never starts)
// ---------------------------------------------------------------------------

test('a queued tool unanswered for 5s pings, and not before', (t) => {
	useFakeTimers(t);
	const {fake, requests} = withWebhook(t);

	fake.emit('tool_queued', {toolCallId: 'c1', toolName: 'shell_command'});
	assert.equal(requests.length, 0, 'should not ping immediately');

	t.mock.timers.tick(4999);
	assert.equal(requests.length, 0, 'should still be quiet just before the window');

	t.mock.timers.tick(1);
	assert.equal(requests.length, 1);
	assert.equal(embedOf(requests[0]).title, '🔐 Waiting for approval');
	assert.match(embedOf(requests[0]).description, /shell_command/);
});

test('a queued tool that starts promptly never pings you', (t) => {
	useFakeTimers(t);
	const {fake, requests} = withWebhook(t);

	fake.emit('tool_queued', {toolCallId: 'c1', toolName: 'shell_command'});
	t.mock.timers.tick(500);
	fake.emit('tool_running', {toolCallId: 'c1'});
	t.mock.timers.tick(60000);

	assert.equal(requests.length, 0);
});

test('a denied queued tool never pings you', (t) => {
	useFakeTimers(t);
	const {fake, requests} = withWebhook(t);

	fake.emit('tool_queued', {toolCallId: 'c1', toolName: 'write_file'});
	t.mock.timers.tick(500);
	fake.emit('tool_denied', {toolCallId: 'c1'});
	t.mock.timers.tick(60000);

	assert.equal(requests.length, 0);
});

test('an interrupt cancels every pending approval ping', (t) => {
	useFakeTimers(t);
	const {fake, requests} = withWebhook(t);

	fake.emit('tool_queued', {toolCallId: 'c1', toolName: 'shell_command'});
	fake.emit('tool_queued', {toolCallId: 'c2', toolName: 'write_file'});
	fake.emit('interrupted');
	t.mock.timers.tick(60000);

	assert.equal(requests.length, 0);
});

test('queued tools are ignored in modes that never prompt', (t) => {
	useFakeTimers(t);
	const {fake, requests} = withWebhook(t);

	for (const mode of ['bypass', 'dont-ask']) {
		fake.emit('permission_mode_changed', {mode});
		fake.emit('tool_queued', {toolCallId: `c-${mode}`, toolName: 'shell_command'});
	}
	t.mock.timers.tick(60000);

	assert.equal(requests.length, 0);
});

test('user-blocking tools are not also given a pending timer', (t) => {
	useFakeTimers(t);
	const {fake, requests} = withWebhook(t);

	// message_end owns these, so the queued path must stay quiet or you'd be pinged twice.
	fake.emit('tool_queued', {toolCallId: 'c1', toolName: 'ask_user_question'});
	t.mock.timers.tick(60000);

	assert.equal(requests.length, 0);
});

// ---------------------------------------------------------------------------
// Mention handling
// ---------------------------------------------------------------------------

test('a bare numeric mention is normalised and guarded with allowed_mentions', (t) => {
	const {fake, requests} = withWebhook(t, {'discord-mention': '123456789012345678'});
	fake.emit('run_end', {result: {finalText: 'ok', stopReason: 'end_turn', turnCount: 1}});

	assert.equal(requests[0].payload.content, '<@123456789012345678>');
	assert.deepEqual(requests[0].payload.allowed_mentions, {parse: ['users', 'roles', 'everyone']});
});

test('an already-formatted mention is passed through unchanged', (t) => {
	const {fake, requests} = withWebhook(t, {'discord-mention': '  @here  '});
	fake.emit('run_end', {result: {finalText: 'ok', stopReason: 'end_turn', turnCount: 1}});

	assert.equal(requests[0].payload.content, '@here');
});

test('no mention means no content field and no allowed_mentions', (t) => {
	const {fake, requests} = withWebhook(t);
	fake.emit('run_end', {result: {finalText: 'ok', stopReason: 'end_turn', turnCount: 1}});

	assert.ok(!('content' in requests[0].payload));
	assert.ok(!('allowed_mentions' in requests[0].payload));
});

// ---------------------------------------------------------------------------
// Delivery robustness
// ---------------------------------------------------------------------------

test('with no webhook configured nothing is sent and nothing throws', (t) => {
	const fake = makeFakeCmd();
	createMod(fake.cmd);
	const requests = stubFetch(t);

	assert.doesNotThrow(() => {
		fake.emit('run_end', {result: {finalText: 'ok', stopReason: 'end_turn', turnCount: 1}});
		fake.emit('run_error', {error: new Error('boom')});
	});
	assert.equal(requests.length, 0);
	assert.equal(fake.notices.length, 1, 'should warn once, not once per event');
	assert.match(fake.notices[0], /no webhook/);
});

test('identical pings inside the debounce window collapse into one', (t) => {
	useFakeTimers(t);
	const {fake, requests} = withWebhook(t);

	fake.emit('run_error', {error: new Error('same failure')});
	assert.equal(requests.length, 1);
	fake.emit('run_error', {error: new Error('same failure')});
	assert.equal(requests.length, 1, 'the identical repeat should be collapsed');

	t.mock.timers.tick(2001);
	fake.emit('run_error', {error: new Error('same failure')});
	assert.equal(requests.length, 2, 'after the window it may send again');
});

test('distinct failures inside the window are both reported', (t) => {
	useFakeTimers(t);
	const {fake, requests} = withWebhook(t);

	fake.emit('run_error', {error: new Error('first problem')});
	fake.emit('run_error', {error: new Error('second problem')});

	assert.equal(requests.length, 2, 'different errors are different information');
});

test('a non-ok webhook response is recorded without throwing', async (t) => {
	const {fake, commands} = withWebhook(t, {}, {ok: false, status: 401});

	assert.doesNotThrow(() => {
		fake.emit('run_end', {result: {finalText: 'ok', stopReason: 'end_turn', turnCount: 1}});
	});
	await settle();

	assert.match(commands.get('notify-status')!().message, /last send: ✗ HTTP 401/);
});

test('a network failure is swallowed so it cannot stall the agent loop', async (t) => {
	const {fake} = withWebhook(t);
	globalThis.fetch = (async () => {
		throw new Error('ECONNREFUSED');
	}) as any;

	assert.doesNotThrow(() => {
		fake.emit('run_end', {result: {finalText: 'ok', stopReason: 'end_turn', turnCount: 1}});
	});
	await settle();

	assert.equal(fake.notices.length, 0, 'a delivery failure should not interrupt the session');
});

// ---------------------------------------------------------------------------
// verbose gating
// ---------------------------------------------------------------------------

test('subagent and session pings stay quiet unless verbose is on', (t) => {
	const {fake, requests} = withWebhook(t);
	fake.emit('subagent_start', {subagentType: 'explore'});
	fake.emit('subagent_stop', {subagentType: 'explore', tokensUsed: 1200});
	fake.emit('session_start', {source: 'startup'});
	fake.emit('session_shutdown', {reason: 'shutdown'});

	assert.equal(requests.length, 0);
});

test('verbose mode reports each subagent and session event separately', (t) => {
	useFakeTimers(t);
	const {fake, requests} = withWebhook(t, {'discord-verbose': true});
	// All of these are "info", so they must not cancel each other out via the debounce.
	fake.emit('subagent_stop', {subagentType: 'explore', tokensUsed: 1200});
	fake.emit('session_start', {source: 'startup'});

	assert.equal(requests.length, 2);
	assert.match(embedOf(requests[0]).description, /explore.*1200 tokens/);
	assert.equal(embedOf(requests[1]).title, '▶️ Session started');
});

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

// The config path is baked in at import time, so each case imports a fresh instance with
// HOME pointed at its own throwaway directory.
async function importWithConfig(content: string | undefined): Promise<{createMod: ModFactory; home: string}> {
	const home = mkdtempSync(join(tmpdir(), 'discord-notify-config-'));
	if (content !== undefined) {
		mkdirSync(join(home, '.commandcode'), {recursive: true});
		writeFileSync(join(home, '.commandcode', 'discord-notify.json'), content);
	}
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	try {
		const mod = await import(`../discord-notify.ts?home=${encodeURIComponent(home)}`);
		return {createMod: mod.default as ModFactory, home};
	} finally {
		process.env.HOME = previousHome;
	}
}

test('reads webhook, mention and quiet out of the config file', async (t) => {
	const {createMod: freshMod, home} = await importWithConfig(
		JSON.stringify({webhook: 'http://file.test/hook', mention: '999', quiet: true}),
	);
	t.after(() => rmSync(home, {recursive: true, force: true}));

	const fake = makeFakeCmd();
	freshMod(fake.cmd);
	const requests = stubFetch(t);

	fake.emit('run_end', {result: {finalText: 'ok', stopReason: 'end_turn', turnCount: 1}});
	assert.equal(requests.length, 0, 'quiet from the file should suppress completion pings');

	fake.emit('message_end', {content: [{type: 'tool_use', name: 'ask_user_question', input: {}}]});
	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, 'http://file.test/hook');
	assert.equal(requests[0].payload.content, '<@999>');
});

test('the env var beats the config file, and a flag beats both', async (t) => {
	const {createMod: freshMod, home} = await importWithConfig(
		JSON.stringify({webhook: 'http://file.test/hook'}),
	);
	t.after(() => rmSync(home, {recursive: true, force: true}));

	const previousEnv = process.env.COMMANDCODE_DISCORD_WEBHOOK;
	process.env.COMMANDCODE_DISCORD_WEBHOOK = 'http://env.test/hook';
	t.after(() => {
		if (previousEnv === undefined) delete process.env.COMMANDCODE_DISCORD_WEBHOOK;
		else process.env.COMMANDCODE_DISCORD_WEBHOOK = previousEnv;
	});

	const requests = stubFetch(t);
	const result = {result: {finalText: 'ok', stopReason: 'end_turn', turnCount: 1}};

	const viaEnv = makeFakeCmd();
	freshMod(viaEnv.cmd);
	viaEnv.emit('run_end', result);
	assert.equal(requests[0].url, 'http://env.test/hook', 'env should beat the file');

	const viaFlag = makeFakeCmd({flags: {'discord-webhook': 'http://flag.test/hook'}});
	freshMod(viaFlag.cmd);
	viaFlag.emit('run_end', result);
	assert.equal(requests[1].url, 'http://flag.test/hook', 'flag should beat the env');
});

test('a malformed config file is treated as unconfigured, not a crash', async (t) => {
	const {createMod: freshMod, home} = await importWithConfig('{ not valid json');
	t.after(() => rmSync(home, {recursive: true, force: true}));

	const fake = makeFakeCmd();
	freshMod(fake.cmd);
	const requests = stubFetch(t);

	assert.doesNotThrow(() => {
		fake.emit('run_end', {result: {finalText: 'ok', stopReason: 'end_turn', turnCount: 1}});
	});
	assert.equal(requests.length, 0);
});

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

test('notify-test sends a labelled test ping', async (t) => {
	const {commands, requests, notices} = withWebhook(t);

	const result = commands.get('notify-test')!();
	assert.match(result.message, /Sending a test notification/);
	await settle();

	assert.equal(requests.length, 1);
	assert.equal(embedOf(requests[0]).title, '👋 Test notification');
	assert.match(notices.at(-1), /test delivered ✓/);
});

test('notify-test bypasses the debounce so it always actually sends', (t) => {
	useFakeTimers(t);
	const {commands, requests} = withWebhook(t);

	commands.get('notify-test')!();
	assert.equal(requests.length, 1);
	commands.get('notify-test')!();
	assert.equal(requests.length, 2, 'a repeated test should not be swallowed');
});

test('notify-test explains what to do when unconfigured', (t) => {
	const fake = makeFakeCmd();
	createMod(fake.cmd);
	stubFetch(t);

	const result = fake.commands.get('notify-test')!();
	assert.match(result.message, /No webhook configured/);
	assert.match(result.message, /discord-notify\.json/);
});

test('notify-status reports an unconfigured mod without throwing', (t) => {
	const fake = makeFakeCmd();
	createMod(fake.cmd);
	stubFetch(t);

	const status = fake.commands.get('notify-status')!().message;
	assert.match(status, /webhook: NOT configured \(none\)/);
	assert.match(status, /last send: nothing sent yet/);
});
