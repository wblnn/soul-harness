# DATA-MODEL — 数据模型与存储规则

- **地位**：数据库 schema 与迁移规则的权威描述。任何表结构变更必须先改本文件，再写 migration。
- **状态**：设计中。以下 DDL 为**逻辑草案**，未在任何数据库执行过。
- **上位决策**：`ADR-001`（SQLite WAL / 单写入 / 首期单库 / 不用 Drizzle）

---

## 1. 命名与字段规则

| 层 | 风格 | 例 |
|---|---|---|
| 线协议（HTTP / WS / JSON Schema / TS 接口） | **camelCase** | `personaId` `receivedAt` |
| 数据库列名 | **snake_case** | `persona_id` `received_at` |
| 表名 | snake_case，复数 | `memory_nodes` |
| 索引 | `ix_<表>_<列…>` | `ix_nodes_persona_lifecycle` |
| 迁移文件 | `NNNN_<snake_desc>.sql` | `0001_init_core.sql` |

**camelCase ↔ snake_case 的映射由 `packages/persistence` 统一完成，禁止各模块自己转换。**
`contracts` 只定义协议类型与 JSON Schema，**不知道**数据库列名。
转换规则固定为纯机械转换（`personaId` ⇄ `persona_id`），不做任何特例，以便推断与测试。

时间字段一律 **Unix 毫秒整数**（`INTEGER`），不用字符串时间戳。需要人读时在边缘层格式化。
布尔字段用 `INTEGER` 0/1，不用 SQLite 的松散类型。
结构化内容用 `TEXT` 存 JSON，且必须带 `schema` 字段标识版本。

**persona 作用域（规则见 `IDENTITY-PROTOCOL.md` §1 第 5 条）**：本文件的表分三类，不得一刀切。

| 类别 | `persona_id` | 本文件中的表 |
|---|---|---|
| 人格数据表 | **必须 `NOT NULL`** | `sessions` / `events` / `tasks` / `runtime_state` / `memory_nodes` / `memory_fragments` / `memory_edges` / `thought_threads` / `dream_sessions` / `action_records` / `archive_records` / `archive_decisions` / `archive_conflict_records` / `erasure_tombstones` |
| 全局系统表 | **不带** | `schema_migrations`（`personas` 以自身 `id` 为主键） |
| 派生索引 / 易失缓存 | 可带可不带；**不带时必须限定单一人格** | `memory_fts`（不带，经 `node_id` 限定，可重建）/ `activation_states`（带 `persona_id`，可重建） |

## 2. 权威关系

```
SQLite（权威）
   ↕ 导入校验（单向：文件 → 库）
Markdown 投影（SOUL.md / IDENTITY.md / MEMORY.md …）
```

- 数据库是**唯一权威**。Markdown 是版本化投影，供人直接编辑。
- 外部编辑 Markdown 后**必须**经 Schema、版本、权限校验后导入；校验失败则整体拒绝，不部分导入。
- **禁止双主写入。** 不允许"文件改了也算真"。
- 人格可自行改写的内容（自我叙事、偏好、关系）与**永不允许人格改写**的内容（密钥、授权策略、归档保留策略）必须分开存放，后者不进入任何可写投影。

### 2.1 P1 存储形态（与隔离边界）

- P1 使用**一个 SQLite 文件**，三域数据同库同进程，**不具备物理隔离**（见 `TRUST-BOUNDARIES.md` §5.1）。
- 逻辑隔离靠两点：**表归属唯一**（每张表只属于一个模块，见 `MODULES.md`）与**接口边界**（跨模块只能走公开接口）。
- 物理隔离（独立 Archive db 文件、独立权限、独立进程）的启用门槛见 `PLAN.md` §6.2。
  **在门槛达成前，`archive_records` 表不创建**：P1 允许正常接收事件，
  `archive_disposition` 为 NULL、`archive_state = 'none'`、`archive_ref` 为 NULL，
  **系统不承诺原始事件审计能力**（见 §3.1 与 `RUNTIME-LIFECYCLE.md` §7.2）。

## 3. 首期表（P1，只实现这 6 张）

> 首期目标是"可靠的认知运行时容器"，不是记忆系统。**不要**提前建记忆表。

