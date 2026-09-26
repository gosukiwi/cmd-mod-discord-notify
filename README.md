# discord-notify

A [Command Code](https://commandcode.ai/docs/mods) mod that pings your phone on Discord
when the agent needs you — or when it finishes and you're away from the machine.

## Install

```bash
bin/install
```

This copies the mod to `~/.commandcode/mods/` (so it loads in every project) and writes a
config template if you don't already have one. Restart Command Code, or run `/reload`.

## Configure

Everything lives in `~/.commandcode/discord-notify.json`:

```json
{
  "webhook": "https://discord.com/api/webhooks/...",
  "mention": "123456789012345678",
  "quiet": false,
  "verbose": false
}
```

| Field | Required | What it does |
|---|---|---|
| `webhook` | yes | Discord webhook URL. Channel → Integrations → Webhooks → New Webhook. |
| `mention` | effectively yes | Your Discord user id. Bare digits are fine — they're normalized to `<@id>`. |
| `quiet` | no | `true` = only ping when the agent is blocked on you, no "finished" pings. |
| `verbose` | no | `true` = also ping on sub-agent activity and session start/end. |

**Why `mention` matters:** Discord's default channel notification setting is *"Only
@mentions"*, and a webhook mentions nobody — so without it the POST succeeds but your
phone stays silent. Either set this field, or set the channel's notification level to
*All Messages*.

Get your user id: Discord → Settings → Advanced → **Developer Mode** on → right-click
your avatar → *Copy User ID*.

The config file is re-read when it changes, so you can edit it and re-test without
restarting. Verify with `/notify-status` and `/notify-test` in a session.

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
bin/uninstall           # remove the mod, keep your config
bin/uninstall --purge   # also delete the config (it holds your webhook URL)
```

## Notes

- Sends only to the webhook you configure. The webhook is treated as a secret: it's never
  logged and never sent to the model.
- `COMMANDCODE_MODS_DIR` overrides the install destination for both scripts.
- After editing `discord-notify.ts`, re-run `bin/install` and `/reload`.

## Tests

```bash
npm test
```

Zero dependencies — the suite runs on Node's built-in test runner, driving the real mod
factory against a fake `ModApi` with `fetch` stubbed. Nothing touches the network, and the
tests redirect `$HOME` to a throwaway directory so they can never read your real config or
fire at your real webhook. Requires Node 24+, which imports the TypeScript source directly
via native type stripping.
