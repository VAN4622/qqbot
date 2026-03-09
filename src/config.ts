import type { ResolvedQQBotAccount, QQBotAccountConfig } from "./types.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

export const DEFAULT_ACCOUNT_ID = "default";

interface QQBotChannelConfig extends QQBotAccountConfig {
  accounts?: Record<string, QQBotAccountConfig>;
}

type QQBotAccountConfigKey = keyof QQBotAccountConfig;

const LEGACY_DEFAULT_ACCOUNT_KEYS: QQBotAccountConfigKey[] = [
  "name",
  "appId",
  "clientSecret",
  "clientSecretFile",
  "dmPolicy",
  "allowFrom",
  "systemPrompt",
  "imageServerBaseUrl",
  "markdownSupport",
  "voiceDirectUploadFormats",
  "audioFormatPolicy",
];

function getDefaultAccountBlock(cfg: OpenClawConfig): QQBotAccountConfig | undefined {
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;
  return qqbot?.accounts?.[DEFAULT_ACCOUNT_ID];
}

function getLegacyTopLevelDefaultAccount(cfg: OpenClawConfig): QQBotAccountConfig {
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;
  return {
    enabled: qqbot?.enabled,
    name: qqbot?.name,
    appId: qqbot?.appId,
    clientSecret: qqbot?.clientSecret,
    clientSecretFile: qqbot?.clientSecretFile,
    dmPolicy: qqbot?.dmPolicy,
    allowFrom: qqbot?.allowFrom,
    systemPrompt: qqbot?.systemPrompt,
    imageServerBaseUrl: qqbot?.imageServerBaseUrl,
    markdownSupport: qqbot?.markdownSupport ?? true,
    voiceDirectUploadFormats: qqbot?.voiceDirectUploadFormats,
    audioFormatPolicy: qqbot?.audioFormatPolicy,
  };
}

function resolveDefaultAccountConfig(cfg: OpenClawConfig): QQBotAccountConfig {
  const standardDefault = getDefaultAccountBlock(cfg);
  const legacyDefault = getLegacyTopLevelDefaultAccount(cfg);
  if (!standardDefault) {
    return legacyDefault;
  }
  return {
    ...legacyDefault,
    ...standardDefault,
  };
}

/**
 * 列出所有 QQBot 账户 ID
 */
export function listQQBotAccountIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;

  if (qqbot?.appId || qqbot?.accounts?.[DEFAULT_ACCOUNT_ID]?.appId) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  if (qqbot?.accounts) {
    for (const accountId of Object.keys(qqbot.accounts)) {
      if (qqbot.accounts[accountId]?.appId) {
        ids.add(accountId);
      }
    }
  }

  return Array.from(ids);
}

/**
 * 获取默认账户 ID
 */
export function resolveDefaultQQBotAccountId(cfg: OpenClawConfig): string {
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;
  // 如果有默认账户配置，返回 default
  if (qqbot?.appId || qqbot?.accounts?.[DEFAULT_ACCOUNT_ID]?.appId) {
    return DEFAULT_ACCOUNT_ID;
  }
  // 否则返回第一个配置的账户
  if (qqbot?.accounts) {
    const ids = Object.keys(qqbot.accounts);
    if (ids.length > 0) {
      return ids[0];
    }
  }
  return DEFAULT_ACCOUNT_ID;
}

/**
 * 解析 QQBot 账户配置
 */
