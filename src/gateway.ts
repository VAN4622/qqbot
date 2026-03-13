import WebSocket from "ws";
import path from "node:path";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import type { QQBotIMStyleReplyConfig, ResolvedQQBotAccount, WSPayload, C2CMessageEvent } from "./types.js";
import { getAccessToken, getGatewayUrl, sendC2CMessage, clearTokenCache, initApiConfig, startBackgroundTokenRefresh, stopBackgroundTokenRefresh, sendC2CInputNotify } from "./api.js";
import { loadSession, saveSession, clearSession, type SessionState } from "./session-store.js";
import { recordKnownUser, flushKnownUsers } from "./known-users.js";
import { getQQBotRuntime } from "./runtime.js";
import { startImageServer, isImageServerRunning, downloadFile, type ImageServerConfig } from "./image-server.js";
import { convertSilkToWav, isVoiceAttachment, formatDuration, resolveTTSConfig, textToSilk } from "./utils/audio-convert.js";
import { getQQBotDataDir, sanitizeFileName, runDiagnostics } from "./utils/platform.js";

/**
 * 通用 OpenAI 兼容 STT（语音转文字）
 *
 * 为什么在插件侧做 STT 而不走框架管道？
 * 框架的 applyMediaUnderstanding 同时执行 runCapability("audio") 和 extractFileBlocks。
 * 后者会把 WAV 文件的 PCM 二进制当文本注入 Body（looksLikeUtf8Text 误判），导致 context 爆炸。
 * 在插件侧完成 STT 后不把 WAV 放入 MediaPaths，即可规避此框架 bug。
 *
 * 配置解析策略（与 TTS 统一的两级回退）：
 * 1. 优先 channels.qqbot.stt（插件专属配置）
 * 2. 回退 tools.media.audio.models[0]（框架级配置）
 * 3. 再从 models.providers.[provider] 继承 apiKey/baseUrl
 * 4. 支持任何 OpenAI 兼容的 STT 服务
 */
interface STTConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function getAccountSTTBlock(cfg: Record<string, unknown>, accountId?: string | null): Record<string, any> | undefined {
  const c = cfg as any;
  if (!accountId) {
    return undefined;
  }
  return c?.channels?.qqbot?.accounts?.[accountId]?.stt;
}

function resolveSTTConfig(cfg: Record<string, unknown>, accountId?: string | null): STTConfig | null {
  const c = cfg as any;
  const accountStt = getAccountSTTBlock(cfg, accountId);

  if (accountStt !== undefined) {
    if (accountStt?.enabled === false) {
      return null;
    }

    const providerId: string = accountStt?.provider || "openai";
    const providerCfg = c?.models?.providers?.[providerId];
    const baseUrl: string | undefined = accountStt?.baseUrl || providerCfg?.baseUrl;
    const apiKey: string | undefined = accountStt?.apiKey || providerCfg?.apiKey;
    const model: string = accountStt?.model || "whisper-1";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
    }
  }

  // 优先使用 channels.qqbot.stt（插件专属配置）
  const channelStt = c?.channels?.qqbot?.stt;
  if (channelStt && channelStt.enabled !== false) {
    const providerId: string = channelStt?.provider || "openai";
    const providerCfg = c?.models?.providers?.[providerId];
    const baseUrl: string | undefined = channelStt?.baseUrl || providerCfg?.baseUrl;
    const apiKey: string | undefined = channelStt?.apiKey || providerCfg?.apiKey;
    const model: string = channelStt?.model || "whisper-1";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
    }
  }

  // 回退到 tools.media.audio.models[0]（框架级配置）
  const audioModelEntry = c?.tools?.media?.audio?.models?.[0];
  if (audioModelEntry) {
    const providerId: string = audioModelEntry?.provider || "openai";
    const providerCfg = c?.models?.providers?.[providerId];
    const baseUrl: string | undefined = audioModelEntry?.baseUrl || providerCfg?.baseUrl;
    const apiKey: string | undefined = audioModelEntry?.apiKey || providerCfg?.apiKey;
    const model: string = audioModelEntry?.model || "whisper-1";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
    }
  }

  return null;
}

