/**
 * Shared History Module
 *
 * Provides persistent, cross-bot chat history storage.
 * All bots in the same group chat share the same history file.
 *
 * History files are stored at: ~/.openclaw/shared-history/<chatId>.jsonl
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Runtime logger (will be set via setSharedHistoryLogger)
type RuntimeLogger = {
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

let runtimeLogger: RuntimeLogger = {};

/**
 * Set the runtime logger for shared history operations
 */
export function setSharedHistoryLogger(logger: RuntimeLogger): void {
  runtimeLogger = logger;
}

export interface SharedHistoryEntry {
  timestamp: number;
  messageId: string;
  sender: string;        // openId of sender (user or bot)
  senderName?: string;   // display name
  senderType: "user" | "bot";
  botAccountId?: string; // which bot sent this (if senderType is "bot")
  body: string;
}

const HISTORY_DIR = path.join(os.homedir(), ".openclaw", "shared-history");
const MAX_HISTORY_ENTRIES = 50;

// Ensure directory exists
function ensureHistoryDir(): void {
  if (!fs.existsSync(HISTORY_DIR)) {
    try {
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
      runtimeLogger.log?.(`shared-history: created directory ${HISTORY_DIR}`);
    } catch (error) {
      runtimeLogger.error?.(`shared-history: failed to create directory ${HISTORY_DIR}: ${error}`);
      throw error;
    }
  }
}

function getHistoryFilePath(chatId: string): string {
  // Sanitize chatId for filesystem
  const safeId = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(HISTORY_DIR, `${safeId}.jsonl`);
}

/**
 * Append a history entry to the shared history file
 */
export function appendSharedHistory(chatId: string, entry: SharedHistoryEntry): void {
  try {
    ensureHistoryDir();
    const filePath = getHistoryFilePath(chatId);
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(filePath, line, "utf-8");
  } catch (error) {
    runtimeLogger.error?.(
      `shared-history: failed to append entry for chatId=${chatId}, messageId=${entry.messageId}: ${error}`
    );
    // Fail silently - don't break bot operation if history recording fails
  }
}

/**
 * Read recent history entries from the shared history file
 */
export function readSharedHistory(chatId: string, limit: number = MAX_HISTORY_ENTRIES): SharedHistoryEntry[] {
  const filePath = getHistoryFilePath(chatId);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    // Get last N entries
    const recentLines = lines.slice(-limit);

    let parseErrors = 0;
    const entries = recentLines.map((line, index) => {
      try {
        return JSON.parse(line) as SharedHistoryEntry;
      } catch (error) {
        parseErrors++;
        const lineNumber = lines.length - limit + index + 1;
        runtimeLogger.warn?.(
          `shared-history: failed to parse line ${lineNumber} in ${path.basename(filePath)}: ${error?.toString() || "Unknown error"}`
        );
        return null;
      }
    }).filter((e): e is SharedHistoryEntry => e !== null);

    if (parseErrors > 0) {
      runtimeLogger.warn?.(
        `shared-history: ${parseErrors}/${recentLines.length} lines failed to parse in ${path.basename(filePath)}`
      );
    }

    return entries;
  } catch (error) {
    runtimeLogger.error?.(
      `shared-history: failed to read history file ${path.basename(filePath)} for chatId=${chatId}: ${error}`
    );
    return [];
  }
}

/**
 * Build context string from shared history for injection into agent prompt
 */
export function buildSharedHistoryContext(
  chatId: string,
  limit: number = MAX_HISTORY_ENTRIES,
  excludeMessageId?: string
): string {
  const entries = readSharedHistory(chatId, limit);
  
  if (entries.length === 0) {
    return "";
  }
  
  // Filter out the current message if provided
  const filtered = excludeMessageId 
    ? entries.filter(e => e.messageId !== excludeMessageId)
    : entries;
  
  if (filtered.length === 0) {
    return "";
  }
  
  const lines = filtered.map(e => {
    const prefix = e.senderType === "bot" 
      ? `[Bot:${e.botAccountId ?? "unknown"}]` 
      : "[User]";
    const name = e.senderName ?? e.sender;
    return `${prefix} ${name}: ${e.body}`;
  });
  
  return `\n--- Recent Chat History (shared across all bots) ---\n${lines.join("\n")}\n--- End of History ---\n`;
}

/**
 * Record a user message to shared history
 */
export function recordUserMessage(params: {
  chatId: string;
  messageId: string;
  sender: string;
  senderName?: string;
  body: string;
}): void {
  try {
    appendSharedHistory(params.chatId, {
      timestamp: Date.now(),
      messageId: params.messageId,
      sender: params.sender,
      senderName: params.senderName,
      senderType: "user",
      body: params.body,
    });
  } catch (error) {
    // Error already logged in appendSharedHistory
    runtimeLogger.warn?.(
      `shared-history: failed to record user message for chatId=${params.chatId}, sender=${params.senderName ?? params.sender}`
    );
  }
}

/**
 * Record a bot reply to shared history
 */
export function recordBotReply(params: {
  chatId: string;
  messageId: string;
  botAccountId: string;
  botName?: string;
  body: string;
}): void {
  try {
    appendSharedHistory(params.chatId, {
      timestamp: Date.now(),
      messageId: params.messageId,
      sender: params.botAccountId,
      senderName: params.botName,
      senderType: "bot",
      botAccountId: params.botAccountId,
      body: params.body,
    });
  } catch (error) {
    // Error already logged in appendSharedHistory
    runtimeLogger.warn?.(
      `shared-history: failed to record bot reply for chatId=${params.chatId}, bot=${params.botName ?? params.botAccountId}`
    );
  }
}

