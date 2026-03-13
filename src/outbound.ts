/**
 * QQ Bot 消息发送模块
 */

import * as path from "path";
import type { QQBotIMStyleReplyConfig, ResolvedQQBotAccount } from "./types.js";
import {
  getAccessToken, 
  sendC2CMessage, 
  sendProactiveC2CMessage,
  sendC2CImageMessage,
  sendC2CVoiceMessage,
  sendC2CVideoMessage,
  sendC2CFileMessage,
} from "./api.js";
import { isAudioFile, audioFileToSilkBase64, waitForFile, resolveTTSConfig, textToSilk } from "./utils/audio-convert.js";
import { checkFileSize, readFileAsync, fileExistsAsync, isLargeFile, formatFileSize } from "./utils/file-utils.js";
import { getQQBotDataDir, isLocalPath as isLocalFilePath, normalizePath, sanitizeFileName } from "./utils/platform.js";

// ============ 消息回复限流器 ============
// 同一 message_id 1小时内最多回复 5 次，超过 1 小时无法被动回复（需改为主动消息）
const MESSAGE_REPLY_LIMIT = 5;
const MESSAGE_REPLY_TTL = 60 * 60 * 1000; // 1小时
const IM_STYLE_MIN_LENGTH = 48;
const IM_STYLE_MAX_PARTS = 3;
const IM_STYLE_TARGET_PART_LENGTH = 36;
const IM_STYLE_MAX_PART_LENGTH = 72;
const IM_STYLE_PART_DELAY_MS = 450;

interface MessageReplyRecord {
  count: number;
  firstReplyAt: number;
}

const messageReplyTracker = new Map<string, MessageReplyRecord>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getImStyleDelayMs(delayMinMs: number, delayMaxMs: number, text: string): number {
  const lengthDelay = Math.min(450, Math.max(0, text.trim().length * 10));
  const base = delayMinMs >= delayMaxMs
    ? delayMinMs
    : delayMinMs + Math.floor(Math.random() * (delayMaxMs - delayMinMs + 1));
  const jitter = Math.floor(Math.random() * 120);
  return Math.max(0, base + lengthDelay + jitter);
}

