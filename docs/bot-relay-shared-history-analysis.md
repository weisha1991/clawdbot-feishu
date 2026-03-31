# bot-relay.ts 与 shared-history.ts 深度分析

## 1. 架构概览

**`bot-relay.ts`** — Bot-to-Bot 接力模块 (238 行)
- **模式**: 服务注册表 + 合成事件分发器
- **用途**: 当一个机器人在群聊中 @mention 另一个机器人时，创建合成事件触发被 @ 的机器人，使其如同收到用户消息一样处理。

**`shared-history.ts`** — 跨 Bot 聊天历史模块 (149 行)
- **模式**: 追加写入的 JSONL 文件存储
- **用途**: 同一群聊中的所有机器人共享历史文件 (`~/.openclaw/shared-history/<chatId>.jsonl`)，让每个机器人都能了解群聊中之前的对话内容。

---

## 2. 程序流程图

### 2.1 整体架构流程

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           Bot Relay 系统架构                                      │
└─────────────────────────────────────────────────────────────────────────────────┘

                              ┌──────────────────┐
                              │   全局状态存储    │
                              ├──────────────────┤
                              │ botRegistry: Map │  ← Bot 注册表 (openId → BotInfo)
                              │ relayConfig      │  ← ClawdbotConfig 引用
                              │ relayRuntime     │  ← RuntimeEnv 引用
                              │ relayChatHistories│ ← 聊天历史引用
                              └────────┬─────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        │                              │                              │
        ▼                              ▼                              ▼
┌───────────────┐            ┌───────────────┐            ┌───────────────┐
│  注册阶段      │            │  查询阶段      │            │  触发阶段      │
│ (启动时)       │            │ (消息处理时)    │            │ (回复后)       │
└───────┬───────┘            └───────┬───────┘            └───────┬───────┘
        │                            │                            │
        ▼                            ▼                            ▼
registerBotForRelay()    getTeammatesContext()       triggerBotRelay()
unregisterBotFromRelay() isBotOpenId()               parseMentionTags()
                         getBotAccountId()
```

### 2.2 启动注册流程

```
┌─────────────────────────────────────────────────────────────────┐
│                        monitor.ts 启动                           │
│                   (遍历所有启用的 accounts)                       │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                   registerBotForRelay(params)                    │
├─────────────────────────────────────────────────────────────────┤
│  输入:                                                           │
│    - accountId: string      (账号 ID, 如 "cto", "builder")       │
│    - botOpenId: string      (飞书 Bot 的 openId)                 │
│    - cfg: ClawdbotConfig    (全局配置)                           │
│    - runtime: RuntimeEnv    (运行时环境)                          │
│    - chatHistories: Map     (聊天历史引用)                        │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │ 构建 BotInfo 对象       │
                    ├───────────────────────┤
                    │ accountId: 账号 ID     │
                    │ openId: Bot 的 openId  │
                    │ name: 显示名称          │
                    │ specialty: 专业领域    │
                    └───────────┬───────────┘
                                │
                ┌───────────────┴───────────────┐
                ▼                               ▼
    ┌───────────────────┐           ┌───────────────────┐
    │ BOT_DISPLAY_NAMES │           │ BOT_SPECIALTIES   │
    │ (硬编码配置表)      │           │ (硬编码配置表)     │
    └───────────────────┘           └───────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────┐
│                     更新全局状态                                  │
├─────────────────────────────────────────────────────────────────┤
│  1. botRegistry.set(openId, botInfo)   // 注册 Bot              │
│  2. relayConfig = cfg                   // 保存配置引用          │
│  3. relayRuntime = runtime              // 保存运行时引用        │
│  4. relayChatHistories = chatHistories  // 保存历史引用          │
│  5. runtime.log("registered {accountId}")                       │
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 消息处理阶段 (查询队友信息)

