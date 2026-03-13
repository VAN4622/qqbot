# QQBot for OpenClaw

QQBot is an OpenClaw plugin for the official QQ Bot API.

This version focuses on QQ direct-message (C2C) workflows and includes:

- multi-account routing
- image, file, video, and voice delivery
- text-to-speech voice replies
- reminder tools
- IM-style short-message replies

## Install

```bash
openclaw plugins install @van1024/qqbot@latest
```

To update an installed plugin:

```bash
openclaw plugins update qqbot
openclaw gateway restart
```

## Configuration

Minimal example:

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "accounts": {
        "default": {
          "enabled": true,
          "allowFrom": ["*"],
          "appId": "YOUR_APP_ID",
          "clientSecret": "YOUR_CLIENT_SECRET"
        }
      }
    }
  }
}
```

For multiple accounts, place them under `channels.qqbot.accounts.<accountId>` and route them with OpenClaw `bindings`.

## Sending Messages

Use the real `message` tool:

- text: `action=send`
- image/file/video: `media`
- TTS voice reply: `message + asVoice=true`
- local audio as QQ voice message: `media + asVoice=true`
- remote image/video URLs are sent as rich media when possible; URLs without a normal file extension are also probed via remote `content-type`

Examples:

```json
{"action":"send","to":"qqbot:c2c:OPENID","message":"Hello."}
```

```json
{"action":"send","to":"qqbot:c2c:OPENID","message":"Here is the image.","media":"C:/tmp/pic.png"}
```

```json
{"action":"send","to":"qqbot:c2c:OPENID","message":"Here is a remote image.","media":"https://example.com/download?id=123"}
```

```json
{"action":"send","to":"qqbot:c2c:OPENID","message":"I will reply by voice now.","asVoice":true}
```

## Reminder Tools

Available tools:

- `qqbot_schedule_reminder`
- `qqbot_list_reminders`
- `qqbot_remove_reminder`

One-shot reminder:

```json
{
  "message": "Remind the user to drink water in 30 minutes.",
  "delayMinutes": 30
}
```

Recurring reminder:

```json
{
  "message": "Remind the user to check in every morning.",
  "cronExpr": "0 8 * * *",
  "timezone": "Asia/Shanghai"
}
```

By default, reminders target the current QQ chat.

- default agent: the reminder wakes the originating chat context
- non-default agent: the reminder automatically falls back to an isolated cron job and delivers back into the current QQ chat

## Notes

- this version supports QQ direct messages only
- legacy inline media markup and private payload strings are no longer supported
- markdown is treated as display text only
- immediate outbound messages are discrete sends; there is no single-message native streaming update

## License

[MIT](LICENSE)