function containsStructuredReplyProtocol(text: string): boolean {
  return (
    text.includes("```") ||
    /(^|\n)\s*(#{1,6}\s|[-*]\s|\d+\.\s|>\s)/.test(text)
  );
}

function resolveImStyleReplyConfig(account: ResolvedQQBotAccount): Required<QQBotIMStyleReplyConfig> {
  const cfg = account.imStyleReply ?? {};
  const fallbackDelay = Math.max(0, cfg.delayMs ?? IM_STYLE_PART_DELAY_MS);
  const delayMinMs = Math.max(0, cfg.delayMinMs ?? fallbackDelay);
  const delayMaxMs = Math.max(delayMinMs, cfg.delayMaxMs ?? fallbackDelay);
  return {
    enabled: cfg.enabled !== false,
    minLength: Math.max(1, cfg.minLength ?? IM_STYLE_MIN_LENGTH),
    maxParts: Math.max(1, Math.min(5, cfg.maxParts ?? IM_STYLE_MAX_PARTS)),
    targetPartLength: Math.max(1, cfg.targetPartLength ?? IM_STYLE_TARGET_PART_LENGTH),
    maxPartLength: Math.max(1, cfg.maxPartLength ?? IM_STYLE_MAX_PART_LENGTH),
    delayMs: fallbackDelay,
    delayMinMs,
    delayMaxMs,
  };
}

function splitLongImSegment(segment: string, maxPartLength: number): string[] {
  const trimmed = segment.trim();
  if (trimmed.length <= maxPartLength) {
    return [trimmed];
  }

  const parts: string[] = [];
  let remaining = trimmed;

  while (remaining.length > maxPartLength) {
    let splitAt = -1;
    for (let i = Math.min(maxPartLength, remaining.length - 1); i >= Math.floor(maxPartLength * 0.5); i--) {
      const char = remaining[i];
      if (char === "，" || char === "," || char === "、" || char === "：" || char === ":" || char === " " || char === "\t") {
        splitAt = i + 1;
        break;
      }
    }
    if (splitAt <= 0) {
      splitAt = maxPartLength;
    }
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts.filter(Boolean);
}

function splitIntoImStyleParts(text: string, config: Required<QQBotIMStyleReplyConfig>, maxPartsOverride?: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  const maxParts = Math.max(1, Math.min(config.maxParts, maxPartsOverride ?? config.maxParts));
  if (!config.enabled || normalized.length < config.minLength || maxParts <= 1) {
    return [normalized];
  }

  const rawSegments: string[] = [];
  let current = "";
  for (const ch of normalized) {
    if (ch === "\n") {
      if (current.trim()) {
        rawSegments.push(current.trim());
      }
      current = "";
      continue;
    }
    current += ch;
    if ("。！？!?；;".includes(ch)) {
      if (current.trim()) {
        rawSegments.push(current.trim());
      }
      current = "";
    }
  }
  if (current.trim()) {
    rawSegments.push(current.trim());
  }

  const segments = rawSegments.length > 0
    ? rawSegments.flatMap((segment) => splitLongImSegment(segment, config.maxPartLength))
    : splitLongImSegment(normalized, config.maxPartLength);
  if (segments.length <= 1) {
    return [normalized];
  }

  const parts: string[] = [];
  let part = "";
  for (const segment of segments) {
    if (!part) {
      part = segment;
      continue;
    }

    const nextLength = part.length + 1 + segment.length;
    if (nextLength <= config.targetPartLength || part.length < Math.floor(config.targetPartLength * 0.5)) {
      part = `${part}\n${segment}`;
      continue;
    }

    parts.push(part);
    part = segment;
  }
  if (part) {
    parts.push(part);
  }

  if (parts.length <= 1) {
    return [normalized];
  }

  if (parts.length > maxParts) {
    const head = parts.slice(0, maxParts - 1);
    const tail = parts.slice(maxParts - 1).join("\n");
    return [...head, tail];
  }

  return parts;
}

async function sendPlainTextMessage(
  accessToken: string,
  target: { type: "c2c"; id: string },
  text: string,
  replyToId?: string | null,
): Promise<OutboundResult> {
  if (replyToId) {
    const result = await sendC2CMessage(accessToken, target.id, text, replyToId);
    recordMessageReply(replyToId);
    return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
  }

  const result = await sendProactiveC2CMessage(accessToken, target.id, text);
  return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
}

/** 限流检查结果 */
export interface ReplyLimitResult {
  /** 是否允许被动回复 */
  allowed: boolean;
  /** 剩余被动回复次数 */
  remaining: number;
  /** 是否需要降级为主动消息（超期或超过次数） */
  shouldFallbackToProactive: boolean;
  /** 降级原因 */
  fallbackReason?: "expired" | "limit_exceeded";
  /** 提示消息 */
  message?: string;
}

/**
 * 检查是否可以回复该消息（限流检查）
 * @param messageId 消息ID
 * @returns ReplyLimitResult 限流检查结果
 */
export function checkMessageReplyLimit(messageId: string): ReplyLimitResult {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);
  
  // 清理过期记录（定期清理，避免内存泄漏）
  if (messageReplyTracker.size > 10000) {
    for (const [id, rec] of messageReplyTracker) {
      if (now - rec.firstReplyAt > MESSAGE_REPLY_TTL) {
        messageReplyTracker.delete(id);
      }
    }
  }
  
  // 新消息，首次回复
  if (!record) {
    return { 
      allowed: true, 
      remaining: MESSAGE_REPLY_LIMIT,
      shouldFallbackToProactive: false,
    };
  }
  
  // 检查是否超过1小时（message_id 过期）
  if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    // 超过1小时，被动回复不可用，需要降级为主动消息
    return { 
      allowed: false, 
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: "expired",
      message: `消息已超过1小时有效期，将使用主动消息发送`,
    };
  }
  
  // 检查是否超过回复次数限制
  const remaining = MESSAGE_REPLY_LIMIT - record.count;
  if (remaining <= 0) {
    return { 
      allowed: false, 
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: "limit_exceeded",
      message: `该消息已达到1小时内最大回复次数(${MESSAGE_REPLY_LIMIT}次)，将使用主动消息发送`,
    };
  }
  
  return { 
    allowed: true, 
    remaining,
    shouldFallbackToProactive: false,
  };
}

/**
 * 记录一次消息回复
 * @param messageId 消息ID
 */
