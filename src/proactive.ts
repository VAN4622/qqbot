/**
 * QQ Bot 主动发送消息模块
 * 仅保留 C2C 私聊主动发送与已知用户查询能力。
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedQQBotAccount } from "./types.js";
import { getAccessToken, sendC2CImageMessage, sendProactiveC2CMessage } from "./api.js";
import { resolveQQBotAccount } from "./config.js";
import { clearKnownUsers, getKnownUser, getKnownUsersStats, listKnownUsers, recordKnownUser, removeKnownUser, type KnownUser } from "./known-users.js";

export type { KnownUser } from "./known-users.js";
export { recordKnownUser, getKnownUser, listKnownUsers, removeKnownUser, clearKnownUsers, getKnownUsersStats };

export interface ProactiveSendOptions {
  to: string;
  text: string;
  imageUrl?: string;
  accountId?: string;
}

export interface ProactiveSendResult {
  success: boolean;
  messageId?: string;
  timestamp?: number | string;
  error?: string;
}

export interface ListKnownUsersOptions {
  accountId?: string;
  sortByLastInteraction?: boolean;
  limit?: number;
}

export async function sendProactive(
  options: ProactiveSendOptions,
  cfg: OpenClawConfig,
): Promise<ProactiveSendResult> {
  const { to, text, imageUrl, accountId = "default" } = options;
  const account = resolveQQBotAccount(cfg, accountId);

  if (!account.appId || !account.clientSecret) {
    return { success: false, error: "QQBot not configured (missing appId or clientSecret)" };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);

    if (imageUrl) {
      try {
        await sendC2CImageMessage(accessToken, to, imageUrl, undefined, undefined);
        console.log(`[qqbot:proactive] Sent image to c2c:${to}`);
      } catch (err) {
        console.error(`[qqbot:proactive] Failed to send image: ${err}`);
      }
    }

    const result = await sendProactiveC2CMessage(accessToken, to, text);
    console.log(`[qqbot:proactive] Sent message to c2c:${to}, id: ${result.id}`);
    return {
      success: true,
      messageId: result.id,
      timestamp: result.timestamp,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[qqbot:proactive] Failed to send message: ${message}`);
    return { success: false, error: message };
  }
}

export async function sendBulkProactiveMessage(
  recipients: string[],
  text: string,
  cfg: OpenClawConfig,
  accountId = "default",
): Promise<Array<{ to: string; result: ProactiveSendResult }>> {
  const results: Array<{ to: string; result: ProactiveSendResult }> = [];
  for (const to of recipients) {
    const result = await sendProactive({ to, text, accountId }, cfg);
    results.push({ to, result });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return results;
}

export async function broadcastMessage(
  text: string,
  cfg: OpenClawConfig,
  options?: {
    accountId?: string;
    limit?: number;
  },
): Promise<{
  total: number;
  success: number;
  failed: number;
  results: Array<{ to: string; result: ProactiveSendResult }>;
}> {
  const users = listKnownUsers({
    accountId: options?.accountId,
    limit: options?.limit,
  });

  const results: Array<{ to: string; result: ProactiveSendResult }> = [];
  let success = 0;
  let failed = 0;

  for (const user of users) {
    const result = await sendProactive({
      to: user.openid,
      text,
      accountId: user.accountId,
    }, cfg);
    results.push({ to: user.openid, result });
    if (result.success) {
      success += 1;
    } else {
      failed += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return { total: users.length, success, failed, results };
}

export async function sendProactiveMessageDirect(
  account: ResolvedQQBotAccount,
  to: string,
  text: string,
): Promise<ProactiveSendResult> {
  if (!account.appId || !account.clientSecret) {
    return { success: false, error: "QQBot not configured (missing appId or clientSecret)" };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const result = await sendProactiveC2CMessage(accessToken, to, text);
    return {
      success: true,
      messageId: result.id,
      timestamp: result.timestamp,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