```sql
-- 人格身份与生命周期
CREATE TABLE personas (
  id            TEXT PRIMARY KEY,          -- personaId
  display_name  TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('CREATED','STARTING','RUNNING','SUSPENDED','STOPPING','STOPPED','FAILED')),
  version       INTEGER NOT NULL DEFAULT 0, -- 状态版本，每次提交 +1
  epoch         INTEGER NOT NULL DEFAULT 1, -- 内容纪元，遗忘时 +1，只增不减
  boot_id       TEXT,                       -- 最近一次持有它的进程实例
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 外部交互会话（适配器提供，不代表人格身份）
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,            -- sessionId
  persona_id  TEXT NOT NULL REFERENCES personas(id),
  adapter_id  TEXT NOT NULL,               -- dsh / minecraft / qq / cli
  external_id TEXT,                        -- 适配器侧会话引用 externalSessionRef；不透明，不参与权限判断
  opened_at   INTEGER NOT NULL,
  closed_at   INTEGER,
  meta_json   TEXT
);
CREATE INDEX ix_sessions_persona ON sessions (persona_id, opened_at DESC);
-- 会话映射以人格为作用域：同一适配器同一外部会话在不同人格下是不同会话。
-- 谓词含 closed_at IS NULL：只约束"当前有效"的映射 —— 旧会话关闭后，同一
-- (persona_id, adapter_id, external_id) 允许再建新会话（重开 = 新 sessionId，见 IDENTITY-PROTOCOL §4.2）。
-- 并发：关闭与新建必须走同一 persona 级单写入协调器（RUNTIME-LIFECYCLE §9）；本索引是第二道防线，
-- 保证任何时刻不会存在两条 closed_at IS NULL 的同键映射。
CREATE UNIQUE INDEX ux_sessions_external
  ON sessions (persona_id, adapter_id, external_id)
  WHERE external_id IS NOT NULL AND closed_at IS NULL;

-- 事件（Reliable World 的观察记录）
-- 注意：本表只存信封与非内容元数据；原始正文归 Archive（加密），通过 archive_ref 指向。
-- P1 无 Archive Writer，本表照样可用，archive_ref 恒为 NULL。
CREATE TABLE events (
  id             TEXT PRIMARY KEY,         -- eventId
  persona_id     TEXT NOT NULL REFERENCES personas(id),
  session_id     TEXT REFERENCES sessions(id),
  source         TEXT NOT NULL,            -- minecraft.chat / dsh.chat / qq.group …
  adapter_id     TEXT NOT NULL,            -- 来源适配器；内部来源用 system.* 正式 ID
  adapter_event_ref TEXT NOT NULL          -- 适配器侧刺激标识；同一刺激重试必须复用
                 CHECK (length(adapter_event_ref) BETWEEN 1 AND 64),
  status         TEXT NOT NULL CHECK (status IN
                   ('received','accepted','noticed','understood',
                    'response_committed','acted','rejected','expired')),
  -- 注意判定结果，与 status 是两个不同维度（见 §3.2）
  attention_outcome TEXT CHECK (attention_outcome IN
                   ('not_evaluated','ignored','queued','partially_aware','fully_aware','forced_control')),
  salience       REAL NOT NULL DEFAULT 0,
  summary        TEXT,                     -- ⚠ 必须为 NULL 或仅含白名单非内容元数据（见 §3.1）
  archive_ref    TEXT,                     -- 不透明引用 token，由 Archive Writer 在 append 时生成；P1 恒为 NULL
  received_at    INTEGER NOT NULL,
  occurred_at    INTEGER,
  updated_at     INTEGER NOT NULL,
  -- 归档判定：确定性策略产物，模型不得参与。Archive 能力关闭时（P1）为 NULL
  archive_disposition TEXT CHECK (archive_disposition IN ('required','excluded')),
  -- 归档状态：与 archive_ref 分离，支持"已归档但引用未提交"的崩溃恢复
  archive_state  TEXT NOT NULL DEFAULT 'none'
                 CHECK (archive_state IN ('none','pending','archived','failed','excluded')),
  -- 终态原因码：受控枚举，且必须与 status 配对（见 §3.4）
  status_reason  TEXT,
  CHECK (
    (status IN ('expired','rejected') AND status_reason IS NOT NULL)
    OR
    (status NOT IN ('expired','rejected') AND status_reason IS NULL)
  ),
  CHECK (
    status_reason IS NULL
    OR (status = 'expired' AND status_reason IN ('buffer_lost','ttl_expired','queue_overflow'))
    OR (status = 'rejected' AND status_reason IN
        ('auth_failed','untrusted_source','schema_invalid','rate_limited',
         'archive_unavailable','archive_conflict','processing_failed'))
  )
);
CREATE INDEX ix_events_persona_status ON events (persona_id, status, received_at);
CREATE INDEX ix_events_session ON events (session_id, received_at);
-- 去重键：同一人格、同一适配器、同一来源、同一刺激 → 只映射一个 eventId（见 IDENTITY-PROTOCOL §4.5）
CREATE UNIQUE INDEX ux_events_dedupe
  ON events (persona_id, adapter_id, source, adapter_event_ref);

-- 任务（调度与睡眠周期共用）
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  persona_id    TEXT NOT NULL REFERENCES personas(id),
  kind          TEXT NOT NULL,             -- stimulus.encode / thought.run / sleep.cycle / dream.segment …
  channel       TEXT NOT NULL CHECK (channel IN ('external','inner','sleep','dream','audit')),
  state         TEXT NOT NULL CHECK (state IN ('queued','running','paused','done','failed','cancelled')),
  priority      INTEGER NOT NULL DEFAULT 0,
  run_id        TEXT,                      -- 执行它的模型调用/作业
  payload_json  TEXT,
  scheduled_at  INTEGER,
  started_at    INTEGER,
  finished_at   INTEGER,
  attempt       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_tasks_persona_state ON tasks (persona_id, state, scheduled_at);

-- 运行时状态（恢复用；不含主观正文）
CREATE TABLE runtime_state (
  persona_id     TEXT PRIMARY KEY REFERENCES personas(id),
  state          TEXT NOT NULL,            -- 见 RUNTIME-LIFECYCLE.md
  boot_id        TEXT,
  epoch          INTEGER NOT NULL,
  checkpoint_json TEXT,                    -- 合法检查点：调度游标、队列快照引用
  updated_at     INTEGER NOT NULL
);

-- 迁移追踪
CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  INTEGER NOT NULL
);
```

**关键取舍：`events` 不存正文。** 本表只留信封 + 非内容元数据 + 不透明引用。
理由：正文一旦在 Reliable World 留一份，就会出现"第二份真相"，遗忘、审计与隐私全部失效。

### 3.1 原文旁路禁令（各字段的具体约束）

原始正文只允许存在于**短暂感知缓冲**（TTL）以及其后**编码出的主观记忆密文片段**。
以下位置**一律不得**成为永久原文储存的旁路：

| 位置 | 允许存什么 | 明确禁止 |
|---|---|---|
| `events.summary` | **必须为 NULL**，或**仅含下表白名单中的非内容元数据** | 任何自然语言摘要、原始消息全文、原文拼接、可还原原文的编码、情感描述、主题概括 |
| `events.archive_ref` | 不透明 token `^[A-Za-z0-9._:-]{1,128}$`，**由 Archive Writer 在 `append` 成功时生成**，Brain 只透传；**不是路径**；**P1 恒为 NULL** | 文件路径、可直接读取的 URI、SQL 片段、密钥材料、原文或原文哈希 |
| `events.archive_state` | 枚举 `none/pending/archived/failed/excluded` | 任何原文或可推断原文的附加信息 |
| `events.archive_disposition` | 枚举 `required/excluded`（P1 为 NULL） | 模型产出的判定、自由文本理由 |
| `events.adapter_event_ref` | 适配器侧刺激标识：不透明字符串 1–64（`^[A-Za-z0-9._:-]{1,64}$`） | 正文、自由文本、路径、URL、错误消息；与 `eventId` 混用 |
| `events.status_reason` | 受控枚举，且必须与状态配对（完整清单见 §3.4） | 自由文本、错误消息原文、异常堆栈、任何含内容的片段 |
| `tasks.payload_json` | **只放引用**：`eventId` / `nodeId` / `threadId` / 参数枚举 | 任何原文、上下文正文、模型输入原文 |
| `runtime_state.checkpoint_json` | 游标、队列位置、版本号、活跃 ID 列表 | 任何正文、对话片段、思维内容 |
| 日志 / 遥测 | 计数、耗时、错误码、ID | 默认不记录原文；确需时须脱敏并显式开关 |
| `sessions.meta_json` | 适配器侧标识与配置 | 会话消息内容 |

**`events.summary` 白名单（严格穷举，不得扩展而不改本文件）**

只允许以下非内容元数据：

- 字符长度 / 字节数 / token 估算；
- 语言标识（如 `zh`、`en`）；
- 消息类型枚举（`text` / `image` / `sticker` / `voice` / `command`）；
- 是否被点名的布尔标记；
- 来源渠道名与协议版本；
- 内容哈希（用于去重，不可逆）。

**禁止**：任何"把内容说一遍"的字段——包括自然语言摘要、关键词列表、情感标签、主题命名。
若在 P2 阶段确实需要给人看的摘要，该摘要属于**主观解释结果**，必须进入
`memory_nodes` 的加密正文，**不得**回填 `events.summary`。

