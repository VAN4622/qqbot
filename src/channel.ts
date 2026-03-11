import {
  type ChannelPlugin,
  type OpenClawConfig,
  applyAccountNameToChannelSection,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk";

import type { ResolvedQQBotAccount } from "./types.js";
import { DEFAULT_ACCOUNT_ID, listQQBotAccountIds, resolveQQBotAccount, applyQQBotAccountConfig, resolveDefaultQQBotAccountId } from "./config.js";
import { sendText, sendMedia, sendQQBotAction } from "./outbound.js";
import { startGateway } from "./gateway.js";
import { qqbotOnboardingAdapter } from "./onboarding.js";
import { getQQBotRuntime } from "./runtime.js";

/**
 * 简单的文本分块函数
 * 用于预先分块长文本
 */
function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  
  const chunks: string[] = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    
    // 尝试在换行处分割
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0 || splitAt < limit * 0.5) {
      // 没找到合适的换行，尝试在空格处分割
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt <= 0 || splitAt < limit * 0.5) {
      // 还是没找到，强制在 limit 处分割
      splitAt = limit;
    }
    
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  
  return chunks;
}

function readParamString(
  params: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; trim?: boolean; allowEmpty?: boolean } = {},
): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    if (opts.required) {
      throw new Error(`${key} is required`);
    }
    return undefined;
  }

  const result = opts.trim === false ? value : value.trim();
  if (!opts.allowEmpty && !result) {
    if (opts.required) {
      throw new Error(`${key} is required`);
    }
    return undefined;
  }

  return result;
}

