# MODULES — 模块边界与依赖规则

- **地位**：模块职责与依赖方向的唯一权威描述。新增跨模块依赖前必须先改本文件。
- **状态**：`contracts`（协议层，SH-004）、`persistence`（SH-006A–D）与 `apps/soul-daemon` 的生命周期装配（SH-007A）已实现。`runtime` 已完成 ID 分配（SH-008A）与进程内 Persona 生命周期（SH-008B）；事件总线、调度、恢复扫描与 Daemon 装配仍未实现。全部 L2 认知包、Studio、CLI **未实现**。本文件仍是施工图：某一行标为已实现，只表示该批已交付的基础设施，不表示本行目标职责已经全部完成。
- **原则**：不为目录完整而创建空类。模块目录先有 `README.md` 说明职责与当前状态，代码在对应阶段再写。

---

## 1. 依赖方向

```
        ┌──────────────────────────────────────────────┐
        │                 apps/                        │
        │  soul-daemon   soul-studio   soul-cli        │
        └───────┬──────────────┬───────────────────────┘
                │              │  只能通过 HTTP/WS 访问
                ▼              ▼
        ┌──────────────────────────────────────────────┐
        │              packages/（内核）                │
        │                                              │
        │   L3 编排：runtime                           │
        │   L2 认知：attention perception memory-graph  │
        │            activation cognition               │
        │            memory-dynamics sleep-dream        │
        │            personality models                 │
        │   L1 基建：persistence                       │
        │   L0 契约：contracts                         │
        └──────────────────────────────────────────────┘
                ▲                          ▲
                │                          │
        adapter-sdk（给外部用，不反向依赖内核）
        action-gateway / archive-writer（独立进程，独立权限域）
```

规则：

1. **只能向下依赖。** 同层之间需显式在 §3 声明，未声明即禁止。
2. 所有模块只允许 `import` `contracts` 与下文明确列出的模块。
3. **禁止**通过相对路径读别的模块的数据库、文件或内部符号。跨模块只能走公开接口。
4. **禁止**任何模块 `import` `@deepseek-ai/*`（见 ADR-001）。
5. 循环依赖视为架构错误，必须重新划分职责而不是加中间层糊过去。

## 2. 全模块总表