**这条是硬约束。** 违反它会让整条遗忘链失效：删了主观记忆，原文还在 `events` 或检查点里躺着。

判据（可自动化）：注入带唯一标记的刺激后，遍历全部库表、索引、检查点与日志，标记串不得出现在上表"明确禁止"的列中。

### 3.2 `attentionOutcome` 与 `event.status` 是两件事

| 维度 | 含义 | 取值 | 谁负责 |
|---|---|---|---|
| `event.status` | 事件在**持久管线**中的阶段 | `received` / `accepted` / `noticed` / `understood` / `response_committed` / `acted` / `rejected` / `expired` | `runtime`（提交器） |
| `attentionOutcome` | 注意机制对这条刺激**单次判定**的结果 | `not_evaluated` / `ignored` / `queued` / `partially_aware` / `fully_aware` / `forced_control` | `attention` |

规则：

1. `ignored` / `queued` 是**注意结果**，不是事件终态。被忽略的事件其 `status` 仍可能是 `accepted`，
   直到队列超时或 TTL 到期才转 `expired`。
2. `forced_control` 必须导致 `status` 立即进入终态（`rejected` 或由控制路径直接处理），不受排队影响。
3. 同一事件可以被**多次**注意判定（例如先 `queued` 后 `fully_aware`），因此
   `attention_outcome` 记录**最近一次**判定；完整历史写入审计流，不进主观回忆。
4. 事件进入模型解释的前提是 `attentionOutcome ∈ {partially_aware, fully_aware, forced_control}`。
   **不得**让模型先读全文再表演"没注意到"。

### 3.3 pending 事件行（归档前置记录）

`required` 事件在调用 Archive Writer 之前，必须先落一条 **metadata-only** 的 pending 行：

| 列 | pending 时的值 | 约束 |
|---|---|---|
| `id` | `eventId` | 已分配，不得因重试更换 |
| `status` | `received` | 尚未 ACK |
| `archive_state` | `pending` | **崩溃恢复的扫描判据** |
| `archive_ref` | `NULL` | 归档成功后与另两个字段**同一事务**提交 |
| `archive_disposition` | `required` | 判定结果已固化 |
| `summary` / 正文类字段 | `NULL` | **pending 行不得含正文、摘要、原文哈希** |

**为什么必须先落 pending**：归档是跨进程动作，若只在内存里挂一个"待归档"任务，
崩溃后这条任务就消失了，适配器却已经收到（或永远收不到）ACK —— 系统会出现"看不见的中间态"。
落 pending 让每一条欠账都可被扫描、可被对账。

**完成事务**：`archive_ref` + `archive_state='archived'` + `status='accepted'` 三条在**同一短事务**提交。
不允许多次写入，也不允许"先改状态后补引用"。

**不创建 pending 的情形**

- `excluded` 事件：直接以 `archive_state='excluded'`、`status='accepted'` 入库，一步完成。
- P1：直接以 `archive_state='none'`、`archive_disposition=NULL`、`status='accepted'` 入库。

### 3.4 `archive_state` 与 `status` 的分离，及 `failed` 的语义

**两个字段回答两个不同问题，不许互相推导：**

| 字段 | 回答的问题 | 取值 |
|---|---|---|
| `archive_state` | "原始记录归档到哪一步了？" | `none` / `pending` / `archived` / `failed` / `excluded` |
| `status` | "这条事件在生命周期里到哪一步了？" | `received` / `accepted` / `noticed` / `understood` / `response_committed` / `acted` / `rejected` / `expired` |

**`failed` 不自动等于 `expired`。**

- `archive_state='failed'` 只说明**归档这次尝试失败了**，不代表事件已经终结。
- 事件是否终结，取决于**原始缓冲是否仍然有效**：
  - 缓冲有效 → 事件可保持 `status='received'`，等待**同一 eventId** 受控重试；
  - 缓冲已失效 → 事件**必须**转 `status='expired'`，原因码 `buffer_lost`
    （内容确实没了，这是根因；归档失败本身由 `archive_state='failed'` 表达）；
  - 若策略或管理员**显式拒绝**该源输入（例如该源要求审计而 Archive 被管理性关闭），
    才使用 `rejected` + `archive_unavailable`。
- **`pending` 才是崩溃恢复扫描的主要对象**；`failed` 不是恢复扫描目标（它是"等外部重试"的状态）。

**`status_reason` 规则（受控枚举，与状态配对）**

| status | 是否必须带原因码 | 允许的原因码 |
|---|---|---|
| `expired` | **必须** | `buffer_lost` / `ttl_expired` / `queue_overflow` |
| `rejected` | **必须** | `auth_failed` / `untrusted_source` / `schema_invalid` / `rate_limited` / `archive_unavailable` / `archive_conflict` / `processing_failed` |
| 其他状态 | **必须为 NULL** | — |

- 原因码**只能是**上表中的字面量；**禁止**自由文本、错误消息原文、异常堆栈
  （堆栈可能夹带 payload，等于原文旁路）。
- 数据库层已用两条 `CHECK` 强制"配对 + 枚举"，应用层不得绕过。
- 新增原因码需要改本文件与 migration，不允许运行时拼接。

**`expired` 三个原因码的语义（互斥，不得混用）**

| 原因码 | 含义 | 典型触发 | 检测点 |
|---|---|---|---|
| `buffer_lost` | 原始缓冲**因进程崩溃/重启而丢失**（非时间原因） | Daemon 异常退出、被强杀、重启后发现缓冲为空 | 启动恢复扫描 |
| `ttl_expired` | 事件**自身的 TTL 到期** | 缓冲存活期内未被注意或未被编码 | 运行期定时清理 |
| `queue_overflow` | **队列容量溢出**，新事件无法入队 | 同会话队列已满 | 入队时 |

判定原则：**先看是不是"进程原因"**。同一事件若既 crash 过又 TTL 到期，以 `buffer_lost` 记
（它是更早、更根本的原因）；一旦转为终态即不再改原因码。

### 3.5 `failed` / `expired` / `rejected` 的转换规则

```
                        ┌──────────────────────────┐
                        │  required, 归档中          │
                        │  status=received           │
                        │  archive_state=pending     │
                        └───────┬──────────┬────────┘
                    归档成功│          │归档失败/重试耗尽
                            ▼          ▼
              ┌──────────────────┐  ┌──────────────────────────┐
              │ status=accepted  │  │ status=received           │
              │ archive_state=   │  │ archive_state=failed      │
              │   archived       │  │ （缓冲仍有效 → 可重试）    │
              └──────────────────┘  └───────┬──────────────────┘
                                            │缓冲失效 / TTL 到期
                                            ▼
                                  ┌──────────────────────────┐
                                  │ status=expired            │
                                  │ reason=buffer_lost        │
                                  │   （重启）或 ttl_expired   │
                                  └──────────────────────────┘
```

