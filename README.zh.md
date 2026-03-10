# QQ Bot for OpenClaw

这个仓库是一个自维护 fork，用来把 QQ 官方 Bot API 接进 OpenClaw，并修正上游版本里一些和多账号、语音、上下文注入、发送体验相关的问题。

本文档描述的是**当前这个 fork 的实际行为**，不保证和上游 npm 发布版完全一致。

## 当前 fork 的主要改动

- 默认账号支持标准结构 `channels.qqbot.accounts.default`
- `STT/TTS` 支持账号级配置，优先级高于插件全局配置
- 去掉了每轮入站正文里那种大段手搓规则注入
- 精简了 QQ 媒体与 cron skill，降低上下文污染
- 增加了待回复历史的轻量持久化
- 增加了 IM 风格短句连发与随机节奏控制
- `QQBOT_PAYLOAD` 的格式要求和错误处理更严格，避免把内部协议文本直接发给用户

## 适用场景

这个插件适合：

- 用 QQ 私聊或群聊远程和 OpenClaw 交互
- 一个 OpenClaw 实例挂多个 QQ 机器人
- 不同机器人绑定不同 Agent
- 不同机器人使用不同 STT/TTS 配置
- 发送图片、语音、视频、文件

## 安装

### 方式 1：从你自己的 fork 或本地源码安装

```bash
git clone <your-fork-url>
cd qqbot
openclaw plugins install .
```

### 方式 2：本地打包后安装

```bash
npm pack
openclaw plugins install ./van4622-qqbot-1.5.4-van.1.tgz
```

如果你是把插件部署到远程服务器，建议用 `.tgz` 包部署。

### 方式 3：从 GitHub Release 安装

先下载你自己 fork 发布的 release 资产，再安装：

```bash
curl -L -o qqbot.tgz <your-release-asset-url>
openclaw plugins install ./qqbot.tgz
```

## 配置结构

当前 fork 推荐使用标准多账号结构：

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "stt": {
        "provider": "siliconflow",
        "model": "FunAudioLLM/SenseVoiceSmall"
      },
      "accounts": {
        "default": {
          "enabled": true,
          "allowFrom": ["*"],
          "appId": "1903058177",
          "clientSecret": "your-default-secret"
        },
        "huajin": {
          "enabled": true,
          "allowFrom": ["*"],
          "appId": "1903057687",
          "clientSecret": "your-huajin-secret"
        }
      }
    }
  }
}
```

说明：

- `accounts.default` 是默认账号
- 其他机器人放在 `accounts.<accountId>`
- 顶层 `channels.qqbot` 主要放插件全局默认配置

## 多账号绑定 Agent

典型绑定方式：

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
      "agentId": "huajin",
      "match": {
        "channel": "qqbot",
        "accountId": "huajin"
      }
    }
  ]
}
```

## 语音配置

### STT 优先级

1. `channels.qqbot.accounts.<accountId>.stt`
2. `channels.qqbot.stt`
3. `tools.media.audio.models[0]`

### TTS 优先级

1. `channels.qqbot.accounts.<accountId>.tts`
2. `channels.qqbot.tts`
3. `messages.tts`

### 示例

```json
{
  "channels": {
    "qqbot": {
      "stt": {
        "provider": "siliconflow",
        "model": "FunAudioLLM/SenseVoiceSmall"
      },
      "accounts": {
        "default": {
          "appId": "1903058177",
          "clientSecret": "secret-a",
          "tts": {
            "provider": "siliconflow",
            "baseUrl": "https://api.siliconflow.cn/v1",
            "apiKey": "key-a",
            "model": "FunAudioLLM/CosyVoice2-0.5B",
            "voice": "FunAudioLLM/CosyVoice2-0.5B:alex"
          }
        },
        "huajin": {
          "appId": "1903057687",
          "clientSecret": "secret-b",
          "tts": {
            "provider": "siliconflow",
            "baseUrl": "https://api.siliconflow.cn/v1",
            "apiKey": "key-b",
            "model": "FunAudioLLM/CosyVoice2-0.5B",
            "voice": "speech:huajin:example"
          }
        }
      }
    }
  }
}
```

## 富媒体发送规则

### 直接发送已有媒体

- 图片：`<qqimg>/absolute/path/or/url</qqimg>`
- 语音：`<qqvoice>/absolute/path</qqvoice>`
- 视频：`<qqvideo>/absolute/path/or/url</qqvideo>`
- 文件：`<qqfile>/absolute/path/or/url</qqfile>`

### 用插件内建 TTS 直接把文本变成语音

使用 `QQBOT_PAYLOAD`：

```text
QQBOT_PAYLOAD:
{
  "type": "media",
  "mediaType": "audio",
  "source": "file",
  "path": "这是一段需要转成语音发送的文本。"
}
```

注意：

- 整条回复必须只包含这一段 payload
- `QQBOT_PAYLOAD:` 必须在第一行
- 前后都不要加解释文字

详细规则见：[docs/qqbot-media-guide.md](docs/qqbot-media-guide.md)

## IM 风格短句连发

这个 fork 支持把较长的纯文本被动回复拆成多条短句发送。

### 优先级

1. `channels.qqbot.accounts.<accountId>.imStyleReply`
2. `channels.qqbot.imStyleReply`

### 支持字段

- `enabled`
- `minLength`
- `maxParts`
- `targetPartLength`
- `maxPartLength`
- `delayMs`
- `delayMinMs`
- `delayMaxMs`

如果同时配置了 `delayMs` 和 `delayMinMs/delayMaxMs`，优先使用区间延迟。

### 示例

```json
{
  "channels": {
    "qqbot": {
      "accounts": {
        "huajin": {
          "appId": "1903057687",
          "clientSecret": "secret-b",
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

说明：

- 只对纯文本被动回复生效
- `<qqimg>` / `<qqvoice>` / `<qqvideo>` / `<qqfile>` / `QQBOT_PAYLOAD` 不会被拆
- 代码块、列表、标题、引用等格式化内容不会启用该拆分

## 本地部署与远程使用

即使没有公网 IP，只要本地机器能主动连出：

- QQ Bot 网关
- 你配置的模型 / STT / TTS 服务

那么 QQ 侧仍然可以远程操作这台本地 OpenClaw。

这不等于你可以直接从公网访问 Control UI。Control UI 仍然需要：

- SSH 隧道
- Tailscale / ZeroTier
- 反向代理 / 内网穿透

## 已知行为

- `STT` 是插件自动处理的，模型拿到的是转写后的结果
- `TTS` 是模型主动选择的发送方式，需要它输出 `<qqvoice>` 或 `QQBOT_PAYLOAD`
- `QQBOT_PAYLOAD` 如果格式错误，当前 fork 会拦截并记日志，不再把内部协议错误直接发给用户
- 被动回复存在平台侧次数限制，插件当前按单条 `message_id` 维护回复计数

## 故障排查

### 账号显示已配置，但收不到消息

先看前台日志：

```bash
openclaw gateway stop
openclaw gateway run --verbose
```

常见原因：

- `invalid appid or secret`
- QQ 平台权限不完整
- 该账号没有真正走到 `READY`

### `clientSecret` 变成了 `"__OPENCLAW_REDACTED__"`

如果配置文件磁盘里真的被写成这个字面值，那它不是“显示脱敏”，而是凭证已经被错误覆盖，需要手工改回真实密钥。

### IM 风格配置不生效

确认你部署的是这个 fork 的最新打包版本，而不是更早的 `.tgz`。

## License

本 fork 继续沿用上游的 [MIT License](LICENSE)。

请保留原许可证和版权声明。