export function recordMessageReply(messageId: string): void {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);
  
  if (!record) {
    messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
  } else {
    // 检查是否过期，过期则重新计数
    if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
      messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
    } else {
      record.count++;
    }
  }
  console.log(`[qqbot] recordMessageReply: ${messageId}, count=${messageReplyTracker.get(messageId)?.count}`);
}

/**
 * 获取消息回复统计信息
 */
export function getMessageReplyStats(): { trackedMessages: number; totalReplies: number } {
  let totalReplies = 0;
  for (const record of messageReplyTracker.values()) {
    totalReplies += record.count;
  }
  return { trackedMessages: messageReplyTracker.size, totalReplies };
}

/**
 * 获取消息回复限制配置（供外部查询）
 */
export function getMessageReplyConfig(): { limit: number; ttlMs: number; ttlHours: number } {
  return {
    limit: MESSAGE_REPLY_LIMIT,
    ttlMs: MESSAGE_REPLY_TTL,
    ttlHours: MESSAGE_REPLY_TTL / (60 * 60 * 1000),
  };
}

export interface OutboundContext {
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  account: ResolvedQQBotAccount;
}

export interface MediaOutboundContext extends OutboundContext {
  mediaUrl: string;
}

export interface OutboundResult {
  channel: string;
  messageId?: string;
  timestamp?: string | number;
  error?: string;
}

/**
 * 解析目标地址
 * 格式：
 *   - openid (32位十六进制) -> C2C 单聊
 */
