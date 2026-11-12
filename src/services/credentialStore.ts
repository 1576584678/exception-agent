import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * 凭证存储（PRD §11.2 R1：凭证不落库明文）。
 *
 * 设计取舍：
 * - 模型 / GitLab 等密钥不写入业务数据库，只落在服务端进程可读的 .env（服务器本地文件）。
 * - 保存后立即更新运行时 config，无需重启即可生效。
 * - 读取接口只返回「是否已配置 + 掩码」，任何情况下不回传明文。
 */

const ENV_PATH = path.resolve(process.cwd(), '.env');

/** 掩码：保留前 4 位与后 4 位，中间省略；过短则全部打码 */
export function maskSecret(secret?: string): string {
  if (!secret) return '';
  const s = secret.trim();
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** .env 值转义：含空格 / # / 引号时用双引号包裹 */
function quoteEnvValue(value: string): string {
  if (/[\s#"']/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

/** 写入（或替换）.env 中的指定键，保留其余内容与注释 */
export function updateEnvFile(key: string, value: string): void {
  let content = '';
  try {
    content = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    content = '';
  }
  const line = `${key}=${quoteEnvValue(value)}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    content = `${content.replace(/\s*$/, '')}\n${line}\n`;
  }
  fs.writeFileSync(ENV_PATH, content, { encoding: 'utf8', mode: 0o600 });
  logger.info({ key }, 'env-file-updated');
}

export interface CredentialStatus {
  configured: boolean;
  masked: string;
  source: 'env' | 'none';
}

function statusOf(value?: string): CredentialStatus {
  return { configured: Boolean(value), masked: maskSecret(value), source: value ? 'env' : 'none' };
}

/** 当前凭证状态（只含掩码，不含明文） */
export function getCredentialStatus(): { llm: CredentialStatus; gitlab: CredentialStatus; github: CredentialStatus } {
  return { llm: statusOf(config.LLM_API_KEY), gitlab: statusOf(config.GITLAB_TOKEN), github: statusOf(config.GITHUB_TOKEN) };
}

/** 保存模型 Key：落 .env + 立即更新运行时配置 */
export function saveLLMKey(apiKey: string): CredentialStatus {
  const key = apiKey.trim();
  updateEnvFile('LLM_API_KEY', key);
  config.LLM_API_KEY = key;
  return statusOf(key);
}

/** 保存 GitLab 只读 token（scope: read_api / read_repository） */
export function saveGitLabToken(token: string): CredentialStatus {
  const t = token.trim();
  updateEnvFile('GITLAB_TOKEN', t);
  config.GITLAB_TOKEN = t;
  return statusOf(t);
}

/** 保存 GitHub PAT（repo 只读） */
export function saveGitHubToken(token: string): CredentialStatus {
  const t = token.trim();
  updateEnvFile('GITHUB_TOKEN', t);
  config.GITHUB_TOKEN = t;
  return statusOf(t);
}
