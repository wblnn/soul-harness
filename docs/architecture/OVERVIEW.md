# OVERVIEW — Soul Harness 总体架构

- **地位**：本文件与 `TRUST-BOUNDARIES.md`、`DATA-MODEL.md`、`RUNTIME-LIFECYCLE.md`、`MODULES.md`、`IDENTITY-PROTOCOL.md`、`AI-DEVELOPMENT-RULES.md` 共同构成**唯一架构基线**。
- **状态**：本文描述目标形态。基础设施已部分落地（`contracts`、`persistence`、Daemon 生命周期装配、`runtime` 的 ID 分配器与进程内 Persona 生命周期）；认知循环尚未运行。已实现范围以 §9 为准，不得把目标架构读成现行能力。
- **上位决策**：`docs/adr/ADR-001-independent-runtime.md`

---

## 1. 一句话定位

Soul Harness 是一个**独立常驻的认知运行时**：人格身份、主观记忆、思维进程、情绪与演化状态由它自己持有，
不依附 DSH、Minecraft、QQ 或任何单一聊天平台。外部平台只是可插拔的输入与执行适配器。

> 文中"自我""意识""睡眠""梦"均为系统设计与行为模拟术语，不主张软件具备已被证实的人类意识。

## 2. 三个组成部分

| 组件 | 是什么 | 不是什么 |
|---|---|---|
| **Soul Daemon** | 常驻进程。持有全部主观状态、调度认知任务、管理模型调用与授权 | 不是插件的宿主附属物；不因 Studio 关闭而停止 |
| **Soul Studio** | Web 管理与可视化界面。**只能**通过 Daemon 的受保护 API 访问数据 | 不直接读数据库文件，不持有认知状态，不参与人格生命周期 |
| **Adapters** | 可选外部适配器（DSH / MC / QQ / CLI / 语音 / 形象）。提交观察、执行授权动作、回报真实结果 | 不持有主观状态；不解释记忆；不决定人格行为 |

**硬性约束**：不安装 DSH，Daemon 必须能独立启动并完整运行。

## 3. 分层拓扑

```
外部世界（DSH / Minecraft / QQ / CLI / 桌面 / 未来语音与形象）
        │  只提交观察、授权与执行回执
        ▼
┌──────────────── Adapter SDK ────────────────┐
│  适配器实现：身份映射、协议转换、限流、重试      │
└──────────────────┬──────────────────────────┘
                   ▼
        Ingress + Pre-attention Gate
        （可信信封、来源鉴别、注意筛选）
                   ▼
┌──────────────── Soul Daemon ─────────────────────────────────┐
│  Runtime Supervisor / Personality Runtime                    │
│    ├─ Attention & Arousal Controller                         │
│    ├─ Continuous Activation / Associative Graph              │
│    ├─ Thought Scheduler (external + inner)                   │
│    ├─ Experience Encoder / Memory Dynamics                   │
│    ├─ Sleep Coordinator + Dream Sandbox                      │
│    ├─ Model Gateway（typed proposal，不直接写库）              │
│    └─ Consciousness Renderer                                 │
│                                                              │
│  SUBJECTIVE STORE  ◄──── 唯一写入者 ────►  RUNTIME            │
└──────────┬───────────────────────────────────┬───────────────┘
           │ 意图提案                          │ 观察新事件
           ▼                                   ▼
  ┌─────────────────┐              ┌──────────────────────┐
  │ Execution       │              │ Archive Writer       │
  │ Gateway         │              │ （独立权限域）          │
  └────────┬────────┘              └──────────┬───────────┘
           │                                  ▼
     系统 / MC / 外发动作              SEALED ARCHIVE
           │                          （Brain 无读权）
           ▼
        执行回执 ──────► 作为**新的当下观察**重新进入 Ingress
```

右侧管理面：Soul Studio 走 Daemon 的本地 API，**不得**接触 Archive 审计数据。

要点：

1. 回执不是"恢复旧记忆"，而是**新观察**。这条决定了记忆的真实性边界。
2. 提案（Proposal）与提交（Commit）分离。模型只提案，确定性代码提交。
3. Archive 是单向写入的孤岛，Brain 侧没有客户端、路径或工具能读它。

## 4. 运行形态

**首期采用：模块化单体 + 强隔离辅助进程。** 不拆微服务。

| 部分 | 进程形态 | 理由 |
|---|---|---|
| 认知 Runtime（主） | 主进程 | 共享活跃子图与调度器，拆开只会引入 IPC 延迟与一致性麻烦 |
| Execution Gateway | 独立进程 + 独立权限令牌 | 现实动作的授权边界要与认知进程物理隔开 |
| Archive Writer | 独立进程 + 独立文件权限 | 保证 Brain 进程拿不到档案句柄 |
| Dream Sandbox | **独立进程**（不得用 Worker Thread） | 梦境必须无真实工具、无网络、无文件写权限；Worker 与主线程同进程共享权限，不构成隔离 |
| 数值计算（图传播） | Worker Thread | 只用于性能，不承担安全边界；性能证据充分后再考虑 Rust |

> **P1 现实**：上述隔离形态在阶段一尚不存在。P1 为单进程单库，Archive Writer / Action Gateway /
> Dream Sandbox 均不启用（门槛见 `PLAN.md` §6.2 与 `MODULES.md` §7）。

所有本地 IPC 带协议版本、身份与能力令牌。**服务重启不得导致人格状态清零。**

## 5. 身份层级