| 包 | 负责 | 不负责 | 状态 |
|---|---|---|---|
| `contracts` | 协议类型、JSON Schema（**含 Stimulus 信封与 `requestNonce` 校验规则**）、**身份 ID 格式与生成契约**（`IDENTITY-PROTOCOL.md`）、版本与能力常量 | 运行时逻辑、IO、状态、**数据库列映射**、注册表查询、**不实际分配 ID** | **已实现（协议层）**，测试见 `packages/contracts/test/` |
| `persistence` | SQLite 连接、单写入协调器、事务、migration、检查点、密钥指针、**camelCase↔snake_case 映射** | 业务语义；不判断"该不该记" | **SH-006A–D 已完成**：连接、WAL 打开、单写入事务、migration、六表 Repository、字段映射、Runtime checkpoint envelope 存取。密钥指针未交付。无显式 `PRAGMA wal_checkpoint`，不重建 Runtime |
| `runtime` | Persona 生命周期、事件总线、任务队列、状态恢复（**pending 归档恢复 + failed 缓冲清理两类扫描**）、提案验证与提交、版本/epoch 控制、**归档决策与冲突审计记录写入**、**六类身份 ID 的分配**（见 `IDENTITY-PROTOCOL.md`）、**入站去重与去重命中后的正文核对**（`compare` 的**唯一**调用方） | 语义解释；不生成回答；**不读 Archive**、不持有 Archive 密钥；不接受外部指定的内部 ID | **部分实现（SH-008A–B）**：ID 分配，以及进程内 Persona 生命周期（经 persistence 仓储，无裸 SQL）。测试见 `packages/runtime/test/`。事件总线、任务队列、恢复扫描、检查点编排、Daemon 装配、去重与 `compare` 调用仍未实现 |
| `personality` | 自我叙事、情绪、关系多维表征、特质缓变 | 不写记忆正文；不授权现实动作 | 未实现 |
| `attention` | 前注意过滤、优先级、唤醒分级、注意结果（ignored/queued/aware） | 不理解内容；不生成回应 | 未实现 |
| `perception` | 感知规范化、选择性编码判定、短暂缓冲（TTL） | 不长期保存原文；不建立关联 | 未实现 |
| `memory-graph` | 节点/边/片段、聚类、FTS 与向量索引抽象、来源分组 | 不决定是否编码；不做遗忘决策 | 未实现 |
| `activation` | 稀疏子图激活迭代、抑制、Hub 抑制、随机探索、传播预算 | 不生成回答；不写权威库 | 未实现 |
| `cognition` | ThoughtProcess、inner/external 通道、意识渲染（ActivatedMemorySet → 有限视角） | 不做外部动作；不直连 Archive | 未实现 |
| `memory-dynamics` | 巩固、重构、来源演化、衰退、真实遗忘事务 | 不授权动作；不读 Archive | 未实现 |
| `sleep-dream` | 睡眠功能周期调度、Dream Sandbox、场景生成与体验者隔离、醒后切换 | 无真实工具/网络/文件权限；**不得仅靠 Worker Thread 隔离** | 未实现 |
| `models` | 多供应商路由、质量分层、用量与失败记录、结构化提案解析 | 不校验业务权限；不直接写库 | 未实现 |
| `action-gateway` | 现实权限校验、幂等、执行、回执、撤销。**独立进程**，达门槛才启用 | 不解释意图；不持有主观记忆 | 未实现 |
| `archive-writer` | 原始记录**加密**落盘（AEAD 独立密钥、HMAC 指纹密钥另置）、密文完整性校验、`expires_at` 有限期保留、按 `eventId` 幂等（**同 ID 重试不得二次 append**）、同 ID 异内容**拒绝覆盖并报冲突**；对外三个接口：**`append`（写）**、**`status`（只回 eventId/state/ref）**、**`compare`（只回 match/conflict/not_found，不回内容；仅 Ingress 去重路径可调，且不解密）**。**唯一写入者 + 独立进程 + 独立权限**，达门槛才启用 | **不向 Brain 提供任何读取接口或密钥**；`status` / `compare` 均不返回原文/密文/指纹/长度；不解释内容；不参与主观记忆 | 未实现 |
| `adapter-sdk` | 适配器协议、可信信封（**含 `requestNonce` 格式约束**）、来源鉴别、重试与限流契约、**适配器注册表**（合法 `adapterId` / `source`） | 不含具体平台实现；不持有状态；不做正则或注册校验的具体执行 | 未实现 |

## 3. 每个模块的允许依赖

| 包 | 允许依赖 | 对外暴露 |
|---|---|---|
| `contracts` | — | 类型、Schema、常量 |
| `persistence` | contracts | `openStore` / `withWrite` / `migrate` / `checkpoint` / 字段映射 |
| `runtime` | contracts, persistence, attention, perception, memory-graph, activation, cognition, memory-dynamics, sleep-dream, personality, models | Persona 与 Task 接口、提案提交入口 |
| `personality` | contracts, persistence | 情绪/关系/自叙事的读写接口 |
| `attention` | contracts | 信封评估 → 注意判定 |
| `perception` | contracts | 规范化、编码判定、TTL 缓冲 |
| `memory-graph` | contracts, persistence | 节点/边 CRUD、查询、索引维护 |
| `activation` | contracts, memory-graph | `step(dt)` → 活跃集 |
| `cognition` | contracts, memory-graph, activation, models | 线程管理、渲染 |
| `memory-dynamics` | contracts, persistence, memory-graph | 巩固/重构/遗忘事务 |
| `sleep-dream` | contracts, persistence, memory-graph, models | 睡眠周期、梦境会话 |
| `models` | contracts | `propose(kind, input)` → 校验前的原始提案 |
| `action-gateway` | contracts | `request` / `receipt` / `revoke`（独立进程） |
| `archive-writer` | contracts, persistence | `append` / `status` / `compare`（**无 `read`**；`status` 只回三字段、`compare` 只回判定） |
| `adapter-sdk` | contracts | 适配器接口定义与校验工具 |

**注**：`runtime` 允许依赖很多模块，但**它不被任何模块依赖**（除 apps）。这保证编排逻辑只有一处。

## 4. 应用层

