import type { DataProbe, DataSource } from '../types.js';

// 模型只产出查询意图（表/主键/关注字段），由适配器执行模板化只读查询，禁止生成任意 SQL（PRD FR-25/FR-26）。
export interface QueryIntent {
  table: string;
  pkField: string;
  pkValue: string;
  fields: string[];
}

export class DataSourceRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'DataSourceRejectedError';
  }
}

export interface DataSourceAdapter {
  readonly name: string;
  query(cfg: DataSource, intent: QueryIntent): Promise<DataProbe>;
}

export function createStubDataSourceAdapter(): DataSourceAdapter {
  return {
    name: 'stub-data',
    async query(cfg, intent) {
      // 表白名单校验：非白名单直接拒绝并返回空，不返回任何数据（PRD FR-06/FR-26）
      if (!cfg.tableWhitelist.includes(intent.table)) {
        throw new DataSourceRejectedError(`表 ${intent.table} 不在白名单`);
      }
      // 列黑名单字段不返回（PRD FR-06）
      const raw: Record<string, unknown> = {
        id: '***8842',
        status: 'INIT',
        coupon_id: '***771',
        amount: 0,
      };
      const snapshot: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (cfg.columnBlacklist.includes(k)) continue;
        snapshot[k] = v;
      }
      const highlighted = intent.fields.includes('status')
        ? [{ field: 'status', expected: 'PAID' as unknown, actual: 'INIT' as unknown }]
        : [];
      return {
        table: intent.table,
        pkField: intent.pkField,
        pkValue: intent.pkValue,
        snapshot,
        highlighted,
        status: 'success',
      };
    },
  };
}
