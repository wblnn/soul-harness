# `@soul-harness/persistence` — 持久化基础

- **地位**：P1 唯一的 SQLite 访问层。任何模块都不得自行打开数据库文件、转换字段名或直接写表。
- **状态**：**批次 A（数据库基础与 Migration）+ 批次 B（事务、字段映射、六表 Repository）+
  批次 C（检查点读写与恢复读取）+ 批次 D（集成验收）已完成**。
  恢复 Runtime 对象、认知状态重建与生命周期编排属后续阶段。
- **集成验收**：`test/integration.test.ts` 覆盖真实文件的完整链路（open → migrate → 六表读写 →
  检查点 → close → 重新 open → 再 migrate → 读回），并在 `tools/consumer-check` 中以包名导入、
  真实建库跑通一次消费流程。
- **上位文档**：[DATA-MODEL](docs/architecture/DATA-MODEL.md) §1/§3/§6/§8、[MODULES](docs/architecture/MODULES.md) §2–§3、
  [RUNTIME-LIFECYCLE](docs/architecture/RUNTIME-LIFECYCLE.md) §2/§9、[TRUST-BOUNDARIES](docs/architecture/TRUST-BOUNDARIES.md) §5.1/§11.3。

## 1. 负责什么

| 能力 | 说明 |
|---|---|
| 连接与生命周期 | `openStore()` / `Store.close()`；自动创建父目录；不自动执行迁移 |
| 连接不变量 | `journal_mode=WAL`、`foreign_keys=ON`、`secure_delete=ON`、`busy_timeout`；打开后**读回断言** |
| Migration | 目录或数组来源统一校验、版本唯一、升序、checksum、逐文件事务 |
| 结构校验 | `verifySchema()` 对照 P1 六表六索引（含列顺序） |
| 事务 | `withWrite` / `withRead`；单写者、同步回调、嵌套拒绝、句柄失效保护 |
| 字段映射 | snake↔camel 纯机械转换；JSON 列带 schema 标识；布尔 0/1 |
| Repository | 六张 P1 表的基础 CRUD；错误分类；分页上限 |
| 检查点 | 版本化 envelope 的保存/读取；epoch 校验；损坏与不支持版本的明确判定 |

## 2. 不负责什么

1. **不判断业务语义**：不决定事件是否该被注意、是否形成记忆、人格该做什么。
2. **不访问 Archive**：无连接、无密钥、无解密能力；P1 的 archive 三列恒为 NULL/NULL/`none`。
3. **不暴露裸句柄**：`DatabaseSync` 不在包入口；事务回调只拿到有生命周期的 `Tx`。
4. **不做进程级单实例锁**：属 Daemon（RUNTIME §9 第 4 步）。
5. **不保存正文**：P1 六表无任何正文字段。
6. **不实现检查点语义**：只按 envelope 存取 `runtime_state.checkpoint_json`；不决定何时保存、不根据它重建 Runtime。

## 3. 目录

```
packages/persistence/
├─ migrations/0001_init_core.sql   # P1 六表 + 六索引
├─ src/
│  ├─ index.ts                     # 唯一公共入口
│  ├─ errors.ts                    # PersistenceError + 受控错误码
│  ├─ mapping.ts                   # snake↔camel、JSON 列、布尔
│  ├─ db/{open-store,store,pragmas,rows,classify}.ts
│  ├─ tx/{coordinator,statements,read-guard-fault}.ts
│  ├─ checkpoint/format.ts        # 版本化 envelope 的编码/校验
│  ├─ migrations/{types,expected-schema,load,migrator}.ts
│  ├─ repositories/{personas,sessions,events,tasks,runtime-state,checkpoint,schema-migrations,shared,index}.ts
│  └─ types/rows.ts                # camelCase 行类型（复用 contracts 品牌 ID）
└─ test/                           # 311 项，真实 SQLite 文件
```

## 4. 依赖

- 运行时依赖：`@soul-harness/contracts`（仅类型与枚举；品牌 ID、事件状态等）。
- 数据库驱动：Node 内置 `node:sqlite`，**无第三方数据库依赖、无 ORM**。

