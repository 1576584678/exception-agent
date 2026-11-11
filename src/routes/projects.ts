import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import type { Project } from '../types.js';
import type { Repositories } from '../repositories/interfaces.js';
import type { AuditService } from '../services/audit.js';
import { BadRequestError, ForbiddenError } from '../errors.js';
import { authenticate, requirePermission } from '../middleware/auth.js';

const codeSourceSchema = z.object({
  type: z.enum(['git', 'local']),
  url: z.string().url().optional(), // GitLab base 或完整项目地址（FR-02）
  projectPath: z.string().optional(), // 如 aigit/qydn-report
  branch: z.string().optional(),
  subdir: z.string().optional(),
  mountPath: z.string().optional(),
  credentialRefId: z.string().optional(), // 仅存引用，禁止明文凭证
});

const logSourceSchema = z.object({
  kind: z.enum(['platform', 'objectstore']),
  endpoint: z.string().optional(), // 日志平台地址；填 http(s) 即启用真实 HTTP 适配器
  path: z.string().optional(),
  timeField: z.string().optional(),
  indexWhitelist: z.array(z.string()).optional(),
  fileFormat: z.string().optional(),
  supportsTraceId: z.boolean(),
  maxReturn: z.number().int().positive().default(2000),
});

const dataSourceSchema = z.object({
  dbType: z.string(),
  credentialRefId: z.string(),
  tableWhitelist: z.array(z.string()).min(1),
  columnBlacklist: z.array(z.string()).default([]),
  rowLimit: z.number().int().positive().default(20),
  timeoutMs: z.number().int().positive().default(5000),
});

const llmConfigSchema = z.object({
  baseUrl: z.string().url().optional(), // 模型网关地址（OpenAI 兼容）
  model: z.string().optional(),
  apiKeyRef: z.string().optional(), // 只存引用，禁止明文 apiKey
  // 推理强度（reasoning 模型专用；不传则由网关默认档位决定）
  reasoningEffort: z.enum(['none', 'low', 'high', 'max']).optional(),
});

const projectSchema = z.object({
  name: z.string().min(1),
  env: z.enum(['prod', 'staging']).default('staging'),
  codeSources: z.array(codeSourceSchema).default([]),
  logSources: z.array(logSourceSchema).min(1, '至少配置一个日志源'), // FR-01
  dataSources: z.array(dataSourceSchema).default([]),
  modelPolicy: z.enum(['local', 'external']).default('local'),
  llmConfig: llmConfigSchema.optional(),
});

// 更新用 patch：字段全可选、无默认值，避免未提供的字段被默认值覆盖
const projectPatchSchema = z.object({
  name: z.string().min(1).optional(),
  env: z.enum(['prod', 'staging']).optional(),
  codeSources: z.array(codeSourceSchema).optional(),
  logSources: z.array(logSourceSchema).min(1).optional(),
  dataSources: z.array(dataSourceSchema).optional(),
  modelPolicy: z.enum(['local', 'external']).optional(),
  llmConfig: llmConfigSchema.optional(),
});

function defaultRules(): Project['redactionRules'] {
  // 内置脱敏规则默认开启且不可关闭（PRD FR-07 / R3）
  return [
    { id: 'r-phone', kind: 'builtin', enabled: true },
    { id: 'r-idcard', kind: 'builtin', enabled: true },
    { id: 'r-bank', kind: 'builtin', enabled: true },
    { id: 'r-email', kind: 'builtin', enabled: true },
    { id: 'r-token', kind: 'builtin', enabled: true },
  ];
}

export async function projectRoutes(
  app: FastifyInstance,
  repos: Repositories,
  audit: AuditService,
): Promise<void> {
  app.get(
    '/projects',
    { preHandler: [authenticate, requirePermission('project:configure')] },
    async () => repos.projects.list(),
  );

  app.get(
    '/projects/:id',
    { preHandler: [authenticate, requirePermission('project:configure')] },
    async (req, reply) => {
      const p = await repos.projects.get((req.params as { id: string }).id);
      if (!p) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '项目不存在' } });
      return p;
    },
  );

  app.post(
    '/projects',
    { preHandler: [authenticate, requirePermission('project:create')] },
    async (req, reply) => {
      const parsed = projectSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('INVALID_BODY', '项目配置校验失败', parsed.error.issues);
      }
      const now = new Date().toISOString();
      const project: Project = {
        id: uuid(),
        name: parsed.data.name,
        env: parsed.data.env,
        ownerId: req.user!.sub,
        codeSources: parsed.data.codeSources,
        logSources: parsed.data.logSources,
        dataSources: parsed.data.dataSources,
        redactionRules: defaultRules(),
        modelPolicy: parsed.data.modelPolicy,
        llmConfig: parsed.data.llmConfig,
        createdAt: now,
        updatedAt: now,
      };
      await repos.projects.create(project);
      await audit.access(req.user!.employeeId, project.id, 'project_config_saved');
      return reply.code(201).send(project);
    },
  );

  // 更新项目配置（配置页保存）：只合并传入字段，内置脱敏规则不可通过更新关闭
  app.put(
    '/projects/:id',
    { preHandler: [authenticate, requirePermission('project:configure')] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const existing = await repos.projects.get(id);
      if (!existing) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '项目不存在' } });
      if (req.user!.role !== 'platform_admin' && existing.ownerId !== req.user!.sub) {
        throw new ForbiddenError('禁止修改他人项目');
      }
      const parsed = projectPatchSchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('INVALID_BODY', '配置校验失败', parsed.error.issues);
      const updated: Project = {
        ...existing,
        ...parsed.data,
        redactionRules: existing.redactionRules,
        updatedAt: new Date().toISOString(),
      };
      await repos.projects.update(updated);
      await audit.access(req.user!.employeeId, id, 'project_config_updated');
      return updated;
    },
  );
}
