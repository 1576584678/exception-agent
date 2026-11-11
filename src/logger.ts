import pino from 'pino';
import { config } from './config.js';

// 结构化 JSON 日志，贯穿请求 ID；业务层不得记录密码、令牌与隐私字段
export const logger = pino({
  level: config.LOG_LEVEL,
  base: undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
