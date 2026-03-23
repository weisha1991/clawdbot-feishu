# clawdbot-feishu 项目分析

> 版本: 0.1.14 | 类型: TypeScript ESM OpenClaw 插件

## 1. 项目概述

**clawdbot-feishu** 是 [OpenClaw](https://github.com/openclaw/openclaw) 的飞书/Lark 频道插件，提供:

- 飞书渠道集成 (接收事件、路由消息、发送回复/媒体/卡片)
- 飞书工具集成 (`feishu_doc`, `feishu_wiki`, `feishu_drive`, `feishu_perm`, `feishu_bitable`, `feishu_task_*`)

### 技术栈

| 技术 | 用途 |
|------|------|
| TypeScript ESM | 源码编写方式, 无构建步骤 |
| `@larksuiteoapi/node-sdk` | 飞书 API SDK (REST + WebSocket) |
| `zod` / `@sinclair/typebox` | 配置验证和工具参数 schema |
| `vitest` | 单元测试框架 |
| `openclaw` | 插件运行时 (peerDependency) |

---

## 2. 目录结构

```
clawdbot-feishu/
├── index.ts                     # 插件入口, 注册 channel + 所有 tools
├── package.json                 # ESM 包, vitest 测试配置, openclaw 插件元数据
├── tsconfig.json                # TypeScript ESM (NodeNext 模块解析)
├── vitest.config.ts             # Vitest + v8 覆盖率 (65% 阈值)
├── openclaw.plugin.json         # OpenClaw 插件清单
├── README.md                    # 完整文档 (EN/CN)
├── CLAUDE.md                    # Claude Code 开发指导
├── CONTRIBUTING.md              # 贡献指南
├── LICENSE                      # MIT
├── .github/                     # GitHub: issue 模板, PR 模板, workflows
├── scripts/                     # 开发脚本
├── skills/                     # 飞书工具 skill 定义 (doc/drive/perm/task/wiki)
├── src/                        # 核心源码 (76 个 TypeScript 文件)
└── docs/                       # 项目文档
```

### src/ 模块地图

| 模块 | 文件 | 职责 |
|------|------|------|
| **Channel Runtime** | `channel.ts`, `monitor.ts`, `bot.ts`, `bot-relay.ts`, `reply-dispatcher.ts`, `outbound.ts` | 插件核心: 连接生命周期、事件处理、消息路由、回复分发 |
| **Client & Config** | `client.ts`, `config-schema.ts`, `accounts.ts`, `policy.ts`, `tools-config.ts`, `types.ts` | 飞书 SDK 客户端工厂、Zod schema、多账号解析、访问策略 |
| **Messaging** | `send.ts`, `media.ts`, `reactions.ts`, `typing.ts`, `streaming-card.ts` | 发送文本/卡片、上传/下载媒体、emoji 回应、输入指示器 |
| **Inbound Processing** | `dedup.ts`, `directory.ts`, `mention.ts`, `probe.ts` | 消息去重、用户/群组查询、@提及提取、健康检查 |
| **Dynamic Agent** | `dynamic-agent.ts`, `shared-history.ts` | 为 DM 用户自动创建独立 agent + workspace 隔离 |
| **Doc Tools** | `doc-tools/` (register/schemas/actions/common + tests) | `feishu_doc` — 文档读写创建 |
| **Wiki Tools** | `wiki-tools/` (register/schemas/actions/common/index) | `feishu_wiki` — 知识库空间/节点操作 |
| **Drive Tools** | `drive-tools/` (register/schemas/actions/common/index) | `feishu_drive` — 云空间文件/文件夹操作 |
| **Perm Tools** | `perm-tools/` (register/schemas/actions/common/index) | `feishu_perm` — 云空间权限管理 |
| **Bitable Tools** | `bitable-tools/` (register/schemas/actions/common/meta/index) | `feishu_bitable_*` — 多维表格字段和记录的 CRUD |
| **Task Tools** | `task-tools/` (register/schemas/actions/common/constants/index) | Task v2 API 的 task/tasklist/comment/attachment CRUD |
| **Shared Utilities** | `tools-common/`, `text/`, `doc-write-service.ts`, `targets.ts`, `onboarding.ts`, `runtime.ts` | 工具执行包装器、markdown 链接处理、文档写入服务、目标格式标准化 |
| **Tests** | `__tests__/` (9 个测试文件) | accounts, config, policy, mention, targets, tools-config, bot 解析, 工具 schema 兼容性测试 |

---

## 3. 架构模式

### 3.1 插件注册流程

```typescript
// index.ts
export default plugin = {
  id: "feishu",
  register(api: OpenClawPluginApi) {
    setFeishuRuntime(api.runtime);
    api.registerChannel({ plugin: feishuPlugin });      // 注册渠道
    registerFeishuDocTools(api);                         // 注册文档工具
    registerFeishuWikiTools(api);                         // 注册知识库工具
    registerFeishuDriveTools(api);                        // 注册云空间工具
    registerFeishuPermTools(api);                        // 注册权限工具
    registerFeishuBitableTools(api);                     // 注册多维表格工具
    registerFeishuTaskTools(api);                        // 注册任务工具
  },
};
```

### 3.2 消息流程

```
┌─────────────────────────────────────────────────────────────────┐
│                        消息入口                                  │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ monitor.ts                                                      │
│  - 解析启用的账号                                                 │
│  - 根据 connectionMode 启动 WebSocket 或 Webhook                 │
│  - 管理多账号并行监听                                             │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ client.ts + EventDispatcher                                     │
│  - 创建飞书 SDK Client (带缓存)                                  │
│  - 注册事件处理器 im.message.receive_v1 等                        │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ bot.ts                                                          │
│  - 消息去重 (dedup.ts)                                          │
│  - DM/群组策略检查 (policy.ts)                                   │
│  - @提及解析 (mention.ts)                                       │
│  - 入站媒体解析 (media.ts)                                      │
│  - 可选: 动态 agent 创建 (dynamic-agent.ts)                      │
│  - 权限错误通知                                                  │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ reply-dispatcher.ts                                             │
│  - renderMode 决策 (auto/raw/card)                               │
│  - 文本分块 (chunkTextWithMode)                                 │
│  - 流式卡片支持 (streaming-card.ts)                              │
│  - 输入指示器集成 (typing.ts)                                     │
│  - Bot-to-Bot relay 触发 (bot-relay.ts)                         │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ send.ts + media.ts                                              │
│  - sendMessageFeishu: 纯文本消息                                  │
│  - sendMarkdownCardFeishu: 交互卡片 (markdown 渲染)               │
│  - uploadImageFeishu / uploadFileFeishu: 上传                    │
│  - downloadImageFeishu / downloadMessageResourceFeishu: 下载     │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 工具注册模式

每个工具子模块遵循一致的 4 层架构:

```
┌─────────────────────────────────────────────────────────────────┐
│ register.ts                                                     │
│  - 调用 api.registerTool() 注册工具                              │
│  - 使用 withFeishuToolClient 包装执行                            │
│  - 统一的错误处理 (errorResult)                                   │
│  - 参数 schema 来自 schemas.ts                                   │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ schemas.ts                                                      │
│  - Typebox/TypeBox TSchema 定义工具参数                           │
│  - 包含参数类型定义                                              │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ actions.ts                                                      │
│  - 具体的飞书 API 调用                                            │
│  - 返回数据转换                                                  │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ common.ts                                                       │
│  - 共享类型定义                                                  │
│  - 格式化/错误辅助函数                                            │
└─────────────────────────────────────────────────────────────────┘
```

### 3.4 多账号配置解析

```
┌─────────────────────────────────────────────────────────────────┐
│ channels.feishu (顶层配置)                                       │
│  ├── appId, appSecret, domain 等基础凭证                          │
│  ├── dmPolicy, allowFrom 等默认策略                               │
│  └── accounts: {                                                │
│        "account-1": { 覆盖顶层配置 },                            │
│        "account-2": { 覆盖顶层配置 }                              │
│      }                                                          │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ accounts.ts: mergeFeishuAccountConfig()                         │
│  - 顶层配置作为基础                                               │
│  - 账号配置覆盖基础配置的同名字段                                  │
│  - resolveFeishuAccount() 返回完整解析后的账号                    │
└─────────────────────────────────────────────────────────────────┘
```

### 3.5 工具执行上下文

```
┌─────────────────────────────────────────────────────────────────┐
│ tools-common/tool-exec.ts                                       │
│                                                                  │
│ withFeishuToolClient({                                          │
│   api,                    // OpenClaw API                       │
│   toolName,               // 工具名称                            │
│   requiredTool,           // 必需的工具开关 (如 "doc", "wiki")    │
│   run: ({ client, account }) => { ... }                         │
│ })                                                              │
└─────────────────────────────────────────────────────────────────┘
```

执行时通过 `resolveToolAccount()` 解析账号:
- 消息驱动路径: 使用 `AsyncLocalStorage` 中的 tool context
- 非会话路径: 回退到默认账号

---

## 4. 核心模块详解

### 4.1 channel.ts — ChannelPlugin 主实现

```typescript
feishuPlugin: ChannelPlugin<ResolvedFeishuAccount> = {
  id: "feishu",
  meta: { ... },                    // 渠道元数据 (id, label, aliases)
  pairing: { ... },                 // 配对审批配置
  capabilities: {                  // 渠道能力声明
    chatTypes: ["direct", "channel"],
    polls: false,
    threads: true,
    media: true,
    reactions: true,
    edit: true,
    reply: true,
  },
  configSchema: { ... },           // Zod 配置 schema
  config: {                        // 账号管理
    listAccountIds,
    resolveAccount,
    defaultAccountId,
    setAccountEnabled,
    deleteAccount,
    isConfigured,
    describeAccount,
    resolveAllowFrom,
    formatAllowFrom,
  },
  security: { collectWarnings },   // 安全警告收集
  setup: { applyAccountConfig },   // 账号设置
  onboarding: feishuOnboardingAdapter,
  messaging: { normalizeTarget, targetResolver },
  directory: { listPeers, listGroups, listPeersLive, listGroupsLive },
  outbound: feishuOutbound,
  status: { ... },                 // 状态快照构建
  gateway: { startAccount },       // 启动账号监听
};
```

### 4.2 monitor.ts — 事件监听引导

支持两种连接模式:

| 模式 | 说明 |
|------|------|
| `websocket` | 长连接 WebSocket, 无需公网地址, 推荐本地开发和大多数部署 |
| `webhook` | HTTP 服务接收回调, 需要公网 URL, 适合反向代理部署 |

多账号并行启动:
```typescript
await Promise.all(
  accounts.map((account) =>
    monitorSingleAccount({ cfg, account, runtime, abortSignal })
  )
);
```

### 4.3 bot.ts — 消息处理器 (1294 行)

核心流程:
1. **去重检查** — `tryRecordMessage()` 跳过重复消息
2. **策略验证** — DM: `pairing/open/allowlist`; 群组: `open/allowlist/disabled`
3. **@提及检查** — `requireMention` + `groupCommandMentionBypass` 逻辑
4. **动态 agent** — DM 用户可创建独立 workspace
5. **消息构建** — 包含引用内容、发言人标签、@提及转发
6. **回复分发** — `reply-dispatcher` → `send.ts`

### 4.4 reply-dispatcher.ts — 回复分发

Render mode 决策:
```typescript
const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));
// shouldUseCard: 检测 ``` 代码块 或 |表格| 模式
```

流式卡片:
- `streamingEnabled = account.config?.streaming === true && renderMode !== "raw"`
- 使用 `FeishuStreamingSession` 通过 Card Kit API 实现流式更新

### 4.5 client.ts — SDK 客户端工厂

```typescript
// 客户端缓存 (按 accountId)
const clientCache = new Map<string, { client: Lark.Client, config }>();