function readOptionalStringStrict(
  params: Record<string, unknown>,
  key: string,
  opts: { trim?: boolean; allowEmpty?: boolean } = {},
): string | undefined {
  if (!(key in params)) {
    return undefined;
  }
  if (typeof params[key] !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return readParamString(params, key, { allowEmpty: opts.allowEmpty, trim: opts.trim });
}

function normalizeQQBotTarget(target: string): string | undefined {
  const id = target.replace(/^qqbot:/i, "");

  if (id.startsWith("c2c:") || id.startsWith("group:") || id.startsWith("channel:")) {
    return `qqbot:${id}`;
  }

  const openIdHexPattern = /^[0-9a-fA-F]{32}$/;
  if (openIdHexPattern.test(id)) {
    return `qqbot:c2c:${id}`;
  }

  const openIdUuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (openIdUuidPattern.test(id)) {
    return `qqbot:c2c:${id}`;
  }

  return undefined;
}

type QQBotValidatedSendParams = {
  to: string;
  message?: string;
  media?: string;
  asVoice: boolean;
  replyToId?: string;
  accountId?: string;
};

function readOptionalBooleanStrict(params: Record<string, unknown>, key: string): boolean | undefined {
  if (!(key in params)) {
    return undefined;
  }
  if (typeof params[key] !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return params[key] as boolean;
}

function assertNoUnknownSendParams(params: Record<string, unknown>) {
  const allowedKeys = new Set([
    "action",
    "to",
    "target",
    "channel",
    "accountId",
    "threadId",
    "message",
    "caption",
    "media",
    "path",
    "filePath",
    "asVoice",
    "replyTo",
  ]);

  const unknownKeys = Object.keys(params).filter((key) => !allowedKeys.has(key) && !key.startsWith("__"));
  if (unknownKeys.length > 0) {
    throw new Error(`Unsupported QQBot send parameter(s): ${unknownKeys.join(", ")}`);
  }
}

function pickOneStringAlias(
  params: Record<string, unknown>,
  keys: string[],
  label: string,
  opts: { allowEmpty?: boolean; trim?: boolean; strict?: boolean } = {},
): string | undefined {
  const present = keys
    .filter((key) => key in params)
    .map((key) => ({
      key,
      value: opts.strict === false
        ? readParamString(params, key, { allowEmpty: true, trim: opts.trim })
        : readOptionalStringStrict(params, key, { allowEmpty: true, trim: opts.trim }),
    }));

  const concrete = present.filter((entry) => typeof entry.value === "string");
  const nonEmpty = concrete.filter((entry) => opts.allowEmpty || entry.value);

  if (nonEmpty.length <= 1) {
    return nonEmpty[0]?.value;
  }

  const distinct = new Set(nonEmpty.map((entry) => entry.value));
  if (distinct.size > 1) {
    throw new Error(`${label} aliases conflict; use only one of ${keys.join(", ")}`);
  }

  return nonEmpty[0]?.value;
}

function validateQQBotSendParams(params: Record<string, unknown>, fallbackAccountId?: string | null): QQBotValidatedSendParams {
  assertNoUnknownSendParams(params);

  const rawTo = pickOneStringAlias(params, ["to", "target"], "target") ?? "";
  if (!rawTo) {
    throw new Error("to is required");
  }
  const to = normalizeQQBotTarget(rawTo);
  if (!to) {
    throw new Error("to must be a valid QQBot target such as qqbot:c2c:OPENID or qqbot:group:GROUPID");
  }

  const channel = readOptionalStringStrict(params, "channel");
  if (channel && channel.trim().toLowerCase() !== "qqbot") {
    throw new Error(`channel must be qqbot when provided (received ${channel})`);
  }

  const message = pickOneStringAlias(params, ["message", "caption"], "message", { allowEmpty: true });
  const media = pickOneStringAlias(params, ["media", "path", "filePath"], "media", {
    allowEmpty: true,
    trim: false,
    strict: false,
  });
  const asVoice = readOptionalBooleanStrict(params, "asVoice") ?? false;
  const replyToId = readOptionalStringStrict(params, "replyTo");
  const explicitAccountId = readOptionalStringStrict(params, "accountId");

  if (!message && !media) {
    throw new Error("QQBot send requires either message text or media");
  }

  if (!media && !message?.trim()) {
    throw new Error("QQBot text send requires a non-empty message");
  }

  if (asVoice && !media && !message?.trim()) {
    throw new Error("QQBot voice send requires message text when media is omitted");
  }

  return {
    to,
    ...(message !== undefined ? { message } : {}),
    ...(media !== undefined ? { media } : {}),
    asVoice,
    ...(replyToId ? { replyToId } : {}),
    ...((explicitAccountId ?? fallbackAccountId ?? undefined) ? { accountId: (explicitAccountId ?? fallbackAccountId)! } : {}),
  };
}

export const qqbotPlugin: ChannelPlugin<ResolvedQQBotAccount> = {
  id: "qqbot",
  meta: {
    id: "qqbot",
    label: "QQ Bot",
    selectionLabel: "QQ Bot",
    docsPath: "/docs/channels/qqbot",
    blurb: "Connect to QQ via official QQ Bot API",
    order: 50,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    /**
     * blockStreaming: true 表示该 Channel 支持块流式
     * 框架会收集流式响应，然后通过 deliver 回调发送
     */
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.qqbot"] },
  // CLI onboarding wizard
  onboarding: qqbotOnboardingAdapter,

  config: {
    listAccountIds: (cfg) => {
      const ids = listQQBotAccountIds(cfg);
      console.log(`[qqbot:channel] listAccountIds: ${JSON.stringify(ids)}`);
      return ids;
    },
    resolveAccount: (cfg, accountId) => {
      const account = resolveQQBotAccount(cfg, accountId);
      console.log(`[qqbot:channel] resolveAccount: input=${accountId} → resolved=${account.accountId}, appId=${account.appId}, enabled=${account.enabled}`);
      return account;
    },
    defaultAccountId: (cfg) => {
      const id = resolveDefaultQQBotAccountId(cfg);
      console.log(`[qqbot:channel] defaultAccountId: ${id}`);
      return id;
    },
    // 新增：设置账户启用状态
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "qqbot",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    // 新增：删除账户
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "qqbot",
        accountId,
        clearBaseFields: ["appId", "clientSecret", "clientSecretFile", "name"],
      }),
    isConfigured: (account) => Boolean(account?.appId && account?.clientSecret),
    describeAccount: (account) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.appId && account?.clientSecret),
      tokenSource: account?.secretSource,
    }),
    // 关键：解析 allowFrom 配置，用于命令授权
    resolveAllowFrom: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) => {
      const account = resolveQQBotAccount(cfg, accountId);
      const allowFrom = account.config?.allowFrom ?? [];
      console.log(`[qqbot] resolveAllowFrom: accountId=${accountId}, allowFrom=${JSON.stringify(allowFrom)}`);
      return allowFrom.map((entry: string | number) => String(entry));
    },
    // 格式化 allowFrom 条目（移除 qqbot: 前缀，统一大写）
    formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> }) =>
      allowFrom
        .map((entry: string | number) => String(entry).trim())
        .filter(Boolean)
        .map((entry: string) => entry.replace(/^qqbot:/i, ""))
        .map((entry: string) => entry.toUpperCase()), // QQ openid 是大写的
  },
  setup: {
    // 新增：规范化账户 ID
    resolveAccountId: ({ accountId }) => accountId?.trim().toLowerCase() || DEFAULT_ACCOUNT_ID,
    // 新增：应用账户名称
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "qqbot",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (!input.token && !input.tokenFile && !input.useEnv) {
        return "QQBot requires --token (format: appId:clientSecret) or --use-env";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      let appId = "";
      let clientSecret = "";

      if (input.token) {
        const parts = input.token.split(":");
        if (parts.length === 2) {
          appId = parts[0];
          clientSecret = parts[1];
        }
      }

      return applyQQBotAccountConfig(cfg, accountId, {
        appId,
        clientSecret,
        clientSecretFile: input.tokenFile,
        name: input.name,
        imageServerBaseUrl: input.imageServerBaseUrl,
      });
    },
  },
  // Messaging 配置：用于解析目标地址
  messaging: {
    /**
     * 规范化目标地址
     * 支持以下格式：
     * - qqbot:c2c:openid -> 私聊
     * - qqbot:group:groupid -> 群聊
     * - qqbot:channel:channelid -> 频道
     * - c2c:openid -> 私聊
     * - group:groupid -> 群聊
     * - channel:channelid -> 频道
     * - 纯 openid（32位十六进制）-> 私聊
     */
    normalizeTarget: ((target: string): string | undefined => normalizeQQBotTarget(target)) as any,
    /**
     * 目标解析器配置
     * 用于判断一个目标 ID 是否看起来像 QQ Bot 的格式
     */
    targetResolver: {
      /**
       * 判断目标 ID 是否可能是 QQ Bot 格式
       * 支持以下格式：
       * - qqbot:c2c:xxx
       * - qqbot:group:xxx  
       * - qqbot:channel:xxx
       * - c2c:xxx
       * - group:xxx
       * - channel:xxx
       * - UUID 格式的 openid
       */
      looksLikeId: (id: string): boolean => {
        // 带 qqbot: 前缀的格式
        if (/^qqbot:(c2c|group|channel):/i.test(id)) {
          return true;
        }
        // 不带前缀但有类型标识
        if (/^(c2c|group|channel):/i.test(id)) {
          return true;
        }
        // 32位十六进制 openid（不带连字符）
        if (/^[0-9a-fA-F]{32}$/.test(id)) {
          return true;
        }
        // UUID 格式的 openid（带连字符）
        const openIdPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
        return openIdPattern.test(id);
      },
      hint: "QQ Bot 目标格式: qqbot:c2c:openid (私聊) 或 qqbot:group:groupid (群聊)",
    },
  },
  agentPrompt: {
    messageToolHints: () => [
      "- On QQBot, send media with the `message` tool using `action=send`, `media`, and optional `message` text.",
      "- For QQ voice replies generated from text, use `message` with `action=send`, `asVoice=true`, and put the spoken content in `message`.",
      "- Do not use the `message` tool for reminders on QQBot. Use the dedicated `qqbot_schedule_reminder`, `qqbot_list_reminders`, and `qqbot_remove_reminder` tools instead.",
      "- Do not call the generic `tts` tool directly on QQBot; generated audio will not be auto-delivered. Use the QQBot `message` tool with `asVoice=true` instead.",
      "- Never emit legacy inline media markup or raw protocol payload text; QQBot only supports the real message tool.",
    ],
  },
  actions: {
    listActions: () => ["send", "sendMessage"],
    supportsAction: ({ action }: { action: string }) =>
      action === "send"
      || action === "sendMessage",
    extractToolSend: ({ args }: { args: Record<string, unknown> }) => {
      const action = typeof args.action === "string" ? args.action.trim() : "";
      if (action !== "send" && action !== "sendMessage") {
        return null;
      }

      try {
        const validated = validateQQBotSendParams(args);
        const threadIdRaw = typeof args.threadId === "string"
          ? args.threadId.trim()
          : typeof args.threadId === "number"
            ? String(args.threadId)
            : "";

        return {
          to: validated.to,
          ...(validated.accountId ? { accountId: validated.accountId } : {}),
          ...(threadIdRaw ? { threadId: threadIdRaw } : {}),
        };
      } catch {
        return null;
      }
    },
    handleAction: async (ctx: {
      action: string;
      cfg: OpenClawConfig;
      params: Record<string, unknown>;
      accountId?: string | null;
    }) => {
      if (ctx.action !== "send" && ctx.action !== "sendMessage") {
        throw new Error(`Unsupported QQBot action: ${ctx.action}`);
      }

      const validated = validateQQBotSendParams(ctx.params, ctx.accountId);
      const account = resolveQQBotAccount(ctx.cfg, ctx.accountId);
      const result = await sendQQBotAction({
        to: validated.to,
        account,
        cfg: ctx.cfg as Record<string, unknown>,
        message: validated.message,
        media: validated.media,
        asVoice: validated.asVoice,
        replyToId: validated.replyToId,
        accountId: validated.accountId ?? ctx.accountId,
      });

      if (result.error) {
        throw new Error(result.error);
      }

      const summary = result.messageId
        ? `Sent QQBot message to ${validated.to} (messageId: ${result.messageId}).`
        : `Sent QQBot message to ${validated.to}.`;

      return {
        content: [{ type: "text", text: summary }],
        details: {
          status: "success",
          channel: "qqbot",
          action: "send",
          to: validated.to,
          messageId: result.messageId ?? null,
          timestamp: result.timestamp ?? null,
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: chunkText,
    chunkerMode: "markdown",
    textChunkLimit: 2000,
    sendText: async ({ to, text, accountId, replyToId, cfg }) => {
      console.log(`[qqbot:channel] sendText called — accountId=${accountId}, to=${to}, replyToId=${replyToId}, text.length=${text?.length ?? 0}`);
      console.log(`[qqbot:channel] sendText text preview: ${text?.slice(0, 100)}${(text?.length ?? 0) > 100 ? "..." : ""}`);
      const account = resolveQQBotAccount(cfg, accountId);
      console.log(`[qqbot:channel] sendText resolved account: id=${account.accountId}, appId=${account.appId}, enabled=${account.enabled}`);
      const result = await sendText({ to, text, accountId, replyToId, account });
      console.log(`[qqbot:channel] sendText result: messageId=${result.messageId}, error=${result.error ?? "none"}`);
      return {
        channel: "qqbot",
        messageId: result.messageId,
        error: result.error ? new Error(result.error) : undefined,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId, cfg }) => {
      console.log(`[qqbot:channel] sendMedia called — accountId=${accountId}, to=${to}, replyToId=${replyToId}, mediaUrl=${mediaUrl?.slice(0, 80)}, text.length=${text?.length ?? 0}`);
      const account = resolveQQBotAccount(cfg, accountId);
      console.log(`[qqbot:channel] sendMedia resolved account: id=${account.accountId}, appId=${account.appId}, enabled=${account.enabled}`);
      const result = await sendMedia({ to, text: text ?? "", mediaUrl: mediaUrl ?? "", accountId, replyToId, account });
      console.log(`[qqbot:channel] sendMedia result: messageId=${result.messageId}, error=${result.error ?? "none"}`);
      return {
        channel: "qqbot",
        messageId: result.messageId,
        error: result.error ? new Error(result.error) : undefined,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const { account, abortSignal, log, cfg } = ctx;

      log?.info(`[qqbot:${account.accountId}] Starting gateway — appId=${account.appId}, enabled=${account.enabled}, name=${account.name ?? "unnamed"}`);
      console.log(`[qqbot:channel] startAccount: accountId=${account.accountId}, appId=${account.appId}, secretSource=${account.secretSource}`);

      await startGateway({
        account,
        abortSignal,
        cfg,
        log,
        onReady: () => {
          log?.info(`[qqbot:${account.accountId}] Gateway ready`);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
          });
        },
        onError: (error) => {
          log?.error(`[qqbot:${account.accountId}] Gateway error: ${error.message}`);
          ctx.setStatus({
            ...ctx.getStatus(),
            lastError: error.message,
          });
        },
      });
    },
    // 新增：登出账户（清除配置中的凭证）
    logoutAccount: async ({ accountId, cfg }) => {
      const nextCfg = { ...cfg } as OpenClawConfig;
      const nextQQBot = cfg.channels?.qqbot ? { ...cfg.channels.qqbot } : undefined;
      let cleared = false;
      let changed = false;

      if (nextQQBot) {
        const qqbot = nextQQBot as Record<string, unknown>;
        if (accountId === DEFAULT_ACCOUNT_ID && qqbot.clientSecret) {
          delete qqbot.clientSecret;
          cleared = true;
          changed = true;
        }
        if (accountId === DEFAULT_ACCOUNT_ID && qqbot.clientSecretFile) {
          delete qqbot.clientSecretFile;
          changed = true;
        }
        const accounts = qqbot.accounts as Record<string, Record<string, unknown>> | undefined;
        if (accounts && accountId in accounts) {
          const entry = accounts[accountId] as Record<string, unknown> | undefined;
          if (entry && "clientSecret" in entry) {
            delete entry.clientSecret;
            cleared = true;
            changed = true;
          }
          if (entry && "clientSecretFile" in entry) {
            delete entry.clientSecretFile;
            changed = true;
          }
          if (entry && Object.keys(entry).length === 0) {
            delete accounts[accountId];
            changed = true;
          }
        }
      }

      if (changed && nextQQBot) {
        nextCfg.channels = { ...nextCfg.channels, qqbot: nextQQBot };
        const runtime = getQQBotRuntime();
        const configApi = runtime.config as { writeConfigFile: (cfg: OpenClawConfig) => Promise<void> };
        await configApi.writeConfigFile(nextCfg);
      }

      const resolved = resolveQQBotAccount(changed ? nextCfg : cfg, accountId);
      const loggedOut = resolved.secretSource === "none";
      const envToken = Boolean(process.env.QQBOT_CLIENT_SECRET);

      return { ok: true, cleared, envToken, loggedOut };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    // 新增：构建通道摘要
    buildChannelSummary: ({ snapshot }: { snapshot: Record<string, unknown> }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastConnectedAt: snapshot.lastConnectedAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }: { account?: ResolvedQQBotAccount; runtime?: Record<string, unknown> }) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.appId && account?.clientSecret),
      tokenSource: account?.secretSource,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
};
