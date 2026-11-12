import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuditService } from '../services/audit.js';
import { BadRequestError } from '../errors.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getCredentialStatus, saveGitHubToken, saveGitLabToken, saveLLMKey } from '../services/credentialStore.js';

const secretSchema = z.object({
  value: z.string().trim().min(8, '密钥长度至少 8 位').max(500),
});

/**
 * 凭证接口：只写不读明文。
 * - GET 返回「已配置 / 掩码」，供前端展示状态。
 * - PUT 写入服务端 .env 并即时生效，响应同样只回掩码。
 * 要求 project:configure 权限（平台管理员 / 项目管理员），并记审计（不记录密钥值）。
 */
export async function credentialRoutes(app: FastifyInstance, audit: AuditService): Promise<void> {
  app.get('/credentials', { preHandler: [authenticate] }, async () => getCredentialStatus());

  app.put(
    '/credentials/llm',
    { preHandler: [authenticate, requirePermission('project:configure')] },
    async (req) => {
      const parsed = secretSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('INVALID_BODY', parsed.error.issues[0]?.message ?? '密钥校验失败');
      }
      const status = saveLLMKey(parsed.data.value);
      await audit.record({
        actor: req.user!.employeeId,
        action: 'llm_credential_updated',
        detail: '模型 API Key 已更新（值不记录）',
      });
      return status;
    },
  );

  app.put(
    '/credentials/gitlab',
    { preHandler: [authenticate, requirePermission('project:configure')] },
    async (req) => {
      const parsed = secretSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('INVALID_BODY', parsed.error.issues[0]?.message ?? 'Token 校验失败');
      }
      const status = saveGitLabToken(parsed.data.value);
      await audit.record({
        actor: req.user!.employeeId,
        action: 'gitlab_credential_updated',
        detail: 'GitLab 只读 token 已更新（值不记录）',
      });
      return status;
    },
  );

  app.put(
    '/credentials/github',
    { preHandler: [authenticate, requirePermission('project:configure')] },
    async (req) => {
      const parsed = secretSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('INVALID_BODY', parsed.error.issues[0]?.message ?? 'Token 校验失败');
      }
      const status = saveGitHubToken(parsed.data.value);
      await audit.record({
        actor: req.user!.employeeId,
        action: 'github_credential_updated',
        detail: 'GitHub PAT 已更新（值不记录）',
      });
      return status;
    },
  );
}