| 起点 | 终点 | 触发条件 |
|---|---|---|
| `pending` | `archived` + `accepted` | Archive append 成功，三字段同事务提交 |
| `pending` | `failed` + 仍 `received` | append 失败且重试耗尽，**缓冲仍有效** |
| `failed` + `received` | `archived` + `accepted` | 同 eventId 重试成功 |
| `failed` + `received` | `expired`（`buffer_lost`） | **进程重启/崩溃后缓冲已丢失**（启动清理，见 RUNTIME §7.3.1 扫描 B） |
| `failed` + `received` | `expired`（`ttl_expired`） | 运行期缓冲 TTL 正常到期 |
| `failed` + `received` | `rejected`（`archive_unavailable`） | 策略/管理员显式拒绝该源（不再等待重试） |
| `pending` / `failed` | `expired`（`buffer_lost`） | 崩溃后重启，缓冲已消失 |
| 任意 | `rejected`（`auth_failed` / `untrusted_source` / `schema_invalid` / `rate_limited` / `processing_failed`） | 入站校验失败或处理重试耗尽 |
| 任意 | `rejected`（`archive_conflict`） | 同 eventId 不同正文 |
| `accepted` | `expired`（`ttl_expired` / `queue_overflow`） | 注意阶段未处理而超时/溢出 |

**终态**：`expired` 与 `rejected` 是终态，**不可再回到 `accepted`**。
`failed` **不是终态**，它只是 `archive_state` 的一个取值。

## 4. 二期表（P3–P5：记忆网络与思维）

```sql
CREATE TABLE memory_nodes (
  id                    TEXT PRIMARY KEY,
  persona_id            TEXT NOT NULL REFERENCES personas(id),
  kind                  TEXT NOT NULL,       -- 开放注册表：Experience/Person/Concept/Emotion/…
  payload_enc           BLOB,                -- 主观正文，按密钥加密
  key_id                TEXT,                -- 内容密钥标识；遗忘时销毁
  vividness             REAL NOT NULL,
  accessibility         REAL NOT NULL,
  stability             REAL NOT NULL,
  salience              REAL NOT NULL,
  subjective_confidence REAL NOT NULL,
  source_impression     TEXT,                -- 主观来源印象（可退化）
  source_group          TEXT,                -- 系统侧来源分组，用于"独立证据"判定
  causal_root_id        TEXT,                -- 同源溯源：同一句话→自述→复述→梦境
  emotion_json          TEXT,
  subjective_time       TEXT,                -- 主观时间（人读，可能是错的）
  content_epoch         INTEGER NOT NULL,
  state_version         INTEGER NOT NULL,
  lifecycle             TEXT NOT NULL CHECK (lifecycle IN ('ACTIVE','FADING','ERASURE_PENDING','ERASED')),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX ix_nodes_persona_lifecycle ON memory_nodes (persona_id, lifecycle, kind);

CREATE TABLE memory_fragments (           -- 片段级存储，供遗忘按片段精确删除
  id          TEXT PRIMARY KEY,
  persona_id  TEXT NOT NULL REFERENCES personas(id),  -- 人格数据表：必须带作用域（IDENTITY-PROTOCOL §1 第 5 条）
  node_id     TEXT NOT NULL REFERENCES memory_nodes(id),
  ordinal     INTEGER NOT NULL,
  content_enc BLOB,
  key_id      TEXT
);

CREATE TABLE memory_edges (
  id                  TEXT PRIMARY KEY,
  persona_id          TEXT NOT NULL REFERENCES personas(id),
  src_id              TEXT NOT NULL REFERENCES memory_nodes(id),
  dst_id              TEXT NOT NULL REFERENCES memory_nodes(id),
  relation            TEXT NOT NULL,       -- Episodic/Semantic/Emotional/…（开放注册表）
  weight              REAL NOT NULL,
  gain                REAL NOT NULL,
  decay               REAL NOT NULL,
  directional         INTEGER NOT NULL DEFAULT 1,
  origin_group        TEXT,
  confidence          REAL NOT NULL DEFAULT 0.5,
  last_coactivated_at INTEGER,
  state_version       INTEGER NOT NULL
);
CREATE INDEX ix_edges_src ON memory_edges (persona_id, src_id);
CREATE INDEX ix_edges_dst ON memory_edges (persona_id, dst_id);
-- 不设"每节点最多 N 条边"的硬上限：靠局部质量、Hub 抑制与衰减回收控制规模。

CREATE TABLE activation_states (         -- 易失缓存，可重建，不是权威
  persona_id  TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  activation  REAL NOT NULL,
  updated_tick INTEGER NOT NULL,
  PRIMARY KEY (persona_id, node_id)
);

CREATE TABLE thought_threads (
  id                  TEXT PRIMARY KEY,    -- threadId
  persona_id          TEXT NOT NULL REFERENCES personas(id),
  channel             TEXT NOT NULL CHECK (channel IN ('external','inner','sleep','dream','audit')),
  trigger             TEXT,
  focus_ids_json      TEXT,
  unresolved_question TEXT,
  state               TEXT NOT NULL CHECK (state IN ('NEW','RUNNING','PAUSED','INTERRUPTED','COMPLETED','ABANDONED')),
  priority            INTEGER NOT NULL DEFAULT 0,
  epoch               INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  last_active_at      INTEGER NOT NULL
);
CREATE INDEX ix_threads_persona_state ON thought_threads (persona_id, state, priority DESC);

-- 词法索引。⚠ 默认明文，可遗忘内容不得直接进入常驻索引（见下方 §4.1）
-- 派生索引：可从 memory_nodes 重建，**不强制**带 persona_id；但任何查询必须经 node_id 限定到
-- 单一人格，遗忘/擦除时必须同步删除（TRUST-BOUNDARIES §11.1，IDENTITY-PROTOCOL §1 第 5 条）。
CREATE VIRTUAL TABLE memory_fts USING fts5(node_id UNINDEXED, body, tokenize = 'unicode61');
```

### 4.1 FTS 明文与真实遗忘的冲突（OPEN）

SQLite FTS5 的索引内容默认是**明文**，`node:sqlite` 无法对索引加密。
"删掉正文、留下索引"等于什么都没删——搜一次就能把已遗忘的内容捞回来。

三个候选方案，**P3 前必须定一个**：

| 方案 | 做法 | 代价 |
|---|---|---|
| A. 分层索引 | 可遗忘内容**不进**常驻 FTS；检索时从解密正文临时构建内存索引，用完即弃 | 检索慢，内存占用高 |
| B. 只索引标签 | 索引里只放概念 ID / 主题标签，不放原文片段 | 丧失词法召回能力 |
| C. 接受约束 | 常驻 FTS 只服务"明确不允许遗忘"的内容（能力文档、技能） | 记忆检索全靠向量 + 图 |

