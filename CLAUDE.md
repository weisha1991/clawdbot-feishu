# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Feishu/Lark (飞书) plugin for [OpenClaw](https://github.com/openclaw/openclaw).

It provides:
- Feishu channel integration (receive events, route messages, send replies/media/cards)
- Feishu tool integrations (`feishu_doc`, `feishu_wiki`, `feishu_drive`, `feishu_perm`, `feishu_bitable`, `feishu_task`)

## Development

This is a TypeScript ESM project. No build step is required - the plugin is loaded directly as `.ts` files by OpenClaw.

```bash
# Install dependencies
npm install

# Type check
npx tsc --noEmit

# Run unit tests
npm run test:unit

# Run tests with coverage
npm run test:coverage

# Run a single test file
npx vitest run src/__tests__/mention.test.ts

# Run tests in watch mode
npm run test:unit:watch

# CI check (typecheck + coverage)
npm run ci:check
```

## Architecture

### Entry Point
- `index.ts` - Plugin registration entry
  - Registers Feishu channel plugin (`api.registerChannel`)
  - Registers Feishu tools (doc/wiki/drive/perm/bitable/task)
  - Exports public helpers (`monitorFeishuProvider`, send/media/reaction/mention utilities)

### Core Modules (src/)

**Channel Runtime (Connection + Events + Replies):**
- `channel.ts` - Main `ChannelPlugin` implementation (capabilities, config/account lifecycle, onboarding, directory, outbound, status)
- `client.ts` - Feishu SDK client factory (REST + WebSocket client + event dispatcher)
- `monitor.ts` - Event monitor bootstrap
  - Supports both `websocket` and `webhook` modes
  - Supports multi-account startup (all enabled accounts)
- `bot.ts` - Incoming event handler
  - Message deduplication
  - DM/group policy checks
  - Mention parsing and forward-mention logic
  - Inbound media/resource resolution
  - Optional dynamic agent creation for DMs
- `reply-dispatcher.ts` - Agent reply dispatch (render mode `auto/raw/card`, chunking, typing indicator integration)
- `send.ts` - Text messages, interactive cards, message editing
- `media.ts` - Upload/download images and files, inbound media resource fetch

**Configuration, Accounts, Policy:**
- `config-schema.ts` - Zod schema definitions for Feishu config
- `accounts.ts` - Account resolution and merged config logic (top-level defaults + account overrides)
- `policy.ts` - DM/group allowlist and mention policy resolution
- `tools-config.ts` - Default tool switches (`doc/wiki/drive/scopes` on, `perm` off)
- `types.ts` - TypeScript types inferred from config/schema

**Multi-Bot Relay (experimental):**
- `bot-relay.ts` - Bot-to-bot communication via @mentions in group chats
  - Enables bots to trigger each other via synthetic events
  - Provides dynamic teammate discovery for agents
  - Trigger mechanism: `parseMentionTags()` parses `<at user_id="ou_xxx">Name</at>` from bot reply text, then `triggerBotRelay()` creates synthetic events for matched bots
  - Bot specialty and display name are hardcoded in `BOT_SPECIALTIES` / `BOT_DISPLAY_NAMES` (requires code change to add new bots)
- `shared-history.ts` - Persistent cross-bot chat history storage
  - All bots in the same group share history via `~/.openclaw/shared-history/<chatId>.jsonl`
  - History is injected into agent context via `buildSharedHistoryContext()` (only in group chats)
  - `shared-history.ts` uses `runtimeLogger` for error logging (set via `setSharedHistoryLogger()` in `bot.ts`)
  - Known limitations: no file locking (concurrent writes may corrupt JSONL), files grow unbounded (MAX_HISTORY_ENTRIES only limits reads), JSON parse errors are logged but entries silently skipped

**Feishu Tool Modules (each follows `actions.ts / schemas.ts / register.ts / common.ts / index.ts` pattern):**
- `doc-tools/` - Document read/write, markdown conversion (`feishu_doc`)
- `wiki-tools/` - Wiki space/node operations (`feishu_wiki`)
- `drive-tools/` - Drive file/folder operations (`feishu_drive`)
- `perm-tools/` - Drive permission member operations (`feishu_perm`)
- `bitable-tools/` - Bitable (多维表格) record/field operations (`feishu_bitable_*`)
- `task-tools/` - Task v2 API operations (`feishu_task_*`)

