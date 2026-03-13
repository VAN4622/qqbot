---
name: qqbot-media
description: Use the real QQBot message tool for images, voice, video, and files.
metadata: {"openclaw":{"emoji":"📨","requires":{"config":["channels.qqbot"]}}}
---

# QQBot Media

When the current channel is `qqbot`, use the `message` tool instead of emitting any inline protocol.

## Rules

- Use `message` with `action=send`.
- Use `message` for normal text replies.
- Use `media` for image, video, audio-file, or document sends.
- Remote image/video URLs are valid media inputs. If a URL does not end with a normal file extension, QQBot will still try to identify it from the remote `content-type`.
- Use `asVoice=true` with `message` text when you want QQBot TTS voice output.
- Never call the generic `tts` tool directly for QQBot delivery; it only generates audio and will not send it into the QQ conversation.
- Never output legacy inline media markup or raw protocol payload text.

## Examples

Send an image:

```json
{"action":"send","to":"qqbot:c2c:OPENID","message":"这是图片","media":"C:/tmp/pic.png"}
```

Send a remote image URL:

```json
{"action":"send","to":"qqbot:c2c:OPENID","message":"这是远程图片","media":"https://example.com/download?id=123"}
```

Send a file:

```json
{"action":"send","to":"qqbot:c2c:OPENID","message":"这是文件","media":"C:/tmp/report.pdf"}
```

Send a local audio file as voice:

```json
{"action":"send","to":"qqbot:c2c:OPENID","media":"C:/tmp/reply.mp3","asVoice":true}
```

Send TTS voice from text:

```json
{"action":"send","to":"qqbot:c2c:OPENID","message":"好的，我现在用语音回复你。","asVoice":true}
```