当前默认倾向 **A**，但需 P3 基准测试后定案。**在定案前，禁止实现"常驻明文 FTS + 可遗忘内容"的组合。**

相关硬要求（详见 `TRUST-BOUNDARIES.md` §11）：

- `PRAGMA secure_delete = ON`，否则删行不从磁盘抹除。
- 遗忘事务结束必须 `PRAGMA wal_checkpoint(TRUNCATE)`。（目标约束。当前代码没有这条显式语句；连接关闭时 SQLite 可能做默认自动 checkpoint，二者不是同一件事。）
- 删除后必须在库文件与 `-wal` 中搜索金丝雀，命中数须为 0。

**节点类型与关系类型是开放注册表**，新增类型只需注册，不需要改表结构。

### 4.2 主观正文加密审查清单（P3 / P5 必须逐项定案）

除已明确加密的列（`memory_nodes.payload_enc`、`memory_fragments.content_enc`、
`archive_records.content_enc`）外，以下列**可能承载主观正文或私人内容**，
在 P3（记忆）与 P5（认知）实现前必须逐项确认：加密 / 白名单限制 / 或改存引用。

**P3 必须审查（记忆层）**

| 列 | 风险 | 初判 |
|---|---|---|
| `memory_nodes.source_impression` | 主观来源印象，可能写成"我记得是他说的……" 这类带内容的叙述 | **加密**或限为枚举（`direct` / `heard` / `inferred` / `dream` / `unknown`） |
| `memory_nodes.emotion_json` | 情绪常附带具体事由描述 | 限为数值向量 + 枚举标签；**禁止**放自由文本 |
| `memory_nodes.subjective_time` | 主观时间可能夹带事件描述 | 限为结构化时间或模糊枚举（`today` / `recently` / `long_ago`） |
| `memory_edges.origin_group` | 来源分组标识 | 只放不透明 ID |

**P5 必须审查（认知层）**

| 列 | 风险 | 初判 |
|---|---|---|
| `thought_threads.trigger` | 触发描述常直接引用原话（"他问我……"） | **加密**或限为枚举 + 节点 ID |
| `thought_threads.unresolved_question` | 未解决问题本身就是一整句私人内容 | **加密** |
| `thought_threads.focus_ids_json` | 只放 ID | 无需加密，但禁止拼入内容 |
| `dream_sessions.fragments_json` | 醒后保留的梦境片段，本质是主观正文 | **加密**或改存为 `memory_nodes` 的 Dream 节点 |
| `action_records.receipt_json` | 回执可能回带请求参数原文 | 只保留状态码与外部动作 ID；原文由适配器侧负责 |

审查通过的结论必须回写本节。**未定案前，上述列不得以明文自由文本形式落盘。**

## 5. 三期表（P6–P8）

```sql
CREATE TABLE erasure_tombstones (        -- 不含原文的不可逆墓碑
  persona_id   TEXT NOT NULL,
  node_id      TEXT NOT NULL,
  erase_epoch  INTEGER NOT NULL,
  erased_at    INTEGER NOT NULL,
  reason_code  TEXT,
  PRIMARY KEY (persona_id, node_id)
);

CREATE TABLE dream_sessions (
  id           TEXT PRIMARY KEY,
  persona_id   TEXT NOT NULL,
  sleep_task_id TEXT,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  outcome      TEXT CHECK (outcome IN ('COMPLETED','INTERRUPTED','AROUSED','REJECTED')),
  fragments_json TEXT                     -- 只留醒后选择保留的有限片段
);

CREATE TABLE action_records (             -- 幂等与回执
  action_id    TEXT PRIMARY KEY,
  persona_id   TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  adapter_id   TEXT NOT NULL,
  intent_version INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state        TEXT NOT NULL CHECK (state IN ('requested','approved','executing','succeeded','failed','revoked','expired')),
  receipt_json TEXT,
  requested_at INTEGER NOT NULL,
  settled_at   INTEGER
);

-- Archive：独立权限域、独立密钥、独立保留策略。
-- 该表属"记录域"，BRAIN 侧永不连接；只有 Archive Writer 进程可写。
-- 存档内容一律加密；此表只存元数据与密文引用。
CREATE TABLE archive_records (
  event_id     TEXT PRIMARY KEY,          -- 幂等键 = eventId：重复写入不产生第二条
  persona_id   TEXT NOT NULL,             -- 作用域：审计/移除都必须可按人格隔离
  source       TEXT NOT NULL,
  received_at  INTEGER NOT NULL,
  occurred_at  INTEGER,
  content_enc  BLOB NOT NULL,             -- 加密后的原始记录（AEAD 密文，不得明文）
  enc_key_id   TEXT NOT NULL,             -- AEAD 加密密钥标识（Archive 域，与主观记忆不同）
  mac_key_id   TEXT NOT NULL,             -- HMAC 指纹密钥标识（**与 enc_key_id 不同密钥**）
  ciphertext_sha256 TEXT NOT NULL,        -- **密文**完整性校验；禁止用原文普通 SHA-256
  content_fingerprint TEXT NOT NULL,      -- 键控指纹 HMAC(mac_key, 明文)，仅用于同 eventId 冲突检测
  byte_len     INTEGER NOT NULL,          -- 密文字节长度（非原文长度）
  retention_class TEXT NOT NULL
                 CHECK (retention_class IN ('standard','restricted','short_lived')),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL           -- **保留期限固化**：到期即删，不得为 NULL
);
CREATE INDEX ix_archive_persona ON archive_records (persona_id, received_at);
CREATE INDEX ix_archive_expiry ON archive_records (expires_at);

-- Archive 决策审计：只有"谁按哪条规则判了什么"，不含任何内容。
-- 归属：Reliable World / 审计侧；由 Ingress 决策路径写入，不属 Archive 域。
CREATE TABLE archive_decisions (
  event_id       TEXT PRIMARY KEY,        -- 一条事件一条决策记录
  persona_id     TEXT NOT NULL,           -- 作用域：审计也必须可按人格隔离
  disposition    TEXT NOT NULL CHECK (disposition IN ('required','excluded')),
  policy_id      TEXT NOT NULL,           -- 策略标识
  rule_id        TEXT NOT NULL,           -- 命中规则标识
  policy_version TEXT NOT NULL,           -- 策略版本（可追溯当时规则）
  decided_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL         -- 决策记录自身保留期限
);
CREATE INDEX ix_decisions_policy ON archive_decisions (policy_id, policy_version, decided_at);

-- 归档冲突记录：只记"某 eventId 出现了异内容重投"，不记内容本身。
-- 归属：Reliable World / 审计侧；由 runtime 在收到 append 返回 conflict 时写入。
CREATE TABLE archive_conflict_records (
  id            TEXT PRIMARY KEY,        -- 冲突记录 ID（`cnf_` 前缀，见 IDENTITY-PROTOCOL §3.1/§3.4）；**不是** eventId
  event_id      TEXT NOT NULL,           -- 被冲突的原事件
  persona_id    TEXT NOT NULL,           -- 作用域：审计也必须可按人格隔离
  detected_at   INTEGER NOT NULL,
  source        TEXT NOT NULL
                CHECK (length(source) BETWEEN 1 AND 64),
  adapter_id    TEXT NOT NULL
                CHECK (length(adapter_id) BETWEEN 1 AND 64),
  request_nonce TEXT NOT NULL
                CHECK (length(request_nonce) BETWEEN 16 AND 64),
  original_status TEXT NOT NULL,         -- 冲突被发现时原事件所处的 status（快照）
  original_archive_state TEXT,           -- 同上，archive_state 快照
  resolution    TEXT NOT NULL DEFAULT 'open'
                CHECK (resolution IN ('open','kept_original','manual_resolved')),
  expires_at    INTEGER NOT NULL
);
CREATE INDEX ix_conflict_event ON archive_conflict_records (event_id, detected_at);
-- 幂等键：四字段全部 NOT NULL；同一次投递的内部重试不得产生第二条。
CREATE UNIQUE INDEX ux_conflict_delivery
  ON archive_conflict_records (event_id, adapter_id, source, request_nonce);
```