createFeishuClient(creds)    // 创建/获取缓存客户端
createFeishuWSClient(account) // 创建 WebSocket 客户端 (每次新建)
createEventDispatcher(account) // 创建事件分发器
getFeishuClient(accountId)    // 获取缓存客户端
clearClientCache(accountId?)  // 清除缓存
```

### 4.6 config-schema.ts — Zod 配置 schema

关键验证:
```typescript
// dmPolicy="open" 时必须包含 "*"
.superRefine((value, ctx) => {
  if (value.dmPolicy === "open") {
    const hasWildcard = allowFrom.some((entry) => String(entry).trim() === "*");
    if (!hasWildcard) {
      ctx.addIssue({ code: "custom", message: 'dmPolicy="open" requires "*"' });
    }
  }
});
```

---

## 5. 工具模块

### 5.1 工具列表

| 工具 | 功能 | Schema |
|------|------|--------|
| `feishu_doc` | 文档读写、块操作、评论 | doc-tools/schemas.ts |
| `feishu_app_scopes` | 查看应用权限范围 | doc-tools/schemas.ts |
| `feishu_wiki` | 知识库空间/节点操作 | wiki-tools/schemas.ts |
| `feishu_drive` | 云空间文件/文件夹操作 | drive-tools/schemas.ts |
| `feishu_perm` | 云空间权限成员管理 | perm-tools/schemas.ts |
| `feishu_bitable_*` (11个) | 多维表格字段/记录 CRUD | bitable-tools/schemas.ts |
| `feishu_task_*` (20个) | Task v2 任务/清单/评论/附件 | task-tools/schemas.ts |

### 5.2 工具开关

```typescript
// tools-config.ts
export const defaultToolsConfig = {
  doc: true,     // 文档操作 (默认开启)
  wiki: true,    // 知识库操作 (默认开启, 依赖 doc)
  drive: true,   // 云空间操作 (默认开启)
  perm: false,   // 权限管理 (默认关闭, 敏感)
  scopes: true,  // 应用权限诊断 (默认开启)
  task: true,    // 任务操作 (默认开启)
};
```

### 5.3 Bitable URL 支持

支持两种 URL 格式:
- `/base/XXX?table=YYY` — 标准多维表格
- `/wiki/XXX?table=YYY` — 嵌入在知识库中的多维表格 (自动转换 app_token)

---

## 6. 高级特性

### 6.1 动态 Agent 创建

当启用 `dynamicAgentCreation.enabled: true` 时, 每个 DM 用户自动获得:
- 独立的 agent 实例
- 专属 workspace 目录
- 隔离的对话历史和记忆

### 6.2 Bot-to-Bot Relay

跨 bot 触发机制:
- `bot-relay.ts` 管理 bot 注册
- 当消息中 @ 其他 bot 时, 触发 relay
- 支持团队协作场景

### 6.3 共享历史

群组中跨 bot 上下文:
- `shared-history.ts` 记录用户消息和 bot 回复
- `buildSharedHistoryContext()` 构建包含其他 bot 回复的上下文

### 6.4 流式卡片

可选的流式更新模式:
- `streaming: true` + `renderMode: "card"` 启用
- 使用 Feishu Card Kit 流式 API
- `blockStreamingCoalesce` 配置分块延迟

---

## 7. 测试

### 7.1 测试文件

```
src/__tests__/
├── accounts.test.ts           # 账号解析逻辑
├── config-schema.test.ts      # Zod schema 验证
├── policy.test.ts             # 策略解析逻辑
├── mention.test.ts            # @提及解析
├── targets.test.ts            # 目标格式标准化
├── tools-config.test.ts       # 工具开关解析
├── bot.parse.test.ts          # 消息解析
├── bot.pairing-compat.test.ts # 配对兼容性
└── tool-schema-compat.test.ts # 工具 schema 兼容性
```

### 7.2 覆盖率目标

| 指标 | 阈值 |
|------|------|
| Statements | 65% |
| Branches | 55% |
| Functions | 65% |
| Lines | 65% |

---

## 8. 关键设计决策

### 8.1 ESM Only

- `"type": "module"` 在 package.json
- `NodeNext` TypeScript 模块解析
- 所有 import 使用 `.js` 扩展名

### 8.2 无构建步骤

插件直接作为 `.ts` 文件加载, 无需编译:
```bash
openclaw plugins install @m1heng-clawd/feishu
```

### 8.3 多账号隔离

- 顶层配置作为默认
- `accounts` 对象按账号覆盖
- 工具在全局注册, 执行时解析到具体账号

### 8.4 飞书 SDK 版本

使用 `@larksuiteoapi/node-sdk ^1.59.0`, 关键 API:
- `client.im.message.create/reply` — 消息发送
- `client.docx.*` — 文档读写
- `client.wiki.*` — 知识库操作
- `client.drive.*` — 云空间操作
- `client.bitable.*` — 多维表格操作
- `WSClient` — WebSocket 长连接
- `Lark.adaptDefault()` — Webhook 适配

---

## 9. 配置选项速查

```yaml
channels:
  feishu:
    enabled: true
    appId: "cli_xxxxx"
    appSecret: "secret"
    domain: "feishu"                    # "feishu" | "lark" | 自定义 URL
    connectionMode: "websocket"         # "websocket" | "webhook"
    dmPolicy: "pairing"                 # "pairing" | "open" | "allowlist"
    allowFrom: []                       # DM 白名单
    groupPolicy: "allowlist"           # "open" | "allowlist" | "disabled"
    requireMention: true               # 群组是否需要 @机器人
    renderMode: "auto"                 # "auto" | "raw" | "card"
    dynamicAgentCreation:
      enabled: false
      workspaceTemplate: "~/workspaces/feishu-{agentId}"
    tools:
      doc: true
      wiki: true
      drive: true
      perm: false
      scopes: true
      task: true
    accounts:
      "account-1":
        dmPolicy: "open"