function parseTarget(to: string): { type: "c2c"; id: string } {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [qqbot] parseTarget: input=${to}`);
  
  // 去掉 qqbot: 前缀
  let id = to.replace(/^qqbot:/i, "");
  
  if (id.startsWith("c2c:")) {
    const userId = id.slice(4);
    if (!userId || userId.length === 0) {
      const error = `Invalid c2c target format: ${to} - missing user ID`;
      console.error(`[${timestamp}] [qqbot] parseTarget: ${error}`);
      throw new Error(error);
    }
    console.log(`[${timestamp}] [qqbot] parseTarget: c2c target, user ID=${userId}`);
    return { type: "c2c", id: userId };
  }
  
  // 默认当作 c2c（私聊）
  if (!id || id.length === 0) {
    const error = `Invalid target format: ${to} - empty ID after removing qqbot: prefix`;
    console.error(`[${timestamp}] [qqbot] parseTarget: ${error}`);
    throw new Error(error);
  }
  
  console.log(`[${timestamp}] [qqbot] parseTarget: default c2c target, ID=${id}`);
  return { type: "c2c", id };
}

/**
 * 发送文本消息
 * - 有 replyToId: 被动回复，1小时内最多回复5次
 * - 无 replyToId: 主动发送，有配额限制（每月4条/用户/群）
 * 
 * 注意：
 * 1. 主动消息（无 replyToId）必须有消息内容，不支持流式发送
 * 2. 当被动回复不可用（超期或超过次数）时，自动降级为主动消息
 * 3. 媒体发送请使用 `sendQQBotAction()` 或独立媒体发送函数
 */
export async function sendText(ctx: OutboundContext): Promise<OutboundResult> {
  const { to, account } = ctx;
  let { text, replyToId } = ctx;
  let fallbackToProactive = false;
  let passiveReplyRemaining = 0;
  const imStyleReplyConfig = resolveImStyleReplyConfig(account);

  console.log("[qqbot] sendText ctx:", JSON.stringify({ to, text: text?.slice(0, 50), replyToId, accountId: account.accountId }, null, 2));

  // ============ 消息回复限流检查 ============
  // 如果有 replyToId，检查是否可以被动回复
  if (replyToId) {
    const limitCheck = checkMessageReplyLimit(replyToId);
    
    if (!limitCheck.allowed) {
      // 检查是否需要降级为主动消息
      if (limitCheck.shouldFallbackToProactive) {
        console.warn(`[qqbot] sendText: 被动回复不可用，降级为主动消息 - ${limitCheck.message}`);
        fallbackToProactive = true;
        replyToId = null; // 清除 replyToId，改为主动消息
      } else {
        // 不应该发生，但作为保底
        console.error(`[qqbot] sendText: 消息回复被限流但未设置降级 - ${limitCheck.message}`);
        return { 
          channel: "qqbot", 
          error: limitCheck.message 
        };
      }
    } else {
      passiveReplyRemaining = limitCheck.remaining;
      console.log(`[qqbot] sendText: 消息 ${replyToId} 剩余被动回复次数: ${limitCheck.remaining}/${MESSAGE_REPLY_LIMIT}`);
    }
  }

  text = text ?? "";

  // ============ 主动消息校验（参考 Telegram 机制） ============
  // 如果是主动消息（无 replyToId 或降级后），必须有消息内容
  if (!replyToId) {
    if (!text || text.trim().length === 0) {
      console.error("[qqbot] sendText error: 主动消息的内容不能为空 (text is empty)");
      return { 
        channel: "qqbot", 
        error: "主动消息必须有内容 (--message 参数不能为空)" 
      };
    }
    if (fallbackToProactive) {
      console.log(`[qqbot] sendText: [降级] 发送主动消息到 ${to}, 内容长度: ${text.length}`);
    } else {
      console.log(`[qqbot] sendText: 发送主动消息到 ${to}, 内容长度: ${text.length}`);
    }
  }

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);
    console.log("[qqbot] sendText target:", JSON.stringify(target));

    if (replyToId && !containsStructuredReplyProtocol(text)) {
      const desiredParts = splitIntoImStyleParts(
        text,
        imStyleReplyConfig,
        Math.max(1, passiveReplyRemaining || 1),
      );
      if (desiredParts.length > 1) {
        console.log(`[qqbot] sendText: Using IM-style split reply (${desiredParts.length} parts)`);
        let lastResult: OutboundResult = { channel: "qqbot" };
        for (let i = 0; i < desiredParts.length; i++) {
          lastResult = await sendPlainTextMessage(accessToken, target, desiredParts[i]!, replyToId);
          if (i < desiredParts.length - 1) {
            await sleep(getImStyleDelayMs(
              imStyleReplyConfig.delayMinMs,
              imStyleReplyConfig.delayMaxMs,
              desiredParts[i]!,
            ));
          }
        }
        return lastResult;
      }
    }

    // 如果没有 replyToId，使用主动发送接口
    if (!replyToId) {
      return await sendPlainTextMessage(accessToken, target, text, null);
    }

    return await sendPlainTextMessage(accessToken, target, text, replyToId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel: "qqbot", error: message };
  }
}

/**
 * 主动发送消息（不需要 replyToId，有配额限制）
 * 
 * @param account - 账户配置
 * @param to - 目标地址，格式：openid（单聊）
 * @param text - 消息内容
 */
export async function sendProactiveMessage(
  account: ResolvedQQBotAccount,
  to: string,
  text: string
): Promise<OutboundResult> {
  const timestamp = new Date().toISOString();
  
  if (!account.appId || !account.clientSecret) {
    const errorMsg = "QQBot not configured (missing appId or clientSecret)";
    console.error(`[${timestamp}] [qqbot] sendProactiveMessage: ${errorMsg}`);
    return { channel: "qqbot", error: errorMsg };
  }

  console.log(`[${timestamp}] [qqbot] sendProactiveMessage: starting, to=${to}, text length=${text.length}, accountId=${account.accountId}`);

  try {
    console.log(`[${timestamp}] [qqbot] sendProactiveMessage: getting access token for appId=${account.appId}`);
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    
    console.log(`[${timestamp}] [qqbot] sendProactiveMessage: parsing target=${to}`);
    const target = parseTarget(to);
    console.log(`[${timestamp}] [qqbot] sendProactiveMessage: target parsed, type=${target.type}, id=${target.id}`);

    console.log(`[${timestamp}] [qqbot] sendProactiveMessage: sending proactive C2C message to user=${target.id}`);
    const result = await sendProactiveC2CMessage(accessToken, target.id, text);
    console.log(`[${timestamp}] [qqbot] sendProactiveMessage: proactive C2C message sent successfully, messageId=${result.id}`);
    return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[${timestamp}] [qqbot] sendProactiveMessage: error: ${errorMessage}`);
    console.error(`[${timestamp}] [qqbot] sendProactiveMessage: error stack: ${err instanceof Error ? err.stack : 'No stack trace'}`);
    return { channel: "qqbot", error: errorMessage };
  }
}

