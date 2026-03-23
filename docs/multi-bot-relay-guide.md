# 多机器人 Relay 系统使用指南

> 基于 V2EX 帖子 / GitHub PR #340 的功能实现

## 1. 功能概述

多机器人 Relay 系统解决了飞书平台的一个根本限制：**飞书的 Bot 发送的消息不会触发其他 Bot 的 `message_receive_v1` 事件**。

这意味着：
- ✅ 用户 @ Bot → Bot 收到事件 → Bot 回复
- ❌ BotA @ BotB → BotB 收不到任何事件

Relay 系统通过**应用层合成事件**来模拟 Bot 之间的通信，让多个 Agent 可以组成协作团队。

## 2. 系统架构

### 2.1 核心组件

| 文件 | 功能 |
|------|------|
| `src/bot-relay.ts` | Bot 注册、@mention 解析、合成事件触发 |
| `src/shared-history.ts` | 跨 Bot 聊天记录共享（JSONL 持久化） |
| `src/reply-dispatcher.ts` | Bot 回复后触发 relay |
| `src/monitor.ts` | 启动时注册所有 Bot |
| `src/bot.ts` | 消息处理，注入共享历史和队友信息 |

### 2.2 数据流

```
用户消息 → monitor.ts (启动时注册 bot)
                ↓
         bot.ts (处理消息)
                ↓
    buildSharedHistoryContext() ← shared-history.ts (读取共享历史)
    getTeammatesContext()       ← bot-relay.ts (获取可用队友)
                ↓
         Agent 处理
                ↓
    reply-dispatcher.ts
                ↓
    recordBotReply()             ← shared-history.ts (记录回复)
    triggerBotRelay()           ← bot-relay.ts (触发被 @ 的 bot)
                ↓
    send.ts (发送消息)
                ↓
         如果消息中有 @ 其他 bot
                ↓
    bot-relay.ts 创建合成事件
                ↓
    被 @ 的 bot 收到"合成事件" → 触发该 bot 的消息处理流程
```

## 3. 配置要求

### 3.1 多账号配置

每个 Bot 需要配置独立的 account：

```yaml
channels:
  feishu:
    # 顶层默认配置
    appId: "cli_main"
    appSecret: "main_secret"
    connectionMode: "websocket"
    
    # 为每个 bot 创建独立账号
    accounts:
      tech-lead:
        appId: "cli_tech_lead"
        appSecret: "tech_lead_secret"
        name: "Tech Lead"
      ios-dev:
        appId: "cli_ios_dev"
        appSecret: "ios_dev_secret"
        name: "iOS助手"
      golang-dev:
        appId: "cli_golang_dev"
        appSecret: "golang_dev_secret"
        name: "Go助手"
```

### 3.2 Bot Specialties 配置

在 `bot-relay.ts` 中定义了默认的 Bot 专业领域：

```typescript
const BOT_SPECIALTIES: Record<string, string> = {
  "tech-lead-bot": "技术决策、任务分配、架构讨论",
  "ios-bot": "iOS、Swift、SwiftUI 开发",
  "golang-bot": "Go、后端、API、数据库",
  "default": "通用助手",
};

const BOT_DISPLAY_NAMES: Record<string, string> = {
  "tech-lead-bot": "Tech Lead",
  "ios-bot": "iOS助手",
  "golang-bot": "Go助手",
  "default": "助手",
};
```

可根据实际账号 ID 修改这些配置。

## 4. @mention 格式

### 4.1 正确的格式

要让 Relay 系统解析 @mention，**必须使用特定格式**：

```xml
<at user_id="ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx">Go助手</at>
```

### 4.2 Agent 提示词示例

系统会自动向每个 Agent 注入可用队友列表，格式如下：

