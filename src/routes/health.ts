import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import type { FastifyInstance } from 'fastify';

// public/index.html 与 src/routes 相对：../../public/index.html
const uiPath = fileURLToPath(new URL('../../public/index.html', import.meta.url));

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // 根路径返回配置 + 分析单页应用
  app.get('/', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    try {
      return await readFile(uiPath, 'utf8');
    } catch {
      return '<!doctype html><meta charset="utf-8"><title>Exception Insight</title><p>UI 未找到，请访问 /api/info 或 /health。</p>';
    }
  });

  app.get('/api/info', async () => ({
    name: 'exception-insight',
    version: '0.2.0',
    status: 'running',
    docs: 'docs/异常分析平台-PRD-v1.0.md',
    endpoints: [
      'POST /auth/login',
      'GET /health',
      'GET /ready',
      'GET /projects',
      'POST /projects',
      'GET /projects/:id',
      'PUT /projects/:id',
      'POST /projects/:id/analyze',
      'GET /projects/:id/runs',
      'GET /runs/:runId',
      'POST /runs/:runId/feedback',
      'GET /audit',
    ],
  }));

  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));
  app.get('/ready', async () => ({ status: 'ready' }));
}
