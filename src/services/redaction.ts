// 脱敏服务：三道脱敏闸（采集时字段级 / 入模前正则兜底 / 出报告前校验），内置规则不可关闭（PRD FR-07 / FR-35 / R3）。

export interface RedactionResult {
  text: string;
  hits: number;
}

// 内置敏感模式（手机号/身份证/银行卡/邮箱/token），默认开启且不可关闭
const BUILTIN_PATTERNS: { id: string; re: RegExp }[] = [
  { id: 'phone', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { id: 'idcard', re: /\d{17}[\dXx]/g },
  { id: 'bankcard', re: /\b\d{16,19}\b/g },
  { id: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { id: 'bearer', re: /Bearer\s+[A-Za-z0-9._-]+/g },
  { id: 'apikey', re: /\b(?:sk|pk|rk)-[A-Za-z0-9]{10,}/g },
];

const SENSITIVE_KEYS = ['password', 'pwd', 'secret', 'token', 'authorization'];

export class RedactionService {
  private custom: RegExp[] = [];

  // 文本级正则兜底（闸 2 / 闸 3 共用）。返回替换后文本与命中数。
  redact(text: string): RedactionResult {
    let out = text ?? '';
    let hits = 0;
    for (const p of BUILTIN_PATTERNS) {
      out = out.replace(p.re, () => {
        hits += 1;
        return '***';
      });
    }
    for (const re of this.custom) {
      out = out.replace(re, () => {
        hits += 1;
        return '***';
      });
    }
    return { text: out, hits };
  }

  // 对象级字段脱敏（闸 1）：敏感 key 的值脱敏 + 字符串化后再过文本正则
  redactObject(obj: unknown): RedactionResult {
    const scrubbed = this.scrubKeys(obj);
    return this.redact(JSON.stringify(scrubbed ?? ''));
  }

  private scrubKeys(obj: unknown, depth = 0): unknown {
    if (depth > 8 || obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map((v) => this.scrubKeys(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.includes(k.toLowerCase()) && typeof v === 'string') out[k] = '***';
      else out[k] = this.scrubKeys(v, depth + 1);
    }
    return out;
  }

  // 出报告前校验（闸 3）：仍有敏感信息则视为未通过
  assertClean(text: string): boolean {
    return this.redact(text).hits === 0;
  }

  addCustomRule(re: RegExp): void {
    this.custom.push(re);
  }
}
