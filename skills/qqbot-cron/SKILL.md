---
name: qqbot-cron
description: QQBot 定时提醒技能。通过 QQ 通道处理提醒、定时任务、周期通知时使用。
metadata: {"openclaw":{"emoji":"⏰","requires":{"config":["channels.qqbot"]}}}
---

# QQBot Cron

当用户要创建、查询、取消提醒时，使用 `cron` 工具。

## 常见动作

- 创建一次性提醒：`action: "add"` + `schedule.kind: "at"`
- 创建周期提醒：`action: "add"` + `schedule.kind: "cron"`
- 查询提醒：`action: "list"`
- 删除提醒：`action: "remove"`

## QQ 投递必需字段

当提醒需要真正发回 QQ 时，`job.payload` 至少要包含：

```json
{
  "kind": "agentTurn",
  "deliver": true,
  "channel": "qqbot",
  "to": "qqbot:c2c:openid-or-group-target"
}
```

同时建议：

- `sessionTarget: "isolated"`
- 一次性提醒加 `deleteAfterRun: true`
- 周期提醒写明时区，例如 `"tz": "Asia/Shanghai"`

## 时间规则

- `schedule.kind: "at"` 时，`atMs` 必须是绝对毫秒时间戳。
- `schedule.kind: "cron"` 时，提供标准 cron 表达式；需要时附带时区。

## 目标格式

- 私聊：`qqbot:c2c:<openid>`
- 群聊：`qqbot:group:<group_openid>`
- 频道：`qqbot:channel:<channel_id>`

## 最小示例

一次性提醒：

```json
{
  "action": "add",
  "job": {
    "name": "喝水提醒",
    "schedule": { "kind": "at", "atMs": 1770734300000 },
    "sessionTarget": "isolated",
    "deleteAfterRun": true,
    "payload": {
      "kind": "agentTurn",
      "message": "提醒用户喝水。",
      "deliver": true,
      "channel": "qqbot",
      "to": "qqbot:c2c:USER_OPENID"
    }
  }
}
```

周期提醒：

```json
{
  "action": "add",
  "job": {
    "name": "打卡提醒",
    "schedule": { "kind": "cron", "expr": "0 8 * * *", "tz": "Asia/Shanghai" },
    "sessionTarget": "isolated",
    "payload": {
      "kind": "agentTurn",
      "message": "提醒用户打卡。",
      "deliver": true,
      "channel": "qqbot",
      "to": "qqbot:c2c:USER_OPENID"
    }
  }
}
```

## 回复风格

- 创建成功后，简短确认即可。
- 查询时，按结果列出提醒。
- 删除成功后，明确说明已取消。
