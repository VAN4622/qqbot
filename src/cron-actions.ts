import { getQQBotRuntime } from "./runtime.js";

type JsonRecord = Record<string, unknown>;
type OpenClawLikeConfig = {
  agents?: {
    list?: Array<{ id?: string; default?: boolean }>;
  };
};

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
  agentId?: string;
  sessionKey?: string;
  sessionTarget?: string;
  scheduleKind?: string;
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: string;
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function readNestedRecord(value: JsonRecord | null, key: string): JsonRecord | null {
  return asRecord(value?.[key]);
}

function readStringCandidate(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function toTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readTimestampCandidate(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = toTimestampMs(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function extractJsonArray(record: JsonRecord, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
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

function normalizeAgentId(value?: string): string {
  return value?.trim().toLowerCase() || "main";
}

function resolveDefaultAgentId(cfg: Record<string, unknown>): string {
  const config = cfg as OpenClawLikeConfig;
  const agents = Array.isArray(config.agents?.list) ? config.agents!.list : [];
  if (agents.length === 0) {
    return "main";
  }
  const defaultEntry = agents.find((entry) => entry?.default && typeof entry.id === "string" && entry.id.trim());
  const firstEntry = agents.find((entry) => typeof entry?.id === "string" && entry.id.trim());
  return normalizeAgentId(defaultEntry?.id || firstEntry?.id || "main");
}

type QQBotReminderRunSummary = {
  lastRunAtMs?: number;
  lastRunStatus?: string;
};

function readReminderRunSummary(run: unknown): QQBotReminderRunSummary | null {
  const record = asRecord(run);
  if (!record) {
    return null;
  }

  const state = readNestedRecord(record, "state");
  const result = readNestedRecord(record, "result");

  const lastRunAtMs = readTimestampCandidate(
    record.completedAtMs,
    record.finishedAtMs,
    record.endedAtMs,
    record.timestampMs,
    record.startedAtMs,
    record.createdAtMs,
    record.completedAt,
    record.finishedAt,
    record.endedAt,
    record.timestamp,
    record.startedAt,
    record.createdAt,
    state?.completedAtMs,
    state?.finishedAtMs,
    state?.endedAtMs,
    state?.startedAtMs,
    state?.completedAt,
    state?.finishedAt,
    state?.endedAt,
    state?.startedAt,
  );

  const lastRunStatus = readStringCandidate(
    record.status,
    record.outcome,
    record.state,
    state?.status,
    state?.outcome,
    result?.status,
    result?.outcome,
  );

  if (lastRunAtMs === undefined && !lastRunStatus) {
    return null;
  }

  return {
    ...(lastRunAtMs !== undefined ? { lastRunAtMs } : {}),
    ...(lastRunStatus ? { lastRunStatus } : {}),
  };
}

async function readLatestReminderRun(jobId: string): Promise<QQBotReminderRunSummary | null> {
  try {
    const result = await runCronCli(["runs", "--id", jobId, "--limit", "1"]);
    const runs = extractJsonArray(result, ["runs", "items", "entries"]);
    if (runs.length === 0) {
      return null;
    }
    return readReminderRunSummary(runs[0]);
  } catch {
    return null;
  }
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
  const session = asRecord(record.session);
  const payloadSession = readNestedRecord(payload, "session");

  const to = readStringCandidate(
    delivery?.to,
    payload?.to,
    record.to,
  );
  const channel = readStringCandidate(
    delivery?.channel,
    payload?.channel,
    record.channel,
  );
  const sessionKey = readStringCandidate(
    record.sessionKey,
    session?.key,
    payload?.sessionKey,
    payloadSession?.key,
  );
  const sessionTarget = readStringCandidate(
    record.sessionTarget,
    session?.target,
    payload?.sessionTarget,
  );
  const agentId = readStringCandidate(
    record.agentId,
    payload?.agentId,
  );
  const looksLikeQQBotSession = typeof sessionKey === "string" && sessionKey.includes(":qqbot:");
  const isQQBotDelivery = channel === "qqbot" || (typeof to === "string" && /^qqbot:/i.test(to));

  if (!looksLikeQQBotSession && !isQQBotDelivery) {
    return null;
  }

  return {
    id: typeof record.id === "string" ? record.id : "",
    name: typeof record.name === "string" ? record.name : "QQBot提醒",
    enabled: record.enabled !== false,
    ...(to ? { to } : {}),
    ...(typeof delivery?.accountId === "string" ? { accountId: delivery.accountId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(sessionTarget ? { sessionTarget } : {}),
    ...(typeof schedule?.kind === "string" ? { scheduleKind: schedule.kind } : {}),
    ...(typeof state?.nextRunAtMs === "number" ? { nextRunAtMs: state.nextRunAtMs } : {}),
    ...(typeof state?.lastRunAtMs === "number"
      ? { lastRunAtMs: state.lastRunAtMs }
      : typeof record.lastRunAtMs === "number"
        ? { lastRunAtMs: record.lastRunAtMs }
        : {}),
    ...(typeof state?.lastRunStatus === "string"
      ? { lastRunStatus: state.lastRunStatus }
      : typeof state?.lastStatus === "string"
        ? { lastRunStatus: state.lastStatus }
        : typeof record.lastRunStatus === "string"
          ? { lastRunStatus: record.lastRunStatus }
          : typeof record.lastStatus === "string"
            ? { lastRunStatus: record.lastStatus }
            : {}),
  };
}

function matchesReminderTarget(job: QQBotReminderSummary, target: QQBotReminderTarget): boolean {
  if (target.sessionKey) {
    if (job.sessionKey !== target.sessionKey) {
      return false;
    }
    if (target.agentId && job.agentId && job.agentId !== target.agentId) {
      return false;
    }
    if (target.accountId && job.accountId && job.accountId !== target.accountId) {
      return false;
    }
    return true;
  }

  if (!job.to || job.to.toLowerCase() !== target.to.toLowerCase()) {
    return false;
  }
  if (target.accountId && job.accountId && job.accountId !== target.accountId) {
    return false;
  }
  return true;
}

export async function addQQBotReminder(cfg: Record<string, unknown>, input: QQBotReminderCreateInput): Promise<QQBotReminderSummary> {
  if (!input.sessionKey) {
    throw new Error("QQBot reminders run in the originating chat context. Provide reminderSessionKey when session metadata is unavailable.");
  }

  const resolvedAgentId = normalizeAgentId(input.agentId);
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const useMainSession = resolvedAgentId === defaultAgentId;

  const args = [
    "add",
    "--name",
    input.name?.trim() || buildDefaultReminderName(input.message),
  ];

  if (useMainSession) {
    args.push(
      "--system-event",
      input.message,
      "--session",
      "main",
      "--wake",
      "now",
    );
  } else {
    args.push(
      "--message",
      input.message,
      "--session",
      "isolated",
      "--wake",
      "now",
      "--announce",
      "--channel",
      "qqbot",
      "--to",
      input.to,
    );
    if (input.accountId) {
      args.push("--account", input.accountId);
    }
  }

  if (resolvedAgentId) {
    args.push("--agent", resolvedAgentId);
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
    return {
      id: typeof result.id === "string" ? result.id : "",
      name: typeof result.name === "string" ? result.name : (input.name?.trim() || buildDefaultReminderName(input.message)),
      enabled: result.enabled !== false,
      to: input.to,
      accountId: input.accountId,
      agentId: resolvedAgentId,
      sessionKey: input.sessionKey,
      sessionTarget: useMainSession ? "main" : "isolated",
      nextRunAtMs: typeof result.nextRunAtMs === "number" ? result.nextRunAtMs : undefined,
    };
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
  const reminders = jobs
    .map((job) => readReminderSummary(job))
    .filter((job): job is QQBotReminderSummary => Boolean(job))
    .filter((job) => matchesReminderTarget(job, target));

  return Promise.all(reminders.map(async (job) => {
    const latestRun = job.id ? await readLatestReminderRun(job.id) : null;
    if (!latestRun) {
      return job;
    }
    return {
      ...job,
      ...(latestRun.lastRunAtMs !== undefined ? { lastRunAtMs: latestRun.lastRunAtMs } : {}),
      ...(latestRun.lastRunStatus ? { lastRunStatus: latestRun.lastRunStatus } : {}),
    };
  }));
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
