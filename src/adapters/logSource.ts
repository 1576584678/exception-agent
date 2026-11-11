import type { Evidence, LogSource, RetrievePlan } from '../types.js';

// 日志源适配器：按检索计划并行拉取并归一化日志。只读，不写。
export interface LogSourceAdapter {
  readonly name: string;
  fetch(cfg: LogSource, plan: RetrievePlan): Promise<Evidence[]>;
}

// ===== stub（开发期/未配置真实地址时使用）=====
export function createStubLogSourceAdapter(): LogSourceAdapter {
  return {
    name: 'stub-log',
    async fetch(cfg, plan) {
      const kw = plan.keywords.join(' ');
      const base = new Date(plan.timeWindow.from).getTime();
      return [
        {
          id: `ev-${Math.random().toString(36).slice(2, 8)}`,
          runId: '',
          sourceType: 'log',
          rawPointer: `${cfg.kind === 'platform' ? cfg.endpoint : cfg.path}/query?kw=${encodeURIComponent(kw)}`,
          normalized: {
            time: new Date(base + 1203).toISOString(),
            level: 'ERROR',
            service: 'order-service',
            traceId: 'trace-demo-001',
            spanId: 'span-1',
            message: `NullPointerException at OrderDetailService.java:128 (kw=${kw})`,
            stack: 'at OrderDetailService.getAmount(OrderDetailService.java:128)',
            url: '/order/detail',
            user: 'user-***8842',
          },
          dedupCount: 37,
          redactionHits: 1,
        },
      ];
    },
  };
}

// ===== 真实 HTTP 日志源：按配置的 endpoint 调日志平台查询 API =====
export function createHttpLogSourceAdapter(): LogSourceAdapter {
  return {
    name: 'http-log',
    async fetch(cfg, plan) {
      const url = cfg.endpoint;
      if (!url) throw new Error('日志源未配置 endpoint');
      const payload = {
        query: plan.keywords.join(' '),
        index: cfg.indexWhitelist?.[0],
        timeField: cfg.timeField || '@timestamp',
        from: plan.timeWindow.from,
        to: plan.timeWindow.to,
        limit: Math.min(plan.maxRows, cfg.maxReturn || 2000),
      };
      // 单次查询超时（PRD FR-14）；失败由编排器捕获并触发阶段级降级
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`日志源 HTTP ${res.status}`);
      const data = (await res.json()) as unknown;
      const rows = Array.isArray(data) ? data : ((data as { rows?: unknown[] }).rows ?? []);
      return rows.slice(0, plan.maxRows).map((r, i) => {
        const row = r as Record<string, unknown>;
        return {
          id: `ev-${i}-${Math.random().toString(36).slice(2, 8)}`,
          runId: '',
          sourceType: 'log' as const,
          rawPointer: url,
          normalized: {
            time: row[cfg.timeField || '@timestamp'] ?? row.time,
            level: row.level ?? row.severity,
            service: row.service,
            traceId: row.traceId ?? row.trace_id,
            spanId: row.spanId,
            message: row.message ?? row.msg,
            stack: row.stack ?? row.exception,
          },
          dedupCount: 1,
        };
      });
    },
  };
}

// ===== VictoriaLogs 适配器（/select/logsql/query，NDJSON 流式返回）=====
// 兼容用户误填 vmui 网页地址：自动回退到同主机 API 地址
// LogsQL 裸词过滤：含 = : 等运算符字符时必须包成短语，否则会被解析成字段过滤并报错
function sanitizeLogsQLWord(w: string): string {
  const s = w.replace(/["\\\n\r]/g, '').trim().slice(0, 64);
  if (!s) return '';
  return /[=:{}|()[\]*~!<>,]/.test(s) ? `"${s}"` : s;
}

function extractTraceId(msg: string): string | undefined {
  const m = msg.match(/tid:\s*([^\]\s,]+)/i);
  return m?.[1] && m[1] !== 'uid:' ? m[1] : undefined;
}

export function createVictoriaLogsAdapter(): LogSourceAdapter {
  return {
    name: 'victorialogs',
    async fetch(cfg, plan) {
      let url = cfg.endpoint;
      if (!url) throw new Error('日志源未配置 endpoint');
      const origin = url.match(/^(https?:\/\/[^/]+)/i)?.[1];
      if (!origin) throw new Error(`日志源地址不合法: ${url}`);
      const api = `${origin}/select/logsql/query`;
      const kw = plan.keywords.map(sanitizeLogsQLWord).filter(Boolean);
      const limit = Math.min(plan.maxRows, 500);
      const fetchRows = async (query: string): Promise<Record<string, unknown>[]> => {
        // VictoriaLogs 用 limit 参数控制行数（| last(N) 管道实测只返回 1 条，不可用）
        const params = new URLSearchParams({ query, start: plan.timeWindow.from, end: plan.timeWindow.to, limit: String(limit) });
        const res = await fetch(`${api}?${params.toString()}`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 200);
          throw new Error(`VictoriaLogs HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
        }
        const text = await res.text();
        return text
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => {
            try {
              return JSON.parse(l) as Record<string, unknown>;
            } catch {
              return null;
            }
          })
          .filter((r): r is Record<string, unknown> => r !== null);
      };
      // 主查询：按计划关键词（时间倒序）；关键词语法非法或命中 0 条时，兜底查 ERROR/WARN
      let rows: Record<string, unknown>[] = [];
      let usedFallback = false;
      try {
        rows = await fetchRows(kw.length ? kw.join(' OR ') : '*');
      } catch {
        usedFallback = true; // 关键词含无法解析的语法，直接走兜底
      }
      if (rows.length === 0) {
        usedFallback = true;
        rows = await fetchRows('level:="ERROR" OR level:="WARN"');
      }
      // 稳定排序：ERROR > WARN > 其他（组内保持时间倒序），让归因阶段优先看到异常日志
      const rank = (l: unknown) => (String(l ?? '').toUpperCase() === 'ERROR' ? 0 : String(l ?? '').toUpperCase() === 'WARN' ? 1 : 2);
      rows.sort((a, b) => rank(a.level) - rank(b.level));
      return rows.map((row, i) => {
        const msg = String(row._msg ?? row.msg ?? '').trim();
        return {
          id: `ev-${i}-${Math.random().toString(36).slice(2, 8)}`,
          runId: '',
          sourceType: 'log' as const,
          rawPointer: `${api}?query=${encodeURIComponent(usedFallback ? 'level:="ERROR" OR level:="WARN"' : kw.join(' OR '))}&limit=${limit}`,
          normalized: {
            time: row._time ?? row.time,
            level: String(row.level ?? row.severity ?? 'INFO').toUpperCase(),
            service: row.service,
            traceId: row.traceId ?? extractTraceId(msg),
            message: msg,
            stack: row.stack ?? row.exception,
          },
          dedupCount: 1,
        };
      });
    },
  };
}

// 选择器：
// - endpoint 含 vmui / logsql → VictoriaLogs（vmui 为网页地址，自动纠正到 API）
// - 其他 http(s) → 通用 HTTP 日志 API
// - 其余（internal://、空、目录路径）→ stub
export function selectLogAdapter(cfg?: LogSource): LogSourceAdapter {
  const ep = cfg?.endpoint;
  if (ep && /^https?:\/\//i.test(ep)) {
    if (/vmui|logsql/i.test(ep)) return createVictoriaLogsAdapter();
    return createHttpLogSourceAdapter();
  }
  return createStubLogSourceAdapter();
}
