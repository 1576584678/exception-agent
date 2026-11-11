import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * 全局设置（跨项目共用）：目前只有大模型配置。
 *
 * 设计：模型网关与 Key 通常全公司/全团队一套，没必要每个项目重复配置；
 * 项目配置只保留「日志源 / 代码仓库 / 数据源」这类真正按项目不同的内容。
 * 存储：data/settings.json（与项目配置同目录，重启保留）。
 */

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export interface GlobalLLMSettings {
  modelPolicy: 'local' | 'external';
  baseUrl?: string;
  model?: string;
  reasoningEffort?: 'none' | 'low' | 'high' | 'max';
}

interface Settings {
  llm: GlobalLLMSettings;
}

function defaultLLM(): GlobalLLMSettings {
  return {
    modelPolicy: config.MODEL_POLICY,
    baseUrl: config.LLM_BASE_URL || undefined,
    model: config.LLM_MODEL || undefined,
  };
}

function load(): Settings {
  try {
    const j = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Partial<Settings>;
    return { llm: { ...defaultLLM(), ...(j.llm ?? {}) } };
  } catch {
    return { llm: defaultLLM() };
  }
}

let settings: Settings = load();

export function getLLMSettings(): GlobalLLMSettings {
  return { ...settings.llm };
}

export function saveLLMSettings(next: Partial<GlobalLLMSettings>): GlobalLLMSettings {
  settings.llm = { ...settings.llm, ...next };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {
    logger.error({ err: (e as Error).message }, 'settings persist failed');
  }
  logger.info({ modelPolicy: settings.llm.modelPolicy, model: settings.llm.model }, 'llm-settings-updated');
  return getLLMSettings();
}