### 5.1 Archive 表字段约束（完整性、指纹、保留）

1. `event_id` 为主键，**天然幂等**：重复归档请求视为已存在，不产生第二条记录。
2. `content_enc` **必须**是 AEAD 密文。`enc_key_id` 属 Archive 密钥域，**不得**与
   `memory_nodes.key_id` 混用或互相派生（两套密钥体系独立）。
3. **加密密钥与指纹密钥必须分离**：
   - `enc_key_id` → AEAD 加密/解密用；
   - `mac_key_id` → 仅用于 `content_fingerprint` 的 HMAC。
   - 二者**不得**是同一密钥，也不得由同一密钥直接派生而无法独立轮换。
   - 理由：指纹会参与冲突判定（读取路径），加密密钥只用于解密（严格路径）。
     合一会把"能比对"升级成"能解密"。
4. **完整性校验用密文哈希**：`ciphertext_sha256` 校验"存储未损坏"。
   **禁止**把原文的普通 SHA-256 作为长期审计元数据保存 —— 短文本的普通哈希
   可被字典/穷举反推，等于变相留存原文。
5. **冲突检测用键控指纹**：`content_fingerprint = HMAC(mac_key, 原文)`。
   - 同一 `eventId` 再次归档时比较指纹：相同 → 幂等命中；**不同 → 拒绝覆盖并报告冲突**。
   - 该指纹**不得**外发给 Brain（IPC 只回 `eventId` / `archiveState` / `archiveRef`），
     也不得用于跨事件的内容比对。
   - 指纹随记录与密钥一起销毁，不做长期保留。
6. `byte_len` 记录**密文**长度，不泄露原文长度（必要时填充到固定分组）。
7. **保留期限以 `expires_at` 固化**：写入时即算出绝对到期时间，不依赖"运行时再解释策略"。
   - `expires_at` **不允许为 NULL、不允许 0、不允许表示"永久"**。
   - 策略未配置有限保留期 → **拒绝归档**（配置错误），不得回退为永久。
   - `retention_class` 只决定"用哪档算出 `expires_at`"，删除以 `expires_at` 为准。
8. 本表**不得**被 Brain 侧连接。P1 阶段本表**不创建**（无 Archive Writer）；
   `excluded` 事件**不创建**本表记录。
9. 保留策略与主观记忆的 `lifecycle` / `epoch` / 墓碑**完全独立**：
   遗忘主观记忆**不会**删除 Archive；清理 Archive **不会**改写主观叙述。

### 5.2 Archive 决策记录（archive_decisions）

| 字段 | 含义 | 约束 |
|---|---|---|
| `event_id` | 对应事件 | 主键，一条事件一条 |
| `disposition` | `required` / `excluded` | 枚举，不得自由文本 |
| `policy_id` | 命中策略 | 配置标识 |
| `rule_id` | 命中规则 | 配置标识 |
| `policy_version` | 策略版本 | 保证历史判定可追溯 |
| `decided_at` | 判定时间 | Unix ms |
| `expires_at` | 决策记录保留期限 | 有限期，不得永久 |

**禁止字段**：正文、摘要、关键词、情感标签、原文哈希、原文长度、可反推内容的任何派生值。
决策记录只回答"谁按哪条规则判了什么"，**不回答"内容是什么"**。

**归属与权限**

- **归属**：Reliable World / 审计侧（不是 Archive 域，也不是主观记忆域）。
- **写入**：仅 Ingress 决策路径写，一条事件一条，不更新（`INSERT OR IGNORE` 保持幂等）。
- **读取**：管理员审计与 Studio 的审计视图；**Brain 运行时上下文不得读取**
  （它会让模型"知道自己被审计"从而改变行为，且本身就是审计信息泄露）。
- **保留**：`expires_at` 到期删除；与事件记录、Archive 记录**各自独立**，不随其删除而删除。

### 5.3 归档冲突记录（archive_conflict_records）

**问题**：`events.id` 是主键，冲突请求（同 `eventId`、不同正文）**无法**用同一 `eventId` 再插一条事件行。
若把原事件改写成 `rejected` 来表示"有冲突"，就等于让一条异内容请求**顶替**了原事件 —— 这是不可接受的。

**规则**

| 角色 | 处理 |
|---|---|
| **原事件记录** | **一律不改状态**。禁止因冲突重投把 `accepted` / `noticed` / `understood` / `response_committed` / `acted` 改写为 `rejected` |
| **冲突请求** | 不落 `events` 行；直接对适配器返回冲突响应（409 `archive_conflict`），**不 ACK** |
| **冲突审计** | 写入本表，一条请求一条记录，`id` 是独立的冲突 ID，**不是** `eventId` |

**唯一例外**：原事件仍处于 `status='received'` 且 `archive_state='pending'`（尚未 `accepted`）时，
归档无法完成，可将**原事件**转为 `rejected`（`archive_conflict`）—— 因为它本来就还没被接受。
一旦原事件进入 `accepted` 或更靠后的状态，**永不改写**。

**禁止字段**

- 冲突正文、正文摘要、关键词；
- 原文的普通 SHA-256 或任何可反推内容的派生值；
- 原文长度、字符数、token 数；
- 解密后的任何片段。

**允许字段**（即上文 DDL）：冲突 ID、`eventId`、检测时间、`source`、`adapter_id`、
**`request_nonce`（投递标识，非内容派生值）**、原事件状态快照、处置状态、过期时间。

