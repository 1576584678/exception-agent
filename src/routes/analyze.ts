import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import type { AnalysisOrchestrator } from '../services/orchestrator.js';
import type { Repositories } from '../repositories/interfaces.js';
import type { AuditService } from '../services/audit.js';
import { BadRequestError } from '../errors.js';
import { authenticate, assertProjectAccess, requirePermission } from '../middleware/auth.js';

const analyzeSchema = z.object({
  inputType: z.enum(['image', 'text']).default('text'),
  inputRef: z.string().optional(),
  supplemental: z
    .object({
      occurredAt: z.string().optional(),
      pageUrl: z.string().optional(),
      userId: z.string().optional(),
      traceId: z.string().optional(),
      bizPk: z.string().optional(),
    })
    .default({}),
  forceDegrade: z.enum(['log', 'data']).optional(),
});

const feedbackSchema = z.object({
  findingId: z.string().min(1),
  verdict: z.enum(['correct', 'incorrect']),
  reason: z.enum(['evidence_wrong', 'code_wrong', 'data_wrong', 'speculation']).optional(),
});

export async function analyzeRoutes(
  app: FastifyInstance,
  repos: Repositories,
  orchestrator: AnalysisOrchestrator,
  audit: AuditService,
): Promise<void> {
  app.post(
    '/projects/:id/analyze',
    { preHandler: [authenticate, requirePermission('analysis:submit')] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      await assertProjectAccess(req, id, repos, audit);
      const parsed = analyzeSchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('INVALID_BODY', '分析请求校验失败', parsed.error.issues);
      // 异步执行：立即返回 runId，前端轮询 GET /runs/:id 获取阶段进度与最终报告
      const run = await orchestrator.startAnalysis({
        actor: req.user!.employeeId,
        projectId: id,
        inputType: parsed.data.inputType,
        inputRef: parsed.data.inputRef,
        supplemental: parsed.data.supplemental,
        forceDegrade: parsed.data.forceDegrade,
      });
      await audit.access(req.user!.employeeId, id, 'analysis_submitted');
      return reply.code(202).send(run);
    },
  );

  app.get(
    '/projects/:id/runs',
    { preHandler: [authenticate] },
    async (req) => {
      const id = (req.params as { id: string }).id;
      await assertProjectAccess(req, id, repos, audit);
      return repos.runs.listByProject(id);
    },
  );

  app.get(
    '/runs/:runId',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const run = await repos.runs.get((req.params as { runId: string }).runId);
      if (!run) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '分析任务不存在' } });
      await assertProjectAccess(req, run.projectId, repos, audit);
      // 只有已出报告的查看记审计；进度轮询（报告未生成）不刷审计日志
      if (run.report) await audit.access(req.user!.employeeId, run.projectId, 'report_viewed');
      return run;
    },
  );

  // 删除分析任务：级联清除证据/假设/结论/反馈；审计仅记录动作（审计日志本身不可删改）
  app.delete(
    '/runs/:runId',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const runId = (req.params as { runId: string }).runId;
      const run = await repos.runs.get(runId);
      if (!run) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '分析任务不存在' } });
      await assertProjectAccess(req, run.projectId, repos, audit);
      await Promise.all([
        repos.evidence.deleteByRun(runId),
        repos.hypotheses.deleteByRun(runId),
        repos.findings.deleteByRun(runId),
        repos.feedback.deleteByRun(runId),
      ]);
      await repos.runs.delete(runId);
      await audit.record({
        actor: req.user!.employeeId,
        projectId: run.projectId,
        action: 'run_deleted',
        detail: `删除分析任务 ${runId}`,
      });
      return reply.code(200).send({ deleted: true, runId });
    },
  );

  app.post(
    '/runs/:runId/feedback',
    { preHandler: [authenticate, requirePermission('feedback:mark')] },
    async (req, reply) => {
      const runId = (req.params as { runId: string }).runId;
      const run = await repos.runs.get(runId);
      if (!run) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '分析任务不存在' } });
      await assertProjectAccess(req, run.projectId, repos, audit);
      const parsed = feedbackSchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('INVALID_BODY', '反馈校验失败', parsed.error.issues);
      const fb = {
        id: uuid(),
        findingId: parsed.data.findingId,
        runId,
        verdict: parsed.data.verdict,
        reason: parsed.data.reason,
        userId: req.user!.sub,
        createdAt: new Date().toISOString(),
      };
      await repos.feedback.add(fb);
      return reply.code(201).send(fb);
    },
  );
}