```
┌─────────────────────────────────────────────────────────────────┐
│                         bot.ts 消息处理                          │
│                   handleFeishuMessage()                          │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                  getTeammatesContext(accountId)                  │
│                    (注入 Agent prompt)                           │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │ 从 botRegistry 获取    │
                    │ 所有注册的 Bot          │
                    └───────────┬───────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │ 过滤掉当前 Bot          │
                    │ (excludeAccountId)     │
                    └───────────┬───────────┘
                                │
                    ┌───────────┴───────────┐
                    │ 队友列表为空?           │
                    └───────────┬───────────┘
                          │           │
                    是 ◄───┘           └───► 否
                          │                 │
                          ▼                 ▼
                    ┌───────────┐   ┌───────────────────────┐
                    │ return "" │   │ 构建 Markdown 表格     │
                    └───────────┘   └───────────┬───────────┘
                                              │
                                              ▼
                              ┌─────────────────────────────────┐
                              │ ## 🤝 群内可用的 AI 队友          │
                              │                                  │
                              │ | 队友 | 专长 | @mention 格式 |  │
                              │ |------|------|---------------|  │
                              │ | BotA | XX  | `<at...` |      │
                              │ | BotB | YY  | `<at...` |      │
                              │                                  │
                              │ ⚠️ 必须使用 <at user_id="...">  │
                              └─────────────────────────────────┘
                                              │
                                              ▼
                              ┌─────────────────────────────────┐
                              │     返回格式化字符串             │
                              │   (注入到 Agent 系统提示)        │
                              └─────────────────────────────────┘
```

### 2.4 触发 Relay 流程 (核心)

```
┌─────────────────────────────────────────────────────────────────┐
│                   reply-dispatcher.ts                           │
│              (Bot 回复发送后调用)                                 │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                   triggerBotRelay(params)                        │
├─────────────────────────────────────────────────────────────────┤
│  输入:                                                           │
│    - sourceAccountId: string   (发送方 Bot 账号 ID)              │
│    - sourceBotName: string     (发送方 Bot 名称)                 │
│    - chatId: string            (群聊 ID)                         │
│    - messageText: string       (回复文本内容)                     │
│    - originalMessageId?: string                                    │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │ relayConfig 或         │
                    │ relayChatHistories     │
                    │ 为 null?               │
                    └───────────┬───────────┘
                          │           │
                    是 ◄───┘           └───► 否
                          │                 │
                          ▼                 ▼
                    ┌───────────┐   ┌───────────────────────┐
                    │  return   │   │ parseMentionTags()    │
                    │  (静默)   │   │ 解析 @mention 标签     │
                    └───────────┘   └───────────┬───────────┘
                                              │
                                              ▼
                              ┌─────────────────────────────────┐
                              │  正则匹配:                       │
                              │  /<at\s+user_id="(ou_[a-f0-9]+)"│
                              │   [^>]*>([^<]*)<\/at>/gi        │
                              │                                  │
                              │  提取: [{ openId, name }, ...]   │
                              └───────────────┬─────────────────┘
                                              │
                                              ▼
                              ┌─────────────────────────────────┐
                              │   mentions = [{openId, name}]   │
                              └───────────────┬─────────────────┘
                                              │
                                              ▼
                              ┌─────────────────────────────────┐
                              │   botMentions = mentions        │
                              │     .filter(m =>                │
                              │       isBotOpenId(m.openId))    │
                              │                                  │
                              │   (过滤出注册过的 Bot)            │
                              └───────────────┬─────────────────┘
                                              │
                                              ▼
                              ┌─────────────────────────────────┐
                              │      botMentions.length > 0?    │
                              └───────────────┬─────────────────┘
                                    │               │
                              否 ◄───┘               └───► 是
                                    │                     │
                                    ▼                     ▼
                              ┌───────────┐   ┌───────────────────────┐
                              │  return   │   │ 遍历每个 botMention   │
                              └───────────┘   └───────────┬───────────┘
                                                        │
                                                        ▼
                              ┌─────────────────────────────────────────┐
                              │            创建合成事件                   │
                              │         syntheticEvent                   │
                              ├─────────────────────────────────────────┤
                              │  message: {                              │
                              │    message_id: "synthetic_{ts}_{accId}" │
                              │    chat_id: chatId                       │
                              │    chat_type: "group"                    │
                              │    message_type: "text"                  │
                              │    content: JSON.stringify({text})       │
                              │    mentions: [{openId, name}]            │
                              │  }                                       │
                              │  sender: {                               │
                              │    sender_id: { open_id: srcBotOpenId } │
                              │    sender_type: "bot"                    │
                              │  }                                       │
                              │  _synthetic: true     ← 标记为合成事件    │
                              │  _sourceBot: sourceAccountId             │
                              │  _sourceBotName: sourceBotName           │
                              └───────────────────────┬─────────────────┘
                                                      │
                                                      ▼
                              ┌─────────────────────────────────────────┐
                              │    handleFeishuMessage({                 │
                              │      cfg: relayConfig,                  │
                              │      event: syntheticEvent,             │
                              │      botOpenId: mention.openId,         │
                              │      runtime: relayRuntime,             │
                              │      chatHistories: relayChatHistories, │
                              │      accountId: targetAccountId,        │
                              │    })                                    │
                              │                                          │
                              │    ↓ 被触发的 Bot 执行完整消息处理流程 ↓   │
                              └───────────────────────┬─────────────────┘
                                                      │
                                              ┌───────┴───────┐
                                              │               │
                                              ▼               ▼
                                        ┌──────────┐   ┌──────────┐
                                        │ 成功     │   │ 失败     │
                                        │ log()    │   │ error()  │
                                        └──────────┘   └──────────┘
```