> 指纹比对发生在 Archive Writer 内部；它只回一个 `conflict` 结果码，不回指纹本身。

**幂等规则（不依赖内容）**

1. **幂等键 = `(event_id, adapter_id, source, request_nonce)`**，四字段**全部 NOT NULL**，由唯一索引强制。
2. `request_nonce` 是适配器在信封里给的**不透明投递标识**，**不是**内容派生值，也**不是**事件内容的一部分。
   - 同一次投递的内部重试（重连、重发、应用层重试）**必须复用**同一 nonce → `INSERT OR IGNORE` 幂等，
     **不产生第二条记录**。
   - 不同的**逻辑投递** → **必须不同** nonce → 分别记录（这是期望行为，不是重复）。
3. **禁止**用正文哈希、内容指纹、长度、字符数等**内容派生值**充当幂等键或去重依据。
   用内容去重等于把原文特征长期留存，与"不留原文"自相矛盾。
4. **不得为了检测 nonce 重用而保存**正文哈希、内容指纹或其他内容派生值。
   nonce 重用由唯一索引自然发现（同键插入被忽略），**不需要也不允许**额外的内容比对。
5. **适配器未提供 `request_nonce` 时**：Ingress 拒绝该信封（`schema_invalid`），
   不允许系统自己"编一个"，也不允许退回按内容去重。

**`request_nonce` 的生成与绑定规则**

| 规则 | 要求 |
|---|---|
| 粒度 | **每次逻辑投递生成一个** |
| 内部重试 | **必须复用**同一个 nonce（重连、超时重发、应用层重试都算同一次投递） |
| 不同投递 | **必须使用不同 nonce**（哪怕是同一条消息、同一 eventId） |
| 随机性 | 必须由密码学随机源生成，具备足够熵（建议 ≥ 96 bit） |
| 禁止派生 | **禁止**从正文、正文哈希、内容指纹、递增计数、时间戳单值等可预测来源派生 |
| 身份绑定 | nonce 必须绑定**已认证的 adapter 身份**：nonce 与 `adapter_id` 一起构成投递身份，<br>跨适配器复用同一 nonce 不得被视为同一次投递 |
| 主动复用 | **不得主动复用**已使用过的 nonce（不做 nonce 池、不做回滚复用） |

**信封 Schema 中的规定**（细节见 `RUNTIME-LIFECYCLE.md` §7.1 的信封字段表）

- 类型：字符串；格式：`^[A-Za-z0-9_-]{16,64}$`（base64url / UUID 类无填充字符）；
- 长度上限 64 字符，下限 16 字符；
- 必填，缺失即 `schema_invalid`；
- 由 **`contracts` 的 JSON Schema** 声明，接收入口执行校验。

**标识符约束与职责分工**

> 长度 `CHECK` **只保证非空与长度合理**，它**不是**正则校验。不要声称 DDL 已执行完整格式验证。

| 层 | 负责什么 | 不负责什么 |
|---|---|---|
| **Ingress Schema（`contracts`）** | 完整字符集与格式校验：`^[a-z0-9._-]{1,64}$`；长度、必填、类型 | 不判断该标识符是否真实注册 |
| **数据库 DDL** | `NOT NULL`、长度区间、枚举取值、唯一索引 | **不**做正则匹配、不**做**注册校验 |
| **注册表（配置）** | `adapter_id` / `source` 是否为**合法且已注册**的标识符；未知标识符一律拒绝 | 不做格式解析（假定 Schema 已过） |

**四级校验顺序**：Schema 格式 → 注册表存在性 → 鉴权（该适配器是否有权投递该 source）→ 落库。

- **内部来源**（sleep / dream / inner 等系统通道）**必须**使用正式受控的 `adapter_id`
  （例如 `system.sleep`），**不允许**用 `NULL` 表示"内部"。
- **不得**接收自由文本、正文片段、错误消息、用户昵称、URL 或文件路径作为标识符。

**写入失败语义**

| 情况 | 处理 |
|---|---|
| 冲突审计写入失败 | **响应不受影响**：仍然返回 409 `archive_conflict`（拒绝优先，不能因为记账失败就接受冲突内容） |
| 重试 | 有界重试（默认 3 次）；失败计入 `audit_gap` 指标与结构化日志（**不含内容**） |
| 持久失败 | 上报运维，人工补录；**不得**因此改写原事件、**不得**接受冲突请求 |
| 原事件状态 | 任何情况下**不受**本次审计写入成败影响 |

**保留**：`expires_at` 到期删除；与事件记录、Archive 记录**各自独立**，不随其删除而删除。

## 6. 版本与纪元

四个版本 / 纪元概念各自维护，**不许合并成一个计数器，也不许混淆作用域**：

| 概念 | 作用域 | 语义 | 变化 / 规则 | 当前 P1 事实 |
|---|---|---|---|---|
| `state_version` | 目标实体 / 记录级 OCC | 乐观并发版本 | 该领域每次成功提交 +1；只在适用的实体上使用 | 当前 P1 没有统一名为 `state_version` 的列；`personas` 使用 `version`，其余 P1 表的条件写见 §6.2 |
| Persona `epoch` | 人格级内容纪元 / 恢复下限 | 遗忘代际与旧结果隔离 | 遗忘时 +1，只增不减；旧检查点低于当前 epoch 不得复活内容 | `personas.epoch` 与 `runtime_state.epoch` 已存在；checkpoint 必须与 `runtime_state.epoch` 一致 |
| `memory_nodes.content_epoch` | 记忆节点级内容 / 索引新旧 | 节点内容与派生索引的一致性代际 | 节点内容或索引语义变化时更新；不得用 Persona `epoch` 代替 | 目标 Schema 字段；当前 P1 尚未创建 `memory_nodes` |
| `action_records.intent_version` | 动作记录的意图版本 | 场景 / 意图版本；过期意图不得执行动作 | 意图实质变化时更新；新意图按 `IDENTITY-PROTOCOL.md §4.6` 分配新 `actionId` | 目标 Schema 字段；当前 P1 尚未创建 `action_records` |

`intent_version` **只属于 `action_records`**，不是所有认知实体或所有 Intent 对象的通用字段。`state_version` 也不是每张表当前都已具备的列；具体字段是否存在以本文件对应表定义和 §6.3 为准。

### 6.1 目标 `base_version` 规则

以下规则是**目标领域契约**，不得删除、弱化或改写；它们不表示当前 P1 的所有 Repository 已经实现统一 OCC：

1. 任何写事务提交前校验 `base_version` 与当前一致，否则拒绝并要求重算。
2. 恢复时取 `max(epoch)`；旧检查点的 `epoch` 低于当前 → **不得**越过墓碑复活内容。
3. 迟到模型结果若 `base_epoch < 当前 epoch` → 直接丢弃，不合并。

