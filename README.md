# 异常分析平台（Exception Insight）

把「截图 / 报错描述 → 原因 → 代码位置 + 最后修改提交 + 具体数据」这条线上问题定位链路，做成**一次提交、一份报告**。

## 产品简介

线上问题定位今天依赖「人找人」：客诉截图发群里 → 猜是哪个服务 → 去日志平台手搜 → 翻 GitLab 代码 → 查 DB。一次定位平均跨 3 个系统、问 2 个人。

Exception Insight 的目标是把这条链路压缩为一次提交、一份带可点击证据的报告。平台只给**排查建议**，不做自动修复、不改代码、不改数据。

核心指标（PRD §2.2）：MTTA P50 ≤ 90s、Top-1 归因采纳率 ≥ 60%、证据挂载率 100%、越权 / 泄露事件 0。

## 当前状态

- **PRD**：v1.0 已定稿（`docs/异常分析平台-PRD-v1.0.md`）。
- **实现**：端到端 MVP 可运行，包含单页工作台（配置抽屉、报告渲染、证据链折叠、记录删除）。
- **技术栈**：Node.js 18+ / TypeScript / Fastify；开发期内存仓储 + 项目配置落盘（`data/projects.json`）；LLM / 日志 / 代码 / 数据均为可替换适配器。
- **已接入真实系统**：OpenAI 兼容大模型（如 DeepSeek）、VictoriaLogs（LogsQL）、GitLab 只读 API。
- **尚未包含**：真实只读数据库查询、本地目录代码定位、截图 OCR、PostgreSQL 持久化、凭证外部引用（Vault/KMS）。报告中对使用 stub 的部分会显式标注「演示占位」。

## 技术栈与架构

- 后端：Fastify + TypeScript + Zod（边界校验）+ Pino（结构化日志）+ @fastify/jwt。
- 分层：`routes`（控制器，无业务逻辑）→ `services`（业务编排）→ `repositories`（数据访问，接口化）→ `adapters`（外部系统，接口化 + stub）。
- 存储：默认内存仓储（`STORAGE=memory`，重启清空，符合 MVP 骨架）；审计日志不可删改、证据按 TTL 清理已在内存层实现，接 PG 时业务层零改动。
- 安全：脱敏三闸、审计 append-only、JWT + RBAC、Prompt 注入隔离，均按 PRD 安全基线落地。

## 快速开始

### 开发模式

```bash
npm install
cp .env.example .env          # 已提供开发用 .env，可直接用
npm run dev                   # tsx watch，默认 :3000
npm run typecheck             # 类型检查
npm run smoke                 # 端到端冒烟（需先启动服务）
```

种子账号：管理员 `1001 / dev123`（platform_admin）、开发 `2002 / dev123`（member，无项目归属用于演示越权）。示例项目固定 id：`demo-project-1`。

### 生产模式（编译后运行）

```bash
npm ci --omit=dev             # 或用 npm install
npm run build                 # tsc → dist/
JWT_SECRET=$(openssl rand -hex 32) npm start
```

> `JWT_SECRET` 必填且至少 16 字符，否则启动即退出（fail-fast）。端口用 `PORT` 覆盖，默认 3000。

### 一键启动脚本

- Windows：双击 `start.bat`（自动生成 `.env` 与随机 `JWT_SECRET`、缺依赖自动装、缺 `dist` 自动编译）
- Linux / macOS：`chmod +x start.sh && ./start.sh`

### Docker

```bash
export JWT_SECRET=$(openssl rand -hex 32)
docker compose up -d --build
# 或
docker build -t exception-insight:0.1.0 .
docker run -d -p 3000:3000 -e JWT_SECRET=$JWT_SECRET -v $(pwd)/data:/app/data exception-insight:0.1.0
```

`data/` 卷用于持久化项目配置；`.env` 不打进镜像，密钥一律走运行时环境变量。

### 打包分发给别人

```bash
npm run pack
```

生成 `release/exception-insight.zip`（约 5–10 MB，含编译产物 + 生产依赖 + 启动脚本）。对方机器只需：