### 2.5 完整端到端流程

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              完整 Bot Relay 流程                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

  时间线
    │
    │  [启动阶段]
    │
    ▼
┌─────────┐     registerBotForRelay()     ┌───────────────────┐
│monitor.ts│──────────────────────────────►│  botRegistry      │
│ (Bot A)  │                               │  Map<openId,Info> │
└─────────┘                               └───────────────────┘
                                                ▲
┌─────────┐     registerBotForRelay()           │
│monitor.ts│─────────────────────────────────────┘
│ (Bot B)  │
└─────────┘
    │
    │  [用户消息阶段]
    │
    ▼
┌─────────┐                                ┌───────────────────┐
│ 用户    │─── @BotA 问题 ─────────────────►│  bot.ts           │
│         │                                 │  handleFeishuMsg  │
└─────────┘                                 └─────────┬─────────┘
                                                      │
                                                      ▼
                                            ┌───────────────────┐
                                            │getTeammatesContext│
                                            │ (注入队友信息)     │
                                            └─────────┬─────────┘
                                                      │
                                                      ▼
                                            ┌───────────────────┐
                                            │     Agent 处理    │
                                            │   (BotA 生成回复)  │
                                            └─────────┬─────────┘
                                                      │
    │  [回复阶段]                                     │
    │                                                 ▼
    ▼                                           ┌───────────────────┐
┌─────────┐                                     │reply-dispatcher.ts│
│ Bot A   │◄────── 发送回复 ─────────────────────│                   │
│ 回复    │      "我来分析...                    └─────────┬─────────┘
│         │       <at user_id="BotB_openId">              │
│         │         BotB</at> 请帮忙"                     │
└─────────┘                                               │
                                                          ▼
                                                ┌───────────────────┐
                                                │  triggerBotRelay  │
                                                └─────────┬─────────┘
                                                          │
                                                          ▼
                                                ┌───────────────────┐
                                                │parseMentionTags() │
                                                │ → [{BotB_openId}] │
                                                └─────────┬─────────┘
                                                          │
    │  [Relay 触发阶段]                                    │
    │                                                     ▼
    ▼                                           ┌───────────────────┐