/**
 * 发送富媒体消息（图片）
 * 
 * 支持以下 mediaUrl 格式：
 * - 公网 URL: https://example.com/image.png
 * - Base64 Data URL: data:image/png;base64,xxxxx
 * - 本地文件路径: /path/to/image.png（自动读取并转换为 Base64）
 * 
 * @param ctx - 发送上下文，包含 mediaUrl
 * @returns 发送结果
 * 
 * @example
 * ```typescript
 * const result = await sendMedia({
 *   to: "qqbot:c2c:USER_OPENID",
 *   text: "这是图片说明",
 *   mediaUrl: "/tmp/generated-chart.png",
 *   account,
 *   replyToId: msgId,
 * });
 * ```
 */
export async function sendMedia(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account } = ctx;
  // 展开波浪线路径：~/Desktop/file.png → /Users/xxx/Desktop/file.png
  const mediaUrl = normalizePath(ctx.mediaUrl);

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  if (!mediaUrl) {
    return { channel: "qqbot", error: "mediaUrl is required for sendMedia" };
  }

  // 判断是否为语音文件（本地文件路径 + 音频扩展名）
  const isLocalPath = isLocalFilePath(mediaUrl);
  const isHttpUrl = mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://");

  if (isLocalPath && isAudioFile(mediaUrl)) {
    return sendVoiceFile(ctx);
  }

  // 判断是否为视频（公网 URL 或本地视频文件）
  if (isVideoFile(mediaUrl)) {
    if (isHttpUrl) {
      return sendVideoUrl(ctx);
    }
    if (isLocalPath) {
      return sendVideoFile(ctx);
    }
  }

  // 判断是否为文档/文件（非图片、非音频、非视频的本地文件）
  if (isLocalPath && !isImageFile(mediaUrl) && !isAudioFile(mediaUrl)) {
    return sendDocumentFile(ctx);
  }

  // === 以下为图片发送逻辑（原有逻辑） ===

  const isDataUrl = mediaUrl.startsWith("data:");
  
  let processedMediaUrl = mediaUrl;
  
  if (isLocalPath) {
    console.log(`[qqbot] sendMedia: local file path detected: ${mediaUrl}`);
    
    try {
      if (!(await fileExistsAsync(mediaUrl))) {
        return { channel: "qqbot", error: `本地文件不存在: ${mediaUrl}` };
      }
      
      // 文件大小校验
      const sizeCheck = checkFileSize(mediaUrl);
      if (!sizeCheck.ok) {
        return { channel: "qqbot", error: sizeCheck.error! };
      }
      
      const fileBuffer = await readFileAsync(mediaUrl);
      const base64Data = fileBuffer.toString("base64");
      
      const ext = path.extname(mediaUrl).toLowerCase();
      const mimeTypes: Record<string, string> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
      };
      
      const mimeType = mimeTypes[ext];
      if (!mimeType) {
        return { 
          channel: "qqbot", 
          error: `不支持的图片格式: ${ext}。支持的格式: ${Object.keys(mimeTypes).join(", ")}` 
        };
      }
      
      processedMediaUrl = `data:${mimeType};base64,${base64Data}`;
      console.log(`[qqbot] sendMedia: local file converted to Base64 (size: ${fileBuffer.length} bytes, type: ${mimeType})`);
      
    } catch (readErr) {
      const errMsg = readErr instanceof Error ? readErr.message : String(readErr);
      console.error(`[qqbot] sendMedia: failed to read local file: ${errMsg}`);
      return { channel: "qqbot", error: `读取本地文件失败: ${errMsg}` };
    }
  } else if (!isHttpUrl && !isDataUrl) {
    console.log(`[qqbot] sendMedia: unsupported media format: ${mediaUrl.slice(0, 50)}`);
    return { 
      channel: "qqbot", 
      error: `不支持的媒体格式: ${mediaUrl.slice(0, 50)}...。支持: 公网 URL、Base64 Data URL 或本地文件路径（图片/音频）。` 
    };
  } else if (isDataUrl) {
    console.log(`[qqbot] sendMedia: sending Base64 image (length: ${mediaUrl.length})`);
  } else {
    console.log(`[qqbot] sendMedia: sending image URL: ${mediaUrl.slice(0, 80)}...`);
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);

    const imageResult = await sendC2CImageMessage(
      accessToken, target.id, processedMediaUrl, replyToId ?? undefined, undefined
    );

    if (text?.trim()) {
      try {
        await sendC2CMessage(accessToken, target.id, text, replyToId ?? undefined);
      } catch (textErr) {
        console.error(`[qqbot] Failed to send text after image: ${textErr}`);
      }
    }

  return { channel: "qqbot", messageId: imageResult.id, timestamp: imageResult.timestamp };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel: "qqbot", error: message };
  }
}