| ID | 含义 | 生命周期 | 不得用于 |
|---|---|---|---|
| `personaId` | 长期人格身份 | 跨进程 / 会话 / 模型 / 场景 / 睡眠周期 | — （一切主观状态的主键） |
| `sessionId` | 某个适配器的交互窗口 | 外部会话 | 代表人格身份 |
| `threadId` | 内部思维进程 | 可跨会话继续 | 当作记忆主体 |
| `runId` | 一次模型调用或睡眠任务 | 单次执行 | 当作记忆主体 |
| `actionId` | 一次真实外部动作 | 幂等键，一次性 | 当作意图 |
| `eventId` | 一个外部已发生的观察 | 永久唯一 | — |

**禁止"猜最近活跃会话是谁"的隐式解析。** 所有接口显式携带 `personaId`，必要时带 `sessionId` / `threadId` 与权限上下文。

> 本表只是概览。六类身份的格式、生成者、唯一性范围与生命周期以 **`IDENTITY-PROTOCOL.md`** 为准
> （含"`eventId` 由 Ingress 生成、适配器只提供 `adapterEventRef`"这条关键分工）。

## 6. 三种权威域（详见 TRUST-BOUNDARIES.md）

| 域 | 权威数据 | 允许变化 | 进入主观回忆？ |
|---|---|---|---|
| **Subjective Mind** | 主观记忆、关系、情绪、自我叙事、思维状态 | 可扭曲、融合、删去 | 是，且仅经注意机制 |
| **Reliable World / Execution** | 世界状态、授权、操作进度、执行回执 | 只据观察或回执更新 | 作为**当下环境观察**，非恢复旧记忆 |
| **Sealed Archive / Audit** | 原始来源记录、审计、管理诊断 | 追加 + 受控管理删除 | **否，永不直连** |

主体不得通过内部工具、Prompt 注入、数据库 ATTACH、历史文件路径、旧备份或检索 API 绕过该边界。

## 7. 模块边界

15 个包的职责、依赖与对外接口见 **`docs/architecture/MODULES.md`**（单表维护，不为未实现模块建空目录）。

## 8. 本地接口

| 服务 | 默认地址 | 说明 |
|---|---|---|
| Daemon HTTP API | `127.0.0.1:18700` | 仅 loopback，本地令牌鉴权，协议版本协商 |
| Daemon WebSocket | 同端口 | 实时状态推送，连接时鉴权 |
| Studio 开发服务器 | `127.0.0.1:18701` | 仅开发期；生产由 Daemon 托管静态资源 |

必须：只监听 loopback、校验令牌与来源、严格 CORS、限制请求体大小、管理操作单独鉴权。
**不得**把 Host/Origin 简单校验当成认证。

## 9. 当前实现状态

| 层 | 状态 |
|---|---|
| 架构文档 | 基线已交付；目标形态仍以本文为准，实现状态以本表为准 |
| Monorepo 骨架 | **已实现**（SH-005） |
| `contracts` | **已实现（协议层，SH-004）**：类型与 10 份已注册 Schema。不生成 ID，无 IO |
| `persistence` | **已实现（SH-006A–D）**：连接、WAL 模式、单写入事务、Migration、字段映射、Runtime checkpoint envelope 存取。不执行显式 `PRAGMA wal_checkpoint`，不重建 Runtime |
| `runtime` | **部分实现（SH-008A–B）**：ID 分配器与进程内 Persona 生命周期，测试见 `packages/runtime/test/`。不跑事件总线或调度器，不装载/写出检查点，Daemon 未装配 |
| `soul-daemon` | **已实现生命周期装配（SH-007A）**：配置、日志、数据目录、单实例锁、打开 SQLite、Migration、Schema 校验、启停状态机。进入 `RUNNING` 只表示进程持有数据库，**不是**人格认知循环已运行 |
| Persona / Runtime 恢复、Event Bus、Scheduler | **未实现**。Daemon 源码把这些步骤标为 `not_implemented`（owner 记为 SH-008，进行中；Daemon 接线属 SH-008C–E。SH-008B 只提供进程内状态机，尚未被 Daemon 调用） |
| HTTP / WebSocket / 健康检查 | **未实现**（源码 owner 记为 SH-009；该任务未开始） |
| 记忆图 / 激活 / 睡眠 / 梦境 / 执行网关 | **未实现** |
| Studio / CLI | **未实现**（目录不存在） |
| SH-007B | **未开始**。不是 SH-008 的前置代码阶段，不单独实施代码；依赖 SH-008 与 SH-009 真实组件接入后的 Daemon 集成验收 |

> 目录和文档存在**不代表**功能完成。任何"已实现"的声明必须以测试与验收记录为凭。
> Daemon 基础设施已通过 SH-007A 验收，不得因此声称人格、记忆或思维进程已经在运行。

## 10. 术语

| 术语 | 含义 |
|---|---|
| Proposal | 模型产出的结构化变更请求，未经提交器校验不入库 |
| Commit / 提交器 | 唯一的权威状态写入路径，负责 Schema、权限、版本、幂等校验 |
| Epoch | 人格内容的单调版本号；遗忘会提升它，旧快照不得越过 |
| Activation | 记忆节点当前的激活强度，稀疏子图上迭代 |
| Sealed Archive | 原始记录的封存域，Brain 无读权 |
| Arousal | 从睡眠中被唤醒的判定（未唤醒 / 部分 / 完全 / 强制控制） |
