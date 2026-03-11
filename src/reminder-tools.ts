import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";

import {
  addQQBotReminder,
  listQQBotReminders,
  removeQQBotReminder,
  type QQBotReminderCreateInput,
  type QQBotReminderTarget,
} from "./cron-actions.js";

export type QQBotReminderToolContext = {
  config?: Record<string, unknown>;
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
};

type ReminderTargetParams = {
  reminderTarget?: string;
  reminderAccountId?: string;
  accountId?: string;
};

function normalizeQQBotTarget(target: string): string | undefined {
  const id = target.replace(/^qqbot:/i, "");
  const canonicalizeId = (rawId: string): string => {
    if (/^[0-9a-fA-F]{32}$/.test(rawId)) {
      return rawId.toUpperCase();
    }
    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(rawId)) {
      return rawId.toUpperCase();
    }
    return rawId;
  };

  if (id.startsWith("c2c:") || id.startsWith("group:") || id.startsWith("channel:")) {
    const [kind, rawId] = id.split(/:(.+)/, 2);
    return rawId ? `qqbot:${kind}:${canonicalizeId(rawId)}` : undefined;
  }

  const openIdHexPattern = /^[0-9a-fA-F]{32}$/;
  if (openIdHexPattern.test(id)) {
    return `qqbot:c2c:${canonicalizeId(id)}`;
  }

  const openIdUuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (openIdUuidPattern.test(id)) {
    return `qqbot:c2c:${canonicalizeId(id)}`;
  }

  return undefined;
}

function deriveQQBotTargetFromSessionKey(sessionKey?: string): string | undefined {
  const raw = sessionKey?.trim();
  if (!raw) {
    return undefined;
  }

  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 5 || parts[0] !== "agent") {
    return undefined;
  }

  const qqbotIndex = parts.findIndex((part) => part.toLowerCase() === "qqbot");
  if (qqbotIndex === -1 || qqbotIndex + 2 >= parts.length) {
    return undefined;
  }

  const next = parts[qqbotIndex + 1]?.toLowerCase();
  const nextNext = parts[qqbotIndex + 2]?.toLowerCase();
  let kind = next;
  let idIndex = qqbotIndex + 2;

  if (kind !== "direct" && kind !== "group" && kind !== "channel") {
    kind = nextNext;
    idIndex = qqbotIndex + 3;
  }

  const peerId = parts[idIndex];
  if (!kind || !peerId) {
    return undefined;
  }

  if (kind === "direct") {
    return `qqbot:c2c:${peerId}`;
  }
  if (kind === "group") {
    return `qqbot:group:${peerId}`;
  }
  if (kind === "channel") {
    return `qqbot:channel:${peerId}`;
  }
  return undefined;
}

function resolveReminderAccountId(params: ReminderTargetParams, ctx: QQBotReminderToolContext): string | undefined {
  const explicitReminderAccountId = params.reminderAccountId?.trim();
  const explicitAccountId = params.accountId?.trim();

  if (explicitReminderAccountId && explicitAccountId && explicitReminderAccountId !== explicitAccountId) {
    throw new Error("Use only one of reminderAccountId or accountId for QQBot reminders");
  }

  return explicitReminderAccountId || explicitAccountId || ctx.agentAccountId;
}

function resolveReminderTarget(params: ReminderTargetParams, ctx: QQBotReminderToolContext): QQBotReminderTarget {
  const rawTo = params.reminderTarget?.trim() || deriveQQBotTargetFromSessionKey(ctx.sessionKey) || "";
  if (!rawTo) {
    throw new Error("QQBot reminder tools default to the current chat. If session metadata is unavailable, provide reminderTarget.");
  }

  const to = normalizeQQBotTarget(rawTo);
  if (!to) {
    throw new Error("reminderTarget must be a valid QQBot target such as qqbot:c2c:OPENID or qqbot:group:GROUPID");
  }

  const resolvedAccountId = resolveReminderAccountId(params, ctx);

  return {
    to,
    ...(resolvedAccountId ? { accountId: resolvedAccountId } : {}),
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
  };
}