┌─────────────────┐                             │  创建合成事件      │
│ syntheticEvent  │                             │  _synthetic: true │
│ {               │◄────────────────────────────│  sender: BotA     │
│   _synthetic,   │                             └─────────┬─────────┘
│   _sourceBot,   │                                       │
│   message,      │                                       │
│   sender        │                                       │
│ }               │                                       ▼
└────────┬────────┘                             ┌───────────────────┐
         │                                      │handleFeishuMessage│
         └─────────────────────────────────────►│ (BotB 的处理函数) │
                                                └─────────┬─────────┘
                                                          │
                                                          ▼
                                                ┌───────────────────┐
                                                │getTeammatesContext│
                                                │ (BotB 看到队友)   │
                                                └─────────┬─────────┘
                                                          │
                                                          ▼
                                                ┌───────────────────┐
                                                │     Agent 处理    │
                                                │   (BotB 生成回复)  │
                                                └─────────┬─────────┘
                                                          │
    │  [Bot B 回复阶段]                                    │
    │                                                     ▼
    ▼
┌─────────┐
│ Bot B   │◄────── 发送回复 ───────────────────────────────┘
│ 回复    │      "收到，我来处理 Go 部分..."
└─────────┘
```

### 2.6 函数调用关系图

```
                    ┌─────────────────────────────────────────────────────────────┐
                    │                      bot-relay.ts 导出函数                   │
                    └─────────────────────────────────────────────────────────────┘


    ┌─────────────────────────────────────────────────────────────────────────────────────┐
    │                                     导出函数                                          │
    ├─────────────────────────────────────────────────────────────────────────────────────┤
    │                                                                                      │
    │   ┌─────────────────────┐         ┌─────────────────────┐                           │
    │   │ registerBotForRelay │         │unregisterBotFromRelay│                          │
    │   │    (注册 Bot)        │         │    (注销 Bot)        │                          │
    │   └──────────┬──────────┘         └─────────────────────┘                           │
    │              │                                                                        │
    │              ▼                                                                        │
    │   ┌──────────────────────────────────────────────────────────┐                       │
    │   │                    botRegistry: Map                       │                       │
    │   │                (模块级全局状态存储)                         │                       │
    │   └──────────────────────────────────────────────────────────┘                       │
    │              │                                                                        │
    │              ▼                                                                        │
    │   ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐          │
    │   │  getTeammatesContext │  │   isBotOpenId       │  │  getBotAccountId    │          │
    │   │  (获取队友上下文)     │  │  (检查是否为 Bot)    │  │  (获取账号 ID)       │          │
    │   └─────────────────────┘  └─────────────────────┘  └─────────────────────┘          │
    │              │                       │                        │                       │
    │              └───────────────────────┴────────────────────────┘                       │
    │                                      │                                               │
    │                                      ▼                                               │
    │                          ┌─────────────────────┐                                     │
    │                          │   getBotInfo        │                                     │
    │                          │  (获取 Bot 信息)     │                                     │
    │                          └─────────────────────┘                                     │
    │                                                                                      │
    │   ┌─────────────────────────────────────────────────────────────────────────────┐   │
    │   │                           triggerBotRelay                                    │   │
    │   │                         (核心触发函数)                                        │   │
    │   └─────────────────────────────────────────────────────────────────────────────┘   │
    │                                      │                                               │
    │              ┌───────────────────────┼───────────────────────┐                       │
    │              ▼                       ▼                       ▼                       │
    │   ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐          │
    │   │  parseMentionTags   │  │   isBotOpenId       │  │ handleFeishuMessage │          │
    │   │  (解析 @mention)     │  │  (过滤 Bot)         │  │ (触发目标 Bot)       │          │
    │   └─────────────────────┘  └─────────────────────┘  │    ← 来自 bot.ts   │          │
    │                                                      └─────────────────────┘          │
    │                                                                                      │
    │   ┌─────────────────────┐                                                            │
    │   │  getRegisteredBots  │                                                            │
    │   │  (获取所有 Bot)      │                                                            │
    │   └─────────────────────┘                                                            │
    │                                                                                      │
    └─────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.7 关键数据结构