**Tool Infrastructure:**
- `tools-common/tool-exec.ts` - Tool account resolution, client wrapper
- `tools-common/tool-context.ts` - AsyncLocalStorage context for message-driven tools
- `tools-common/feishu-api.ts` - Shared Feishu API helpers

**Supporting Utilities:**
- `targets.ts` - Normalize `user:xxx`/`chat:xxx` target formats
- `directory.ts` - User/group lookup
- `reactions.ts` - Emoji reactions API
- `typing.ts` - Typing indicator (emoji-based)
- `probe.ts` - Bot health check
- `mention.ts` - Mention extraction/formatting and mention-forward helpers
- `dynamic-agent.ts` - Auto-create dedicated DM agents (workspace + binding updates)
- `onboarding.ts` - Channel onboarding adapter
- `runtime.ts` - Plugin runtime holder/getter

### Message Flow

1. `monitor.ts` resolves enabled account(s) and starts event listener in `websocket` or `webhook` mode.
2. Feishu event dispatcher routes `im.message.receive_v1` to `bot.ts`.
3. `bot.ts` validates policies, parses mentions/content, optionally resolves media resources.
4. `bot.ts` dispatches to OpenClaw runtime using `reply-dispatcher.ts`.
5. `reply-dispatcher.ts` chooses render path (`raw` text vs markdown card) and sends via `send.ts`.

### Skills Directory

The `skills/` directory contains tool-specific documentation for agents:
- `skills/feishu-doc/` - Document tool usage guide
- `skills/feishu-drive/` - Drive tool usage guide
- `skills/feishu-wiki/` - Wiki tool usage guide
- `skills/feishu-perm/` - Permission tool usage guide
- `skills/feishu-task/` - Task tool usage guide

### Key Configuration Options

| Option | Description |
|--------|-------------|
| `connectionMode` | `websocket` (default) or `webhook` |
| `accounts` | Multi-account config map; account config overrides top-level defaults |
| `dmPolicy` | `pairing` / `open` / `allowlist` |
| `groupPolicy` | `open` / `allowlist` / `disabled` |
| `requireMention` | Require @bot in groups (default: true) |
| `renderMode` | Reply render mode: `auto` / `raw` / `card` |
| `dynamicAgentCreation` | Auto-create isolated DM agents/workspaces |
| `tools` | Tool category switches (`doc`, `wiki`, `drive`, `perm`, `scopes`) |

### Defaults

- `connectionMode`: `websocket`
- `dmPolicy`: `pairing`
- `groupPolicy`: `allowlist`
- `requireMention`: `true`
- Tool defaults: `doc/wiki/drive/scopes: true`, `perm: false`

### Feishu SDK Usage

Uses `@larksuiteoapi/node-sdk`. Key APIs:
- `client.im.message.create/reply/get/patch` - Message operations
- `client.im.messageResource.get` - Download media
- `client.im.image.create / client.im.file.create` - Upload media
- `client.docx.*` - Document operations
- `client.wiki.*` / `client.drive.*` / `client.bitable.*` - Resource operations
- `WSClient` + `Lark.adaptDefault(...)` - WebSocket and webhook event delivery

## Plugin Installation

The plugin is installed to OpenClaw via link mode (directly references the source directory):

```bash
# Install from local source (link mode - code changes take effect on restart)
openclaw plugins install /path/to/clawdbot-feishu --link

# Verify installation
openclaw plugins list | grep feishu
openclaw plugins inspect m1heng-feishu
```

Config is stored in `~/.openclaw/openclaw.json` under `plugins.installs.m1heng-feishu`.

## Multi-Bot Relay Design Notes

Detailed analysis and improvement plans are documented in `docs/multi-bot-relay-improvements.md`.

Key points for future development:
- The relay trigger depends on agents outputting `<at user_id="ou_xxx">Name</at>` format — if agents don't follow this convention, relay will not fire
- `bot-relay.ts` holds module-level global state (`botRegistry`, `relayConfig`, `relayRuntime`) that is set during `registerBotForRelay()` in `monitor.ts`
- Synthetic events are marked with `_synthetic: true` and processed through the same `handleFeishuMessage()` path as real user events
- Bot replies are recorded to shared history in `reply-dispatcher.ts` (only for group chats where `chatId.startsWith("oc_")`)
