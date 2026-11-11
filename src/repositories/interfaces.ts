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

// 仓储接口：服务层只依赖这些抽象，后续接 PostgreSQL 时提供新实现即可，业务代码零改动。

export interface ProjectRepository {
  create(p: Project): Promise<Project>;
  get(id: string): Promise<Project | undefined>;
  list(): Promise<Project[]>;
  update(p: Project): Promise<Project>;
}

export interface CredentialRepository {
  create(c: CredentialRef): Promise<CredentialRef>;
  get(id: string): Promise<CredentialRef | undefined>; // 绝不返回明文
}

export interface AnalysisRunRepository {
  create(r: AnalysisRun): Promise<AnalysisRun>;
  get(id: string): Promise<AnalysisRun | undefined>;
  update(r: AnalysisRun): Promise<AnalysisRun>;
  listByProject(projectId: string): Promise<AnalysisRun[]>;
}

export interface EvidenceRepository {
  add(e: Evidence, ttlDays?: number): Promise<Evidence>;
  listByRun(runId: string): Promise<Evidence[]>;
  pruneExpired(now?: number): void; // 对应 PRD FR-41 留存清理（MVP 内存版）
}

export interface HypothesisRepository {
  add(h: Hypothesis): Promise<Hypothesis>;
  listByRun(runId: string): Promise<Hypothesis[]>;
}

export interface FindingRepository {
  add(f: Finding): Promise<Finding>;
  get(id: string): Promise<Finding | undefined>;
  listByRun(runId: string): Promise<Finding[]>;
}

export interface FeedbackRepository {
  add(f: Feedback): Promise<Feedback>;
  listByRun(runId: string): Promise<Feedback[]>;
}

export interface AuditRepository {
  append(entry: AuditLog): Promise<void>; // 仅追加，禁止删除与修改
  list(filter?: { projectId?: string; actor?: string; action?: string }): Promise<AuditLog[]>;
}

export interface UserRepository {
  create(u: User): Promise<User>;
  getByEmployeeId(employeeId: string): Promise<User | undefined>;
  list(): Promise<User[]>;
}

export interface Repositories {
  projects: ProjectRepository;
  credentials: CredentialRepository;
  runs: AnalysisRunRepository;
  evidence: EvidenceRepository;
  hypotheses: HypothesisRepository;
  findings: FindingRepository;
  feedback: FeedbackRepository;
  audit: AuditRepository;
  users: UserRepository;
}