```

---

## 10. 文件清单

<details>
<summary>完整文件列表 (76 个 TypeScript 文件)</summary>

```
src/
├── index.ts
├── channel.ts
├── client.ts
├── monitor.ts
├── bot.ts
├── bot-relay.ts
├── reply-dispatcher.ts
├── outbound.ts
├── send.ts
├── media.ts
├── reactions.ts
├── typing.ts
├── streaming-card.ts
├── dedup.ts
├── directory.ts
├── mention.ts
├── probe.ts
├── dynamic-agent.ts
├── shared-history.ts
├── targets.ts
├── onboarding.ts
├── runtime.ts
├── policy.ts
├── tools-config.ts
├── config-schema.ts
├── accounts.ts
├── types.ts
├── doc-write-service.ts
├── tools-common/
│   ├── tool-exec.ts
│   ├── tool-context.ts
│   ├── feishu-api.ts
│   └── __tests__/
│       └── tool-exec.test.ts
├── text/
│   ├── markdown-links.ts
│   └── __tests__/
│       └── markdown-links.test.ts
├── doc-tools/
│   ├── register.ts
│   ├── index.ts
│   ├── schemas.ts
│   ├── actions.ts
│   ├── common.ts
│   └── __tests__/
│       ├── actions.test.ts
│       └── common.test.ts
├── wiki-tools/
│   ├── register.ts
│   ├── index.ts
│   ├── schemas.ts
│   ├── actions.ts
│   └── common.ts
├── drive-tools/
│   ├── register.ts
│   ├── index.ts
│   ├── schemas.ts
│   ├── actions.ts
│   └── common.ts
├── perm-tools/
│   ├── register.ts
│   ├── index.ts
│   ├── schemas.ts
│   ├── actions.ts
│   └── common.ts
├── bitable-tools/
│   ├── register.ts
│   ├── index.ts
│   ├── schemas.ts
│   ├── actions.ts
│   ├── common.ts
│   └── meta.ts
├── task-tools/
│   ├── register.ts
│   ├── index.ts
│   ├── schemas.ts
│   ├── actions.ts
│   ├── common.ts
│   ├── constants.ts
│   └── __tests__/
│       └── tool-schema-compat.test.ts
└── __tests__/
    ├── accounts.test.ts
    ├── config-schema.test.ts
    ├── policy.test.ts
    ├── mention.test.ts
    ├── targets.test.ts
    ├── tools-config.test.ts
    ├── bot.parse.test.ts
    ├── bot.pairing-compat.test.ts
    └── tool-schema-compat.test.ts
```

</details>

---

## 附录 A: 消息信封格式

```
channel: Feishu
from: feishu:o_xxx        # DM: feishu:openId | 群组: chatId:senderOpenId
to: user:o_xxx           # DM: user:openId | 群组: chat:chatId
sessionKey: feishu:accountId:chatId  # 或带 topic 的隔离 session
```

## 附录 B: @ 转发机制

当消息中 @ 机器人并同时 @ 其他用户时:
1. `isMentionForwardRequest()` 检测转发请求
2. `extractMentionTargets()` 提取被 @ 的目标
3. 回复时自动带上 `@目标用户` 的 mention

## 附录 C: 权限错误处理

遇到飞书 API 权限错误 (code: 99991672) 时:
1. 提取 `grantUrl` 权限授权链接
2. 通过 `enqueueSystemEvent` 通知 agent
3. Agent 回复用户并提供授权链接
4. 5 分钟冷却避免重复通知
