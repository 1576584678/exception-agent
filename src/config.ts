import 'dotenv/config';
import { z } from 'zod';

// 集中配置：全部来自环境变量，启动时一次性校验，失败快速退出（fail-fast）
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET 至少 16 字符，生产环境必须替换为强随机值'),
  JWT_EXPIRES_IN: z.coerce.number().int().positive().default(3600),
  // 模型策略：local 禁用外部调用；external 允许（受凭证引用约束）
  MODEL_POLICY: z.enum(['local', 'external']).default('local'),
  LLM_BASE_URL: z.string().url().optional().or(z.literal('')),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  // GitLab 只读 token（env 注入，禁止入库；scope: read_api / read_repository）
  GITLAB_TOKEN: z.string().optional(),
  // 存储：memory 开发期默认；pg 为后续生产接入
  STORAGE: z.enum(['memory', 'pg']).default('memory'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // 配置错误属于致命问题，直接输出并退出，不泄露具体密钥值
  console.error('[FATAL] 配置校验失败：', JSON.stringify(parsed.error.issues, null, 2));
  process.exit(1);
}

export const config = parsed.data;
export type AppConfig = typeof config;
