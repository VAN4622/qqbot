# QQBot for OpenClaw

QQBot 是一个面向 OpenClaw 的 QQ 官方 Bot API 插件。

当前版本专注于 QQ 私聊（C2C）场景，支持：

- 多账号路由
- 图片、文件、视频、语音发送
- 文本转语音与语音消息发送
- 定时提醒
- IM 风格短句回复

## 安装

```bash
openclaw plugins install @van1024/qqbot@latest
```

更新已安装版本：

```bash
openclaw plugins update qqbot
openclaw gateway restart
```

## 配置

最小配置示例：

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

多账号时，把其他账号放到 `channels.qqbot.accounts.<accountId>` 下，再通过 OpenClaw `bindings` 路由到不同 Agent。

## 发送消息

请使用正式 `message` 工具：

- 文本：`action=send`
- 图片/文件/视频：`media`
- TTS 语音：`message + asVoice=true`
- 本地音频转 QQ 语音消息：`media + asVoice=true`
- URL 图片 / 视频会优先按媒体发送；即使 URL 没有标准文件后缀，也会尝试根据远端 `content-type` 识别

示例：

```json
{"action":"send","to":"qqbot:c2c:OPENID","message":"你好。"}
```

```json
{"action":"send","to":"qqbot:c2c:OPENID","message":"这是图片。","media":"C:/tmp/pic.png"}
```

```json
{"action":"send","to":"qqbot:c2c:OPENID","message":"这是远程图片。","media":"https://example.com/download?id=123"}
```

```json
{"action":"send","to":"qqbot:c2c:OPENID","message":"我现在用语音回复你。","asVoice":true}
```

## Reminder 工具

可用工具：

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

默认情况下，提醒作用于当前 QQ 会话。

- 默认 agent：触发时回到原会话上下文
- 非默认 agent：自动切到隔离任务，并把结果投递回当前 QQ 会话

## 说明

- 当前版本只支持 QQ 私聊（C2C）
- 不再支持旧的内联富文本协议或私有 payload 字符串
- markdown 只作为展示文本，不再承担执行协议职责
- 即时消息是离散发送，不支持单条消息原生流式更新

## License

[MIT](LICENSE)
