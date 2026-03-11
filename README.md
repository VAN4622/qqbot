# QQBot for OpenClaw

QQBot is an OpenClaw channel plugin for the official QQ Bot API.

This repository is a fork of the upstream project. Upstream remains the original source and deserves full credit. This README documents the behavior of this codebase, because its runtime behavior and tool surface no longer match the upstream README.

## What this fork changes

- supports multi-account QQBot routing
- supports account-scoped `STT`, `TTS`, and IM-style reply settings
- removes the old prompt-heavy QQ rule injection from normal message bodies
- stops treating markdown and code blocks as hidden media instructions
- replaces brittle inline media parsing with explicit tool-based sends
- replaces QQ-specific reminder payload strings with standalone reminder tools
- sends text and media through the real `message` tool
- treats markdown as display text instead of an execution protocol

## Install

### Install from source

```bash
git clone <your-fork-url>
cd qqbot
openclaw plugins install .
```

### Install from npm

```bash
openclaw plugins install @van1024/qqbot@latest
```

### Install from a tarball

```bash
npm pack
openclaw plugins install ./van1024-qqbot-1.5.5.tgz
```

For offline or remote deployment, a `.tgz` package is usually the safest release artifact.

## Configuration

Use the standard multi-account layout under `channels.qqbot.accounts`.

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "stt": {
        "provider": "YOUR_STT_PROVIDER",
        "model": "YOUR_STT_MODEL"
      },
      "accounts": {
        "default": {
          "enabled": true,
          "allowFrom": ["*"],
          "appId": "YOUR_DEFAULT_APP_ID",
          "clientSecret": "YOUR_DEFAULT_CLIENT_SECRET"
        },
        "bot_b": {
          "enabled": true,
          "allowFrom": ["*"],
          "appId": "YOUR_SECONDARY_APP_ID",
          "clientSecret": "YOUR_SECONDARY_CLIENT_SECRET"
        }
      }
    }
  }
}
```

Notes:

- `accounts.default` is the default QQBot account
- additional accounts live under `accounts.<accountId>`
- top-level `channels.qqbot` holds shared defaults

## Bindings

Route different QQBot accounts to different agents through OpenClaw bindings.

```json
{
  "bindings": [
    {
      "agentId": "main",
      "match": {
        "channel": "qqbot",
        "accountId": "default"
      }
    },
    {
      "agentId": "agent-b",
      "match": {
        "channel": "qqbot",
        "accountId": "bot_b"
      }
    }
  ]
}
```

The example names here are generic on purpose. They are not special runtime identifiers.

## STT and TTS

### STT priority

1. `channels.qqbot.accounts.<accountId>.stt`
2. `channels.qqbot.stt`
3. `tools.media.audio.models[0]`

### TTS priority

1. `channels.qqbot.accounts.<accountId>.tts`
2. `channels.qqbot.tts`
3. `messages.tts`

Example:

```json
{
  "channels": {
    "qqbot": {
      "accounts": {
        "default": {
          "appId": "YOUR_DEFAULT_APP_ID",
          "clientSecret": "YOUR_DEFAULT_CLIENT_SECRET",
          "tts": {
            "provider": "YOUR_TTS_PROVIDER",
            "baseUrl": "YOUR_TTS_BASE_URL",
            "apiKey": "YOUR_TTS_API_KEY",
            "model": "YOUR_TTS_MODEL",
            "voice": "YOUR_DEFAULT_TTS_VOICE"
          }
        },
        "bot_b": {
          "appId": "YOUR_SECONDARY_APP_ID",
          "clientSecret": "YOUR_SECONDARY_CLIENT_SECRET",
          "tts": {
            "provider": "YOUR_TTS_PROVIDER",
            "baseUrl": "YOUR_TTS_BASE_URL",
            "apiKey": "YOUR_TTS_API_KEY",
            "model": "YOUR_TTS_MODEL",
            "voice": "YOUR_SECONDARY_TTS_VOICE"
          }
        }
      }
    }
  }
}
```

## Sending messages and media

Use the real `message` tool.

Supported actions:

- `send`
- `sendMessage`

Supported patterns:

- plain text message
- image, file, video, or local audio path through `media`
- TTS voice message through `message + asVoice=true`
- existing local audio file sent as a QQ voice message through `media + asVoice=true`

Examples:

```json
{"action":"send","to":"qqbot:c2c:OPENID","message":"Hello from QQBot."}
```

```json
{"action":"send","to":"qqbot:c2c:OPENID","message":"Here is the image.","media":"C:/tmp/pic.png"}
```

```json
{"action":"send","to":"qqbot:c2c:OPENID","message":"I will reply by voice now.","asVoice":true}
```

```json
{"action":"send","to":"qqbot:c2c:OPENID","media":"C:/tmp/reply.mp3","asVoice":true}
```

Note:

- do not use the generic `tts` tool for QQ delivery
- QQBot media delivery is expected to go through `message`

## Reminder tools

Use the standalone reminder tools:

- `qqbot_schedule_reminder`
- `qqbot_list_reminders`
- `qqbot_remove_reminder`

One-shot reminder:

```json
{
  "message": "Remind the user to drink water.",
  "delayMinutes": 30
}
```

Recurring reminder:

```json
{
  "message": "Remind the user to check in.",
  "cronExpr": "0 8 * * *",
  "timezone": "Asia/Shanghai"
}
```

By default, reminder tools operate on the current QQ session.

Use `reminderTarget` only when managing a different QQ conversation.
Use `reminderAccountId` when that target belongs to a different QQBot account.

```json
{
  "message": "Remind the user to review this thread.",
  "delayMinutes": 1,
  "reminderTarget": "qqbot:c2c:USER_OPENID",
  "reminderAccountId": "bot_b"
}
```

## Cross-agent reminder workflow

If one agent needs to manage reminders for another agent's QQ session:

1. Use the system `sessions_list` tool first.
2. Resolve the target QQ session.
3. Pass `reminderTarget` and, if needed, `reminderAccountId`.

If `sessions_list` cannot see other agents' sessions, the host usually needs:

```json
{
  "tools": {
    "profile": "full",
    "sessions": {
      "visibility": "all"
    },
    "agentToAgent": {
      "enabled": true,
      "allow": ["agent-b"]
    }
  }
}
```

## IM-style replies

This fork can split longer passive plain-text replies into shorter IM-style messages.

Priority:

1. `channels.qqbot.accounts.<accountId>.imStyleReply`
2. `channels.qqbot.imStyleReply`

Supported fields:

- `enabled`
- `minLength`
- `maxParts`
- `targetPartLength`
- `maxPartLength`
- `delayMs`
- `delayMinMs`
- `delayMaxMs`

Example:

```json
{
  "channels": {
    "qqbot": {
      "accounts": {
        "bot_b": {
          "appId": "YOUR_SECONDARY_APP_ID",
          "clientSecret": "YOUR_SECONDARY_CLIENT_SECRET",
          "imStyleReply": {
            "enabled": true,
            "minLength": 18,
            "maxParts": 4,
            "targetPartLength": 28,
            "maxPartLength": 64,
            "delayMinMs": 500,
            "delayMaxMs": 1100
          }
        }
      }
    }
  }
}
```

Structured markdown is left intact.

## Limitations

- reminder delivery is outbound and does not automatically hydrate the original session transcript
- `qqbot_list_reminders` can report `lastRunAtMs` and `lastRunStatus` only while the underlying job still exists
- one-shot reminders deleted immediately after execution may no longer appear in later listings
- QQ platform-side delivery limits still apply

## Troubleshooting

### Messages are not arriving

```bash
openclaw gateway stop
openclaw gateway run --verbose
```

Common causes:

- `invalid appid or secret`
- missing QQ platform permissions
- the account never reaches `READY`
- an old package is deployed instead of the latest build of this fork

### `clientSecret` became `"__OPENCLAW_REDACTED__"`

If the literal value on disk is `"__OPENCLAW_REDACTED__"`, the credential was overwritten and must be restored manually.

## License

This fork continues to use the upstream [MIT License](LICENSE).