```
┌─────────────────────────────────────────────────────────────────┐
│                         BotInfo 接口                             │
├─────────────────────────────────────────────────────────────────┤
│  interface BotInfo {                                             │
│    accountId: string;     // 账号 ID (如 "cto", "builder")       │
│    openId: string;        // 飞书 Bot 的 openId (ou_xxx)         │
│    name: string;          // 显示名称                            │
│    specialty?: string;    // 专业领域描述                        │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     SyntheticEvent 结构                          │
├─────────────────────────────────────────────────────────────────┤
│  {                                                               │
│    message: {                                                    │
│      message_id: "synthetic_1710000000000_cto",                  │
│      chat_id: "oc_xxx",                                          │
│      chat_type: "group",                                         │
│      message_type: "text",                                       │
│      content: "{\"text\":\"...\"}",                              │
│      mentions: [{ id: { open_id }, name, key }]                  │
│    },                                                            │
│    sender: {                                                     │
│      sender_id: { open_id: "ou_source_bot" },                    │
│      sender_type: "bot"                                          │
│    },                                                            │
│    _synthetic: true,         // ← 合成事件标记                   │
│    _sourceBot: "builder",    // ← 来源 Bot accountId             │
│    _sourceBotName: "Builder" // ← 来源 Bot 显示名                │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘
```

### 2.8 消息处理入口 `handleFeishuMessage()`

所有消息处理都从 `handleFeishuMessage()` 入口开始，有两个调用来源：

#### 两个调用来源

| 来源 | 文件位置 | 触发场景 |
|------|----------|----------|
| 真实事件 | `monitor.ts:65` | 用户发送消息 (WebSocket/Webhook) |
| 合成事件 | `bot-relay.ts:217` | Bot 被 @mention 触发 |

#### 入口流程图

```
┌─────────────────────────────────────────────────────────────────┐
│                     消息处理入口                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┴───────────────────┐
          ▼                                       ▼
┌─────────────────────┐               ┌─────────────────────┐
│   真实用户消息       │               │   合成 Bot 消息      │
│                     │               │                     │
│  monitor.ts:65      │               │  bot-relay.ts:217   │
│  (WebSocket/        │               │  (triggerBotRelay)  │
│   Webhook 事件)     │               │                     │
└──────────┬──────────┘               └──────────┬──────────┘
           │                                     │
           └─────────────────┬───────────────────┘
                             ▼
              ┌───────────────────────────────┐
              │   handleFeishuMessage()       │
              │   src/bot.ts:736              │
              │                               │
              │   - 解析消息内容               │
              │   - 检查策略 (DM/群聊)         │
              │   - 注入共享历史               │
              │   - 注入队友信息 ← 只在群聊    │
              │   - 分发到 Agent              │
              └───────────────────────────────┘
```

#### 真实事件 vs 合成事件

| 特征 | 真实事件 | 合成事件 |
|------|----------|----------|
| 来源 | 飞书服务器 | `triggerBotRelay()` |
| `sender_type` | `"user"` | `"bot"` |
| `_synthetic` | 无 | `true` |
| `replyToMessageId` | 有 | `undefined` (不回复) |

### 2.9 `getTeammatesContext()` 注入时机

#### 调用位置

`src/bot.ts` 第 1225-1231 行，在 `handleFeishuMessage()` 函数内部：

```typescript
// Inject available teammates info (for bot-to-bot collaboration)
if (isGroup) {  // ← 只在群聊中注入
  const teammatesInfo = getTeammatesContext(account.accountId);
  if (teammatesInfo) {
    combinedBody = combinedBody + "\n" + teammatesInfo;
  }
}
```

#### 触发条件

