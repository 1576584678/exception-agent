import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuditService } from '../services/audit.js';
import { BadRequestError } from '../errors.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getLLMSettings, saveLLMSettings } from '../services/settingsStore.js';

const llmSettingsSchema = z.object({
  modelPolicy: z.enum(['local', 'external']).optional(),
  baseUrl: z.string().url().optional(),
  model: z.string().optional(),
  reasoningEffort: z.enum(['none', 'low', 'high', 'max']).optional(),
});

/**
 * 全局设置接口：大模型配置对全部项目生效（项目配置只管日志源/代码仓库/数据源）。
 */
export async function settingsRoutes(app: FastifyInstance, audit: AuditService): Promise<void> {
  app.get('/settings', { preHandler: [authenticate] }, async () => ({ llm: getLLMSettings() }));

  app.put(
    '/settings/llm',
    { preHandler: [authenticate, requirePermission('project:configure')] },
    async (req) => {
      const parsed = llmSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('INVALID_BODY', parsed.error.issues[0]?.message ?? '模型配置校验失败');
      }
      const saved = saveLLMSettings(parsed.data);
      await audit.record({
        actor: req.user!.employeeId,
        action: 'llm_settings_updated',
        detail: `全局模型配置更新（model=${saved.model ?? '-'}, effort=${saved.reasoningEffort ?? 'default'}）`,
      });
      return { llm: saved };
    },
  );
}
