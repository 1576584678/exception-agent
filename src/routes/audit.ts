import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../repositories/interfaces.js';
import { authenticate, requirePermission } from '../middleware/auth.js';

export async function auditRoutes(app: FastifyInstance, repos: Repositories): Promise<void> {
  // 审计日志仅审计员 / 平台管理员可读（PRD §11.1）
  app.get(
    '/audit',
    { preHandler: [authenticate, requirePermission('audit:view')] },
    async () => repos.audit.list(),
  );
}
