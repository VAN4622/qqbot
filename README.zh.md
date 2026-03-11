# QQBot for OpenClaw

QQBot 是一个接入 QQ 官方 Bot API 的 OpenClaw channel 插件。

这个仓库是上游项目的 fork。上游仍然是原始来源，理应获得完整尊重与署名。之所以单独写这份 README，是因为这套代码的运行行为和工具接口已经和上游文档不再一致。

## 这版的变化

- 支持多 QQBot 账号路由
- 支持账号级 `STT`、`TTS`、IM 风格回复配置
- 去掉了源项目里塞进普通消息正文的大段手搓 QQ 规则提示词
- markdown 和代码块里的内容不再被当成隐式媒体协议执行
- 富媒体发送不再依赖从普通回复里硬解析内联协议
- 富媒体发送改成正式工具链路
- 定时提醒改成独立 reminder 工具，不再依赖 QQ 私有 payload 字符串
- 文本和媒体统一通过 `message` 工具发送
- markdown 只负责展示，不再承担执行协议职责

## 安装

### 从源码安装

```bash
git clone <your-fork-url>
cd qqbot
openclaw plugins install .
```

### 从 npm 安装

```bash
openclaw plugins install @van1024/qqbot@latest
```

### 从打包产物安装

```bash
npm pack
openclaw plugins install ./van1024-qqbot-1.5.5.tgz
```

如果是离线或远程部署，`.tgz` 通常是最稳妥的发布物。

## 配置结构

当前推荐使用 `channels.qqbot.accounts` 这一套标准多账号结构。

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

说明：

- `accounts.default` 是默认 QQBot 账号
- 其他账号放在 `accounts.<accountId>`
- 顶层 `channels.qqbot` 存放共享默认配置

## 绑定到 Agent

可以通过 OpenClaw 的 `bindings` 把不同 QQBot 账号路由到不同 Agent。

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

这里使用的是通用示例名，不代表任何特殊运行时含义。

## STT 与 TTS

### STT 优先级

1. `channels.qqbot.accounts.<accountId>.stt`
2. `channels.qqbot.stt`
3. `tools.media.audio.models[0]`

### TTS 优先级

1. `channels.qqbot.accounts.<accountId>.tts`
2. `channels.qqbot.tts`
3. `messages.tts`

示例：

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

## 发送消息与媒体

请使用正式 `message` 工具。

可用 action：

- `send`
- `sendMessage`

支持的模式：

- 纯文本消息
- 通过 `media` 发送图片、文件、视频或本地音频
- 通过 `message + asVoice=true` 发送 TTS 语音
- 通过 `media + asVoice=true` 把已有本地音频文件按 QQ 语音消息发送

示例：

```json
{"action":"send","to":"qqbot:c2c:OPENID","message":"你好，这是一条 QQBot 消息。"}
```

```json
{"action":"send","to":"qqbot:c2c:OPENID","message":"这是图片。","media":"C:/tmp/pic.png"}
```

```json
{"action":"send","to":"qqbot:c2c:OPENID","message":"我现在用语音回复你。","asVoice":true}
```

```json
{"action":"send","to":"qqbot:c2c:OPENID","media":"C:/tmp/reply.mp3","asVoice":true}
```

注意：

- 不要在 QQBot 场景直接调用通用 `tts`
- QQBot 媒体发送应统一通过 `message` 完成

## Reminder 工具

请使用独立 reminder 工具：

- `qqbot_schedule_reminder`
- `qqbot_list_reminders`
- `qqbot_remove_reminder`

一次性提醒：

```json
{
  "message": "30 分钟后提醒用户喝水。",
  "delayMinutes": 30
}
```

周期提醒：

```json
{
  "message": "每天提醒用户打卡。",
  "cronExpr": "0 8 * * *",
  "timezone": "Asia/Shanghai"
}
```

默认情况下，这些工具直接作用于当前 QQ 会话。

只有在管理其他 QQ 会话时，才传：

- `reminderTarget`

如果目标属于另一个 QQBot 账号，再传：

- `reminderAccountId`

```json
{
  "message": "1 分钟后提醒用户回看这个会话。",
  "delayMinutes": 1,
  "reminderTarget": "qqbot:c2c:USER_OPENID",
  "reminderAccountId": "bot_b"
}
```

## 跨 Agent 提醒流程

如果一个 Agent 要管理另一个 Agent 绑定的 QQ 会话提醒：

1. 先使用系统 `sessions_list`
2. 定位目标 QQ 会话
3. 再传 `reminderTarget`
4. 如有需要，再传 `reminderAccountId`

如果 `sessions_list` 看不到其他 Agent 的会话，宿主通常需要这样的配置：

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

## IM 风格回复

这个 fork 可以把较长的被动纯文本回复拆成更短的 IM 风格消息。

优先级：

1. `channels.qqbot.accounts.<accountId>.imStyleReply`
2. `channels.qqbot.imStyleReply`

支持字段：

- `enabled`
- `minLength`
- `maxParts`
- `targetPartLength`
- `maxPartLength`
- `delayMs`
- `delayMinMs`
- `delayMaxMs`

示例：

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

结构化 markdown 会保持原样，不做拆分。

## 已知限制

- reminder 投递属于外发动作，不会自动回流到原始会话 transcript
- `qqbot_list_reminders` 只有在底层任务仍存在时，才能返回 `lastRunAtMs` 和 `lastRunStatus`
- 一次性提醒如果执行后立即删除，后续查询里可能看不到执行痕迹
- QQ 平台侧发送限制依然存在

## 故障排查

### 收不到消息

```bash
openclaw gateway stop
openclaw gateway run --verbose
```

常见原因：

- `invalid appid or secret`
- QQ 平台权限缺失
- 账号没有进入 `READY`
- 部署的是旧包，不是这个 fork 的最新构建

### `clientSecret` 变成了 `"__OPENCLAW_REDACTED__"`

如果磁盘上的字面值真的是 `"__OPENCLAW_REDACTED__"`，说明凭证被覆盖了，需要手工恢复真实密钥。

## License

本 fork 继续沿用上游的 [MIT License](LICENSE)。