function ensureSingleSchedule(params: {
  atMs?: number;
  delayMs?: number;
  delayMinutes?: number;
  cronExpr?: string;
}): QQBotReminderCreateInput["schedule"] {
  const scheduleKinds = [
    params.atMs !== undefined ? "atMs" : null,
    params.delayMs !== undefined ? "delayMs" : null,
    params.delayMinutes !== undefined ? "delayMinutes" : null,
    params.cronExpr?.trim() ? "cronExpr" : null,
  ].filter(Boolean);

  if (scheduleKinds.length !== 1) {
    throw new Error("qqbot_schedule_reminder requires exactly one schedule: atMs, delayMs, delayMinutes, or cronExpr");
  }

  if (params.cronExpr?.trim()) {
    return {
      kind: "cron",
      expr: params.cronExpr.trim(),
    };
  }

  return {
    kind: "at",
    atMs: params.atMs ?? Date.now() + (params.delayMs ?? Math.round((params.delayMinutes ?? 0) * 60_000)),
  };
}

const ScheduleReminderParamsSchema = Type.Object({
  message: Type.String({ minLength: 1, description: "Reminder text to send back to QQ." }),
  delayMinutes: Type.Optional(Type.Number({ minimum: 0, description: "Delay in minutes before sending the reminder." })),
  delayMs: Type.Optional(Type.Number({ minimum: 0, description: "Delay in milliseconds before sending the reminder." })),
  atMs: Type.Optional(Type.Number({ minimum: 0, description: "Absolute Unix timestamp in milliseconds." })),
  cronExpr: Type.Optional(Type.String({ minLength: 1, description: "Cron expression for recurring reminders." })),
  timezone: Type.Optional(Type.String({ minLength: 1, description: "Timezone for cronExpr, e.g. Asia/Shanghai." })),
  name: Type.Optional(Type.String({ minLength: 1, description: "Optional reminder name." })),
  deleteAfterRun: Type.Optional(Type.Boolean({ description: "Whether to delete the job after the first run." })),
  reminderTarget: Type.Optional(Type.String({ minLength: 1, description: "Optional QQBot target override. Omit to use the current chat." })),
  reminderAccountId: Type.Optional(Type.String({ minLength: 1, description: "Optional QQBot account id override for cross-account reminders." })),
  accountId: Type.Optional(Type.String({ minLength: 1, description: "Alias of reminderAccountId." })),
}, { additionalProperties: false });

const ListRemindersParamsSchema = Type.Object({
  includeDisabled: Type.Optional(Type.Boolean({ description: "Include disabled reminders in the result." })),
  reminderTarget: Type.Optional(Type.String({ minLength: 1, description: "Optional QQBot target override. Omit to use the current chat." })),
  reminderAccountId: Type.Optional(Type.String({ minLength: 1, description: "Optional QQBot account id override for cross-account reminders." })),
  accountId: Type.Optional(Type.String({ minLength: 1, description: "Alias of reminderAccountId." })),
}, { additionalProperties: false });

const RemoveReminderParamsSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, description: "Reminder id to remove." })),
  name: Type.Optional(Type.String({ minLength: 1, description: "Reminder name to remove when id is unavailable." })),
  reminderTarget: Type.Optional(Type.String({ minLength: 1, description: "Optional QQBot target override. Omit to use the current chat." })),
  reminderAccountId: Type.Optional(Type.String({ minLength: 1, description: "Optional QQBot account id override for cross-account reminders." })),
  accountId: Type.Optional(Type.String({ minLength: 1, description: "Alias of reminderAccountId." })),
}, { additionalProperties: false });

type ScheduleReminderParams = Static<typeof ScheduleReminderParamsSchema>;
type ListRemindersParams = Static<typeof ListRemindersParamsSchema>;
type RemoveReminderParams = Static<typeof RemoveReminderParamsSchema>;