/**
 * 发送语音文件消息
 * 流程类似图片发送：读取本地音频文件 → 转为 SILK Base64 → 上传 → 发送
 */
async function sendVoiceFile(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account, mediaUrl } = ctx;

  console.log(`[qqbot] sendVoiceFile: ${mediaUrl}`);

  // 等待文件就绪（TTS 工具异步生成，文件可能还没写完）
  const fileSize = await waitForFile(mediaUrl);
  if (fileSize === 0) {
    return { channel: "qqbot", error: `语音生成失败，请稍后重试` };
  }

  try {
    // 尝试转换为 SILK 格式（QQ 语音要求 SILK 格式），支持配置直传格式跳过转换
    const directFormats = account.config?.audioFormatPolicy?.uploadDirectFormats ?? account.config?.voiceDirectUploadFormats;
    const silkBase64 = await audioFileToSilkBase64(mediaUrl, directFormats);
    if (!silkBase64) {
      // 如果无法转换为 SILK，直接读取文件作为 Base64 上传（让 API 尝试处理）
      const buf = await readFileAsync(mediaUrl);
      const fallbackBase64 = buf.toString("base64");
      console.log(`[qqbot] sendVoiceFile: not SILK format, uploading raw file (${formatFileSize(buf.length)})`);

      const accessToken = await getAccessToken(account.appId!, account.clientSecret!);
      const target = parseTarget(to);

      const result = await sendC2CVoiceMessage(accessToken, target.id, fallbackBase64, replyToId ?? undefined);

      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    }

    console.log(`[qqbot] sendVoiceFile: SILK format ready, uploading...`);

    const accessToken = await getAccessToken(account.appId!, account.clientSecret!);
    const target = parseTarget(to);

    const voiceResult = await sendC2CVoiceMessage(accessToken, target.id, silkBase64, replyToId ?? undefined);

    // 如果有文本说明，再发送一条文本消息
    if (text?.trim()) {
      try {
        await sendC2CMessage(accessToken, target.id, text, replyToId ?? undefined);
      } catch (textErr) {
        console.error(`[qqbot] Failed to send text after voice: ${textErr}`);
      }
    }

    console.log(`[qqbot] sendVoiceFile: voice message sent`);
    return { channel: "qqbot", messageId: voiceResult.id, timestamp: voiceResult.timestamp };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[qqbot] sendVoiceFile: failed: ${message}`);
    return { channel: "qqbot", error: message };
  }
}

/** 判断文件是否为图片格式 */
function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext);
}

/** 判断文件/URL 是否为视频格式 */
function isVideoFile(filePath: string): boolean {
  // 去掉 URL query 参数后判断扩展名
  const cleanPath = filePath.split("?")[0]!;
  const ext = path.extname(cleanPath).toLowerCase();
  return [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"].includes(ext);
}

/**
 * 发送视频消息（公网 URL）
 */
async function sendVideoUrl(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account, mediaUrl } = ctx;

  console.log(`[qqbot] sendVideoUrl: ${mediaUrl}`);

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);

    const videoResult = await sendC2CVideoMessage(accessToken, target.id, mediaUrl, undefined, replyToId ?? undefined);

    // 如果有文本说明，再发送一条文本消息
    if (text?.trim()) {
      try {
        await sendC2CMessage(accessToken, target.id, text, replyToId ?? undefined);
      } catch (textErr) {
        console.error(`[qqbot] Failed to send text after video: ${textErr}`);
      }
    }

    console.log(`[qqbot] sendVideoUrl: video message sent`);
    return { channel: "qqbot", messageId: videoResult.id, timestamp: videoResult.timestamp };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[qqbot] sendVideoUrl: failed: ${message}`);
    return { channel: "qqbot", error: message };
  }
}

/**
 * 发送本地视频文件
 * 流程：读取本地文件 → Base64 → 上传(file_type=2) → 发送
 */
