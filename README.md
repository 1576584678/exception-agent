# 异常分析平台（Exception Insight）

把「截图 / 报错描述 → 原因 → 代码位置 + 最后修改提交 + 具体数据」这条线上问题定位链路，做成**一次提交、一份报告**。

## 产品简介

线上问题定位今天依赖「人找人」：客诉截图发群里 → 猜是哪个服务 → 去日志平台手搜 → 翻 GitLab 代码 → 查 DB。一次定位平均跨 3 个系统、问 2 个人。

Exception Insight 的目标是把这条链路压缩为一次提交、一份带可点击证据的报告。平台只给**排查建议**，不做自动修复、不改代码、不改数据。

核心指标（PRD §2.2）：MTTA P50 ≤ 90s、Top-1 归因采纳率 ≥ 60%、证据挂载率 100%、越权 / 泄露事件 0。

## 当前状态

- **PRD**：v1.0 已定稿（`docs/异常分析平台-PRD-v1.0.md`）。
- **实现**：已交付**端到端 MVP 骨架**，后端分析链路跑通，13 项端到端冒烟全部 PASS（登录鉴权、报告生成、证据挂载、跨项目 403、阶段级降级等）。
- **技术栈**：Node.js + TypeScript + Fastify；开发期用内存仓储（可一键换 PostgreSQL）；LLM / 日志源 / 代码源 / 数据源均为**可替换适配器 + stub**（无需外部依赖即可跑通）。
- **尚未包含**：前端 UI（本次范围只做后端链路）、真实私有化模型接入、真实 Git/日志/DB 适配器、凭据外部引用服务。

## 技术栈与架构

- 后端：Fastify + TypeScript + Zod（边界校验）+ Pino（结构化日志）+ @fastify/jwt。
- 分层：`routes`（控制器，无业务逻辑）→ `services`（业务编排）→ `repositories`（数据访问，接口化）→ `adapters`（外部系统，接口化 + stub）。
- 存储：默认内存仓储（`STORAGE=memory`，重启清空，符合 MVP 骨架）；审计日志不可删改、证据按 TTL 清理已在内存层实现，接 PG 时业务层零改动。
- 安全：脱敏三闸、审计 append-only、JWT + RBAC、Prompt 注入隔离，均按 PRD 安全基线落地。

## 快速开始

```bash
npm install
cp .env.example .env          # 已提供开发用 .env，可直接用
npm run dev                   # 启动（tsx watch，默认 :3000）
npm run typecheck             # 类型检查
npm run smoke                 # 端到端冒烟（需先启动服务）
```

种子账号：管理员 `1001 / dev123`（platform_admin）、开发 `2002 / dev123`（member，无项目归属用于演示越权）。示例项目固定 id：`demo-project-1`。

## API 端点（已落地）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/auth/login` | 公开 | 登录获取 JWT |
| GET | `/me` | 登录 | 当前用户 |
| GET | `/health`、`/ready` | 公开 | 健康检查 |
| GET/POST | `/projects` | project:configure / project:create | M1 项目配置（FR-01） |
| GET | `/projects/:id` | project:configure | 项目详情 |
| POST | `/projects/:id/analyze` | analysis:submit | 提交分析（M2–M6 主链路） |
| GET | `/projects/:id/runs` | 本项目成员 | 分析任务列表 |
| GET | `/runs/:runId` | 本项目成员 | 获取报告 |
| POST | `/runs/:runId/feedback` | feedback:mark | 结论反馈（FR-33） |
| GET | `/audit` | audit:view | 审计日志（FR-40） |

## 配置大模型 / 日志 / Git（配置真正生效）

通过 `POST /projects` 创建项目时配置，分析时由编排器**按项目配置自动选择适配器**：

```bash
curl -X POST http://localhost:3000/projects \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{
    "name": "订单服务",
    "env": "prod",
    "codeSources": [{ "type": "git", "url": "https://gitlab.internal/order", "branch": "main", "credentialRefId": "cred-git-1" }],
    "logSources": [{ "kind": "platform", "endpoint": "https://log.internal/api/query", "timeField": "@timestamp", "supportsTraceId": true, "maxReturn": 2000 }],
    "dataSources": [{ "dbType": "mysql", "credentialRefId": "cred-db-1", "tableWhitelist": ["order"], "columnBlacklist": ["password"], "rowLimit": 20, "timeoutMs": 5000 }],
    "modelPolicy": "external",
    "llmConfig": { "baseUrl": "https://llm.internal/v1", "model": "qwen2.5-72b" }
  }'
```

- `modelPolicy: "local"` → 内置 stub（无需外部模型）；`"external"` → 调 `llmConfig.baseUrl`（或 env `LLM_BASE_URL`），`apiKey` 走 env `LLM_API_KEY` 或 `apiKeyRef` 引用（禁止明文）。
- `logSources[].endpoint` 填 http(s) 地址 → 启用真实 HTTP 日志拉取；否则内置 stub。
- `codeSources[]` 填 git 类型 + url → 启用 Git 适配器（解析堆栈定位；blame 接真实 GitLab API 为后续）。
- 依赖不可达时自动**阶段级降级**（如日志不可达 → partial + 低置信），不整单失败。

## 安全红线（硬约束，不可绕过）

1. 凭证只存外部引用，禁止明文。2. Git/日志/DB 统一只读 + 表白名单/列黑名单。3. 三道脱敏闸全程生效。4. 模型输出禁止直接执行为工具调用。5. 文件读取限定仓库内。6. 审计不可删改、跨项目 403。7. Prompt 注入隔离。8. 数据定位走模板化只读查询。完整说明见 `AGENTS.md`。

## 已实现 vs 待实现（对照 PRD）

**已实现（骨架）**：分层架构；配置集中校验 + 结构化日志 + 类型化错误；JWT+RBAC；脱敏三闸（采集/入模/出报告）；审计 append-only；分析编排器 + 状态机（PRD §9.1）+ 阶段级降级（FR-42）；**真实 OpenAI 兼容 LLM / HTTP 日志源 / Git 代码源适配器（按项目配置自动选择）**；截图 / 报错描述双输入（截图 OCR 为占位）；内存仓储（审计不可删改、证据 TTL）；端到端冒烟 19 项全 PASS。

**待实现（按 PRD 演进）**：真实私有化模型联调（适配器已就绪，配 `modelPolicy=external` + `llmConfig` 即启用）；真实 GitLab blame / 日志平台 API 联调（骨架已就绪）；真实 DB 只读连接（当前为白名单校验 + stub 数据）；PostgreSQL 持久化（`STORAGE=pg` + 迁移）；前端报告页与配置 UI；截图 OCR 接入视觉模型；凭证外部引用服务（Vault/KMS）；并发队列、后台续跑、人工接管（FR-43/44）；V2+ 多项目联合、前端 SourceMap 反解等。

## 给 AI 协作伙伴

涉及模型调用、工具执行、凭证、脱敏、审计、文件读取、数据查询的改动，务必先读 `AGENTS.md` 的「安全红线」一节再动手。

---

**合规声明**：本仓库文档为产品设计参考，具体实施请结合公司合规与法务要求确认。文档与代码中的示例人物、工号、订单号与数据均为虚构，仅用于说明。
