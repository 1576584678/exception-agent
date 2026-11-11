import type { Role, User } from '../types.js';
import type { UserRepository } from '../repositories/interfaces.js';
import { UnauthorizedError } from '../errors.js';

export type Permission =
  | 'project:create'
  | 'project:configure'
  | 'analysis:submit'
  | 'report:view'
  | 'feedback:mark'
  | 'audit:view';

// RBAC 权限矩阵（对齐 PRD §11.1）
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  platform_admin: ['project:create', 'project:configure', 'analysis:submit', 'report:view', 'feedback:mark', 'audit:view'],
  project_admin: ['project:create', 'project:configure', 'analysis:submit', 'report:view', 'feedback:mark'],
  member: ['analysis:submit', 'report:view', 'feedback:mark'],
  observer: ['report:view'],
  auditor: ['audit:view'],
};

export function can(role: Role, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(perm);
}

export interface TokenPayload {
  sub: string;
  role: Role;
  employeeId: string;
}

// 认证服务：登录校验 + 签发 JWT。密码为开发期明文占位，生产必须替换为 bcrypt/scrypt 强哈希。
export class AuthService {
  constructor(
    private users: UserRepository,
    private sign: (payload: TokenPayload) => string,
  ) {}

  async login(employeeId: string, password: string): Promise<{ token: string; user: User }> {
    const user = await this.users.getByEmployeeId(employeeId);
    if (!user || user.passwordHash !== password) {
      throw new UnauthorizedError('工号或密码错误');
    }
    const token = this.sign({ sub: user.id, role: user.role, employeeId: user.employeeId });
    return { token, user };
  }
}
