# discord-notify

A [Command Code](https://commandcode.ai/docs/mods) mod that pings your phone on Discord
when the agent needs you — or when it finishes and you're away from the machine.

## Install

```bash
cmd mods add -g gosukiwi/cmd-mod-discord-notify
```

`-g` installs it user-wide, so it loads in every project — drop it to scope the mod to the
current project instead. `cmd mods update` refreshes it after a new commit or tag.

To try it without installing anything, load the file straight from a checkout:

```bash
cmd --mod ./discord-notify.ts
```

Either way, restart Command Code or run `/reload`, then [configure](#configure) your webhook.

## Configure

Everything lives in `~/.commandcode/discord-notify.json`; create it with the template below:

```json
{
  "webhook": "https://discord.com/api/webhooks/...",
  "mention": "123456789012345678",
  "quiet": false,
  "verbose": false,
  "enabled": true
}
```

| Field | Required | What it does |
|---|---|---|
| `webhook` | yes | Discord webhook URL. Channel → Integrations → Webhooks → New Webhook. |
| `mention` | effectively yes | Your Discord user id. Bare digits are fine — they're normalized to `<@id>`. |
| `quiet` | no | `true` = only ping when the agent is blocked on you, no "finished" pings. |
| `verbose` | no | `true` = also ping on sub-agent activity and session start/end. |
| `enabled` | no | `false` mutes everything. Absent means on. |

**Why `mention` matters:** Discord's default channel notification setting is *"Only
@mentions"*, and a webhook mentions nobody — so without it the POST succeeds but your
phone stays silent. Either set this field, or set the channel's notification level to
*All Messages*.

Get your user id: Discord → Settings → Advanced → **Developer Mode** on → right-click
your avatar → *Copy User ID*.

The config file is re-read when it changes, so you can edit it and re-test without
restarting.

## Commands

| Command | What it does |
|---|---|
| `/notify-test` | Send a test ping so you can confirm it reaches your phone. |
| `/notify-status` | Show the current config, the mute state, and the last delivery result. |
| `/notify-disable` | Mute notifications until you turn them back on. |
| `/notify-enable` | Unmute. |

Muting is written to the config file, so it survives restarts and applies to every project —
it is not just for the current session. While muted, delivery is skipped entirely, including
the "could not be delivered" warning: being told about a notification you asked not to
receive would be noise.

## What triggers a ping

| Ping | When |
|---|---|
| 🙋 **Needs your input** | The agent calls `ask_user_question`, or presents a plan for approval. These panels are TUI-side and fire no tool events, so they're detected via the finished message's `tool_use` block. Includes the question text. |
| 🔐 **Waiting for your approval** | A tool sat queued for 5s without starting — i.e. an approval modal is up. Says what the tool is about to do (the command, or the file it will write). Approve quickly and you're never pinged. |
| ✅ **Finished** | A run ends. Shows how long it took, how it ended in plain words, how many tool calls it made, and the final message. |
| ❌ **Run failed** | A non-retryable run error, with the error text. |
| 🤖▶️⏹ *info* | Sub-agent start/stop and session start/end, only with `verbose`. |

Stop reasons are translated rather than passed through — you get *"Stopped — you denied a
permission request"* instead of `permission_denied`.

Pings also quote back what you asked for, in a `You asked` field. That comes from the typed
input seam, so it appears in interactive sessions but **not** in `cmd -p` runs, where the
prompt arrives on the command line instead. The field is simply omitted when there's
nothing captured.

Delivery is fire-and-forget, so a slow or failing webhook can never stall the agent loop.
Byte-identical notifications arriving within 2s of each other are collapsed into one;
anything genuinely different is always delivered, so two distinct "needs you" events in
quick succession both reach you.

## Uninstall

```bash
cmd mods remove discord-notify
```

That removes the mod; your config is deliberately left alone (it holds your webhook URL).
Delete it too with:

```bash
rm ~/.commandcode/discord-notify.json
```

## Notes

- Sends only to the webhook you configure. The webhook is treated as a secret: it's never
  logged and never sent to the model.
- A failed delivery is reported once per outage — not once per notification — naming the
  reason (`HTTP 401`, `fetch failed (ECONNREFUSED)`, `timed out`). It appears as a feed row
  in the TUI, or on **stderr** under `cmd -p`, where `cmd.ui.notify` prints nothing.
  `/notify-status` shows the last outcome.
- After editing `discord-notify.ts`, run `/reload` — or iterate with `cmd --mod ./discord-notify.ts`.

## Tests

```bash
npm test
```

Zero dependencies — the suite runs on Node's built-in test runner, driving the real mod
factory against a fake `ModApi` with `fetch` stubbed. Nothing touches the network, and the
tests redirect `$HOME` to a throwaway directory so they can never read your real config or
fire at your real webhook. Requires Node 24+, which imports the TypeScript source directly
via native type stripping.
