import { getQQBotRuntime } from "./runtime.js";

type JsonRecord = Record<string, unknown>;

export type QQBotReminderTarget = {
  to: string;
  accountId?: string;
  agentId?: string;
  sessionKey?: string;
};

export type QQBotReminderSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "cron"; expr: string; timezone?: string };

export type QQBotReminderCreateInput = QQBotReminderTarget & {
  name?: string;
  message: string;
  schedule: QQBotReminderSchedule;
  deleteAfterRun?: boolean;
};

export type QQBotReminderSummary = {
  id: string;
  name: string;
  enabled: boolean;
  to?: string;
  accountId?: string;
  scheduleKind?: string;
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: string;
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function parseCliJson(stdout: string, stderr: string, commandLabel: string): JsonRecord {
  const raw = stdout.trim();
  if (!raw) {
    throw new Error(`${commandLabel} returned empty output${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    if (!record) {
      throw new Error("CLI did not return a JSON object");
    }
    return record;
  } catch (error) {
    const suffix = stderr.trim() ? ` stderr=${stderr.trim()}` : "";
    throw new Error(`${commandLabel} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}${suffix}`);
  }
}

async function runCronCli(args: string[]): Promise<JsonRecord> {
  const runtime = getQQBotRuntime() as unknown as {
    system: {
      runCommandWithTimeout: (argv: string[], options: { timeoutMs: number }) => Promise<{
        stdout: string;
        stderr: string;
        code: number | null;
      }>;
    };
  };
  const result = await runtime.system.runCommandWithTimeout(
    ["openclaw", "cron", ...args, "--json"],
    { timeoutMs: 30000 },
  );

  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code ?? "unknown"}`;
    throw new Error(`openclaw cron ${args[0]} failed: ${detail}`);
  }

  return parseCliJson(result.stdout, result.stderr, `openclaw cron ${args[0]}`);
}

function buildDefaultReminderName(message: string): string {
  const head = message.slice(0, 24).trim();
  return `QQBot提醒 ${head || "未命名"}`;
}

function buildReminderTargetArgs(target: QQBotReminderTarget): string[] {
  const args = ["--channel", "qqbot", "--to", target.to];
  if (target.accountId) {
    args.push("--account", target.accountId);
  }
  return args;
}

function readReminderSummary(job: unknown): QQBotReminderSummary | null {
  const record = asRecord(job);
  if (!record) {
    return null;
  }

  const payload = asRecord(record.payload);
  const delivery = asRecord(record.delivery);
  const state = asRecord(record.state);
  const schedule = asRecord(record.schedule);

  const to = typeof delivery?.to === "string"
    ? delivery.to
    : typeof payload?.to === "string"
      ? payload.to
      : undefined;
  const channel = typeof delivery?.channel === "string"
    ? delivery.channel
    : typeof payload?.channel === "string"
      ? payload.channel
      : undefined;

  if (channel !== "qqbot" || !to) {
    return null;
  }

  return {
    id: typeof record.id === "string" ? record.id : "",
    name: typeof record.name === "string" ? record.name : "QQBot提醒",
    enabled: record.enabled !== false,
    to,
    accountId: typeof delivery?.accountId === "string" ? delivery.accountId : undefined,
    scheduleKind: typeof schedule?.kind === "string" ? schedule.kind : undefined,
    nextRunAtMs: typeof state?.nextRunAtMs === "number" ? state.nextRunAtMs : undefined,
    lastRunAtMs: typeof state?.lastRunAtMs === "number"
      ? state.lastRunAtMs
      : typeof record.lastRunAtMs === "number"
        ? record.lastRunAtMs
        : undefined,
    lastRunStatus: typeof state?.lastRunStatus === "string"
      ? state.lastRunStatus
      : typeof state?.lastStatus === "string"
        ? state.lastStatus
        : typeof record.lastRunStatus === "string"
          ? record.lastRunStatus
          : typeof record.lastStatus === "string"
            ? record.lastStatus
            : undefined,
  };
}

function matchesReminderTarget(job: QQBotReminderSummary, target: QQBotReminderTarget): boolean {
  if (job.to?.toLowerCase() !== target.to.toLowerCase()) {
    return false;
  }
  if (target.accountId) {
    return job.accountId === target.accountId;
  }
  return true;
}

export async function addQQBotReminder(_cfg: Record<string, unknown>, input: QQBotReminderCreateInput): Promise<QQBotReminderSummary> {
  const args = [
    "add",
    "--name",
    input.name?.trim() || buildDefaultReminderName(input.message),
    "--message",
    input.message,
    "--session",
    "isolated",
    "--wake",
    "now",
    "--announce",
    ...buildReminderTargetArgs(input),
  ];

  if (input.agentId) {
    args.push("--agent", input.agentId);
  }
  if (input.sessionKey) {
    args.push("--session-key", input.sessionKey);
  }

  const deleteAfterRun = input.schedule.kind === "at"
    ? input.deleteAfterRun ?? true
    : input.deleteAfterRun ?? false;
  args.push(deleteAfterRun ? "--delete-after-run" : "--keep-after-run");

  if (input.schedule.kind === "at") {
    args.push("--at", new Date(input.schedule.atMs).toISOString());
  } else {
    args.push("--cron", input.schedule.expr);
    if (input.schedule.timezone) {
      args.push("--tz", input.schedule.timezone);
    }
  }

  const result = await runCronCli(args);
  const summary = readReminderSummary(result);
  if (!summary) {
    throw new Error("openclaw cron add returned a non-QQBot job");
  }
  return summary;
}

export async function listQQBotReminders(
  _cfg: Record<string, unknown>,
  target: QQBotReminderTarget,
  includeDisabled = false,
): Promise<QQBotReminderSummary[]> {
  const result = await runCronCli(["list", ...(includeDisabled ? ["--all"] : [])]);
  const jobs = Array.isArray(result.jobs) ? result.jobs : [];
  return jobs
    .map((job) => readReminderSummary(job))
    .filter((job): job is QQBotReminderSummary => Boolean(job))
    .filter((job) => matchesReminderTarget(job, target));
}

export async function removeQQBotReminder(
  cfg: Record<string, unknown>,
  target: QQBotReminderTarget,
  selector: { id?: string; name?: string },
): Promise<{ id: string; name: string }> {
  let jobId = selector.id?.trim() || "";
  let jobName = selector.name?.trim() || "";

  if (!jobId) {
    if (!jobName) {
      throw new Error("removeReminder requires either id or name");
    }
    const jobs = await listQQBotReminders(cfg, target, true);
    const exact = jobs.filter((job) => job.name === jobName);
    const partial = exact.length > 0 ? exact : jobs.filter((job) => job.name.includes(jobName));
    if (partial.length === 0) {
      throw new Error(`No QQBot reminder matched "${jobName}"`);
    }
    if (partial.length > 1) {
      throw new Error(`Multiple QQBot reminders matched "${jobName}", please remove by id`);
    }
    jobId = partial[0]!.id;
    jobName = partial[0]!.name;
  } else {
    const jobs = await listQQBotReminders(cfg, target, true);
    const matched = jobs.find((job) => job.id === jobId);
    if (!matched) {
      throw new Error(`Reminder ${jobId} was not found for this QQBot target`);
    }
    jobName = matched.name;
  }

  await runCronCli(["remove", jobId]);
  return { id: jobId, name: jobName };
}