async function transcribeAudio(audioPath: string, cfg: Record<string, unknown>, accountId?: string | null): Promise<string | null> {
  const sttCfg = resolveSTTConfig(cfg, accountId);
  if (!sttCfg) return null;

  const fileBuffer = fs.readFileSync(audioPath);
  const fileName = sanitizeFileName(path.basename(audioPath));
  const mime = fileName.endsWith(".wav") ? "audio/wav"
    : fileName.endsWith(".mp3") ? "audio/mpeg"
    : fileName.endsWith(".ogg") ? "audio/ogg"
    : "application/octet-stream";

  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: mime }), fileName);
  form.append("model", sttCfg.model);

  const resp = await fetch(`${sttCfg.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${sttCfg.apiKey}` },
    body: form,
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`STT failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
  }

  const result = await resp.json() as { text?: string };
  return result.text?.trim() || null;
}

const INTENTS = {
  C2C_MESSAGES: 1 << 25,
};

const INTENT_LEVELS = [
  {
    name: "c2c",
    intents: INTENTS.C2C_MESSAGES,
    description: "仅 C2C 私聊",
  },
];

// 重连配置
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000]; // 递增延迟
const RATE_LIMIT_DELAY = 60000; // 遇到频率限制时等待 60 秒
const MAX_RECONNECT_ATTEMPTS = 100;
const MAX_QUICK_DISCONNECT_COUNT = 3; // 连续快速断开次数阈值
const QUICK_DISCONNECT_THRESHOLD = 5000; // 5秒内断开视为快速断开

// 图床服务器配置（可通过环境变量覆盖）
const IMAGE_SERVER_PORT = parseInt(process.env.QQBOT_IMAGE_SERVER_PORT || "18765", 10);
// 使用绝对路径，确保文件保存和读取使用同一目录
const IMAGE_SERVER_DIR = process.env.QQBOT_IMAGE_SERVER_DIR || getQQBotDataDir("images");

// 消息队列配置（异步处理，防止阻塞心跳）
const MESSAGE_QUEUE_SIZE = 1000; // 最大队列长度（全局总量）
const PER_USER_QUEUE_SIZE = 20; // 单用户最大排队数
const MAX_CONCURRENT_USERS = 10; // 最大同时处理的用户数

// ============ 消息回复限流器 ============
// 同一 message_id 1小时内最多回复 5 次，超过1小时需降级为主动消息
const MESSAGE_REPLY_LIMIT = 5;
const MESSAGE_REPLY_TTL = 60 * 60 * 1000; // 1小时

interface MessageReplyRecord {
  count: number;
  firstReplyAt: number;
}

const messageReplyTracker = new Map<string, MessageReplyRecord>();
const PENDING_HISTORY_LIMIT = 20;
const MAX_PENDING_HISTORY_KEYS = 1000;
const PENDING_HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
const IM_STYLE_MIN_LENGTH = 48;
const IM_STYLE_MAX_PARTS = 3;
const IM_STYLE_TARGET_PART_LENGTH = 36;
const IM_STYLE_MAX_PART_LENGTH = 72;

type PendingHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
};

type PendingHistoryFile = {
  sessionKey: string;
  updatedAt: number;
  entries: PendingHistoryEntry[];
};

const pendingInboundHistories = new Map<string, PendingHistoryEntry[]>();
const pendingHistoryLoadPromises = new Map<string, Promise<PendingHistoryEntry[] | undefined>>();

function getPendingHistoryDir(): string {
  return getQQBotDataDir("history");
}

function normalizePendingHistoryKey(sessionKey: string): string {
  return sessionKey.trim().toLowerCase();
}

function getPendingHistoryFilePath(sessionKey: string): string {
  const normalizedKey = normalizePendingHistoryKey(sessionKey);
  const digest = createHash("sha256").update(normalizedKey).digest("hex");
  return path.join(getPendingHistoryDir(), `${digest}.json`);
}

function sanitizePendingHistoryEntry(entry: unknown): PendingHistoryEntry | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const sender = typeof (entry as any).sender === "string" ? (entry as any).sender.trim() : "";
  const body = typeof (entry as any).body === "string" ? (entry as any).body.trim() : "";
  if (!sender || !body) {
    return null;
  }

  const timestamp = typeof (entry as any).timestamp === "number" ? (entry as any).timestamp : undefined;
  const messageId = typeof (entry as any).messageId === "string" ? (entry as any).messageId : undefined;
  return { sender, body, timestamp, messageId };
}

async function persistPendingInboundHistory(
  sessionKey: string,
  entries: PendingHistoryEntry[],
): Promise<void> {
  const normalizedKey = normalizePendingHistoryKey(sessionKey);
  const filePath = getPendingHistoryFilePath(normalizedKey);

  if (entries.length === 0) {
    pendingInboundHistories.delete(normalizedKey);
    try {
      await fs.promises.unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }
    return;
  }

  await fs.promises.mkdir(getPendingHistoryDir(), { recursive: true });
  const payload: PendingHistoryFile = {
    sessionKey: normalizedKey,
    updatedAt: Date.now(),
    entries,
  };
  await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function evictPendingHistoryKeys(): void {
  if (pendingInboundHistories.size <= MAX_PENDING_HISTORY_KEYS) {
    return;
  }
  const overflow = pendingInboundHistories.size - MAX_PENDING_HISTORY_KEYS;
  const iterator = pendingInboundHistories.keys();
  for (let i = 0; i < overflow; i += 1) {
    const key = iterator.next().value;
    if (key !== undefined) {
      pendingInboundHistories.delete(key);
    }
  }
}

async function readPendingInboundHistory(sessionKey?: string): Promise<PendingHistoryEntry[] | undefined> {
  if (!sessionKey) {
    return undefined;
  }
  const key = normalizePendingHistoryKey(sessionKey);
  const cachedEntries = pendingInboundHistories.get(key);
  if (cachedEntries && cachedEntries.length > 0) {
    return cachedEntries.map((entry) => ({ ...entry }));
  }

  const inFlight = pendingHistoryLoadPromises.get(key);
  if (inFlight) {
    return inFlight;
  }

  const loadPromise = (async () => {
    try {
      const raw = await fs.promises.readFile(getPendingHistoryFilePath(key), "utf8");
      const parsed = JSON.parse(raw) as Partial<PendingHistoryFile>;
      const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0;
      if (Date.now() - updatedAt > PENDING_HISTORY_TTL_MS) {
        await persistPendingInboundHistory(key, []);
        return undefined;
      }

      const entries = Array.isArray(parsed.entries)
        ? parsed.entries
            .map((entry) => sanitizePendingHistoryEntry(entry))
            .filter((entry): entry is PendingHistoryEntry => Boolean(entry))
            .slice(-PENDING_HISTORY_LIMIT)
        : [];

      if (entries.length === 0) {
        await persistPendingInboundHistory(key, []);
        return undefined;
      }

      pendingInboundHistories.set(key, entries);
      evictPendingHistoryKeys();
      return entries.map((entry) => ({ ...entry }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return undefined;
      }
      if (err instanceof SyntaxError) {
        await persistPendingInboundHistory(key, []);
        return undefined;
      }
      throw err;
    } finally {
      pendingHistoryLoadPromises.delete(key);
    }
  })();

  pendingHistoryLoadPromises.set(key, loadPromise);
  return loadPromise;
}

async function appendPendingInboundHistory(params: {
  sessionKey?: string;
  entry?: PendingHistoryEntry | null;
}): Promise<void> {
  if (!params.sessionKey || !params.entry) {
    return;
  }
  const key = normalizePendingHistoryKey(params.sessionKey);
  const entries = (await readPendingInboundHistory(key)) ?? [];
  entries.push(params.entry);
  while (entries.length > PENDING_HISTORY_LIMIT) {
    entries.shift();
  }
  if (pendingInboundHistories.has(key)) {
    pendingInboundHistories.delete(key);
  }
  pendingInboundHistories.set(key, entries);
  evictPendingHistoryKeys();
  await persistPendingInboundHistory(key, entries);
}

async function clearPendingInboundHistory(sessionKey?: string): Promise<void> {
  if (!sessionKey) {
    return;
  }
  await persistPendingInboundHistory(sessionKey, []);
}

function summarizeLocalAttachmentsForHistory(mediaTypes: string[]): string | undefined {
  if (mediaTypes.length === 0) {
    return undefined;
  }

  let imageCount = 0;
  let videoCount = 0;
  let audioCount = 0;
  let fileCount = 0;

  for (const mediaType of mediaTypes) {
    if (mediaType.startsWith("image/")) {
      imageCount += 1;
    } else if (mediaType.startsWith("video/")) {
      videoCount += 1;
    } else if (mediaType.startsWith("audio/")) {
      audioCount += 1;
    } else {
      fileCount += 1;
    }
  }

  const parts: string[] = [];
  if (imageCount > 0) {
    parts.push(`${imageCount} 张图片`);
  }
  if (videoCount > 0) {
    parts.push(`${videoCount} 个视频`);
  }
  if (audioCount > 0) {
    parts.push(`${audioCount} 个音频`);
  }
  if (fileCount > 0) {
    parts.push(`${fileCount} 个文件`);
  }

  if (parts.length === 0) {
    return undefined;
  }

  return `[附件] 用户发送了 ${parts.join("、")}`;
}

function buildVisualMediaHint(mediaTypes: string[]): string | undefined {
  let imageCount = 0;
  let videoCount = 0;

  for (const mediaType of mediaTypes) {
    if (mediaType.startsWith("image/")) {
      imageCount += 1;
    } else if (mediaType.startsWith("video/")) {
      videoCount += 1;
    }
  }

  const parts: string[] = [];
  if (imageCount > 0) {
    parts.push(`${imageCount} 张图片`);
  }
  if (videoCount > 0) {
    parts.push(`${videoCount} 个视频`);
  }

  if (parts.length === 0) {
    return undefined;
  }

  return [
    `[视觉附件] 用户发送了 ${parts.join("、")}。`,
    "如果你具备多模态能力，请直接尝试理解图片或视频内容；不要机械地回复看不到、无法查看，或让用户重复描述附件内容。",
  ].join("\n");
}

/**
 * 检查是否可以回复该消息（限流检查）
 * @param messageId 消息ID
 * @returns { allowed: boolean, remaining: number } allowed=是否允许回复，remaining=剩余次数
 */
function checkMessageReplyLimit(messageId: string): { allowed: boolean; remaining: number } {
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
  
  if (!record) {
    return { allowed: true, remaining: MESSAGE_REPLY_LIMIT };
  }
  
  // 检查是否过期
  if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    messageReplyTracker.delete(messageId);
    return { allowed: true, remaining: MESSAGE_REPLY_LIMIT };
  }
  
  // 检查是否超过限制
  const remaining = MESSAGE_REPLY_LIMIT - record.count;
  return { allowed: remaining > 0, remaining: Math.max(0, remaining) };
}

/**
 * 记录一次消息回复
 * @param messageId 消息ID
 */
function recordMessageReply(messageId: string): void {
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
}

// ============ QQ 表情标签解析 ============

/**
 * 解析 QQ 表情标签，将 <faceType=1,faceId="13",ext="base64..."> 格式
 * 替换为 【表情: 中文名】 格式
 * ext 字段为 Base64 编码的 JSON，格式如 {"text":"呲牙"}
 */
function parseFaceTags(text: string): string {
  if (!text) return text;

  // 匹配 <faceType=...,faceId="...",ext="..."> 格式的表情标签
  return text.replace(/<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g, (_match, ext: string) => {
    try {
      const decoded = Buffer.from(ext, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);
      const faceName = parsed.text || "未知表情";
      return `【表情: ${faceName}】`;
    } catch {
      return _match;
    }
  });
}

// ============ 媒体发送友好错误提示 ============

/**
 * 将媒体上传/发送错误转为对用户友好的提示文案
 */
function formatMediaErrorMessage(mediaType: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("上传超时") || msg.includes("timeout") || msg.includes("Timeout")) {
    return `抱歉，${mediaType}资源加载超时，可能是网络原因或文件太大，请稍后再试～`;
  }
  if (msg.includes("文件不存在") || msg.includes("not found") || msg.includes("Not Found")) {
    return `抱歉，${mediaType}文件不存在或已失效，无法发送～`;
  }
  if (msg.includes("文件大小") || msg.includes("too large") || msg.includes("exceed")) {
    return `抱歉，${mediaType}文件太大了，超出了发送限制～`;
  }
  if (msg.includes("Network error") || msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND")) {
    return `抱歉，网络连接异常，${mediaType}发送失败，请稍后再试～`;
  }
  return `抱歉，${mediaType}发送失败了，请稍后再试～`;
}

// ============ 内部标记过滤 ============

/**
 * 过滤内部标记（如 [[reply_to: xxx]]）
 * 这些标记可能被 AI 错误地学习并输出，需要在发送前移除
 */
function filterInternalMarkers(text: string): string {
  if (!text) return text;
  
  // 过滤 [[xxx: yyy]] 格式的内部标记
  // 例如: [[reply_to: ROBOT1.0_kbc...]]
  let result = text.replace(/\[\[[a-z_]+:\s*[^\]]*\]\]/gi, "");
  
  // 清理可能产生的多余空行
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  
  return result;
}

function containsImStyleUnsafeFormatting(text: string): boolean {
  return (
    text.includes("```") ||
    /(^|\n)\s*(#{1,6}\s|[-*]\s|\d+\.\s|>\s)/.test(text)
  );
}