## 5. 事务模型

```ts
withWrite(store, (tx) => T): T     // T 必须同步；返回 Promise 视为错误
withRead(store, (tx) => T): T
```

| 保证 | 实现 |
|---|---|
| 单写者 | 单连接 + `BEGIN IMMEDIATE`；回调**同步**执行，JS 单线程下事务不可能被 `await` 打断 |
| 异步回调 | 运行时检测 thenable → `async_callback_unsupported`（回滚），**不做半支持** |
| 嵌套写 | 任何模式下的 `withWrite` 嵌套 → `nested_write` |
| 读嵌套 | `withRead` 在外层事务内**加入**外层（不新开事务、不提交），但叠加**深度计数**的只读守卫：最外层读作用域把 `query_only` 置 ON，全部退出后还原 |
| 只读强制 | 只读作用域（含嵌套）期间 `PRAGMA query_only = ON`（连接层）；读接口另只允许 prepare `SELECT/WITH/VALUES/EXPLAIN` |
| 事务控制权 | 回调**没有** `exec`，只有 `prepare()`；`BEGIN/COMMIT/END/ROLLBACK/SAVEPOINT/RELEASE/PRAGMA/ATTACH/DETACH/VACUUM` 一律 `statement_blocked` |
| 语句生命周期 | 每次 `run/get/all` 与迭代器每次 `next()` 都检查事务是否仍 active；事务结束后 → `transaction_closed` |
| 句柄形态 | `Tx`（`kind: 'write'`）与 `ReadTx`（`kind: 'read'`）是不同类型，不可互换 |
| 清理失败 | 读守卫恢复失败 → Store 标记 `store_unusable`；若回调本身成功，**调用整体失败**并抛出 `store_unusable`，绝不返回正常结果 |
| 事务失效 | Store 一旦 unusable，**当前活动事务同步失效**：新 `prepare` 抛 `store_unusable`，此前已 prepare 的语句抛 `transaction_closed`，`withWrite` 拒绝 COMMIT 并回滚 |
| 全操作失效 | unusable 后 **Repository 读**（`readDatabaseOf`）与 **Migration 公共 API**（`migrate` / `verifySchema`）同样拒绝，不只是写 |
| 错误保真 | 非 SQLite 错误原样抛出（identity 不变）；SQLite 错误分类后带 `cause` |
| 关闭后 | `store_closed`，不会静默重开 |

> **设计取舍**：不提供异步事务。`node:sqlite` 是同步 API，允许 `await` 会把事务拉长到跨越提交点之外，
> 正是"异步操作在事务结束后继续写库"的成因。需要异步工作时，应在事务**外**完成。
>
> **SQL 能力闸门**不是子串黑名单：它取注释与空白之后的**首个关键字**判定（`firstKeyword()`），
> 且依赖 `node:sqlite` 只准备第一条语句的行为（实测：`SELECT 1; SELECT 2` 只执行第一条）。
> 关键字闸门只决定"能不能 prepare"，**不承担只读判定**——`WITH … INSERT/UPDATE/DELETE`
> 首关键字是 `WITH`，会被闸门放行，但一定被 `query_only` 在 SQLite 执行层拒绝。
>
> **嵌套读作用域的只读性**：在外层写事务中开启 `query_only` 已在真实 SQLite 上验证——
> 写入（含 `WITH …` 形式）被 SQLite 以 `read_only_violation` 拒绝，读取仍能看到未提交行，
> 还原后外层事务可继续写入并正常提交。守卫按深度计数，连续/嵌套的多个读作用域互不干扰。
>
> **读守卫清理失败的语义**：`query_only` 无法恢复意味着连接状态未知，因此
> ① Store 立即标记为不可用，后续 `withRead`/`withWrite` 一律 `store_unusable`；
> ② 若回调正常返回，`withRead` 抛出 `store_unusable` 而不是返回结果；
> ③ 若回调已经抛错，**原始错误保持 identity 不被覆盖**，清理失败作为后续拒绝时的 `cause` 记录
> （消息只描述操作，不含 SQL 或路径）；
> ④ **正在运行的事务一并失效**：即使外层 `withWrite` 的回调捕获了内层错误并正常返回，
> 该事务也永不被提交——协调器在 COMMIT 前检查 Store 状态，改为 ROLLBACK 并抛出
> `store_unusable`；回调期间的新语句与已 prepare 的语句同样被拒绝。

