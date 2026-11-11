import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/jwt';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../errors.js';
import { can, type Permission, type TokenPayload } from '../services/auth.js';
import type { AuditService } from '../services/audit.js';
import type { Repositories } from '../repositories/interfaces.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: TokenPayload;
  }
}

// JWT 校验：失败直接抛 401，不进入业务
export async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify();
  } catch {
    throw new UnauthorizedError();
  }
}

// 权限中间件：按 RBAC 矩阵校验
export function requirePermission(perm: Permission) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const user = req.user;
    if (!user) throw new UnauthorizedError();
    if (!can(user.role, perm)) throw new ForbiddenError(`缺少权限: ${perm}`);
  };
}

// 跨项目访问拦截：禁止非授权用户访问其他项目数据（PRD FR-39 / R6），命中即 403 + 记审计
export async function assertProjectAccess(
  req: FastifyRequest,
  projectId: string,
  repos: Repositories,
  audit: AuditService,
): Promise<void> {
  const user = req.user;
  if (!user) throw new UnauthorizedError();
  if (user.role === 'platform_admin') return; // 平台管理员全局可见
  const project = await repos.projects.get(projectId);
  if (!project) throw new NotFoundError('项目不存在');
  if (user.role === 'auditor') throw new ForbiddenError('审计员不可查看业务报告');
  if (project.ownerId !== user.sub) {
    await audit.crossProjectBlock(user.employeeId, projectId);
    throw new ForbiddenError('禁止跨项目访问');
  }
}
