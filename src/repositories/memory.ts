import { v4 as uuid } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AnalysisRun,
  AuditLog,
  CredentialRef,
  Evidence,
  Feedback,
  Finding,
  Hypothesis,
  Project,
  User,
} from '../types.js';
import type {
  AnalysisRunRepository,
  AuditRepository,
  CredentialRepository,
  EvidenceRepository,
  FeedbackRepository,
  FindingRepository,
  HypothesisRepository,
  ProjectRepository,
  Repositories,
  UserRepository,
} from './interfaces.js';

const DEFAULT_EVIDENCE_TTL_DAYS = 7;

// 项目配置持久化：data/projects.json（内存实现 + 落盘，重启不丢用户配置）
const DATA_DIR = path.resolve(process.cwd(), 'data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

function loadPersistedProjects(): Map<string, Project> {
  const m = new Map<string, Project>();
  try {
    const arr = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')) as Project[];
    for (const p of arr) if (p && typeof p.id === 'string') m.set(p.id, p);
  } catch {
    // 首次运行无持久化文件
  }
  return m;
}

class MemProjectRepository implements ProjectRepository {
  private store = loadPersistedProjects();
  private persist(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(PROJECTS_FILE, JSON.stringify([...this.store.values()], null, 2), 'utf8');
    } catch (e) {
      // 落盘失败不阻断业务（下次更新会重试）
      console.error('[persist] projects.json 写入失败:', (e as Error).message);
    }
  }
  async create(p: Project) {
    // 幂等种子：已存在（含持久化恢复的）不覆盖
    if (!this.store.has(p.id)) {
      this.store.set(p.id, structuredClone(p));
      this.persist();
    }
    return p;
  }
  async get(id: string) {
    const v = this.store.get(id);
    return v ? structuredClone(v) : undefined;
  }
  async list() {
    return [...this.store.values()].map((v) => structuredClone(v));
  }
  async update(p: Project) {
    this.store.set(p.id, structuredClone(p));
    this.persist();
    return p;
  }
}

class MemCredentialRepository implements CredentialRepository {
  private store = new Map<string, CredentialRef>();
  async create(c: CredentialRef) {
    this.store.set(c.id, structuredClone(c));
    return c;
  }
  async get(id: string) {
    const v = this.store.get(id);
    return v ? structuredClone(v) : undefined; // 不含明文
  }
}

class MemAnalysisRunRepository implements AnalysisRunRepository {
  private store = new Map<string, AnalysisRun>();
  async create(r: AnalysisRun) {
    this.store.set(r.id, structuredClone(r));
    return r;
  }
  async get(id: string) {
    const v = this.store.get(id);
    return v ? structuredClone(v) : undefined;
  }
  async update(r: AnalysisRun) {
    this.store.set(r.id, structuredClone(r));
    return r;
  }
  async listByProject(projectId: string) {
    return [...this.store.values()]
      .filter((r) => r.projectId === projectId)
      .map((v) => structuredClone(v));
  }
}

class MemEvidenceRepository implements EvidenceRepository {
  private store = new Map<string, { e: Evidence; expiresAt: number }>();
  async add(e: Evidence, ttlDays = DEFAULT_EVIDENCE_TTL_DAYS) {
    const expiresAt = Date.now() + ttlDays * 24 * 60 * 60 * 1000;
    this.store.set(e.id, { e: structuredClone(e), expiresAt });
    return e;
  }
  async listByRun(runId: string) {
    const now = Date.now();
    return [...this.store.values()]
      .filter((x) => x.e.runId === runId && x.expiresAt > now)
      .map((x) => structuredClone(x.e));
  }
  pruneExpired(now = Date.now()) {
    for (const [k, x] of this.store) if (x.expiresAt <= now) this.store.delete(k);
  }
}

class MemHypothesisRepository implements HypothesisRepository {
  private store = new Map<string, Hypothesis>();
  async add(h: Hypothesis) {
    this.store.set(h.id, structuredClone(h));
    return h;
  }
  async listByRun(runId: string) {
    return [...this.store.values()]
      .filter((h) => h.runId === runId)
      .map((v) => structuredClone(v));
  }
}

class MemFindingRepository implements FindingRepository {
  private store = new Map<string, Finding>();
  async add(f: Finding) {
    this.store.set(f.id, structuredClone(f));
    return f;
  }
  async get(id: string) {
    const v = this.store.get(id);
    return v ? structuredClone(v) : undefined;
  }
  async listByRun(runId: string) {
    return [...this.store.values()]
      .filter((f) => f.runId === runId)
      .map((v) => structuredClone(v));
  }
}

class MemFeedbackRepository implements FeedbackRepository {
  private store = new Map<string, Feedback>();
  async add(f: Feedback) {
    this.store.set(f.id, structuredClone(f));
    return f;
  }
  async listByRun(runId: string) {
    return [...this.store.values()]
      .filter((f) => f.runId === runId)
      .map((v) => structuredClone(v));
  }
}

// 审计日志：仅追加，无删除/修改接口，满足 PRD FR-40 不可删改硬约束
class MemAuditRepository implements AuditRepository {
  private store: AuditLog[] = [];
  async append(entry: AuditLog) {
    this.store.push(structuredClone(entry));
  }
  async list(filter?: { projectId?: string; actor?: string; action?: string }) {
    return this.store
      .filter(
        (a) =>
          (!filter?.projectId || a.projectId === filter.projectId) &&
          (!filter?.actor || a.actor === filter.actor) &&
          (!filter?.action || a.action === filter.action),
      )
      .map((v) => structuredClone(v));
  }
}

class MemUserRepository implements UserRepository {
  private store = new Map<string, User>();
  async create(u: User) {
    this.store.set(u.id, structuredClone(u));
    return u;
  }
  async getByEmployeeId(employeeId: string) {
    const v = [...this.store.values()].find((u) => u.employeeId === employeeId);
    return v ? structuredClone(v) : undefined;
  }
  async list() {
    return [...this.store.values()].map((v) => structuredClone(v));
  }
}

export function createMemoryRepositories(seedUsers: User[] = []): Repositories {
  const users = new MemUserRepository();
  for (const u of seedUsers) users.create(u);
  return {
    projects: new MemProjectRepository(),
    credentials: new MemCredentialRepository(),
    runs: new MemAnalysisRunRepository(),
    evidence: new MemEvidenceRepository(),
    hypotheses: new MemHypothesisRepository(),
    findings: new MemFindingRepository(),
    feedback: new MemFeedbackRepository(),
    audit: new MemAuditRepository(),
    users,
  };
}

export { uuid };