## 6. 字段映射

| 规则 | 例 |
|---|---|
| camel → snake | `personaId` → `persona_id`、`adapterEventRef` → `adapter_event_ref` |
| snake → camel | `received_at` → `receivedAt` |
| 非法名 | 空、首字母大写、`__`、首尾下划线、含 `-`/空格 → `invalid_field_name`（**不修复**） |
| 行键转换 | `camelizeRow()` 只改键；`null` 原样保留，不转 `undefined` |
| 布尔 | `toDbBoolean` / `fromDbBoolean`；只接受 0/1，其他 → `invalid_column_value` |
| JSON 列 | `encodeJsonColumn(schemaId, payload)` 写入 `schema` 标记；`decodeJsonColumn` 校验；payload 自带 `schema` 被拒绝 |

映射**不生成 SQL**：Repository 用固定语句 + 参数绑定，映射只处理名称与列值形状。

## 7. Repository

| 表 | 方法 |
|---|---|
| `personas` | `insert` / `insertWithRuntimeState` / `getById` / `updateState`（版本自增）/ `compareAndSetState`（条件写）/ `commitLifecycle`（条件写并镜像 `runtime_state`）/ `list(limit)` / `listPage`（键集分页） |
| `sessions` | `insert` / `getById` / `findActiveByExternal` / `openActive`（只返回未关闭映射，关闭后插入新 id）/ `close` / `listByPersona` |
| `events` | `insert`（archive 三列不可设；`summary` 只接受 NULL；`adapterEventRef` 强制格式）/ `getById` / `findByDedupeKey` / `updateStatus` / `expireIfActive`（条件写：必须带 `personaId`，且仅 P1 `archive_state='none'`，只写 `buffer_lost`）/ `commitP1Envelope`（同一事务 `received` → P1 结局）/ `expireActive`（同一守卫，只接受过期原因码）/ `rejectIfActive`（同一守卫，只接受拒绝原因码）/ `listByPersonaStatus` / `listPageByPersonaStatus`（键集分页） |
| `tasks` | `insert` / `getById` / `updateState` / `listByPersonaState` |
| `runtime_state` | `upsert`（不触碰 checkpoint）/ `get` |
| `checkpoints` | `load` / `save`（见 §7.1；**无 clear**） |
| `schema_migrations` | **只读**：`listApplied` / `getLatest` |

- 所有写入都经过 `withWrite`；Repository 不持有连接、不暴露 `DatabaseSync`。
- 列表查询默认 50、上限 500，越界 → `invalid_argument`，不存在"全表读取"入口。
- 错误区分：`unique_conflict` / `foreign_key_violation` / `check_violation` / `not_null_violation` / `db_error`。
- 返回 `null` 表示"不存在"（`getById`）或"未命中/未变更"（`updateState` 返回 `null`、`close` 返回 `false`）。

### 写入边界的两条硬校验（SH-006B.R1）

| 规则 | 行为 |
|---|---|
| `events.summary` 在 P1 只能为 NULL | 类型为 `summary?: null`；运行时任何非 NULL 值 → `invalid_column_value`，且**在事务开启前**拒绝，数据库不受影响（DATA-MODEL §3.1：摘要属内容，不得落库） |
| `adapterEventRef` 必须匹配 `^[A-Za-z0-9._:-]{1,64}$` | 复用 contracts 的 `isAdapterEventRef`；空串、超长、空白、换行、中文、非法字符 → `invalid_identifier`；**不 trim、不修复**；去重键行为不变 |

> 未追加数据库层 CHECK（会需要重建表）；当前由写入边界强制，`0001_init_core.sql` 保持原样。

