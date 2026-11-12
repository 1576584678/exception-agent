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

// ===== Elasticsearch 适配器（REST _search）=====
// endpoint 可填 http://host:9200 或 http://host:9200/your-index；
// indexWhitelist[0] 优先作为索引（如 logs-app-*）
export function createElasticsearchAdapter(): LogSourceAdapter {
  return {
    name: 'elasticsearch',
    async fetch(cfg, plan) {
      const ep = (cfg.endpoint || '').replace(/\/+$/, '');
      if (!ep) throw new Error('日志源未配置 endpoint');
      const origin = ep.match(/^(https?:\/\/[^/]+)/i)?.[1];
      if (!origin) throw new Error(`日志源地址不合法: ${ep}`);
      const pathIndex = ep.slice(origin.length).replace(/^\/+/, '').replace(/\/_search$/, '');
      const index = pathIndex || cfg.indexWhitelist?.[0] || '_all';
      const timeField = cfg.timeField || '@timestamp';
      const size = Math.min(plan.maxRows, cfg.maxReturn || 500, 500);
      const keywords = plan.keywords.filter(Boolean);

      const search = async (body: Record<string, unknown>) => {
        const res = await fetch(`${origin}/${index}/_search`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 200);
          throw new Error(`Elasticsearch HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
        }
        const data = (await res.json()) as {
          hits?: { hits?: { _source?: Record<string, unknown>; _index?: string }[] };
        };
        return (data.hits?.hits ?? []).map((h) => ({ _index: h._index, ...(h._source ?? {}) }));
      };

      const range = { range: { [timeField]: { gte: plan.timeWindow.from, lte: plan.timeWindow.to } } };
      // 主查询：关键词 query_string；0 条或异常时兜底 ERROR/WARN
      let rows: Record<string, unknown>[] = [];
      let usedFallback = false;
      try {
        rows = await search({
          size,
          sort: [{ [timeField]: { order: 'desc' } }],
          query: { bool: { must: [range, ...(keywords.length
            ? [{ query_string: { query: keywords.map((k) => k.replace(/[:"(){}[\]^~*!\\/-]/g, ' ').trim()).filter(Boolean).join(' OR ') } }]
            : [])] } },
        });
      } catch {
        usedFallback = true;
      }
      if (rows.length === 0) {
        usedFallback = true;
        rows = await search({
          size,
          sort: [{ [timeField]: { order: 'desc' } }],
          query: { bool: { must: [range, { terms: { level: ['ERROR', 'WARN', 'error', 'warn'] } }] } },
        }).catch(() => []);
      }

      const rank = (l: unknown) => (String(l ?? '').toUpperCase() === 'ERROR' ? 0 : String(l ?? '').toUpperCase() === 'WARN' ? 1 : 2);
      rows.sort((a, b) => rank(a.level ?? a.severity) - rank(b.level ?? b.severity));
      return rows.slice(0, size).map((row, i) => ({
        id: `ev-${i}-${Math.random().toString(36).slice(2, 8)}`,
        runId: '',
        sourceType: 'log' as const,
        rawPointer: `${origin}/${index}/_search`,
        normalized: {
          time: row[timeField] ?? row.timestamp ?? row.time,
          level: String(row.level ?? row.severity ?? 'INFO').toUpperCase(),
          service: row.service ?? row.service_name ?? row.app ?? row._index,
          traceId: row.traceId ?? row.trace_id,
          message: row.message ?? row.msg ?? '',
          stack: row.stack ?? row.exception,
        },
        dedupCount: 1,
      }));
    },
  };
}

// ===== Loki 适配器（/loki/api/v1/query_range，PromQL/LogQL）=====
// endpoint 可填 http://host:3100 或 http://host:3100/loki（自动补全路径）
export function createLokiAdapter(): LogSourceAdapter {
  return {
    name: 'loki',
    async fetch(cfg, plan) {
      const ep = (cfg.endpoint || '').replace(/\/+$/, '');
      const origin = ep.match(/^(https?:\/\/[^/]+)/i)?.[1];
      if (!origin) throw new Error(`日志源地址不合法: ${ep || '(空)'}`);
      const api = /\/loki\/?$/i.test(ep) ? `${ep}/api/v1/query_range` : `${origin}/loki/api/v1/query_range`;
      const limit = Math.min(plan.maxRows, cfg.maxReturn || 500, 500);
      const start = String(new Date(plan.timeWindow.from).getTime() * 1e6);
      const end = String(new Date(plan.timeWindow.to).getTime() * 1e6);
      const keywords = plan.keywords.map((k) => k.replace(/[\\"]/g, '').trim()).filter(Boolean).slice(0, 3);

      const query = async (q: string) => {
        const params = new URLSearchParams({ query: q, start, end, limit: String(limit), direction: 'backward' });
        const res = await fetch(`${api}?${params.toString()}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 200);
          throw new Error(`Loki HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
        }
        const data = (await res.json()) as { data?: { result?: { stream?: Record<string, string>; values?: [string, string][] }[] } };
        return (data.data?.result ?? []).flatMap((s) =>
          (s.values ?? []).map(([ts, line]) => ({ ts, line, labels: s.stream ?? {} })),
        );
      };

      // 主查询：所有日志流 + 关键词正则过滤；失败或 0 条时兜底查 ERROR 级别样式日志
      const selector = '{job=~".+"}';
      let rows: { ts: string; line: string; labels: Record<string, string> }[] = [];
      let usedFallback = false;
      try {
        rows = await query(keywords.length ? `${selector} |~ "${keywords.join('|')}"` : selector);
      } catch {
        usedFallback = true;
      }
      if (rows.length === 0) {
        usedFallback = true;
        rows = await query(`${selector} |~ "(?i)(ERROR|error)"`).catch(() => []);
      }

      // 行可能是 JSON 日志：提取结构化字段；否则整行为 message
      const parseLine = (line: string): Record<string, unknown> => {
        try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; }
      };
      const rank = (l: string) => (/ERROR/i.test(l) ? 0 : /WARN/i.test(l) ? 1 : 2);
      rows.sort((a, b) => rank(a.line) - rank(b.line));
      return rows.slice(0, limit).map((r, i) => {
        const j = parseLine(r.line);
        return {
          id: `ev-${i}-${Math.random().toString(36).slice(2, 8)}`,
          runId: '',
          sourceType: 'log' as const,
          rawPointer: `${api}?query=${encodeURIComponent(usedFallback ? 'ERROR' : keywords.join('|'))}`,
          normalized: {
            time: r.ts ? new Date(Number(r.ts) / 1e6).toISOString() : j.time ?? j.timestamp,
            level: String(j.level ?? j.severity ?? (/ERROR/i.test(r.line) ? 'ERROR' : /WARN/i.test(r.line) ? 'WARN' : 'INFO')).toUpperCase(),
            service: j.service ?? r.labels?.job ?? r.labels?.app,
            traceId: j.traceId ?? j.trace_id,
            message: String(j.message ?? j.msg ?? r.line),
            stack: j.stack ?? j.exception,
          },
          dedupCount: 1,
        };
      });
    },
  };
}

// 选择器：
// - endpoint 含 vmui / logsql → VictoriaLogs（vmui 为网页地址，自动纠正到 API）
// - endpoint 含 loki 或 :3100 → Loki
// - endpoint 含 elasticsearch / :9200 / _search，或 indexWhitelist 存在 → Elasticsearch
// - 其他 http(s) → 通用 HTTP 日志 API
// - 其余（internal://、空、目录路径）→ stub
export function selectLogAdapter(cfg?: LogSource): LogSourceAdapter {
  const ep = cfg?.endpoint;
  if (ep && /^https?:\/\//i.test(ep)) {
    if (/vmui|logsql/i.test(ep)) return createVictoriaLogsAdapter();
    if (/loki/i.test(ep) || /:3100(\/|$)/i.test(ep)) return createLokiAdapter();
    if (/elasticsearch/i.test(ep) || /:9200(\/|$)/i.test(ep) || /_search/i.test(ep) || (cfg?.indexWhitelist?.length ?? 0) > 0) {
      return createElasticsearchAdapter();
    }
    return createHttpLogSourceAdapter();
  }
  return createStubLogSourceAdapter();
}
