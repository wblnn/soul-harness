# Soul Harness 2.0

独立认知运行时。人格身份、主观记忆、思维进程与情绪状态由本系统自己持有，不依附任何聊天平台。

DSH / Minecraft / QQ / CLI 都是**可选适配器**；不安装它们，Daemon 也必须能独立运行。

> "自我""意识""睡眠""梦"是系统设计与行为模拟概念，不主张软件具备已被证实的人类意识。

---

## 当前状态

**P0：架构冻结与工程规范。** 文档主体已完成；`packages/contracts` 已落地（SH-004）；
Monorepo 根工程化已完成（SH-005）。

**P1 进行中。** `packages/persistence` 的 SH-006A–D 已完成；其后还有已合并的 SH-008P 分页与条件写原语、SH-008C 所用的会话复用与 P1 信封提交，以及 SH-008D D1 任务状态机。这些不另计为 SH-006 的再次验收。`apps/soul-daemon` 的生命周期与装配层（SH-007A）已完成；`packages/runtime` 已有 ID 分配、Persona 生命周期、P1 Ingress、`recoverRuntime`、Scheduler，以及 SH-008E 的 Daemon 装配代码。**SH-008D 已完成并通过独立复审与整批验收。SH-008E 的 E1–E5、AUDIT-001、E6 已实施/合并，但 SH-008E 整批仍等待最终独立验收签署。**

**SH-009 本地管理 API 已落地：** E1–E4、E5.P0、E5A 已分别完成并通过独立复审；E5B 文档同步正在进行。**SH-009 整批尚未正式验收。** Daemon 当前在 `RUNNING` 时已装配 Persona Recovery、Runtime Recovery、Ingress、Scheduler、本地 HTTP/WebSocket/Health 与 Token 保护。Scheduler Handler Map 仍为空，`taskDispatch=unavailable_no_handlers`，不会派发真实任务。

**P1 Runtime 仍不具备认知循环。** 没有主观记忆生成、思维循环、扫描 A/B、检查点装载/写出或真实任务 Handler；本地 API 只是管理与状态查询，不是外部 Stimulus transport。**不得把 SH-008E 的等待最终签署写成“已验收”，也不得把 SH-009 的单批复审写成整批验收。**

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 主计划、ADR、信任边界、数据模型、生命周期、模块边界、身份协议、协作规范 | 文档主体已完成（SH-001 → SH-003.2）；**`packages/contracts` 已实现（SH-004）** |
| P1 | Monorepo 骨架、Daemon 生命周期、Persistence、最小 API | **Monorepo（SH-005）**、**Persistence（SH-006A–D）**、**Daemon 生命周期（SH-007A）**、**SH-008D 整批验收** 已完成。SH-008E 的 E1–E5、AUDIT-001、E6 已实施/合并，整批等待最终独立验收签署。SH-009 E1–E4、E5.P0、E5A 已通过独立复审，E5B 文档同步进行中，整批未验收。Daemon 已装配 Persona / Runtime Recovery、Ingress、Scheduler 与本地 HTTP/WS/Health；Scheduler Handler Map 为空，P1 认知循环未运行 |
| P2+ | 事件接入、记忆网络、激活、自主认知、遗忘、睡眠梦境、外部适配 | 未开始 |

目录和文档存在**不代表**功能完成。任何"已实现"必须以测试与验收记录为凭。
目前按当时记录交付的是 `packages/contracts`（SH-004）、`packages/persistence` 的 SH-006A–D、
`apps/soul-daemon` 的生命周期装配（SH-007A），以及 `packages/runtime` 的 ID 分配器（SH-008A）
与进程内 Persona 生命周期（SH-008B）。SH-008C 的代码已合并；SH-008D 已完成并通过独立复审与整批验收。SH-008E 的装配代码已实施/合并，整批等待最终独立验收签署。
这些都不等于 P1 认知循环已经在 Daemon 里运行。Daemon 会创建空的 Handler Map Scheduler；没有真实任务 Handler、主观记忆、思维循环、扫描 A/B 或检查点编排。SH-008E 整批仍等待最终独立验收签署；SH-009 整批仍等待最终验收。

## 文档入口