### 7.1 检查点（SH-006C）

```ts
const result = checkpoints.load(personaId);   // 'absent' | 'present' | 'stale'
const stored = checkpoints.save({ personaId, epoch, refs?, updatedAt });
```

**存储格式**（`runtime_state.checkpoint_json`，DATA-MODEL §3.1 只允许游标/队列位置/版本号/活跃 ID 列表）：

```json
{
  "schema": "soul.runtime.checkpoint.v1",
  "version": 1,
  "epoch": 3,
  "refs": { "cursor": "sched:0:17", "threadIds": ["thr_…"], "runIds": ["run_…"] }
}
```

| 规则 | 行为 |
|---|---|
| `schema` | 必须是 `soul.runtime.checkpoint.v1`，否则 `checkpoint_version_unsupported` |
| `version` | 必须是 `1`；其他值（含字符串）→ `checkpoint_version_unsupported` / `checkpoint_invalid` |
| `epoch` | 非负整数；`save` 时**必须等于** `runtime_state.epoch`，否则 `checkpoint_epoch_mismatch` |
| `refs` | 可选；只允许 `cursor`（`^[A-Za-z0-9._:-]{1,128}$`，**整串精确匹配**）、`threadIds`、`runIds`（contracts 品牌 ID，各 ≤256） |
| 未知字段 | 一律拒绝（`checkpoint_invalid`）——防止未来写入方夹带正文 |
| 大小上限 | 64 KiB |
| 缺失 / 损坏 | 缺失 → `absent`；非法 JSON、缺字段、类型错误、超限 → `checkpoint_invalid`（**不得当作空检查点**） |
| 过期 | envelope `epoch` < 行 `epoch` → 返回 `stale`，**不删除**（丢弃是恢复流程的决定，见 RUNTIME-LIFECYCLE §4） |
| 超前 | envelope `epoch` > 行 `epoch` → `checkpoint_epoch_mismatch` |
| 无运行状态行 | `save` → `runtime_state_missing`；`load` → `absent` |

**事务与所有权**：

- `save` 在 `withWrite` 内执行单条 `UPDATE`（原子、失败回滚、旧检查点不变）；载荷在**开启事务前**校验。
- `load` 在 `withRead` 内执行，加入外层事务时能读到未提交的检查点。
- `runtime_state.upsert` 不写 `checkpoint_json`；`checkpoints.save` 只写 `checkpoint_json` 与 `updated_at`，两边互不覆盖。
- 嵌套调用仍受 SH-006B 约束：`save` 在外层事务内 → `nested_write`；Store unusable → `store_unusable`。
- **不提供 `clear()`**：架构只定义了恢复时"丢弃"过期检查点，没有授权删除已存检查点的接口。

### 7.2 键集分页与条件写（SH-008P）

恢复流程需要"能证明读全"和"不覆盖并发修改"，因此新增四个方法；**表结构、索引、迁移均未改动**。

| 方法 | 语义 |
|---|---|
| `personas.listPage({ afterId?, limit? })` | 按主键 `id` 升序的键集分页 |
| `events.listPageByPersonaStatus({ personaId, status, afterId?, limit? })` | 同上，先按 `persona_id` + `status` 过滤 |
| `personas.compareAndSetState({ id, expectedState, expectedVersion, nextState, updatedAt })` | 条件写；`version` 由语句自增（INV-V） |
| `events.expireIfActive({ id, personaId, updatedAt })` | 条件写，**仅** P1 缓冲丢失恢复：同一 `personaId` 下，`received`/`accepted` 且 `archive_state = 'none'` → `expired` + `buffer_lost`。不处理归档恢复（扫描 A / 扫描 B） |

**分页约定**

- 游标与 `ORDER BY` **使用同一列 `id`**（唯一、主键索引），因此翻页不可能跳行或重复；
- 首屏不传 `afterId`；末页返回行数 `< limit` 即结束；空页同样视为结束；
- `id` 之外的排序键（`created_at` / `received_at`）**不可**用作游标——它们不唯一；
  原有的 `list` / `listByPersonaStatus` 保持时间排序，不能用于完整扫描；
