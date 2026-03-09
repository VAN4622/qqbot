---
name: qqbot-media
description: QQBot 图片、语音、视频、文件收发。通过 QQ 通道通信且需要发送富媒体时使用。
metadata: {"openclaw":{"emoji":"📸","requires":{"config":["channels.qqbot"]}}}
---

# QQBot Media

当通过 `qqbot` 通道发送富媒体时，直接在回复文本中使用以下标签：

| 类型 | 标签格式 | 说明 |
| --- | --- | --- |
| 图片 | `<qqimg>路径或URL</qqimg>` | 本地绝对路径或公网 URL |
| 语音 | `<qqvoice>绝对路径</qqvoice>` | 本地音频文件 |
| 视频 | `<qqvideo>路径或URL</qqvideo>` | 本地绝对路径或公网 URL |
| 文件 | `<qqfile>路径或URL</qqfile>` | 非图片/非语音/非视频文件 |

## 最小规则

- 需要发送媒体时，把标签直接写进回复文本里。
- 本地文件优先使用绝对路径。
- 多个媒体就写多个标签。
- 标签外的普通文字会作为消息正文一起发送。
- 如果只是告诉用户文件路径，不要使用媒体标签。

## TTS 语音回复

- 有两种发送语音的方式：
  - 已有本地音频文件：直接使用 `<qqvoice>绝对路径</qqvoice>`
  - 需要把文本转成语音：使用 `QQBOT_PAYLOAD` 结构化载荷，让插件执行 TTS 并发送
- `<qqvoice>` 只用于已经存在的本地音频文件；不要在没有音频文件时凭空输出该标签。

### 直接触发插件 TTS

当用户要求“用语音回复”且你手上没有现成音频文件时，输出：

```text
QQBOT_PAYLOAD:
{
  "type": "media",
  "mediaType": "audio",
  "source": "file",
  "path": "请把这段文本转成语音并发送给用户"
}
```

- 使用 `QQBOT_PAYLOAD` 时，整条回复必须只包含这一段结构化载荷。
- `QQBOT_PAYLOAD:` 必须位于回复第一行。
- 载荷前后都不要添加任何解释、寒暄、确认语或额外文本。
- 违反以上格式时，插件不会按预期发送语音。
- `path` 字段里写要朗读的文本内容。
- 如果需要，也可以用 `caption` 作为更完整的朗读文本；插件会优先使用 `caption`，否则使用 `path`。
- 这种方式会由插件完成 TTS，并直接把生成的语音发送到 QQ。

## 例子

```text
这是图片：
<qqimg>/tmp/pic.png</qqimg>
```

```text
这是语音：
<qqvoice>/tmp/voice.mp3</qqvoice>
```

```text
好的，我用语音回复你：
<qqvoice>/tmp/tts/reply.mp3</qqvoice>
```

```text
QQBOT_PAYLOAD:
{
  "type": "media",
  "mediaType": "audio",
  "source": "file",
  "path": "好的，我用语音告诉你今天的安排。"
}
```

```text
这是视频：
<qqvideo>https://example.com/video.mp4</qqvideo>
```

```text
这是文件：
<qqfile>/tmp/report.pdf</qqfile>
```