export function buildQQBotReminderTools(ctx: QQBotReminderToolContext): AgentTool<any>[] {
  const isQQBotSession = ctx.messageChannel === "qqbot" || ctx.sessionKey?.includes(":qqbot:");
  if (!isQQBotSession || !ctx.config) {
    return [];
  }

  const scheduleReminderTool: AgentTool<typeof ScheduleReminderParamsSchema> = {
      name: "qqbot_schedule_reminder",
      label: "QQBot Schedule Reminder",
      description: "Schedule a QQBot reminder for the current chat or an optional reminderTarget.",
      parameters: ScheduleReminderParamsSchema,
      execute: async (_toolCallId, params: ScheduleReminderParams) => {
        const target = resolveReminderTarget(params, ctx);
        const schedule = ensureSingleSchedule(params);
        const input: QQBotReminderCreateInput = {
          ...target,
          message: params.message.trim(),
          schedule: schedule.kind === "cron" && params.timezone?.trim()
            ? { kind: "cron", expr: schedule.expr, timezone: params.timezone.trim() }
            : schedule,
          ...(params.name?.trim() ? { name: params.name.trim() } : {}),
          ...(params.deleteAfterRun !== undefined ? { deleteAfterRun: params.deleteAfterRun } : {}),
        };

        const reminder = await addQQBotReminder(ctx.config as Record<string, unknown>, input);
        const whenText = reminder.nextRunAtMs
          ? new Date(reminder.nextRunAtMs).toLocaleString("zh-CN", { hour12: false })
          : "已创建";
        return {
          content: [{ type: "text", text: `Scheduled QQBot reminder "${reminder.name}" for ${whenText}.` }],
          details: {
            status: "success",
            tool: "qqbot_schedule_reminder",
            id: reminder.id,
            name: reminder.name,
            to: reminder.to ?? target.to,
            nextRunAtMs: reminder.nextRunAtMs ?? null,
          },
        };
      },
    };

  const listRemindersTool: AgentTool<typeof ListRemindersParamsSchema> = {
      name: "qqbot_list_reminders",
      label: "QQBot List Reminders",
      description: "List QQBot reminders for the current chat or an optional reminderTarget.",
      parameters: ListRemindersParamsSchema,
      execute: async (_toolCallId, params: ListRemindersParams) => {
        const target = resolveReminderTarget(params, ctx);
        const reminders = await listQQBotReminders(
          ctx.config as Record<string, unknown>,
          target,
          params.includeDisabled ?? false,
        );
        const lines = reminders.length === 0
          ? ["No QQBot reminders found for this target."]
          : reminders.map((job, index) => {
              const next = job.nextRunAtMs ? new Date(job.nextRunAtMs).toLocaleString("zh-CN", { hour12: false }) : "n/a";
              const lastRun = job.lastRunAtMs ? new Date(job.lastRunAtMs).toLocaleString("zh-CN", { hour12: false }) : "n/a";
              const lastStatus = job.lastRunStatus ?? "unknown";
              const status = job.enabled ? "enabled" : "disabled";
              return `${index + 1}. ${job.name} [${job.id}] (${status}, next: ${next}, last: ${lastRun}, lastStatus: ${lastStatus})`;
            });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            status: "success",
            tool: "qqbot_list_reminders",
            count: reminders.length,
            to: target.to,
            reminders,
          },
        };
      },
    };

  const removeReminderTool: AgentTool<typeof RemoveReminderParamsSchema> = {
      name: "qqbot_remove_reminder",
      label: "QQBot Remove Reminder",
      description: "Remove a QQBot reminder by id or name for the current chat or an optional reminderTarget.",
      parameters: RemoveReminderParamsSchema,
      execute: async (_toolCallId, params: RemoveReminderParams) => {
        if (!params.id?.trim() && !params.name?.trim()) {
          throw new Error("qqbot_remove_reminder requires either id or name");
        }

        const target = resolveReminderTarget(params, ctx);
        const removed = await removeQQBotReminder(ctx.config as Record<string, unknown>, target, {
          ...(params.id?.trim() ? { id: params.id.trim() } : {}),
          ...(params.name?.trim() ? { name: params.name.trim() } : {}),
        });

        return {
          content: [{ type: "text", text: `Removed QQBot reminder "${removed.name}" (${removed.id}).` }],
          details: {
            status: "success",
            tool: "qqbot_remove_reminder",
            id: removed.id,
            name: removed.name,
            to: target.to,
          },
        };
      },
    };

  return [scheduleReminderTool, listRemindersTool, removeReminderTool];
}