| 条件 | 是否注入 |
|------|----------|
| 用户在群聊中发消息 | ✅ 是 |
| 用户在群聊中 @Bot | ✅ 是 |
| 用户发送私信 (DM) | ❌ 否 |
| 其他 Bot 通过 relay 触发 (合成事件) | ✅ 是 (群聊) |

#### 注入顺序

在 `combinedBody` 构建过程中，顺序为：

```
1. 共享历史 (buildSharedHistoryContext) - 其他 Bot 的回复记录
       ↓
2. 当前消息内容 (combinedBody)
       ↓
3. 队友信息 (getTeammatesContext) ← 只在群聊
       ↓
4. dispatchReplyFromConfig() → Agent 处理
```

#### 关键点

1. **只在群聊注入**: `if (isGroup)` 限制了只有群聊场景才会注入队友信息
2. **合成事件也会触发**: 当 BotA @ BotB 时，BotB 收到合成事件后也会看到队友信息（包括 BotA）
3. **排除自己**: `getTeammatesContext(account.accountId)` 会排除当前 Bot 自己，所以每个 Bot 只能看到其他队友

---

## 3. 关键组件

### `bot-relay.ts` 导出函数

| 导出 | 用途 |
|------|------|
| `registerBotForRelay()` | monitor.ts 启动时调用，将 Bot 信息存入 `botRegistry` 并设置全局引用 |
| `unregisterBotFromRelay()` | 关闭时清理 |
| `getTeammatesContext()` | 返回格式化的 Markdown 表格，列出所有其他机器人（注入 Agent prompt） |
| `parseMentionTags()` | 正则提取 `<at user_id="ou_xxx">Name</at>` 格式的 @mention |
| `triggerBotRelay()` | 为每个被 @mention 的机器人创建合成 FeishuMessageEvent 并调用 handleFeishuMessage() |
| `getRegisteredBots()` | 返回所有已注册机器人的 openIds/accountIds |

**合成事件结构** (第 197-214 行):
```typescript
const syntheticEvent: FeishuMessageEvent = {
  message: {
    message_id: `synthetic_${Date.now()}_${targetAccountId}`,
    chat_id: chatId,
    chat_type: "group",
    message_type: "text",
    content: JSON.stringify({ text: messageText }),  // ← text 被包装成对象
    mentions: [{ id: { open_id: mention.openId }, name: mention.name, key: "@_user_1" }],
  },
  sender: {
    sender_id: { open_id: srcBotOpenId ?? "" },
    sender_type: "bot",
  },
  _synthetic: true,          // ← 标记为合成事件
  _sourceBot: sourceAccountId,
  _sourceBotName: sourceBotName,
}
```

### `shared-history.ts` 导出函数

| 导出 | 用途 |
|------|------|
| `appendSharedHistory()` | 将 SharedHistoryEntry 追加到 JSONL 文件 |
| `readSharedHistory()` | 从 JSONL 文件读取最近 N 条记录 |
| `buildSharedHistoryContext()` | 将历史格式化为 `[Bot:accountId] name: body` 字符串供 Agent 使用 |
| `recordUserMessage()` | 用户消息的便捷封装 |
| `recordBotReply()` | 机器人回复的便捷封装 |

**SharedHistoryEntry 结构**:
```typescript
interface SharedHistoryEntry {
  timestamp: number;
  messageId: string;
  sender: string;        // 发送者的 openId
  senderName?: string;
  senderType: "user" | "bot";
  botAccountId?: string;
  body: string;
}
```

---

## 4. `bot.ts` 对合成事件的处理

在 `bot.ts` 第 765-772 行：
```typescript
const isSyntheticEvent = (event as any)._synthetic === true;
const syntheticSourceBot = (event as any)._sourceBotName as string | undefined;

// 对于合成事件，直接使用源机器人名称
// 以避免跨应用 openId 解析错误
let senderResult: Awaited<ReturnType<typeof resolveFeishuSenderName>> = {};
if (isSyntheticEvent && syntheticSourceBot) {
  ctx = { ...ctx, senderName: syntheticSourceBot };
}
```

