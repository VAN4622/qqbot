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
这是视频：
<qqvideo>https://example.com/video.mp4</qqvideo>
```

```text
这是文件：
<qqfile>/tmp/report.pdf</qqfile>
```
