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
| 🙋 **Needs you** | The agent calls `ask_user_question`, or presents a plan for approval. These panels are TUI-side and fire no tool events, so they're detected via the finished message's `tool_use` block. Includes the question text. |
| 🔐 **Waiting for approval** | A tool sat queued for 5s without starting — i.e. an approval modal is up. Approve quickly and you're never pinged. |
| ✅ **Finished** | A run ends. Carries the stop reason, turn count, and the final message. |
| ❌ **Run failed** | A non-retryable run error. |
| 🤖▶️⏹ *info* | Sub-agent start/stop and session start/end, only with `verbose`. |

Delivery is debounced (at most one ping per cause per 2s) and fire-and-forget, so a slow
or failing webhook can never stall the agent loop.

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

## Credits

The event-detection logic is adapted from
[`cmd-mod-completion-bell`](https://github.com/timuela/commandcode-mods) (MIT, ©
timuela1997), which established which Command Code events indicate the agent is blocked
awaiting a human — the non-obvious part of this problem. This project keeps that mapping
and replaces its local WAV playback with a Discord webhook so the ping reaches your phone.
See [LICENSE](./LICENSE).
