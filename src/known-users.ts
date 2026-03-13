/**
 * 已知用户存储
 * 仅记录与机器人发生过 C2C 私聊交互的用户。
 */

import fs from "node:fs";
import path from "node:path";
import { getQQBotDataDir } from "./utils/platform.js";

export interface KnownUser {
  openid: string;
  type: "c2c";
  nickname?: string;
  accountId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  interactionCount: number;
}

const KNOWN_USERS_DIR = getQQBotDataDir("data");
const KNOWN_USERS_FILE = path.join(KNOWN_USERS_DIR, "known-users.json");

let usersCache: Map<string, KnownUser> | null = null;
const SAVE_THROTTLE_MS = 5000;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let isDirty = false;

function ensureDir(): void {
  if (!fs.existsSync(KNOWN_USERS_DIR)) {
    fs.mkdirSync(KNOWN_USERS_DIR, { recursive: true });
  }
}

function loadUsersFromFile(): Map<string, KnownUser> {
  if (usersCache !== null) {
    return usersCache;
  }

  usersCache = new Map();

  try {
    if (fs.existsSync(KNOWN_USERS_FILE)) {
      const data = fs.readFileSync(KNOWN_USERS_FILE, "utf-8");
      const users = JSON.parse(data) as KnownUser[];
      for (const user of users) {
        const key = makeUserKey(user.accountId, user.openid);
        usersCache.set(key, user);
      }
      console.log(`[known-users] Loaded ${usersCache.size} users`);
    }
  } catch (err) {
    console.error(`[known-users] Failed to load users: ${err}`);
    usersCache = new Map();
  }

  return usersCache;
}

function saveUsersToFile(): void {
  if (!isDirty || saveTimer) {
    return;
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    doSaveUsersToFile();
  }, SAVE_THROTTLE_MS);
}

function doSaveUsersToFile(): void {
  if (!usersCache || !isDirty) {
    return;
  }

  try {
    ensureDir();
    const users = Array.from(usersCache.values());
    fs.writeFileSync(KNOWN_USERS_FILE, JSON.stringify(users, null, 2), "utf-8");
    isDirty = false;
  } catch (err) {
    console.error(`[known-users] Failed to save users: ${err}`);
  }
}

export function flushKnownUsers(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  doSaveUsersToFile();
}

function makeUserKey(accountId: string, openid: string): string {
  return `${accountId}:c2c:${openid}`;
}

export function recordKnownUser(user: {
  openid: string;
  type: "c2c";
  nickname?: string;
  accountId: string;
}): void {
  const cache = loadUsersFromFile();
  const key = makeUserKey(user.accountId, user.openid);
  const now = Date.now();
  const existing = cache.get(key);

  if (existing) {
    existing.lastSeenAt = now;
    existing.interactionCount += 1;
    if (user.nickname && user.nickname !== existing.nickname) {
      existing.nickname = user.nickname;
    }
  } else {
    cache.set(key, {
      openid: user.openid,
      type: "c2c",
      nickname: user.nickname,
      accountId: user.accountId,
      firstSeenAt: now,
      lastSeenAt: now,
      interactionCount: 1,
    });
    console.log(`[known-users] New user: ${user.openid} (c2c)`);
  }

  isDirty = true;
  saveUsersToFile();
}

export function getKnownUser(
  accountId: string,
  openid: string,
  type: "c2c" = "c2c",
): KnownUser | undefined {
  if (type !== "c2c") {
    return undefined;
  }
  return loadUsersFromFile().get(makeUserKey(accountId, openid));
}

export function listKnownUsers(options?: {
  accountId?: string;
  type?: "c2c";
  activeWithin?: number;
  limit?: number;
  sortBy?: "lastSeenAt" | "firstSeenAt" | "interactionCount";
  sortOrder?: "asc" | "desc";
}): KnownUser[] {
  const cache = loadUsersFromFile();
  let users = Array.from(cache.values());

  if (options?.accountId) {
    users = users.filter((u) => u.accountId === options.accountId);
  }
  if (options?.type && options.type !== "c2c") {
    return [];
  }
  if (options?.activeWithin) {
    const cutoff = Date.now() - options.activeWithin;
    users = users.filter((u) => u.lastSeenAt >= cutoff);
  }

  const sortBy = options?.sortBy ?? "lastSeenAt";
  const sortOrder = options?.sortOrder ?? "desc";
  users.sort((a, b) => {
    const aVal = a[sortBy] ?? 0;
    const bVal = b[sortBy] ?? 0;
    return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
  });

  if (options?.limit && options.limit > 0) {
    users = users.slice(0, options.limit);
  }

  return users;
}

export function getKnownUsersStats(accountId?: string): {
  totalUsers: number;
  c2cUsers: number;
  activeIn24h: number;
  activeIn7d: number;
} {
  const users = listKnownUsers({ accountId });
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  return {
    totalUsers: users.length,
    c2cUsers: users.length,
    activeIn24h: users.filter((u) => now - u.lastSeenAt < day).length,
    activeIn7d: users.filter((u) => now - u.lastSeenAt < 7 * day).length,
  };
}

export function removeKnownUser(
  accountId: string,
  openid: string,
  type: "c2c" = "c2c",
): boolean {
  if (type !== "c2c") {
    return false;
  }
  const cache = loadUsersFromFile();
  const key = makeUserKey(accountId, openid);
  if (!cache.has(key)) {
    return false;
  }
  cache.delete(key);
  isDirty = true;
  saveUsersToFile();
  console.log(`[known-users] Removed user ${openid}`);
  return true;
}

export function clearKnownUsers(accountId?: string): number {
  const cache = loadUsersFromFile();
  let count = 0;

  if (accountId) {
    for (const [key, user] of cache.entries()) {
      if (user.accountId === accountId) {
        cache.delete(key);
        count += 1;
      }
    }
  } else {
    count = cache.size;
    cache.clear();
  }

  if (count > 0) {
    isDirty = true;
    doSaveUsersToFile();
    console.log(`[known-users] Cleared ${count} users`);
  }

  return count;
}
