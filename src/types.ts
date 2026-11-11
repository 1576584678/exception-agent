// 领域类型：与 PRD §10.1 核心实体对齐，作为仓储/服务/路由的共享契约。

export type Role = 'platform_admin' | 'project_admin' | 'member' | 'observer' | 'auditor';

export interface CredentialRef {
  id: string;
  type: 'git' | 'db' | 'log';
  secretRef: string; // 外部引用 ID，平台内禁止保存明文
  ownerProjectId: string;
  lastVerifiedAt: string;
}

export interface CodeSource {
  type: 'git' | 'local';
  url?: string; // GitLab base（如 http://host:port）或完整项目地址
  projectPath?: string; // GitLab 项目路径，如 group/project
  branch?: string;
  subdir?: string;
  mountPath?: string;
  credentialRefId?: string;
}

export interface LogSource {
  kind: 'platform' | 'objectstore';
  endpoint?: string;
  queryTemplate?: string;
  timeField?: string;
  indexWhitelist?: string[];
  path?: string;
  fileFormat?: string;
  supportsTraceId: boolean;
  maxReturn: number;
}

export interface DataSource {
  dbType: string;
  credentialRefId: string;
  tableWhitelist: string[];
  columnBlacklist: string[];
  rowLimit: number; // 默认 20
  timeoutMs: number; // 默认 5000
}

export interface RedactionRule {
  id: string;
  kind: 'builtin' | 'custom';
  pattern?: string; // 自定义正则（仅 custom）
  enabled: boolean;
}

export interface Project {
  id: string;
  name: string;
  env: 'prod' | 'staging';
  ownerId: string;
  codeSources: CodeSource[];
  logSources: LogSource[];
  dataSources: DataSource[];
  redactionRules: RedactionRule[];
  modelPolicy: 'local' | 'external';
  // 项目级模型配置（external 时启用；apiKey 走 env 或外部凭证引用，禁止明文存储）
  llmConfig?: { baseUrl?: string; model?: string; apiKeyRef?: string };
  createdAt: string;
  updatedAt: string;
}

export type InputType = 'image' | 'text';
export type Confidence = 'high' | 'medium' | 'low';
export type ConclusionType =
  | 'code_defect'
  | 'data_anomaly'
  | 'config_issue'
  | 'env_dependency'
  | 'frontend_compat'
  | 'unknown';
export type RunStatus =
  | 'parsing'
  | 'plan_confirm'
  | 'collecting'
  | 'attributing'
  | 'data_checking'
  | 'reporting'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface ParsedFields {
  errorText?: string;
  stack?: string;
  httpStatus?: string;
  pageTitle?: string;
  route?: string;
  occurredAt?: string;
  fieldConfidence: Record<string, number>;
}

export interface RetrievePlan {
  keywords: string[];
  timeWindow: { from: string; to: string };
  sources: string[];
  maxRows: number;
  editable: true;
}

export interface Evidence {
  id: string;
  runId: string;
  sourceType: 'log' | 'code' | 'blame' | 'data';
  rawPointer: string;
  normalized?: Record<string, unknown>;
  dedupCount?: number;
  redactionHits?: number;
}

export interface Hypothesis {
  id: string;
  runId: string;
  statement: string;
  verifyPlan: string[];
  supportingEvidenceIds: string[];
}

export interface CodeLocation {
  file: string;
  line: number;
  snippet?: string;
  blame: {
    shortSha: string;
    authorName: string;
    authorEmployeeId: string; // 工号，禁止展示邮箱/手机
    committedAt: string;
    message: string;
    commitUrl: string;
    isLastModifier: boolean;
    note: 'blame 仅表示最后修改者，不代表责任人';
  };
  commitSha: string;
  versionAligned: boolean;
}

export interface DataProbe {
  table: string;
  pkField: string;
  pkValue: string;
  snapshot: Record<string, unknown>; // 脱敏后
  highlighted: { field: string; expected: unknown; actual: unknown }[];
  status: 'success' | 'incomplete';
  reason?: string;
}

export interface Finding {
  id: string;
  runId: string;
  type: ConclusionType;
  statement: string;
  evidenceIds: string[];
  confidence: Confidence;
  codeLocation?: CodeLocation;
  dataProbe?: DataProbe;
}

export interface Report {
  runId: string;
  conclusion: string;
  conclusionType: ConclusionType;
  confidence: Confidence;
  evidenceChain: Evidence[];
  findings: Finding[];
  impact: string;
  suggestions: string[];
  unverified: string[];
  plan: RetrievePlan;
  status: 'completed' | 'partial';
  // 演示占位标注：列出使用了 stub 假数据的部分（如 代码位置/数据定位），UI 显式提示，避免误认为真实结论
  demoParts?: string[];
}

export interface RunStage {
  name: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface AnalysisRun {
  id: string;
  projectId: string;
  inputType: InputType;
  inputRef?: string;
  supplemental: {
    occurredAt?: string;
    pageUrl?: string;
    userId?: string;
    traceId?: string;
    bizPk?: string;
  };
  parsedFields?: ParsedFields;
  plan?: RetrievePlan;
  status: RunStatus;
  stages: RunStage[];
  confidence?: Confidence;
  conclusionType?: ConclusionType;
  report?: Report;
  createdBy: string;
  createdAt: string;
  totalCostMs?: number;
}

export interface Feedback {
  id: string;
  findingId: string;
  runId: string;
  verdict: 'correct' | 'incorrect';
  reason?: 'evidence_wrong' | 'code_wrong' | 'data_wrong' | 'speculation';
  userId: string;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  actor: string;
  at: string;
  projectId?: string;
  action: string;
  query?: string;
  tablesAccessed?: string[]; // 仅表名，不记录值
  columnsAccessed?: string[];
  modelPayloadBytes?: number;
  modelPayloadHash?: string;
  detail?: string;
  // 不可删改
}

export interface User {
  id: string;
  name: string;
  employeeId: string;
  role: Role;
  passwordHash: string; // 开发期明文占位，生产必须替换为强哈希
}