function resolveImStyleReplyConfig(account: ResolvedQQBotAccount): Required<QQBotIMStyleReplyConfig> {
  const cfg = account.imStyleReply ?? {};
  const fallbackDelay = Math.max(0, cfg.delayMs ?? 450);
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
      const ch = remaining[i];
      if (ch === "，" || ch === "," || ch === "、" || ch === "：" || ch === ":" || ch === " " || ch === "\t") {
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

function splitIntoImStyleParts(
  text: string,
  config: Required<QQBotIMStyleReplyConfig>,
  maxPartsOverride?: number,
): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const maxParts = Math.max(1, Math.min(config.maxParts, maxPartsOverride ?? config.maxParts));
  if (!normalized || !config.enabled || normalized.length < config.minLength || maxParts <= 1 || containsImStyleUnsafeFormatting(normalized)) {
    return normalized ? [normalized] : [];
  }

  const rawSegments: string[] = [];
  let current = "";
  for (const ch of normalized) {
    if (ch === "\n") {
      if (current.trim()) rawSegments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
    if ("。！？!?；;".includes(ch)) {
      if (current.trim()) rawSegments.push(current.trim());
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

  if (parts.length > maxParts) {
    const head = parts.slice(0, maxParts - 1);
    const tail = parts.slice(maxParts - 1).join("\n");
    return [...head, tail];
  }
  return parts;
}

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

export interface GatewayContext {
  account: ResolvedQQBotAccount;
  abortSignal: AbortSignal;
  cfg: unknown;
  onReady?: (data: unknown) => void;
  onError?: (error: Error) => void;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

/**
 * 消息队列项类型（用于异步处理消息，防止阻塞心跳）
 */
interface QueuedMessage {
  type: "c2c";
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  attachments?: Array<{ content_type: string; url: string; filename?: string; voice_wav_url?: string }>;
}

/**
 * 启动图床服务器
 */
async function ensureImageServer(log?: GatewayContext["log"], publicBaseUrl?: string): Promise<string | null> {
  if (isImageServerRunning()) {
    return publicBaseUrl || `http://0.0.0.0:${IMAGE_SERVER_PORT}`;
  }

  try {
    const config: Partial<ImageServerConfig> = {
      port: IMAGE_SERVER_PORT,
      storageDir: IMAGE_SERVER_DIR,
      // 使用用户配置的公网地址，而不是 0.0.0.0
      baseUrl: publicBaseUrl || `http://0.0.0.0:${IMAGE_SERVER_PORT}`,
      ttlSeconds: 3600, // 1 小时过期
    };
    await startImageServer(config);
    log?.info(`[qqbot] Image server started on port ${IMAGE_SERVER_PORT}, baseUrl: ${config.baseUrl}`);
    return config.baseUrl!;
  } catch (err) {
    log?.error(`[qqbot] Failed to start image server: ${err}`);
    return null;
  }
}

/**
 * 启动 Gateway WebSocket 连接（带自动重连）
 * 支持流式消息发送
 */
export async function startGateway(ctx: GatewayContext): Promise<void> {
  const { account, abortSignal, cfg, onReady, onError, log } = ctx;

  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }

  // 启动环境诊断（首次连接时执行）
  const diag = await runDiagnostics();
  if (diag.warnings.length > 0) {
    for (const w of diag.warnings) {
      log?.info(`[qqbot:${account.accountId}] ${w}`);
    }
  }

  // 初始化 API 配置（markdown 支持）
  initApiConfig({
    markdownSupport: account.markdownSupport,
  });
  log?.info(`[qqbot:${account.accountId}] API config: markdownSupport=${account.markdownSupport === true}`);
  if (account.systemPrompt?.trim()) {
    log?.info(
      `[qqbot:${account.accountId}] account.systemPrompt is deprecated and no longer injected by qqbot. Move this prompt to the OpenClaw agent/system side.`,
    );
  }

  // TTS 配置验证
  const ttsCfg = resolveTTSConfig(cfg as Record<string, unknown>, account.accountId);
  if (ttsCfg) {
    const maskedKey = ttsCfg.apiKey.length > 8
      ? `${ttsCfg.apiKey.slice(0, 4)}****${ttsCfg.apiKey.slice(-4)}`
      : "****";
    log?.info(`[qqbot:${account.accountId}] TTS configured: model=${ttsCfg.model}, voice=${ttsCfg.voice}, authStyle=${ttsCfg.authStyle ?? "bearer"}, baseUrl=${ttsCfg.baseUrl}`);
    log?.info(`[qqbot:${account.accountId}] TTS apiKey: ${maskedKey}${ttsCfg.queryParams ? `, queryParams=${JSON.stringify(ttsCfg.queryParams)}` : ""}${ttsCfg.speed !== undefined ? `, speed=${ttsCfg.speed}` : ""}`);
  } else {
    log?.info(`[qqbot:${account.accountId}] TTS not configured (voice messages will be unavailable)`);
  }

  // 如果配置了公网 URL，启动图床服务器
  let imageServerBaseUrl: string | null = null;
  if (account.imageServerBaseUrl) {
    // 使用用户配置的公网地址作为 baseUrl
    await ensureImageServer(log, account.imageServerBaseUrl);
    imageServerBaseUrl = account.imageServerBaseUrl;
    log?.info(`[qqbot:${account.accountId}] Image server enabled with URL: ${imageServerBaseUrl}`);
  } else {
    log?.info(`[qqbot:${account.accountId}] Image server disabled (no imageServerBaseUrl configured)`);
  }

  let reconnectAttempts = 0;
  let isAborted = false;
  let currentWs: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let sessionId: string | null = null;
  let lastSeq: number | null = null;
  let lastConnectTime: number = 0; // 上次连接成功的时间
  let quickDisconnectCount = 0; // 连续快速断开次数
  let isConnecting = false; // 防止并发连接
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null; // 重连定时器
  let shouldRefreshToken = false; // 下次连接是否需要刷新 token
  let intentLevelIndex = 0; // 当前尝试的权限级别索引
  let lastSuccessfulIntentLevel = -1; // 上次成功的权限级别

  // ============ P1-2: 尝试从持久化存储恢复 Session ============
  // 传入当前 appId，如果 appId 已变更（换了机器人），旧 session 自动失效
  const savedSession = loadSession(account.accountId, account.appId);
  if (savedSession) {
    sessionId = savedSession.sessionId;
    lastSeq = savedSession.lastSeq;
    intentLevelIndex = savedSession.intentLevelIndex;
    lastSuccessfulIntentLevel = savedSession.intentLevelIndex;
    log?.info(`[qqbot:${account.accountId}] Restored session from storage: sessionId=${sessionId}, lastSeq=${lastSeq}, intentLevel=${intentLevelIndex}`);
  }

  // ============ 按用户并发的消息队列（同用户串行，跨用户并行） ============
  // 每个用户有独立队列，同一用户的消息串行处理（保持时序），
  // 不同用户的消息并行处理（互不阻塞）。
  const userQueues = new Map<string, QueuedMessage[]>(); // peerId → 消息队列
  const activeUsers = new Set<string>(); // 正在处理中的用户
  let messagesProcessed = 0;
  let handleMessageFnRef: ((msg: QueuedMessage) => Promise<void>) | null = null;
  let totalEnqueued = 0; // 全局已入队总数（用于溢出保护）

  // 获取消息的路由 key（决定并发隔离粒度）
  const getMessagePeerId = (msg: QueuedMessage): string => {
    return `dm:${msg.senderId}`;
  };

  const enqueueMessage = (msg: QueuedMessage): void => {
    const peerId = getMessagePeerId(msg);
    let queue = userQueues.get(peerId);
    if (!queue) {
      queue = [];
      userQueues.set(peerId, queue);
    }

    // 单用户队列溢出保护
    if (queue.length >= PER_USER_QUEUE_SIZE) {
      const dropped = queue.shift();
      log?.error(`[qqbot:${account.accountId}] Per-user queue full for ${peerId}, dropping oldest message ${dropped?.messageId}`);
    }

    // 全局总量保护
    totalEnqueued++;
    if (totalEnqueued > MESSAGE_QUEUE_SIZE) {
      log?.error(`[qqbot:${account.accountId}] Global queue limit reached (${totalEnqueued}), message from ${peerId} may be delayed`);
    }

    queue.push(msg);
    log?.debug?.(`[qqbot:${account.accountId}] Message enqueued for ${peerId}, user queue: ${queue.length}, active users: ${activeUsers.size}`);

    // 如果该用户没有正在处理的消息，立即启动处理
    drainUserQueue(peerId);
  };

  // 处理指定用户队列中的消息（串行）
  const drainUserQueue = async (peerId: string): Promise<void> => {
    if (activeUsers.has(peerId)) return; // 该用户已有处理中的消息
    if (activeUsers.size >= MAX_CONCURRENT_USERS) {
      log?.info(`[qqbot:${account.accountId}] Max concurrent users (${MAX_CONCURRENT_USERS}) reached, ${peerId} will wait`);
      return; // 达到并发上限，等待其他用户处理完后触发
    }

    const queue = userQueues.get(peerId);
    if (!queue || queue.length === 0) {
      userQueues.delete(peerId);
      return;
    }

    activeUsers.add(peerId);

    try {
      while (queue.length > 0 && !isAborted) {
        const msg = queue.shift()!;
        totalEnqueued = Math.max(0, totalEnqueued - 1);
        try {
          if (handleMessageFnRef) {
            await handleMessageFnRef(msg);
            messagesProcessed++;
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message processor error for ${peerId}: ${err}`);
        }
      }
    } finally {
      activeUsers.delete(peerId);
      userQueues.delete(peerId);
      // 处理完后，检查是否有等待并发槽位的用户
      for (const [waitingPeerId, waitingQueue] of userQueues) {
        if (waitingQueue.length > 0 && !activeUsers.has(waitingPeerId)) {
          drainUserQueue(waitingPeerId);
          break; // 每次只唤醒一个，避免瞬间并发激增
        }
      }
    }
  };

  const startMessageProcessor = (handleMessageFn: (msg: QueuedMessage) => Promise<void>): void => {
    handleMessageFnRef = handleMessageFn;
    log?.info(`[qqbot:${account.accountId}] Message processor started (per-user concurrency, max ${MAX_CONCURRENT_USERS} users)`);
  };

  abortSignal.addEventListener("abort", () => {
    isAborted = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanup();
    // P1-1: 停止后台 Token 刷新
    stopBackgroundTokenRefresh(account.appId);
    // P1-3: 保存已知用户数据
    flushKnownUsers();
  });

  const cleanup = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (currentWs && (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING)) {
      currentWs.close();
    }
    currentWs = null;
  };

  const getReconnectDelay = () => {
    const idx = Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1);
    return RECONNECT_DELAYS[idx];
  };

  const scheduleReconnect = (customDelay?: number) => {
    if (isAborted || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log?.error(`[qqbot:${account.accountId}] Max reconnect attempts reached or aborted`);
      return;
    }

    // 取消已有的重连定时器
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const delay = customDelay ?? getReconnectDelay();
    reconnectAttempts++;
    log?.info(`[qqbot:${account.accountId}] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isAborted) {
        connect();
      }
    }, delay);
  };

  const connect = async () => {
    // 防止并发连接
    if (isConnecting) {
      log?.debug?.(`[qqbot:${account.accountId}] Already connecting, skip`);
      return;
    }
    isConnecting = true;

    try {
      cleanup();

      // 如果标记了需要刷新 token，则清除缓存
      if (shouldRefreshToken) {
        log?.info(`[qqbot:${account.accountId}] Refreshing token...`);
        clearTokenCache(account.appId);
        shouldRefreshToken = false;
      }
      
      const accessToken = await getAccessToken(account.appId, account.clientSecret);
      log?.info(`[qqbot:${account.accountId}] ✅ Access token obtained successfully`);
      const gatewayUrl = await getGatewayUrl(accessToken);

      log?.info(`[qqbot:${account.accountId}] Connecting to ${gatewayUrl}`);

      const ws = new WebSocket(gatewayUrl);
      currentWs = ws;

      const pluginRuntime = getQQBotRuntime();

      // 处理收到的消息
      const handleMessage = async (event: {
        type: "c2c";
        senderId: string;
        senderName?: string;
        content: string;
        messageId: string;
        timestamp: string;
        attachments?: Array<{ content_type: string; url: string; filename?: string; voice_wav_url?: string }>;
      }) => {

        log?.debug?.(`[qqbot:${account.accountId}] Received message: ${JSON.stringify(event)}`);
        log?.info(`[qqbot:${account.accountId}] Processing message from ${event.senderId}: ${event.content}`);
        if (event.attachments?.length) {
          log?.info(`[qqbot:${account.accountId}] Attachments: ${event.attachments.length}`);
        }

        pluginRuntime.channel.activity.record({
          channel: "qqbot",
          accountId: account.accountId,
          direction: "inbound",
        });

        // 发送输入状态提示（非关键，失败不影响主流程）
        try {
          let token = await getAccessToken(account.appId, account.clientSecret);
          try {
            await sendC2CInputNotify(token, event.senderId, event.messageId, 60);
          } catch (notifyErr) {
            const errMsg = String(notifyErr);
            if (errMsg.includes("token") || errMsg.includes("401") || errMsg.includes("11244")) {
              log?.info(`[qqbot:${account.accountId}] InputNotify token expired, refreshing...`);
              clearTokenCache(account.appId);
              token = await getAccessToken(account.appId, account.clientSecret);
              await sendC2CInputNotify(token, event.senderId, event.messageId, 60);
            } else {
              throw notifyErr;
            }
          }
          log?.info(`[qqbot:${account.accountId}] Sent input notify to ${event.senderId}`);
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] sendC2CInputNotify error: ${err}`);
        }

        const route = pluginRuntime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "qqbot",
          accountId: account.accountId,
          peer: {
            kind: "direct",
            id: event.senderId,
          },
        });
        const inboundHistory = await readPendingInboundHistory(route.sessionKey);

        const envelopeOptions = pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(cfg);

        // 组装消息体
        // 静态系统提示已移至 skills/qqbot-cron/SKILL.md 和 skills/qqbot-media/SKILL.md
        // BodyForAgent 只保留必要的动态上下文信息
        
        // ============ 用户标识信息 ============
        
        // 处理附件（图片等）- 下载到本地供 clawdbot 访问
        let attachmentInfo = "";
        const displayImageUrls: string[] = [];
        const localMediaPaths: string[] = [];
        const localMediaUrls: string[] = [];
        const localMediaTypes: string[] = [];
        const fallbackAttachmentNotes: string[] = [];
        const voiceTranscripts: string[] = [];
        // 存到 .openclaw/qqbot 目录下的 downloads 文件夹
        const downloadDir = getQQBotDataDir("downloads");
        
        if (event.attachments?.length) {
          const otherAttachments: string[] = [];
          
          for (const att of event.attachments) {
            // 修复 QQ 返回的 // 前缀 URL
            const attUrl = att.url?.startsWith("//") ? `https:${att.url}` : att.url;

            // 语音附件：优先下载 WAV（voice_wav_url），减少 SILK→WAV 转换
            const isVoice = isVoiceAttachment(att);
            let localPath: string | null = null;
            let audioPath: string | null = null; // 用于 STT 的音频路径

            if (isVoice && att.voice_wav_url) {
              const wavUrl = att.voice_wav_url.startsWith("//") ? `https:${att.voice_wav_url}` : att.voice_wav_url;
              const wavLocalPath = await downloadFile(wavUrl, downloadDir);
              if (wavLocalPath) {
                localPath = wavLocalPath;
                audioPath = wavLocalPath;
                log?.info(`[qqbot:${account.accountId}] Voice attachment: ${att.filename}, downloaded WAV directly (skip SILK→WAV)`);
              } else {
                log?.error(`[qqbot:${account.accountId}] Failed to download voice_wav_url, falling back to original URL`);
              }
            }

            // WAV 下载失败或不是语音附件：下载原始文件
            if (!localPath) {
              localPath = await downloadFile(attUrl, downloadDir, att.filename);
            }

            if (localPath) {
              if (att.content_type?.startsWith("image/")) {
                displayImageUrls.push(localPath);
                localMediaPaths.push(localPath);
                localMediaUrls.push(attUrl || localPath);
                localMediaTypes.push(att.content_type || "image/png");
              } else if (isVoice) {
                // 语音消息处理：先检查 STT 是否可用，避免无意义的转换开销
                const sttCfg = resolveSTTConfig(cfg as Record<string, unknown>, account.accountId);
                if (!sttCfg) {
                  log?.info(`[qqbot:${account.accountId}] Voice attachment: ${att.filename} (STT not configured, skipping transcription)`);
                  voiceTranscripts.push("[语音消息 - 语音识别未配置，无法转录]");
                } else {
                  // 如果还没有 WAV 路径（voice_wav_url 不可用），需要 SILK→WAV 转换
                  if (!audioPath) {
                    const sttFormats = account.config?.audioFormatPolicy?.sttDirectFormats;
                    log?.info(`[qqbot:${account.accountId}] Voice attachment: ${att.filename}, converting SILK→WAV...`);
                    try {
                      const wavResult = await convertSilkToWav(localPath, downloadDir);
                      if (wavResult) {
                        audioPath = wavResult.wavPath;
                        log?.info(`[qqbot:${account.accountId}] Voice converted: ${wavResult.wavPath} (${formatDuration(wavResult.duration)})`);
                      } else {
                        audioPath = localPath; // 转换失败，尝试用原始文件
                      }
                    } catch (convertErr) {
                      log?.error(`[qqbot:${account.accountId}] Voice conversion failed: ${convertErr}`);
                      voiceTranscripts.push("[语音消息 - 格式转换失败]");
                      continue;
                    }
                  }

                  // STT 转录
                  try {
                    const transcript = await transcribeAudio(audioPath!, cfg as Record<string, unknown>, account.accountId);
                    if (transcript) {
                      log?.info(`[qqbot:${account.accountId}] STT transcript: ${transcript.slice(0, 100)}...`);
                      voiceTranscripts.push(transcript);
                    } else {
                      log?.info(`[qqbot:${account.accountId}] STT returned empty result`);
                      voiceTranscripts.push("[语音消息 - 转录结果为空]");
                    }
                  } catch (sttErr) {
                    log?.error(`[qqbot:${account.accountId}] STT failed: ${sttErr}`);
                    voiceTranscripts.push("[语音消息 - 转录失败]");
                  }
                }
              } else {
                otherAttachments.push(`[附件: ${localPath}]`);
                localMediaPaths.push(localPath);
                localMediaUrls.push(attUrl || localPath);
                localMediaTypes.push(att.content_type || "application/octet-stream");
              }
              log?.info(`[qqbot:${account.accountId}] Downloaded attachment to: ${localPath}`);
            } else {
              // 下载失败，fallback 到原始 URL
              log?.error(`[qqbot:${account.accountId}] Failed to download: ${attUrl}`);
              if (att.content_type?.startsWith("image/")) {
                if (attUrl) {
                  displayImageUrls.push(attUrl);
                }
                fallbackAttachmentNotes.push(
                  `[附件: ${att.filename ?? att.content_type ?? "image"}] (${attUrl ? `下载失败，远程 URL: ${attUrl}` : "下载失败"})`,
                );
              } else {
                fallbackAttachmentNotes.push(
                  `[附件: ${att.filename ?? att.content_type ?? "unknown"}] (${attUrl ? `下载失败，远程 URL: ${attUrl}` : "下载失败"})`,
                );
              }
            }
          }
          
          const displayAttachmentNotes = [...otherAttachments, ...fallbackAttachmentNotes];
          if (displayAttachmentNotes.length > 0) {
            attachmentInfo += "\n" + displayAttachmentNotes.join("\n");
          }
        }
        
        // 语音转录文本注入到用户消息中
        let voiceText = "";
        let transcriptText = "";
        if (voiceTranscripts.length > 0) {
          transcriptText = voiceTranscripts.length === 1
            ? voiceTranscripts[0]
            : voiceTranscripts.map((t, i) => `[语音${i + 1}] ${t}`).join("\n");
          voiceText = voiceTranscripts.length === 1
            ? `[语音消息] ${voiceTranscripts[0]}`
            : voiceTranscripts.map((t, i) => `[语音${i + 1}] ${t}`).join("\n");
        }

        // 解析 QQ 表情标签，将 <faceType=...,ext="base64"> 替换为 【表情: 中文名】
        const parsedContent = parseFaceTags(event.content);
        const commandBody = parsedContent.trim();
        const userContent = voiceText
          ? (parsedContent.trim() ? `${parsedContent}\n${voiceText}` : voiceText) + attachmentInfo
          : parsedContent + attachmentInfo;

        // Body: 展示用的用户原文（Web UI 看到的）
        const body = pluginRuntime.channel.reply.formatInboundEnvelope({
          channel: "qqbot",
          from: event.senderName ?? event.senderId,
          timestamp: new Date(event.timestamp).getTime(),
          body: userContent,
          chatType: "direct",
          sender: {
            id: event.senderId,
            name: event.senderName,
          },
          envelope: envelopeOptions,
          ...(displayImageUrls.length > 0 ? { imageUrls: displayImageUrls } : {}),
        });
        
        // Keep the agent-facing body to the current user input only.
        const agentBodyParts: string[] = [];
        if (commandBody) {
          agentBodyParts.push(commandBody);
        }
        if (transcriptText) {
          agentBodyParts.push(`[语音转写]\n${transcriptText}`);
          agentBodyParts.push("[回复偏好]\n当前消息是语音消息；在自然且合适时，优先使用语音回复。");
        }
        const visualMediaHint = buildVisualMediaHint(localMediaTypes);
        if (visualMediaHint) {
          agentBodyParts.push(visualMediaHint);
        }
        if (agentBodyParts.length === 0 && fallbackAttachmentNotes.length > 0) {
          agentBodyParts.push(["[附件说明]", ...fallbackAttachmentNotes].join("\n"));
        }
        const agentBody = agentBodyParts.join("\n\n").trim();
        const historyBodyParts = [...agentBodyParts];
        const localAttachmentSummary = summarizeLocalAttachmentsForHistory(localMediaTypes);
        if (localAttachmentSummary) {
          historyBodyParts.push(localAttachmentSummary);
        }
        if (fallbackAttachmentNotes.length > 0) {
          historyBodyParts.push(["[附件说明]", ...fallbackAttachmentNotes].join("\n"));
        }
        const historyBody = historyBodyParts.join("\n\n").trim();

        const untrustedContext = fallbackAttachmentNotes.length > 0
          ? [["Attachment metadata (download fallback, untrusted):", ...fallbackAttachmentNotes].join("\n")]
          : undefined;

        log?.info(`[qqbot:${account.accountId}] agentBody length: ${agentBody.length}`);

        const fromAddress = `qqbot:c2c:${event.senderId}`;
        const toAddress = fromAddress;
        const nativeChannelId = event.senderId;
        const conversationLabel = `QQ DM ${event.senderId}`;

        // 计算命令授权状态
        // allowFrom: ["*"] 表示允许所有人，否则检查 senderId 是否在 allowFrom 列表中
        const allowFromList = account.config?.allowFrom ?? [];
        const allowAll = allowFromList.length === 0 || allowFromList.some((entry: string) => entry === "*");
        const commandAuthorized = allowAll || allowFromList.some((entry: string) => 
          entry.toUpperCase() === event.senderId.toUpperCase()
        );

        const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext({
          Body: body,
          BodyForAgent: agentBody,
          ...(inboundHistory ? { InboundHistory: inboundHistory } : {}),
          RawBody: event.content,
          CommandBody: commandBody,
          BodyForCommands: commandBody,
          From: fromAddress,
          To: toAddress,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: "direct",
          ConversationLabel: conversationLabel,
          SenderId: event.senderId,
          SenderName: event.senderName,
          Provider: "qqbot",
          Surface: "qqbot",
          MessageSid: event.messageId,
          Timestamp: new Date(event.timestamp).getTime(),
          NativeChannelId: nativeChannelId,
          OriginatingChannel: "qqbot",
          OriginatingTo: toAddress,
          ...(transcriptText ? { Transcript: transcriptText } : {}),
          ...(untrustedContext ? { UntrustedContext: untrustedContext } : {}),
          CommandAuthorized: commandAuthorized,
          // 传递媒体路径和 URL，使 openclaw 原生媒体处理（视觉等）能正常工作
          ...(localMediaPaths.length > 0 ? {
            MediaPaths: localMediaPaths,
            MediaPath: localMediaPaths[0],
            MediaTypes: localMediaTypes,
            MediaType: localMediaTypes[0],
            MediaUrls: localMediaUrls,
            MediaUrl: localMediaUrls[0],
          } : {}),
        });
        await appendPendingInboundHistory({
          sessionKey: route.sessionKey,
          entry: historyBody
            ? {
                sender: event.senderName ?? event.senderId,
                body: historyBody,
                timestamp: new Date(event.timestamp).getTime(),
                messageId: event.messageId,
              }
            : null,
        });

        // 发送消息的辅助函数，带 token 过期重试
        const sendWithTokenRetry = async (sendFn: (token: string) => Promise<unknown>) => {
          try {
            const token = await getAccessToken(account.appId, account.clientSecret);
            await sendFn(token);
          } catch (err) {
            const errMsg = String(err);
            // 如果是 token 相关错误，清除缓存重试一次
            if (errMsg.includes("401") || errMsg.includes("token") || errMsg.includes("access_token")) {
              log?.info(`[qqbot:${account.accountId}] Token may be expired, refreshing...`);
              clearTokenCache(account.appId);
              const newToken = await getAccessToken(account.appId, account.clientSecret);
              await sendFn(newToken);
            } else {
              throw err;
            }
          }
        };

        // 发送错误提示的辅助函数
        const sendErrorMessage = async (errorText: string) => {
          try {
            await sendWithTokenRetry(async (token) => {
              await sendC2CMessage(token, event.senderId, errorText, event.messageId);
            });
          } catch (sendErr) {
            log?.error(`[qqbot:${account.accountId}] Failed to send error message: ${sendErr}`);
          }
        };

        const imStyleReplyConfig = resolveImStyleReplyConfig(account);

        const sendPlainTextReply = async (text: string) => {
          const trimmed = text.trim();
          if (!trimmed) {
            return;
          }
          await sendWithTokenRetry(async (token) => {
            await sendC2CMessage(token, event.senderId, trimmed, event.messageId);
          });
          recordMessageReply(event.messageId);
        };

        const sendReplyTextWithImStyle = async (text: string) => {
          const trimmed = text.trim();
          if (!trimmed) {
            return;
          }

          const replyLimit = checkMessageReplyLimit(event.messageId);
          const parts = splitIntoImStyleParts(trimmed, imStyleReplyConfig, replyLimit.remaining);

          if (parts.length > 1) {
            log?.info(`[qqbot:${account.accountId}] IM-style split reply enabled (${parts.length} parts, remaining=${replyLimit.remaining}/${MESSAGE_REPLY_LIMIT})`);
          }

          for (let i = 0; i < parts.length; i++) {
            await sendPlainTextReply(parts[i]!);
            if (i < parts.length - 1 && imStyleReplyConfig.delayMs > 0) {
              await sleep(getImStyleDelayMs(
                imStyleReplyConfig.delayMinMs,
                imStyleReplyConfig.delayMaxMs,
                parts[i]!,
              ));
            }
          }
        };

        try {
          const messagesConfig = pluginRuntime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);

          // 追踪是否有响应
          let hasResponse = false;
          let historyCleared = false;
          const responseTimeout = 120000; // 120秒超时（2分钟，与 TTS/文件生成超时对齐）
          let timeoutId: ReturnType<typeof setTimeout> | null = null;
          const clearPendingHistoryOnReply = async () => {
            if (historyCleared) {
              return;
            }
            historyCleared = true;
            await clearPendingInboundHistory(route.sessionKey);
          };

          const timeoutPromise = new Promise<void>((_, reject) => {
            timeoutId = setTimeout(() => {
              if (!hasResponse) {
                reject(new Error("Response timeout"));
              }
            }, responseTimeout);
          });

          const dispatchPromise = pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              responsePrefix: messagesConfig.responsePrefix,
              deliver: async (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }, info: { kind: string }) => {
                log?.info(`[qqbot:${account.accountId}] deliver called, kind: ${info.kind}, payload keys: ${Object.keys(payload).join(", ")}`);

                // ============ 跳过工具调用的中间结果 ============
                // kind: "tool" 是 AI 调用消息工具后的中间结果，不应直接转发给用户。
                if (info.kind === "tool") {
                  log?.info(`[qqbot:${account.accountId}] Skipping tool result deliver (intermediate, not user-facing)`);
                  return;
                }
                hasResponse = true;
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }
                await clearPendingHistoryOnReply();

                let replyText = payload.text ?? "";
                
                replyText = filterInternalMarkers(replyText);
                if (replyText.trim()) {
                  try {
                    await sendReplyTextWithImStyle(replyText);
                    log?.info(`[qqbot:${account.accountId}] Sent plain text reply (${event.type})`);
                  } catch (err) {
                    log?.error(`[qqbot:${account.accountId}] Failed to send reply text: ${err}`);
                  }
                }

                pluginRuntime.channel.activity.record({
                  channel: "qqbot",
                  accountId: account.accountId,
                  direction: "outbound",
                });
              },
              onError: async (err: unknown) => {
                log?.error(`[qqbot:${account.accountId}] Dispatch error: ${err}`);
                hasResponse = true;
                await clearPendingHistoryOnReply();
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }
                
                // 发送错误提示给用户，显示完整错误信息
                const errMsg = String(err);
                if (errMsg.includes("401") || errMsg.includes("key") || errMsg.includes("auth")) {
                  await sendErrorMessage("大模型 API Key 可能无效，请检查配置");
                } else {
                  // 显示完整错误信息，截取前 500 字符
                  await sendErrorMessage(`出错: ${errMsg.slice(0, 500)}`);
                }
              },
            },
            replyOptions: {
              disableBlockStreaming: false,
            },
          });

          // 等待分发完成或超时
          try {
            await Promise.race([dispatchPromise, timeoutPromise]);
          } catch (err) {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            if (!hasResponse) {
              log?.error(`[qqbot:${account.accountId}] No response within timeout`);
              await clearPendingHistoryOnReply();
              await sendErrorMessage("QQ已经收到了你的请求并转交给了Openclaw，任务可能比较复杂，正在处理中...");
            }
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message processing failed: ${err}`);
          await clearPendingInboundHistory(route.sessionKey);
          await sendErrorMessage(`处理失败: ${String(err).slice(0, 500)}`);
        }
      };

      ws.on("open", () => {
        log?.info(`[qqbot:${account.accountId}] WebSocket connected`);
        isConnecting = false; // 连接完成，释放锁
        reconnectAttempts = 0; // 连接成功，重置重试计数
        lastConnectTime = Date.now(); // 记录连接时间
        // 启动消息处理器（异步处理，防止阻塞心跳）
        startMessageProcessor(handleMessage);
        // P1-1: 启动后台 Token 刷新
        startBackgroundTokenRefresh(account.appId, account.clientSecret, {
          log: log as { info: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void },
        });
      });

      ws.on("message", async (data) => {
        try {
          const rawData = data.toString();
          const payload = JSON.parse(rawData) as WSPayload;
          const { op, d, s, t } = payload;

          if (s) {
            lastSeq = s;
            // P1-2: 更新持久化存储中的 lastSeq（节流保存）
            if (sessionId) {
              saveSession({
                sessionId,
                lastSeq,
                lastConnectedAt: lastConnectTime,
                intentLevelIndex: lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex,
                accountId: account.accountId,
                savedAt: Date.now(),
                appId: account.appId,
              });
            }
          }

          log?.debug?.(`[qqbot:${account.accountId}] Received op=${op} t=${t}`);

          switch (op) {
            case 10: // Hello
              log?.info(`[qqbot:${account.accountId}] Hello received`);
              
              // 如果有 session_id，尝试 Resume
              if (sessionId && lastSeq !== null) {
                log?.info(`[qqbot:${account.accountId}] Attempting to resume session ${sessionId}`);
                ws.send(JSON.stringify({
                  op: 6, // Resume
                  d: {
                    token: `QQBot ${accessToken}`,
                    session_id: sessionId,
                    seq: lastSeq,
                  },
                }));
              } else {
                // 新连接，发送 Identify
                // 如果有上次成功的级别，直接使用；否则从当前级别开始尝试
                const levelToUse = lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex;
                const intentLevel = INTENT_LEVELS[Math.min(levelToUse, INTENT_LEVELS.length - 1)];
                log?.info(`[qqbot:${account.accountId}] Sending identify with intents: ${intentLevel.intents} (${intentLevel.description})`);
                ws.send(JSON.stringify({
                  op: 2,
                  d: {
                    token: `QQBot ${accessToken}`,
                    intents: intentLevel.intents,
                    shard: [0, 1],
                  },
                }));
              }

              // 启动心跳
              const interval = (d as { heartbeat_interval: number }).heartbeat_interval;
              if (heartbeatInterval) clearInterval(heartbeatInterval);
              heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ op: 1, d: lastSeq }));
                  log?.debug?.(`[qqbot:${account.accountId}] Heartbeat sent`);
                }
              }, interval);
              break;

            case 0: // Dispatch
              if (t === "READY") {
                const readyData = d as { session_id: string };
                sessionId = readyData.session_id;
                // 记录成功的权限级别
                lastSuccessfulIntentLevel = intentLevelIndex;
                const successLevel = INTENT_LEVELS[intentLevelIndex];
                log?.info(`[qqbot:${account.accountId}] Ready with ${successLevel.description}, session: ${sessionId}`);
                // P1-2: 保存新的 Session 状态
                saveSession({
                  sessionId,
                  lastSeq,
                  lastConnectedAt: Date.now(),
                  intentLevelIndex,
                  accountId: account.accountId,
                  savedAt: Date.now(),
                  appId: account.appId,
                });
                onReady?.(d);
              } else if (t === "RESUMED") {
                log?.info(`[qqbot:${account.accountId}] Session resumed`);
                // P1-2: 更新 Session 连接时间
                if (sessionId) {
                  saveSession({
                    sessionId,
                    lastSeq,
                    lastConnectedAt: Date.now(),
                    intentLevelIndex: lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex,
                    accountId: account.accountId,
                    savedAt: Date.now(),
                    appId: account.appId,
                  });
                }
              } else if (t === "C2C_MESSAGE_CREATE") {
                const event = d as C2CMessageEvent;
                // P1-3: 记录已知用户
                recordKnownUser({
                  openid: event.author.user_openid,
                  type: "c2c",
                  accountId: account.accountId,
                });
                // 使用消息队列异步处理，防止阻塞心跳
                enqueueMessage({
                  type: "c2c",
                  senderId: event.author.user_openid,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  attachments: event.attachments,
                });
              }
              break;

            case 11: // Heartbeat ACK
              log?.debug?.(`[qqbot:${account.accountId}] Heartbeat ACK`);
              break;

            case 7: // Reconnect
              log?.info(`[qqbot:${account.accountId}] Server requested reconnect`);
              cleanup();
              scheduleReconnect();
              break;

            case 9: // Invalid Session
              const canResume = d as boolean;
              const currentLevel = INTENT_LEVELS[intentLevelIndex];
              log?.error(`[qqbot:${account.accountId}] Invalid session (${currentLevel.description}), can resume: ${canResume}, raw: ${rawData}`);
              
              if (!canResume) {
                sessionId = null;
                lastSeq = null;
                // P1-2: 清除持久化的 Session
                clearSession(account.accountId);
                
                // 尝试降级到下一个权限级别
                if (intentLevelIndex < INTENT_LEVELS.length - 1) {
                  intentLevelIndex++;
                  const nextLevel = INTENT_LEVELS[intentLevelIndex];
                  log?.info(`[qqbot:${account.accountId}] Downgrading intents to: ${nextLevel.description}`);
                } else {
                  // 已经是最低权限级别了
                  log?.error(`[qqbot:${account.accountId}] All intent levels failed. Please check AppID/Secret.`);
                  shouldRefreshToken = true;
                }
              }
              cleanup();
              // Invalid Session 后等待一段时间再重连
              scheduleReconnect(3000);
              break;
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message parse error: ${err}`);
        }
      });

      ws.on("close", (code, reason) => {
        log?.info(`[qqbot:${account.accountId}] WebSocket closed: ${code} ${reason.toString()}`);
        isConnecting = false; // 释放锁
        
        // 根据错误码处理（参考 QQ 官方文档）
        // 4004: CODE_INVALID_TOKEN - Token 无效，需刷新 token 重新连接
        // 4006: CODE_SESSION_NO_LONGER_VALID - 会话失效，需重新 identify
        // 4007: CODE_INVALID_SEQ - Resume 时 seq 无效，需重新 identify
        // 4008: CODE_RATE_LIMITED - 限流断开，等待后重连
        // 4009: CODE_SESSION_TIMED_OUT - 会话超时，需重新 identify
        // 4900-4913: 内部错误，需要重新 identify
        // 4914: 机器人已下架
        // 4915: 机器人已封禁
        if (code === 4914 || code === 4915) {
          log?.error(`[qqbot:${account.accountId}] Bot is ${code === 4914 ? "offline/sandbox-only" : "banned"}. Please contact QQ platform.`);
          cleanup();
          // 不重连，直接退出
          return;
        }
        
        // 4004: Token 无效，强制刷新 token 后重连
        if (code === 4004) {
          log?.info(`[qqbot:${account.accountId}] Invalid token (4004), will refresh token and reconnect`);
          shouldRefreshToken = true;
          cleanup();
          if (!isAborted) {
            scheduleReconnect();
          }
          return;
        }
        
        // 4008: 限流断开，等待后重连（不需要重新 identify）
        if (code === 4008) {
          log?.info(`[qqbot:${account.accountId}] Rate limited (4008), waiting ${RATE_LIMIT_DELAY}ms before reconnect`);
          cleanup();
          if (!isAborted) {
            scheduleReconnect(RATE_LIMIT_DELAY);
          }
          return;
        }
        
        // 4006/4007/4009: 会话失效或超时，需要清除 session 重新 identify
        if (code === 4006 || code === 4007 || code === 4009) {
          const codeDesc: Record<number, string> = {
            4006: "session no longer valid",
            4007: "invalid seq on resume",
            4009: "session timed out",
          };
          log?.info(`[qqbot:${account.accountId}] Error ${code} (${codeDesc[code]}), will re-identify`);
          sessionId = null;
          lastSeq = null;
          // 清除持久化的 Session
          clearSession(account.accountId);
          shouldRefreshToken = true;
        } else if (code >= 4900 && code <= 4913) {
          // 4900-4913 内部错误，清除 session 重新 identify
          log?.info(`[qqbot:${account.accountId}] Internal error (${code}), will re-identify`);
          sessionId = null;
          lastSeq = null;
          // 清除持久化的 Session
          clearSession(account.accountId);
          shouldRefreshToken = true;
        }
        
        // 检测是否是快速断开（连接后很快就断了）
        const connectionDuration = Date.now() - lastConnectTime;
        if (connectionDuration < QUICK_DISCONNECT_THRESHOLD && lastConnectTime > 0) {
          quickDisconnectCount++;
          log?.info(`[qqbot:${account.accountId}] Quick disconnect detected (${connectionDuration}ms), count: ${quickDisconnectCount}`);
          
          // 如果连续快速断开超过阈值，等待更长时间
          if (quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
            log?.error(`[qqbot:${account.accountId}] Too many quick disconnects. This may indicate a permission issue.`);
            log?.error(`[qqbot:${account.accountId}] Please check: 1) AppID/Secret correct 2) Bot permissions on QQ Open Platform`);
            quickDisconnectCount = 0;
            cleanup();
            // 快速断开太多次，等待更长时间再重连
            if (!isAborted && code !== 1000) {
              scheduleReconnect(RATE_LIMIT_DELAY);
            }
            return;
          }
        } else {
          // 连接持续时间够长，重置计数
          quickDisconnectCount = 0;
        }
        
        cleanup();
        
        // 非正常关闭则重连
        if (!isAborted && code !== 1000) {
          scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        log?.error(`[qqbot:${account.accountId}] WebSocket error: ${err.message}`);
        onError?.(err);
      });

    } catch (err) {
      isConnecting = false; // 释放锁
      const errMsg = String(err);
      log?.error(`[qqbot:${account.accountId}] Connection failed: ${err}`);
      
      // 如果是频率限制错误，等待更长时间
      if (errMsg.includes("Too many requests") || errMsg.includes("100001")) {
        log?.info(`[qqbot:${account.accountId}] Rate limited, waiting ${RATE_LIMIT_DELAY}ms before retry`);
        scheduleReconnect(RATE_LIMIT_DELAY);
      } else {
        scheduleReconnect();
      }
    }
  };

  // 开始连接
  await connect();

  // 等待 abort 信号
  return new Promise((resolve) => {
    abortSignal.addEventListener("abort", () => resolve());
  });
}