| 文档 | 内容 |
|---|---|
| **[PLAN](docs/PLAN.md)** | **唯一现行主计划**：R01–R12、H01–H18、阶段路线、质量目标、迁移计划、风险 |
| [ADR-001](docs/adr/ADR-001-independent-runtime.md) | 为什么取消插件形态，及锁定技术栈 |
| [OVERVIEW](docs/architecture/OVERVIEW.md) | 三层组件、分层拓扑、身份层级、端口 |
| [TRUST-BOUNDARIES](docs/architecture/TRUST-BOUNDARIES.md) | 三种权威域、四条红线、威胁模型、遗忘的存储约束 |
| [DATA-MODEL](docs/architecture/DATA-MODEL.md) | 表结构、原文旁路禁令、迁移规则 |
| [RUNTIME-LIFECYCLE](docs/architecture/RUNTIME-LIFECYCLE.md) | Daemon / Persona / Thought / Event / Sleep 状态机、刺激流转 |
| [IDENTITY-PROTOCOL](docs/architecture/IDENTITY-PROTOCOL.md) | 六类核心身份（persona / session / thread / run / event / action）的语义、格式、唯一性与生命周期 |
| [MODULES](docs/architecture/MODULES.md) | 模块职责、依赖方向、隔离门槛 |
| [AI-DEVELOPMENT-RULES](docs/architecture/AI-DEVELOPMENT-RULES.md) | 双 AI 协作规范（动手前必读） |
| [LEGACY-BASELINE](docs/migration/LEGACY-BASELINE.md) | 旧插件冻结基线、数据现状、复用分类 |
| [archive/](docs/archive/README.md) | 历史计划文件（**非现行**，仅作追溯） |

## 仓库结构

```text
.
├─ apps/
│  └─ soul-daemon/            # 生命周期、Runtime 装配、本地 HTTP/WS/Health、Token。无认知循环
├─ packages/
│  ├─ contracts/              # 协议契约包（SH-004，零运行时依赖）
│  ├─ persistence/            # SQLite 持久化（SH-006A–D）
│  └─ runtime/                # ID 分配、Persona 生命周期、进程内 Ingress、recoverRuntime、Scheduler。无检查点编排
├─ tools/consumer-check/      # 跨包导入验证：按包名导入 ESM + d.ts
├─ docs/                      # 架构文档（唯一基线）
├─ .github/workflows/ci.yml   # CI：format / lint / typecheck / test / build / consumer
├─ package.json               # workspace 根（turbo / eslint / prettier / tsc / vitest）
├─ pnpm-workspace.yaml        # workspace 成员 + 构建脚本放行
├─ pnpm-lock.yaml             # 唯一 lockfile
├─ turbo.json                 # 任务图与缓存
├─ tsconfig.base.json         # 统一 TS 配置（各包 extends）
└─ vitest.config.ts           # 统一测试入口（projects: packages/*、apps/*）
```

`soul-studio` 与 `soul-cli` 尚未创建。**不存在 Soul Studio 应用**；`127.0.0.1:18701` 只是 Studio 预留开发端口。

| 包 | 内容 | 状态 |
|---|---|---|
| [packages/contracts](packages/contracts/README.md) | 协议类型、10 份已注册 JSON Schema、枚举与标识符格式；双层信封（适配器输入层 / Ingress 归一化层）、零运行时依赖、无 IO、不生成 ID | **已实现（协议层，SH-004）**，含测试与正反 fixtures |
| [packages/persistence](packages/persistence/README.md) | SQLite（WAL、单写入者）、Migration、事务协调器、六表 Repository、字段映射、Runtime checkpoint envelope 存取；其后另有 SH-008P 的分页与条件写原语、SH-008C 所用的会话复用与 P1 信封提交，以及 SH-008D D1 任务状态机 | **SH-006A–D 已完成**。后续提交不另计为 SH-006 验收。不重建 Runtime；无显式 `PRAGMA wal_checkpoint` |
| [packages/runtime](packages/runtime/README.md) | 六类核心 ID 与辅助 ID（`tsk` / `cnf`）分配；进程内 Persona 生命周期；进程内 P1 Ingress；P1 `recoverRuntime`；进程内 Scheduler。无裸 SQL | **SH-008D 已完成并通过独立复审与整批验收。** 无扫描 A/B、无检查点编排。SH-008E 已把 Persona Recovery / Runtime Recovery / Ingress / Scheduler 装配到 Daemon；Scheduler Handler Map 仍为空 |
| [apps/soul-daemon](apps/soul-daemon/README.md) | 配置、结构化日志、数据目录、单实例锁、SQLite/Migration、Persona/Runtime Recovery、Ingress、空 Handler Scheduler、本地 HTTP/WebSocket/Health、Token 文件、Persona 管理与状态查询 | **SH-007A 生命周期完成；SH-008E 装配已实施/合并，整批等待最终独立验收签署；SH-009 E1–E4、E5.P0、E5A 已通过独立复审，整批未验收。** Scheduler 不派发任务；API 不是 Stimulus transport；无认知循环 |