```
## 🤝 群内可用的 AI 队友

你可以 @mention 以下队友来协作：

| 队友 | 专长 | @mention 格式 |
|------|------|---------------|
| **Go助手** | Go、后端、API、数据库 | `<at user_id="ou_xxx">Go助手</at>` |

### 4.3 如何触发队友

在 Agent 的回复中直接写入 mention 格式：

````
这个问题需要 Go 专家来解答，<at user_id="ou_xxxxxxxx">Go助手</at> 请帮忙分析。
````

⚠️ **重要**：必须使用 `<at user_id="...">` 格式，纯文本 `@名字` 不会触发队友！

## 5. 共享历史机制

### 5.1 存储位置

```
~/.openclaw/shared-history/<chatId>.jsonl
```

每个群聊有一个独立的 JSONL 文件，最多保留 50 条记录。

### 5.2 历史记录格式

```json
{"timestamp":1710000000000,"messageId":"xxx","sender":"ou_xxx","senderName":"张三","senderType":"user","body":"用户消息"}
{"timestamp":1710000001000,"messageId":"bot_xxx","sender":"tech-lead","senderName":"Tech Lead","senderType":"bot","botAccountId":"tech-lead","body":"Bot 回复内容"}
```

### 5.3 上下文注入

当 Agent 处理消息时，系统会注入类似以下的上下文：

```
--- Recent Chat History (shared across all bots) ---
[Bot:tech-lead] Tech Lead: 这是 Tech Lead 的分析
[Bot:golang-dev] Go助手: 好的，我来帮你查一下
[User] 张三: 谢谢！
--- End of History ---
```

这样每个 Bot 都能看到其他 Bot 的回复，保持上下文连贯性。

## 6. 合成事件机制

### 6.1 事件创建

当 BotA @ BotB 时，`triggerBotRelay()` 会创建合成事件：

```typescript
const syntheticEvent: FeishuMessageEvent = {
  message: {
    message_id: `synthetic_${Date.now()}_${targetAccountId}`,
    chat_id: chatId,
    chat_type: "group",
    message_type: "text",
    content: JSON.stringify({ text: messageText }),
    mentions: [{ id: { open_id: mention.openId }, name: mention.name }],
  },
  sender: {
    sender_id: { open_id: `bot_${sourceAccountId}` },
    sender_type: "bot",
  },
  _synthetic: true,
  _sourceBot: sourceAccountId,
  _sourceBotName: sourceBotName,
};
```

### 6.2 事件处理

合成事件通过 `handleFeishuMessage()` 直接调用消息处理函数，被 @ 的 Bot 会像收到普通用户消息一样处理。

## 7. 典型使用场景

### 7.1 Multi-Agent 团队协作

```
用户提问 → Tech Lead 分析 → @mention 专家 → 专家回复 → 专家之间互相讨论
```

1. 用户在群里提问
2. Tech Lead Bot 分析问题，决定需要哪些专家协助
3. Tech Lead 回复中 @mention Go助手
4. Go助手 收到合成事件，处理请求并回复
5. 如果需要 iOS 专家，Go助手 可以在回复中 @mention iOS助手
6. 所有 Bot 的对话都会被记录到共享历史

### 7.2 避免 Ping-Pong 问题

由于飞书的限制，Bot 在非 mention 模式下也会忽略其他机器人发的消息。因此使用 mention 模式可以精确控制哪个 Bot 应该响应，避免无限循环。

## 8. 限制与注意事项

1. **飞书平台限制**：Bot 之间的消息不会触发 `message_receive_v1` 事件，这是飞书设计层面限制，无法通过 API 绕过

2. **Mention 格式**：必须使用 `<at user_id="ou_xxx">名字</at>` 格式，纯文本 @名字 不会触发

3. **Bot 注册**：每个账号需要在 `accounts` 中配置，且需要单独配置 appId/appSecret

4. **共享历史**：存储在 `~/.openclaw/shared-history/`，每个群聊最多 50 条记录

5. **合成事件标记**：通过 `_synthetic: true` 标记，可以通过此属性识别合成事件进行特殊处理

## 9. 相关文件索引

| 文件路径 | 说明 |
|----------|------|
| `src/bot-relay.ts` | 核心 Relay 模块 |
| `src/shared-history.ts` | 共享历史模块 |
| `src/reply-dispatcher.ts` | 回复分发（触发 relay） |
| `src/monitor.ts` | 启动注册 Bot |
| `src/bot.ts` | 消息处理（注入上下文） |
| `docs/project-analysis.md` | 项目架构分析 |

## 10. 参考资料

- V2EX 帖子: https://www.v2ex.com/t/1194837
- GitHub PR: https://github.com/m1heng/clawdbot-feishu/pull/340
- Fork 仓库: https://github.com/Alenryuichi/clawdbot-feishu