async function sendVideoFile(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account, mediaUrl } = ctx;

  console.log(`[qqbot] sendVideoFile: ${mediaUrl}`);

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  try {
    if (!(await fileExistsAsync(mediaUrl))) {
      return { channel: "qqbot", error: `视频文件不存在: ${mediaUrl}` };
    }

    // 文件大小校验
    const sizeCheck = checkFileSize(mediaUrl);
    if (!sizeCheck.ok) {
      return { channel: "qqbot", error: sizeCheck.error! };
    }

    const fileBuffer = await readFileAsync(mediaUrl);
    const videoBase64 = fileBuffer.toString("base64");
    console.log(`[qqbot] sendVideoFile: Read local video (${formatFileSize(fileBuffer.length)})`);

    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);

    const videoResult = await sendC2CVideoMessage(accessToken, target.id, undefined, videoBase64, replyToId ?? undefined);

    // 如果有文本说明，再发送一条文本消息
    if (text?.trim()) {
      try {
        await sendC2CMessage(accessToken, target.id, text, replyToId ?? undefined);
      } catch (textErr) {
        console.error(`[qqbot] Failed to send text after video: ${textErr}`);
      }
    }

    console.log(`[qqbot] sendVideoFile: video message sent`);
    return { channel: "qqbot", messageId: videoResult.id, timestamp: videoResult.timestamp };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[qqbot] sendVideoFile: failed: ${message}`);
    return { channel: "qqbot", error: message };
  }
}

/**
 * 发送文件消息
 * 流程：读取本地文件 → Base64 → 上传(file_type=4) → 发送
 * 支持本地文件路径和公网 URL
 */
async function sendDocumentFile(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account, mediaUrl } = ctx;

  console.log(`[qqbot] sendDocumentFile: ${mediaUrl}`);

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  const isHttpUrl = mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://");
  const fileName = sanitizeFileName(path.basename(mediaUrl));

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);

    if (isHttpUrl) {
      // 公网 URL：通过 url 参数上传
      console.log(`[qqbot] sendDocumentFile: uploading via URL: ${mediaUrl}`);
      var fileResult = await sendC2CFileMessage(accessToken, target.id, undefined, mediaUrl, replyToId ?? undefined, fileName);
    } else {
      // 本地文件：读取转 Base64 上传
      if (!(await fileExistsAsync(mediaUrl))) {
        return { channel: "qqbot", error: `本地文件不存在: ${mediaUrl}` };
      }

      // 文件大小校验
      const docSizeCheck = checkFileSize(mediaUrl);
      if (!docSizeCheck.ok) {
        return { channel: "qqbot", error: docSizeCheck.error! };
      }

      const fileBuffer = await readFileAsync(mediaUrl);
      if (fileBuffer.length === 0) {
        return { channel: "qqbot", error: `文件内容为空: ${mediaUrl}` };
      }

      const fileBase64 = fileBuffer.toString("base64");
      console.log(`[qqbot] sendDocumentFile: read local file (${formatFileSize(fileBuffer.length)}), uploading...`);

      var fileResult = await sendC2CFileMessage(accessToken, target.id, fileBase64, undefined, replyToId ?? undefined, fileName);
    }

    // 如果有附带文本说明，再发送一条文本消息
    if (text?.trim()) {
      try {
        await sendC2CMessage(accessToken, target.id, text, replyToId ?? undefined);
      } catch (textErr) {
        console.error(`[qqbot] Failed to send text after file: ${textErr}`);
      }
    }

    console.log(`[qqbot] sendDocumentFile: file message sent`);
    return { channel: "qqbot", messageId: fileResult.id, timestamp: fileResult.timestamp };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[qqbot] sendDocumentFile: failed: ${message}`);
    return { channel: "qqbot", error: message };
  }
}

function isImageResource(resource: string): boolean {
  if (resource.startsWith("data:image/")) {
    return true;
  }
  const clean = resource.split("?")[0]!;
  const ext = path.extname(clean).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext);
}