## 旧系统

原 `dsh-soul-core` 插件已冻结：

- 仓库：`F:\6\dsh-agent-dfy\dsh-soul-core`
- tag：`legacy-plugin-frozen-2026-11-15`（指向 `9275c39`）
- 定位：迁移对照基准 + 未来的 DSH Adapter 源。**不再接受认知引擎开发。**

## 技术栈（锁定）

Node.js 24 LTS（`>=24.15.0 <25`）· TypeScript(strict) · pnpm · Turborepo · Fastify · WebSocket ·
SQLite（`node:sqlite`，WAL，单写入者）· JSON Schema · Vitest · React + Vite + Tailwind + shadcn/ui + Zustand

**版本锁定**：开发环境 Node **24.21.0**（`.nvmrc`，已完整跑通全仓检查）；包管理器 pnpm **11.7.0**
（根 `package.json` 的 `packageManager`，Corepack 读取）。改这两项需要 ADR。

无 ORM。细节与变更流程见 [AI-DEVELOPMENT-RULES](docs/architecture/AI-DEVELOPMENT-RULES.md) §3。

## 开发命令

```bash
pnpm install --frozen-lockfile   # 安装（唯一 lockfile 在根）
pnpm run format:check            # Prettier 检查（代码；docs/ 与 fixtures 不参与）
pnpm run lint                    # ESLint（flat config，ts + js）
pnpm run typecheck               # turbo typecheck + 跨包 consumer 类型检查
pnpm test                        # Vitest（根配置 projects: packages/*、apps/*）
pnpm run build                   # turbo build
pnpm run check:consumer          # 按包名导入 ESM + d.ts 的实际验证
```

`pnpm run check` 按顺序串联以上全部步骤，与 CI 完全一致；CI 配置见
[.github/workflows/ci.yml](.github/workflows/ci.yml)。

## 已知限制（必须随发布一起声明）

1. **P1 不具备物理隔离。** 阶段一只有一个 SQLite 文件，三域数据同库同进程，安全边界仅靠接口与代码约束。
   Archive / Action Gateway / Dream Sandbox 需达到各自门槛才启用，未达门槛前不对外声称存在
   （见 [PLAN](docs/PLAN.md) §6.2）。
2. **管理员保留的离线明文副本无法由软件消灭。** 真实遗忘只能保证本系统控制范围内的内容不可恢复
   （含库、派生索引、缓存、思维快照、检查点、备份密文）。备份策略与"诊断日志禁明文"属部署要求。
3. **FTS 明文问题未完全解决。** 常驻明文全文索引与"可遗忘"直接冲突，方案待 P3 定案
   （见 [DATA-MODEL](docs/architecture/DATA-MODEL.md) §4.1）。
4. **模型仍可能自行推断出"这是梦"。** 梦境设计保证信息隔离与可观察行为，不宣称百分百消除内部推断。
5. **失败不可见时不允许声称成功。** 没有 `ActionReceipt` 就等于没发生。
6. 首期单机单人格为主；多人格并发隔离有测试要求，但非首期目标。
7. Node 24 与历史计划书中的 26.x 不一致，以本仓库锁定为准。
8. **去重只保证"同一条事件"，不保证"同一段正文"。** 只有 `required` 且已归档时才能发现同键异内容
   （`archive.compare` → 409）；`excluded` 与 P1 下**无法发现差异**，重复投递的正文可能被丢弃
   （见 [IDENTITY-PROTOCOL](docs/architecture/IDENTITY-PROTOCOL.md) §4.5.1）。
9. **P1 不保存历史 run。** `tasks.run_id` 只保留当前尝试；放弃的尝试不恢复，复盘靠结构化日志里的 `runId`。
   独立 `runs` 表留到后续阶段（IDENTITY-PROTOCOL OPEN-1，2026-11-20 已决定）。

## 许可

见 [LICENSE](LICENSE)（继承自旧仓库，MIT）。
