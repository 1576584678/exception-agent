import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { config } from './config.js';
import { logger } from './logger.js';
import { createMemoryRepositories } from './repositories/memory.js';
import { RedactionService } from './services/redaction.js';
import { AuditService } from './services/audit.js';
import { AuthService } from './services/auth.js';
import { AnalysisOrchestrator } from './services/orchestrator.js';
import { registerErrorHandler } from './middleware/errorHandler.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { analyzeRoutes } from './routes/analyze.js';
import { auditRoutes } from './routes/audit.js';
import { credentialRoutes } from './routes/credentials.js';
import type { Project, User } from './types.js';
import { v4 as uuid } from 'uuid';

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: false });

  // CORS：显式来源，生产禁用通配符
  const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').filter(Boolean) : true;
  await app.register(cors, { origin: corsOrigin, credentials: true });
  await app.register(jwt, { secret: config.JWT_SECRET });

  // 种子数据（开发期；生产由身份系统对接）
  const admin: User = {
    id: uuid(),
    name: '管理员',
    employeeId: '1001',
    role: 'platform_admin',
    passwordHash: 'dev123', // 开发期明文占位，生产必须替换为强哈希
  };
  const member: User = {
    id: uuid(),
    name: '开发小王',
    employeeId: '2002',
    role: 'member',
    passwordHash: 'dev123',
  };
  const repos = createMemoryRepositories([admin, member]);

  // 示例项目：固定 id 便于冒烟测试
  // 说明：logSources 指向真实 VictoriaLogs（/select/logsql/query → VictoriaLogs 适配器）；
  //      换成 internal:// 等占位地址即回退 stub；modelPolicy=external + llmConfig 即启用真实大模型。
  const now = new Date().toISOString();
  const sampleProject: Project = {
    id: 'demo-project-1',
    name: '示例电商后端',
    env: 'prod',
    ownerId: admin.id,
    codeSources: [{ type: 'git', url: 'https://git.internal/monorepo', branch: 'main', credentialRefId: 'cred-git-1' }],
    logSources: [
      {
        kind: 'platform',
        endpoint: 'http://192.168.9.212:9428/select/logsql/query',
        timeField: '_time',
        indexWhitelist: ['order-*'],
        supportsTraceId: true,
        maxReturn: 2000,
      },
    ],
    dataSources: [
      {
        dbType: 'mysql',
        credentialRefId: 'cred-db-1',
        tableWhitelist: ['order', 'coupon'],
        columnBlacklist: ['password'],
        rowLimit: 20,
        timeoutMs: 5000,
      },
    ],
    redactionRules: [
      { id: 'r-phone', kind: 'builtin', enabled: true },
      { id: 'r-idcard', kind: 'builtin', enabled: true },
      { id: 'r-bank', kind: 'builtin', enabled: true },
      { id: 'r-email', kind: 'builtin', enabled: true },
      { id: 'r-token', kind: 'builtin', enabled: true },
    ],
    modelPolicy: config.MODEL_POLICY,
    createdAt: now,
    updatedAt: now,
  };
  await repos.projects.create(sampleProject);

  // 基础设施装配：适配器由编排器按项目配置动态选择，无需在此绑定具体实现
  const redaction = new RedactionService();
  const audit = new AuditService(repos.audit);
  const orchestrator = new AnalysisOrchestrator(repos, redaction, audit);
  const auth = new AuthService(repos.users, (p) => app.jwt.sign(p));

  registerErrorHandler(app);
  await healthRoutes(app);
  await authRoutes(app, auth);
  await projectRoutes(app, repos, audit);
  await analyzeRoutes(app, repos, orchestrator, audit);
  await auditRoutes(app, repos);
  await credentialRoutes(app, audit);

  logger.info(
    { demoProjectId: sampleProject.id, adminEmployeeId: admin.employeeId, memberEmployeeId: member.employeeId },
    'seed ready',
  );

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT }, 'exception-insight started');
}

bootstrap().catch((e) => {
  logger.error({ err: e }, 'bootstrap failed');
  process.exit(1);
});