export function resolveQQBotAccount(
  cfg: OpenClawConfig,
  accountId?: string | null
): ResolvedQQBotAccount {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;

  // 基础配置
  let accountConfig: QQBotAccountConfig = {};
  let appId = "";
  let clientSecret = "";
  let secretSource: "config" | "file" | "env" | "none" = "none";

  if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    // 默认账户优先读取 accounts.default，回退到旧顶层结构
    accountConfig = resolveDefaultAccountConfig(cfg);
    appId = accountConfig.appId ?? "";
  } else {
    // 命名账户从 accounts 读取
    const account = qqbot?.accounts?.[resolvedAccountId];
    accountConfig = account ?? {};
    appId = account?.appId ?? "";
  }

  // 解析 clientSecret
  if (accountConfig.clientSecret) {
    clientSecret = accountConfig.clientSecret;
    secretSource = "config";
  } else if (accountConfig.clientSecretFile) {
    // 从文件读取（运行时处理）
    secretSource = "file";
  } else if (process.env.QQBOT_CLIENT_SECRET && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    clientSecret = process.env.QQBOT_CLIENT_SECRET;
    secretSource = "env";
  }

  // AppId 也可以从环境变量读取
  if (!appId && process.env.QQBOT_APP_ID && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    appId = process.env.QQBOT_APP_ID;
  }

  return {
    accountId: resolvedAccountId,
    name: accountConfig.name,
    enabled: accountConfig.enabled !== false,
    appId,
    clientSecret,
    secretSource,
    systemPrompt: accountConfig.systemPrompt,
    imageServerBaseUrl: accountConfig.imageServerBaseUrl || process.env.QQBOT_IMAGE_SERVER_BASE_URL,
    markdownSupport: accountConfig.markdownSupport !== false,
    config: accountConfig,
  };
}

/**
 * 应用账户配置
 */
export function applyQQBotAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
  input: { appId?: string; clientSecret?: string; clientSecretFile?: string; name?: string; imageServerBaseUrl?: string }
): OpenClawConfig {
  const next = { ...cfg };
  const currentQQBot = (next.channels?.qqbot as QQBotChannelConfig) || {};

  if (accountId === DEFAULT_ACCOUNT_ID) {
    // 默认账户写入标准结构 accounts.default，并清理旧顶层字段
    const legacyDefault = getLegacyTopLevelDefaultAccount(next);
    const existingDefault = currentQQBot.accounts?.[DEFAULT_ACCOUNT_ID] || {};
    const allowFrom = existingDefault.allowFrom ?? legacyDefault.allowFrom ?? ["*"];
    const nextDefault: QQBotAccountConfig = {
      ...legacyDefault,
      ...existingDefault,
      enabled: true,
      allowFrom,
      ...(input.appId ? { appId: input.appId } : {}),
      ...(input.clientSecret
        ? { clientSecret: input.clientSecret, clientSecretFile: undefined }
        : input.clientSecretFile
          ? { clientSecretFile: input.clientSecretFile, clientSecret: undefined }
          : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.imageServerBaseUrl ? { imageServerBaseUrl: input.imageServerBaseUrl } : {}),
    };

    const sanitizedQQBot: Record<string, unknown> = {
      ...(currentQQBot as Record<string, unknown>),
      enabled: true,
      accounts: {
        ...(currentQQBot.accounts || {}),
        [DEFAULT_ACCOUNT_ID]: nextDefault,
      },
    };

    for (const key of LEGACY_DEFAULT_ACCOUNT_KEYS) {
      delete sanitizedQQBot[key];
    }

    next.channels = {
      ...next.channels,
      qqbot: sanitizedQQBot as QQBotChannelConfig,
    };
  } else {
    // 如果没有设置过 allowFrom，默认设置为 ["*"]
    const existingAccountConfig = currentQQBot.accounts?.[accountId] || {};
    const allowFrom = existingAccountConfig.allowFrom ?? ["*"];
    
    next.channels = {
      ...next.channels,
      qqbot: {
        ...(currentQQBot as Record<string, unknown> || {}),
        enabled: true,
        accounts: {
          ...(currentQQBot.accounts || {}),
          [accountId]: {
            ...(currentQQBot.accounts?.[accountId] || {}),
            enabled: true,
            allowFrom,
            ...(input.appId ? { appId: input.appId } : {}),
            ...(input.clientSecret
              ? { clientSecret: input.clientSecret }
              : input.clientSecretFile
                ? { clientSecretFile: input.clientSecretFile }
                : {}),
            ...(input.name ? { name: input.name } : {}),
            ...(input.imageServerBaseUrl ? { imageServerBaseUrl: input.imageServerBaseUrl } : {}),
          },
        },
      },
    };
  }

  return next;
}