**关键设计**: 合成事件跳过发送者名称解析（跨 Bot openId 解析可能失败），直接使用源机器人的显示名称。

---

## 5. 潜在问题与观察

### 问题 1: `shared-history.ts` 没有文件锁

使用 `fs.appendFileSync()` 而无文件锁。如果两个机器人同时写入同一 JSONL 文件：

```typescript
// 机器人 A 和 B 同时调用 appendSharedHistory()
fs.appendFileSync(filePath, lineA + lineB, "utf-8");  // 可能交错写入！
```

**风险**: JSONL 文件损坏、条目丢失或解析错误。

### 问题 2: 历史文件永不截断

`MAX_HISTORY_ENTRIES = 50` 仅影响**读取**（通过 slice），不影响写入。文件会无限增长：

```typescript
// getHistoryFilePath 仅做 chatId  sanitize，但文件无限增长
const recentLines = lines.slice(-limit);  // 只有读取被限制
```

### 问题 3: 静默丢弃格式错误的行

`readSharedHistory()` 中，格式错误的 JSON 被静默丢弃：

```typescript
return recentLines.map(line => {
  try {
    return JSON.parse(line) as SharedHistoryEntry;
  } catch {
    return null;  // 静默失败，无日志
  }
}).filter((e): e is SharedHistoryEntry => e !== null);
```

单行损坏会导致后续所有行解析异常（虽然 filter 会移除 null，但没有日志提示数据丢失）。

### 问题 4: `bot-relay.ts` 中的全局状态

```typescript
let relayConfig: ClawdbotConfig | null = null;
let relayRuntime: RuntimeEnv | null = null;
let relayChatHistories: Map<string, HistoryEntry[]> | null = null;
```

如果 monitor 关闭后调用 `triggerBotRelay()`（引用已过时），会静默无操作：

```typescript
if (!relayConfig || !relayChatHistories) {
  return;  // 静默无操作
}
```

### 问题 5: 合成事件缺少可选字段

`FeishuMessageEvent` 类型定义了一些可选字段，但合成事件未填充：

- `sender.tenant_key` (optional) — 未设置
- `message.root_id` / `parent_id` (optional) — 未设置
- `message.mentions[].tenant_key` (optional) — 未设置

这些对于接力处理可能不需要，但相对于类型定义是不完整的。

### 问题 6: `BOT_SPECIALTIES` / `BOT_DISPLAY_NAMES` 是硬编码的

```typescript
const BOT_SPECIALTIES: Record<string, string> = {
  "cos-muliao-zhang": "技术决策、任务分配、架构讨论",
  "cto": "iOS、Swift、SwiftUI 开发",
  "builder": "Go、后端、API、数据库",
  "main": "通用助手",
};
```

新增机器人需要修改代码。

---

## 6. 设计优点

1. **职责清晰分离**: `bot-relay` 处理跨 Bot 触发；`shared-history` 处理持久化。两者是正交的。
2. **队友上下文注入**: `getTeammatesContext()` 返回 Agent 可直接理解并使用的格式化 Markdown。
3. **合成事件标记**: `_synthetic` + `_sourceBotName` 标记设计优雅——绕过名称解析但不破坏现有逻辑。
4. **JSONL 格式**: 追加写入简单且崩溃安全（优于读-改-写）。

---

## 7. 总结

| 模块 | 职责 | 主要风险 |
|------|------|----------|
| `bot-relay.ts` | 通过合成事件实现跨 Bot @mention 接力 | 全局状态过期、Bot 配置硬编码 |
| `shared-history.ts` | 通过 JSONL 实现跨 Bot 共享聊天历史 | 无文件锁、文件无限增长 |

这两个模块协同工作，使多机器人群聊成为可能——机器人可以互相 @mention 并看到对话历史，营造协作式 AI 团队体验。
