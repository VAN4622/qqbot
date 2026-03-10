# QQ Bot Media Guide

这份文档只讲当前 fork 里真实生效的富媒体发送规则，不讲宣传示例。

## 总则

QQBot 的富媒体发送有两条主路径：

1. 直接发送已有文件或 URL
2. 用 `QQBOT_PAYLOAD` 触发结构化媒体发送

模型如果写错协议，插件不会再把整段内部协议文本直接发给用户。

## 直接发送已有媒体

### 图片

```text
<qqimg>/absolute/path/or/url</qqimg>
```

### 语音

```text
<qqvoice>/absolute/path</qqvoice>
```

用于“已经有一个本地音频文件”的情况。

### 视频

```text
<qqvideo>/absolute/path/or/url</qqvideo>
```

### 文件

```text
<qqfile>/absolute/path/or/url</qqfile>
```

## 用插件内建 TTS 发送语音

如果没有现成音频文件，而是要把一段文本直接变成语音，使用：

```text
QQBOT_PAYLOAD:
{
  "type": "media",
  "mediaType": "audio",
  "source": "file",
  "path": "请把这段文本转成语音发送。"
}
```

### 严格要求

- 整条回复必须只包含这一段 payload
- `QQBOT_PAYLOAD:` 必须在第一行
- 前面不能加解释文字
- 后面不能再跟额外文本

下面这种是错的：

```text
好，我来发送语音。

QQBOT_PAYLOAD:
{
  "type": "media",
  "mediaType": "audio",
  "source": "file",
  "path": "这会失败。"
}
```

下面这种也是错的：

```text
QQBOT_PAYLOAD:
{
  "type": "media",
  "mediaType": "audio",
  "source": "file",
  "path": "这也会失败。"
}
额外文本
```

## 图片、视频、文件的结构化载荷

### 图片

```text
QQBOT_PAYLOAD:
{
  "type": "media",
  "mediaType": "image",
  "source": "file",
  "path": "/absolute/path/to/image.png",
  "caption": "可选说明文字"
}
```

### 视频

```text
QQBOT_PAYLOAD:
{
  "type": "media",
  "mediaType": "video",
  "source": "file",
  "path": "/absolute/path/to/video.mp4",
  "caption": "可选说明文字"
}
```

### 文件

```text
QQBOT_PAYLOAD:
{
  "type": "media",
  "mediaType": "file",
  "source": "file",
  "path": "/absolute/path/to/report.pdf"
}
```

## STT 与 TTS 的区别

### STT

- 由插件自动做
- 用户发语音后，插件先转写
- 模型看到的是转写结果
- 模型不需要自己调用 STT

### TTS

- 由模型主动选择发送路径
- 有现成音频文件时，用 `<qqvoice>`
- 只有文本时，用 `QQBOT_PAYLOAD` 的 `mediaType: "audio"`

## 发送失败时的行为

当前 fork 做了这些保护：

- `QQBOT_PAYLOAD` 放错位置时，拦截并记日志
- `QQBOT_PAYLOAD` JSON 解析失败时，拦截并记日志
- 不再把内部协议错误原样发给用户

真正的媒体业务错误，例如：

- 文件不存在
- 上传失败
- TTS 失败

仍然会按业务错误路径处理。

## IM 风格短句连发与富媒体

IM 风格短句连发只作用于纯文本被动回复。

这些内容不会被拆：

- `<qqimg>`
- `<qqvoice>`
- `<qqvideo>`
- `<qqfile>`
- `QQBOT_PAYLOAD`

也就是说，语音、图片、视频、文件本体不会因为 IM 风格配置被切坏。