1. 安装 Node.js 18+（https://nodejs.org）
2. 解压 zip
3. 双击 `start.bat`（Windows）或执行 `./start.sh`
4. 浏览器打开 http://localhost:3000，用 `1001 / dev123` 登录

首次启动会自动生成 `.env`（含随机 JWT_SECRET）。之后在页面右上角「配置」里填模型地址 / 模型 Key / 日志源 / 代码仓库即可。

### 发给同事前的注意事项

- **包内不含任何密钥和本机配置**：只有 `.env.example`（值为空）、`data/` 空目录；`.env`、`data/projects.json`、`data/settings.json` 均不会打包。
- **默认账号 `1001 / dev123` 仅用于内网试用**，不要暴露到公网；如需改账号请改源码种子用户后重新构建。
- **默认自带一个「示例电商后端」演示项目**，其中的日志地址/仓库地址只是示例占位，请在「配置」里改成自己的，或直接用「+ 新建项目」创建（顶栏 ⋯ 菜单里可删除不需要的项目）。
- 日志源按地址自动识别：VictoriaLogs（`:9428` / `vmui` / `logsql`）、Elasticsearch（`:9200` / `_search`）、Loki（`:3100` / `loki`），其他 HTTP 地址走通用查询接口；仓库支持 GitLab 与 GitHub（GitHub 需在配置页保存 PAT）。
- 端口冲突（默认 3000）时改 `.env` 里的 `PORT` 再重启；页面右上角 🌙/☀️ 可切深色模式。

> 若对方环境无法访问 npm registry，`release/` 里已包含 `node_modules`，可直接运行。

## API 端点（已落地）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/auth/login` | 公开 | 登录获取 JWT |
| GET | `/me` | 登录 | 当前用户 |
| GET | `/health`、`/ready` | 公开 | 健康检查 |
| GET/POST | `/projects` | project:configure / project:create | M1 项目配置（FR-01） |
| GET/PUT | `/projects/:id` | project:configure | 项目详情 / 更新配置 |
| POST | `/projects/:id/analyze` | analysis:submit | 提交分析（M2–M6 主链路） |
| GET | `/projects/:id/runs` | 本项目成员 | 分析任务列表 |
| GET | `/runs/:runId` | 本项目成员 | 获取报告 |
| DELETE | `/runs/:runId` | 本项目成员 | 删除分析记录（级联清除证据） |
| POST | `/runs/:runId/feedback` | feedback:mark | 结论反馈（FR-33） |
| GET | `/credentials` | 登录 | 凭证状态（仅掩码） |
| PUT | `/credentials/llm`、`/credentials/gitlab` | project:configure | 保存密钥（写 .env，不落库） |
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

**已实现**：分层架构；配置集中校验 + 结构化日志 + 类型化错误；JWT+RBAC；脱敏三闸（采集/入模/出报告）；审计 append-only；分析编排器 + 状态机（PRD §9.1）+ 阶段级降级（FR-42）；真实 OpenAI 兼容 LLM / VictoriaLogs / GitLab 代码源适配器（按项目配置自动选择）；截图 / 报错描述双输入（截图 OCR 为占位）；项目配置持久化；单页工作台（配置抽屉、报告折叠、证据分页、记录删除、演示占位标注）；端到端冒烟 21 项全 PASS。

**待实现（按 PRD 演进）**：真实只读数据库查询（当前白名单校验 + stub 数据，报告已标注「演示」）；本地目录代码定位（`type=local` 目前走 stub）；截图 OCR 接入视觉模型；PostgreSQL 持久化分析记录（`STORAGE=pg` + 迁移）；凭证外部引用服务（Vault/KMS）；并发队列、后台续跑、人工接管（FR-43/44）；V2+ 多项目联合、前端 SourceMap 反解等。

## 给 AI 协作伙伴

涉及模型调用、工具执行、凭证、脱敏、审计、文件读取、数据查询的改动，务必先读 `AGENTS.md` 的「安全红线」一节再动手。

---

**合规声明**：本仓库文档为产品设计参考，具体实施请结合公司合规与法务要求确认。文档与代码中的示例人物、工号、订单号与数据均为虚构，仅用于说明。