function isVideoResource(resource: string): boolean {
  const clean = resource.split("?")[0]!;
  const ext = path.extname(clean).toLowerCase();
  return [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"].includes(ext);
}

type RemoteMediaKind = "image" | "video" | "audio" | "file" | "unknown";

async function detectRemoteMediaKind(resource: string): Promise<RemoteMediaKind> {
  if (!(resource.startsWith("http://") || resource.startsWith("https://"))) {
    return "unknown";
  }

  const methods: Array<"HEAD" | "GET"> = ["HEAD", "GET"];

  for (const method of methods) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(resource, {
        method,
        signal: controller.signal,
        redirect: "follow",
        headers: method === "GET" ? { Range: "bytes=0-0" } : undefined,
      });

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.startsWith("image/")) {
        return "image";
      }
      if (contentType.startsWith("video/")) {
        return "video";
      }
      if (contentType.startsWith("audio/")) {
        return "audio";
      }
      if (contentType) {
        return "file";
      }
    } catch {
      // Ignore probe errors and fall through to extension-based fallback.
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return "unknown";
}

export interface QQBotSendActionContext {
  to: string;
  account: ResolvedQQBotAccount;
  cfg: Record<string, unknown>;
  message?: string;
  media?: string;
  asVoice?: boolean;
  replyToId?: string | null;
  accountId?: string | null;
}

export async function sendQQBotAction(ctx: QQBotSendActionContext): Promise<OutboundResult> {
  const text = (ctx.message ?? "").trim();
  const media = typeof ctx.media === "string" ? normalizePath(ctx.media) : "";

  if (!media) {
    if (ctx.asVoice) {
      if (!text) {
        return { channel: "qqbot", error: "QQBot voice send requires message text when media is omitted" };
      }
      const ttsCfg = resolveTTSConfig(ctx.cfg, ctx.account.accountId);
      if (!ttsCfg) {
        return { channel: "qqbot", error: "QQBot TTS is not configured" };
      }
      const ttsDir = getQQBotDataDir("tts");
      const { silkPath } = await textToSilk(text, ttsCfg, ttsDir);
      return await sendVoiceFile({
        to: ctx.to,
        text: "",
        mediaUrl: silkPath,
        accountId: ctx.accountId,
        replyToId: ctx.replyToId,
        account: ctx.account,
      });
    }

    return await sendText({
      to: ctx.to,
      text,
      accountId: ctx.accountId,
      replyToId: ctx.replyToId,
      account: ctx.account,
    });
  }

  if (ctx.asVoice) {
    if (!isLocalFilePath(media)) {
      return { channel: "qqbot", error: "QQBot voice attachments must use a local audio path" };
    }
    return await sendVoiceFile({
      to: ctx.to,
      text,
      mediaUrl: media,
      accountId: ctx.accountId,
      replyToId: ctx.replyToId,
      account: ctx.account,
    });
  }

  let remoteMediaKind: RemoteMediaKind = "unknown";
  if (!isImageResource(media) && !isVideoResource(media) && (media.startsWith("http://") || media.startsWith("https://"))) {
    remoteMediaKind = await detectRemoteMediaKind(media);
  }

  if (isImageResource(media)) {
    return await sendMedia({
      to: ctx.to,
      text,
      mediaUrl: media,
      accountId: ctx.accountId,
      replyToId: ctx.replyToId,
      account: ctx.account,
    });
  }

  if (remoteMediaKind === "image") {
    return await sendMedia({
      to: ctx.to,
      text,
      mediaUrl: media,
      accountId: ctx.accountId,
      replyToId: ctx.replyToId,
      account: ctx.account,
    });
  }

  if (isLocalFilePath(media) && isAudioFile(media)) {
    return await sendVoiceFile({
      to: ctx.to,
      text,
      mediaUrl: media,
      accountId: ctx.accountId,
      replyToId: ctx.replyToId,
      account: ctx.account,
    });
  }

  if (isVideoResource(media)) {
    const isHttpUrl = media.startsWith("http://") || media.startsWith("https://");
    const fn = isHttpUrl ? sendVideoUrl : sendVideoFile;
    return await fn({
      to: ctx.to,
      text,
      mediaUrl: media,
      accountId: ctx.accountId,
      replyToId: ctx.replyToId,
      account: ctx.account,
    });
  }

  if (remoteMediaKind === "video") {
    return await sendVideoUrl({
      to: ctx.to,
      text,
      mediaUrl: media,
      accountId: ctx.accountId,
      replyToId: ctx.replyToId,
      account: ctx.account,
    });
  }

  return await sendDocumentFile({
    to: ctx.to,
    text,
    mediaUrl: media,
    accountId: ctx.accountId,
    replyToId: ctx.replyToId,
    account: ctx.account,
  });
}