- 一次 `withRead` 内连续调用多页 = 同一读事务快照（WAL）：期间其他连接提交的
  插入/删除对本轮扫描不可见。快照外的变化由条件写 + 调用方的复核扫描处理；
- 上限仍为 500/次；非法游标或越界 `limit` → `invalid_argument`，且在**任何数据库访问之前**抛出。

**条件写约定**

- 守卫写在同一条 `UPDATE` 的 `WHERE` 中，不存在"先读后写"的竞态；
- 条件不匹配返回 `null`，**未修改任何字段**；
- `expireIfActive` **严格限于 P1 缓冲丢失恢复**（`archive_state = 'none'`），不处理归档恢复。
  同一条 `UPDATE` 的 `WHERE` 为
  `persona_id = ? AND id = ? AND status IN ('received', 'accepted') AND archive_state = 'none'`：
  - 按 ID 访问事件必须同时带 `personaId`（IDENTITY-PROTOCOL §1 第 5 条）。用人格 A 的 `personaId`
    过期人格 B 的 `eventId` 不会改任何列；`personaId` 在开事务前按 `isPersonaId` 校验，非法值
    → `invalid_identifier`（与 `adapterEventRef` 同一错误码；分页游标仍是 `invalid_argument`）；
  - `archive_state` 不是 `'none'` 的行（`pending` / `archived` / `failed` / `excluded`）一律不改。
    扫描 A（对象是 `pending`）和扫描 B（对象是 `failed` 等）要先对账归档状态；本方法不代替它们，
    也不会把这些行静默标成 `expired`；
  - `SET` 只写 `status`、`status_reason = 'buffer_lost'`、`updated_at`。`attention_outcome` 保持原值。
    终态 `acted` / `rejected` / `expired` 不会被命中；
- `version` 严格自增是持久化不变式：CAS 以 `version` 为令牌，若允许写入后版本不变会引入 ABA。

### 7.3 人格行与 `runtime_state` 同事务写入（SH-008B）

`compareAndSetState` 仍然只改 `personas`，不写 `boot_id`，也不碰 `runtime_state`。生命周期需要「状态、版本、boot id、runtime 行」一次落地，因此新增两个方法。它们不判断转移是否合法，也不接受调用方传入的 `epoch`。

| 方法 | 语义 |
|---|---|
| `insertWithRuntimeState(input)` | 同一事务插入 `personas` 与 `runtime_state`。`version` / `epoch` 用表默认值（0 / 1）。不写检查点 |
| `commitLifecycle({ id, expectedState, expectedVersion, nextState, updatedAt, bootId? })` | 条件写。命中则 `version` 严格 +1，并把结果行镜像到 `runtime_state`。未命中返回 `null`，两表都不变 |

`bootId` 省略时保留 `personas.boot_id`；传入 `null` 则清空；传入合法 `BootId` 则覆盖。镜像行的 `boot_id` 与 `epoch` 取自刚写完的人格行，因此 epoch 不会在这里被增加。两条语句都不包含 `checkpoint_json`，已有检查点保持原样。

参数在打开事务之前校验：非法 `PersonaId`、`BootId`、状态名或非安全整数 → `invalid_identifier` / `invalid_argument`，库不变。

### 7.4 会话复用与 P1 信封提交（SH-008C）

Ingress 需要两件现有方法做不到的事：在一个写事务里区分「活跃会话」和「已关闭会话」，以及把事件从 `received` 推进到 P1 结局之后再提交。表结构没有变。