目标设计中的 `state_version`、Persona `epoch`、`memory_nodes.content_epoch` 与 `action_records.intent_version` 按各自粒度参与提交条件；并非每种提案都需要携带或比较全部版本字段，也不得用 Persona `epoch` 替代节点 `content_epoch`，或把 `intent_version` 当成通用实体版本。

### 6.2 当前 P1 的实际条件写入边界

以下只描述 `0001_init_core.sql` 已创建的 P1 六表。不得把下列条件写、唯一索引或状态谓词概括为统一 `state_version` CAS；也不得把目标表写成当前已实现能力。

| 表 / 对象 | 当前实际字段 | 实际条件写 / 约束 | 不是统一 OCC 的部分 |
|---|---|---|---|
| `personas` | `version`、`epoch`；**没有** `state_version` 列 | `compareAndSetState` 与 `commitLifecycle` 使用 `state + version` 条件写，并递增 `version`；`updateState` 仅按 `id` 更新，递增 `version`，**不比较**预期状态或版本；当前源码未发现 `updateState` 调用者 | `updateState` 不是 CAS；不能把 `personas` 的所有写入都说成版本 CAS；`epoch` 不是通用 OCC |
| `runtime_state` | `epoch`、`checkpoint_json`；**没有** `state_version` 列 | checkpoint `save()` 在写事务中先核对 `runtime_state.epoch` 与输入 `epoch` 一致，再写 `checkpoint_json`；通用 `upsert()` 按冲突更新 `state` / `boot_id` / `epoch` 等字段，**没有** CAS | checkpoint 的 epoch 检查不等于整个 `runtime_state` Repository 具备统一 OCC；`upsert()` 本身不是 CAS |
| `sessions` | 无版本列 | `ux_sessions_external` 是部分唯一索引（仅 `closed_at IS NULL` 的有效映射）；查找有效会话使用 `persona_id + adapter_id + external_id + closed_at IS NULL`；关闭使用 `id + persona_id + closed_at IS NULL` 条件 | 唯一索引和有效会话谓词不是版本 CAS |
| `events` | 无版本列 | P1 信封提交先在事务内插入 `received`，再用 `id + persona_id + status='received' + archive_state='none'` 更新到结果；`expireActive` / `rejectIfActive` 使用 `status IN ('received','accepted') + archive_state='none'` | 不同操作使用 `status` / `archive_state` 谓词，不是 `state_version` CAS |
| `tasks` | 无版本列 | `claimNext` 使用 `state='queued'`、`attempt` 上限、`channel` 和 Persona `RUNNING`；`completeTask` / `failTask` 使用 `state='running' + run_id + attempt`；`setTaskState` 等按各自状态与 attempt 条件写 | 状态、`run_id`、`attempt` 谓词随操作而异，不能称为 `state_version` CAS |
| `schema_migrations` | `version` 主键 | 迁移记录按 `version` 唯一；不是业务实体 OCC | 迁移版本不是业务乐观并发版本 |

**验证路径（只读证据）：** `packages/persistence/migrations/0001_init_core.sql`；`packages/persistence/src/repositories/personas.ts`、`runtime-state.ts`、`checkpoint.ts`、`sessions.ts`、`events.ts`、`tasks.ts`；测试 `persona-lifecycle-write.test.ts`、`checkpoint.test.ts`、`event-write-boundary.test.ts`、`tasks-state.test.ts`、`conditional-update.test.ts`。

### 6.3 目标 Schema 与 `thought_threads`

- `memory_nodes`、`memory_edges`、`thought_threads`、`action_records`、`dream_sessions` 等是**目标 Schema**，当前 P1 Migration 尚未创建；不得把它们列入 P1 实际写入能力。
- 目标 `memory_nodes` 同时设计 `content_epoch` 与 `state_version`；目标 `memory_edges` 只有 `state_version`；目标 `action_records` 只有 `intent_version`。这些是不同粒度的目标设计，不能互相替代。
- 目标 `thought_threads` **确实有 `epoch` 字段**，但它不能直接等同于 Persona `epoch`。其 OCC 字段 / 并发控制方案仍归 **CA-OPEN-05**；本文件不为其指定 `state_version`，不新增字段，也不给出未裁决的 OCC 语义。
- 目标表当前没有 Migration、Repository 或写入路径，无法运行时验证其版本 / OCC 行为；不得把目标设计写成已实现，也不得写成“已实现但仅缺证据”。

## 7. 一致性协议

```
Read Snapshot（事务外，含 version/epoch）
    → Model Proposal（事务外，模型只提案）
    → Schema 校验
    → 权限校验（域 / persona / 字段）
    → 版本与 epoch 校验
    → 冲突合并或要求重算
    → 短事务 Commit（单写入者）
    → 派生索引刷新（FTS / 向量）
    → 广播（WebSocket）
```

写事务尽量短；不得在事务内调用模型、网络或文件 IO。
高频激活**不写盘**：活跃子图在内存迭代，批量快照。

## 8. 迁移规则

1. 每个变更 = 一个 migration 文件，带 `checksum`，记录到 `schema_migrations`。
2. migration 必须**幂等**、可在空库上重放、有对应的回滚说明。
3. **禁止修改已提交的 migration**；错误用新 migration 修正。
4. 破坏性变更（删列/删表）必须分两步：先停用，确认无引用后再删。
5. 表归属唯一：每张表只属于一个包（见 MODULES.md），跨包访问必须走该包接口。

## 9. 旧库 → 新库的映射提示

> 迁移是**一次性重编码**，不是导出导入。旧库 `user_version=0`，只能靠表结构探测判断版本。

| 旧表 | 去向 | 说明 |
|---|---|---|
| `sessions` | `sessions` | 需补 `adapter_id='dsh'` |
| `events` | `events` | 旧行无正文，天然符合新设计；`summary` 需重新生成 |
| `episodes` / `episode_notes` | `memory_nodes`（Experience） | 按锚点生成初始主观痕迹，**保留"旧系统摘要"来源标记** |
| `messages` | 不迁入主观记忆 | 原文属 Archive；是否导入由迁移授权窗口决定 |
| `links` | `memory_edges` | **权重不可直接沿用**；五边上限与两跳扩散的产物需要重算 |
| `dream_runs` / `dream_notes` | `dream_sessions` + 记忆节点 | 语义待确认（见 LEGACY-BASELINE 未决项） |
| `world_events` / `world_cursor` | `events`（source 加 `mc.world`） | 游标不迁移，新内核重新建立 |
| `frames` / `note_usage` | 不迁移 | 属旧索引与统计实现细节 |

**硬规则**：旧库中的"历史模型摘要"不得自动提升为真实经历，必须保留其 `source_impression = '旧系统推断'` 类标记。
