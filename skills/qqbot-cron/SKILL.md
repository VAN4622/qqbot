---
name: qqbot-cron
description: QQBot 定时提醒技能。通过 QQ 通道处理提醒、定时任务、周期通知时使用。
metadata: {"openclaw":{"emoji":"⏰","requires":{"config":["channels.qqbot"]}}}
---

# QQBot Cron

当用户要创建、查询、取消提醒时，使用 QQBot 的正式 reminder 工具：

- `qqbot_schedule_reminder`
- `qqbot_list_reminders`
- `qqbot_remove_reminder`

不要把提醒信息编码进消息正文，也不要尝试输出任何 QQBot 私有协议字符串。

## 常见动作

- 创建一次性提醒：调用 `qqbot_schedule_reminder`，并提供 `delayMinutes` / `delayMs` / `atMs`
- 创建周期提醒：调用 `qqbot_schedule_reminder`，并提供 `cronExpr`
- 查询提醒：调用 `qqbot_list_reminders`
- 删除提醒：调用 `qqbot_remove_reminder`

## 必需字段

- 创建提醒时，把提醒正文放进 `message`
- `qqbot_schedule_reminder` 必须且只能提供一种时间方式：
  - `atMs`
  - `delayMs`
  - `delayMinutes`
  - `cronExpr`

- 周期提醒可选 `timezone`
- `qqbot_remove_reminder` 优先用 `id`；拿不到 `id` 时再用 `name`

## 会话规则

- 默认 agent 下，QQBot reminder 会写回当前会话上下文
- 非默认 agent 下，QQBot reminder 会自动切到隔离任务，并把结果投递回当前 QQ 会话
- 不要传 `target` 或 `to`
- 默认直接使用当前会话的 `sessionKey`
- 只有明确要为另一个 QQ 会话建提醒时，才传：
  - `reminderSessionKey`
  - 可选 `reminderTarget`
  - 可选 `reminderAccountId`
  - 可选 `reminderAgentId`
- `reminderTarget` 仅支持私聊格式：`qqbot:c2c:<openid>`

## 最小示例

调用 `qqbot_schedule_reminder` 创建一次性提醒：

```json
{
  "message": "提醒用户喝水。",
  "delayMinutes": 30
}
```

调用 `qqbot_schedule_reminder` 创建周期提醒：

```json
{
  "message": "提醒用户打卡。",
  "cronExpr": "0 8 * * *",
  "timezone": "Asia/Shanghai"
}
```

跨账号 / 跨 Agent 示例：

```json
{
  "message": "提醒用户回看这个会话。",
  "delayMinutes": 1,
  "reminderSessionKey": "agent:assistant-b:qqbot:direct:USER_OPENID",
  "reminderTarget": "qqbot:c2c:USER_OPENID",
  "reminderAccountId": "secondary",
  "reminderAgentId": "assistant-b"
}
```

## 跨 Agent 会话

- 如果用户要“给另一个 Agent / 另一个会话设置提醒”，先使用系统的 `sessions_list` 工具查目标会话
- 只有拿到目标会话对应的 `sessionKey` 后，才去调用 QQBot reminder 工具
- 跨 Agent 场景下，通常要同时传：
  - `reminderSessionKey`
  - `reminderTarget`
  - `reminderAccountId`
  - `reminderAgentId`

如果 `sessions_list` 看不到其他 Agent 的会话，通常不是 QQBot reminder 工具的问题，而是宿主权限没开。常见原因是下面两项没有开启：

```json
{
  "tools": {
    "profile": "full",
    "sessions": {
      "visibility": "all"
    },
    "agentToAgent": {
      "enabled": true,
      "allow": ["assistant-b"]
    }
  }
}
```

- `tools.sessions.visibility = "all"`：允许看到其他会话
- `tools.agentToAgent.enabled = true`：允许 Agent 间访问
- `tools.agentToAgent.allow`：允许访问的目标 Agent 列表

如果这些没开，就不要假设自己能看到其他 Agent 的会话，也不要编造会话 ID。

## 回复风格

- 创建成功后，简短确认即可。
- 查询时，优先带上最近一次执行时间和执行状态。
- 删除成功后，明确说明已取消。