| 方法 | 语义 |
|---|---|
| `sessions.openActive({ id, personaId, adapterId, externalId, openedAt })` | 已有 `closed_at IS NULL` 的同键行则返回它（`created: false`），不使用调用方这次带来的 `id`。没有则插入 `id`（`created: true`）。已关闭的行不会被打开。唯一冲突若能再读到活跃行，返回那一行；主键被别的外部引用占用则抛 `unique_conflict`，调用方另分配 id |
| `events.commitP1Envelope(input)` | 同一 `withWrite` 内先插入 `status='received'`（归档列不出现在语句里，保持 NULL / NULL / `'none'`），再更新为 `accepted`，或 `expired` + `queue_overflow`。提交后看不到中间的 `received`。不接收正文。去重键或主键冲突 → `unique_conflict`，事务回滚 |
| `events.expireActive({ id, personaId, updatedAt, reason })` | 与 `expireIfActive` 同一条守卫：`persona_id` + `id` + `status IN ('received','accepted')` + `archive_state='none'`。`reason` 只能是过期原因码。未命中返回 `null`，终态和非 `none` 的归档状态都不改 |
| `events.rejectIfActive({ id, personaId, updatedAt, reason })` | 同一条守卫，但写成 `rejected`。`reason` 只能是拒绝原因码。不写 `buffer_lost`。未命中返回 `null` |

`expireIfActive` 仍只写 `buffer_lost`，语义与 SH-008P / PR #3 相同，没有改成通用方法。运行期把活跃事件收成 `rejected` 走 `rejectIfActive`，不借用 `buffer_lost`。`openActive` 的 `externalId` 必须是去掉首尾空白、不含空白或控制字符、长度 1..256 的字符串（`ACTIVE_SESSION_EXTERNAL_ID_MAX_LENGTH`）。这是写入边界，不是协议里的新字符集；超限在开事务前拒绝。原有 `sessions.insert` 不套用这条长度限制。

`commitP1Envelope` 的 `outcome` 只允许 `accepted`，或 `expired` 且原因为 `queue_overflow`。其它形状在开事务前 → `invalid_argument`。

## 8. Migration 机制

1. 文件命名 `NNNN_<snake_desc>.sql`；目录来源与数组来源**共用** `normalizeMigrations()`（校验 + 去重 + 升序）。
2. checksum = 归一化（CRLF/CR → LF）后内容的 SHA-256；始终由 SQL 文本推导，调用方无法注入。
3. 已应用迁移先校验 checksum；不匹配 → `migration_checksum_mismatch`，且不执行任何新迁移。
4. 待应用迁移逐个 `BEGIN IMMEDIATE … COMMIT`；失败回滚，不留半成品表与记账行。
5. 缺失版本 → `migration_not_found`；待应用版本低于已应用最高版本 → `migration_out_of_order`。
6. 允许版本不连续；追踪表由迁移器自举，`0001` 以 `IF NOT EXISTS` 重复同一 DDL。

### 回滚说明

- 已应用迁移**永不回滚**（DATA-MODEL §8.3）；修正靠新增迁移。
- `0001_init_core.sql` 文件头写明测试环境的 DROP 顺序。

## 9. 已知限制

1. **事务回调必须同步**（见 §5）；异步调用方需要在事务外完成 IO。
2. `verifySchema()` 只覆盖 P1 六表；新增迁移必须同步更新 `expected-schema.ts`。
3. 行类型里的 ID 使用 contracts 品牌类型，但**读取不再校验格式**：数据库是存储，不是鉴权边界。
4. `PersonaState` / `TaskState` 目前定义在本包（contracts 未提供）；迁入 contracts 属后续契约变更。
5. **WAL checkpoint 不在本包**。本包不执行显式 `PRAGMA wal_checkpoint`。`Store.close()` 只关闭 `DatabaseSync`；SQLite 在关闭时可能做默认自动 checkpoint，这不保证 `TRUNCATE`，也不等于遗忘语义。单实例锁已在 `apps/soul-daemon`（SH-007A）实现，不属于本包。
6. 检查点只提供 envelope 存取：**业务载荷（调度器的具体游标语义、活跃思维集合的判定）由后续 Runtime 批次定义**；本包不解释 `refs` 的含义，只校验形状。
7. 检查点保存是**独立事务**：SH-006B 规定事务回调必须同步且禁止嵌套写，因此运行期无法把 checkpoint 保存并入更大的事务；若未来需要，属于事务契约变更。