| 应用 | 职责 | 约束 |
|---|---|---|
| `soul-daemon` | 生命周承载、bootstrap、supervisor、HTTP/WS、健康检查 | 只做装配与传输，业务逻辑必须下沉到 packages |
| `soul-studio` | Web UI（Overview / Personas / Events / Runtime / Settings 优先） | **只**经 Daemon API；不碰数据库文件 |
| `soul-cli` | 初始化、诊断、导出、安全停机 | 同样经 API（或直接调用 packages 的只读接口，不得写库） |

**当前代码（不改写上表的目标职责）**：

- `apps/soul-daemon`（SH-007A）已实现配置、结构化日志、数据目录探测、单实例锁、打开 SQLite、Migration、Schema 校验、启停状态机与资源逆序释放。进程可以进入 `RUNNING`，但这只表示它持有数据库与锁，**人格认知循环没有运行**。
- 同一应用**未实现**：Persona 恢复、Runtime 恢复、Event Bus、Scheduler（源码标为 `not_implemented`，owner 记为 SH-008；SH-008 进行中，目前只有 SH-008A 的 ID 分配器，Daemon 尚未装配）、HTTP / WebSocket、健康检查（owner 记为 SH-009；未开始）。
- `CHECKPOINTING` 跳过的是 Runtime checkpoint（`runtime_state.checkpoint_json`），不是 SQLite WAL checkpoint。关闭数据库没有显式 `PRAGMA wal_checkpoint`；`DatabaseSync.close()` 可能触发 SQLite 默认自动 checkpoint。
- SH-007B 不是下一代码批次，也不单独实施代码。它依赖 SH-008（Persona / Runtime 恢复、Event Bus、Scheduler）与 SH-009（HTTP / WebSocket、健康检查）接入真实组件之后，再验收 Daemon 的启动、就绪、关闭、资源释放与失败处理。细项通过标准不在此预先规定。
- `soul-studio`、`soul-cli` 目录不存在。上表对它们的描述仍是目标职责。

## 5. 端口与传输

| 通道 | 地址 | 用途 |
|---|---|---|
| Daemon HTTP | `127.0.0.1:18700` | 命令与查询 |
| Daemon WS | `127.0.0.1:18700` | 状态推送 |
| Studio dev | `127.0.0.1:18701` | 仅开发期 |

全部只监听 loopback，带本地令牌与协议版本协商。未来可换 Windows 命名管道 / Unix socket，但**语义不变**。

## 6. 模块 README 要求

每个模块目录必须有 `README.md`，至少写清：

1. 这个模块负责什么、**不负责什么**。
2. 允许依赖谁、被谁依赖。
3. 对外接口签名（可为草案）。
4. 当前状态：未实现 / 设计中 / 部分实现 / 已实现（附测试路径）。
5. 已知限制。

**状态为"已实现"必须有对应测试与验收记录**，否则一律写"设计中"。

## 7. 隔离门槛与模块启用顺序

P1 只有单库单进程，**不具备物理隔离**（见 `TRUST-BOUNDARIES.md` §5.1）。因此以下三个模块
虽然定义了接口，但**在门槛达成前不得启用**：

| 模块 | 门槛 | 未达门槛时 |
|---|---|---|
| `archive-writer` | 独立 db 文件 + 独立进程 + Brain 无读权限与无密钥 + 加密存储 + 按 `eventId` 幂等 + 受限 IPC（`append` / `status` / `compare`） + 有限期保留分类 + 句柄审计 | **仍允许接收事件**（P1 决议）：正文随感知缓冲 TTL 删除，`disposition` 为 NULL、`archive_state='none'`、`archive_ref` 为 NULL，**不承诺审计能力** |
| `action-gateway` | 独立进程 + 独立令牌 + 幂等持久化 + 回执校验 + 重复执行=0 测试 | 不执行任何真实外部动作 |
| `sleep-dream`（梦境部分） | **独立进程**（非 Worker）+ 无网络/无文件写/无工具令牌 + 逃逸测试 | 梦境不启用；睡眠的记忆巩固可先做（不涉及执行权限） |

**Worker Thread 只用于非安全目的的数值计算**（激活传播等），不可作为任何安全边界。

对应阶段：Archive 与 Action Gateway 属 P8；梦境属 P7。在此之前，`runtime` 只装配 mock/空实现，
且**不得**对外声称这些能力存在。
