import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors.js';
import { logger } from '../logger.js';

// 全局错误处理：客户端只看到规范化结构，绝不返回堆栈或内部细节
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply
        .code(err.statusCode)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const code = (err as { code?: string }).code;
    if (code === 'FST_JWT_NO_AUTHORIZATION_TOKEN' || code === 'FST_JWT_AUTHORIZATION_TOKEN_INVALID') {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: '未认证或令牌无效' } });
    }
    // Fastify 自身的 4xx（空 body、JSON 解析失败、请求体不合规）不应被兜成 500
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({
        error: { code: code || 'BAD_REQUEST', message: err.message || '请求不合法' },
      });
    }
    logger.error({ err }, 'unhandled-error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: `路径不存在: ${req.method} ${req.url}` } });
  });
}
