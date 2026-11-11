import { v4 as uuid } from 'uuid';
import type { AuditLog } from '../types.js';
import type { AuditRepository } from '../repositories/interfaces.js';
import { logger } from '../logger.js';

// 审计服务：所有动作经此记录。审计日志不可删改（仓储仅 append，PRD FR-40 / R6）。
export class AuditService {
  constructor(private repo: AuditRepository) {}

  async record(input: Omit<AuditLog, 'id' | 'at'>): Promise<void> {
    const entry: AuditLog = { ...input, id: uuid(), at: new Date().toISOString() };
    await this.repo.append(entry);
    logger.info({ audit: true, action: entry.action, actor: entry.actor, projectId: entry.projectId }, 'audit-event');
  }

  async modelCall(actor: string, projectId: string | undefined, bytes: number, hash: string): Promise<void> {
    await this.record({
      actor,
      projectId,
      action: 'model_call',
      modelPayloadBytes: bytes,
      modelPayloadHash: hash,
    });
  }

  async access(
    actor: string,
    projectId: string | undefined,
    action: string,
    tables?: string[],
    columns?: string[],
  ): Promise<void> {
    await this.record({ actor, projectId, action, tablesAccessed: tables, columnsAccessed: columns });
  }

  async crossProjectBlock(actor: string, attemptedProjectId: string): Promise<void> {
    await this.record({
      actor,
      projectId: attemptedProjectId,
      action: 'cross_project_blocked',
      detail: '跨项目访问被拒绝(403)',
    });
  }

  async redaction(actor: string, projectId: string | undefined, hits: number): Promise<void> {
    await this.record({ actor, projectId, action: 'redaction_hit', detail: `脱敏命中 ${hits} 次` });
  }
}
