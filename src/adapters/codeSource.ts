import { config } from '../config.js';
import type { CodeLocation, CodeSource } from '../types.js';

// 代码源适配器：定位候选代码、blame、版本对齐。读取路径必须限定在仓库根目录内（PRD FR-08 / R5）。
export interface CodeSourceAdapter {
  readonly name: string;
  locate(input: { errorText?: string; stack?: string; errorCode?: string }): Promise<
    { file: string; line: number; snippet?: string }[]
  >;
  blame(file: string, line: number): Promise<CodeLocation['blame']>;
  resolveCommitAt(time?: string): Promise<{ sha: string; versionAligned: boolean }>;
}

// ===== stub（开发期/未配置真实仓库或 token 时使用）=====
export function createStubCodeSourceAdapter(): CodeSourceAdapter {
  return {
    name: 'stub-code',
    async locate() {
      return [
        {
          file: 'src/main/java/com/example/OrderDetailService.java',
          line: 128,
          snippet: 'public BigDecimal getAmount() { return coupon.getAmount(); }',
        },
      ];
    },
    async blame(file, line) {
      // 边界声明固定附在报告提交人区块（PRD FR-22），禁止关闭
      return {
        shortSha: 'a1b2c3d',
        authorName: '张某',
        authorEmployeeId: '1024',
        committedAt: '2026-08-14T10:22:00+08:00',
        message: '优化券金额计算',
        commitUrl: `https://git.internal/monorepo/-/blob/a1b2c3d/${file}#L${line}`,
        isLastModifier: true,
        note: 'blame 仅表示最后修改者，不代表责任人',
      };
    },
    async resolveCommitAt(time) {
      return { sha: 'a1b2c3d', versionAligned: !!time };
    },
  };
}

// ===== 真实 GitLab 适配器（REST API v4）=====
// base/path 可从 codeSource.url 解析，如 http://192.168.9.111:60200/aigit/qydn-report
function resolveGitInfo(cfg: CodeSource): { base: string; path: string } {
  let base = '';
  let path = cfg.projectPath ?? '';
  if (cfg.url) {
    try {
      const u = new URL(cfg.url);
      base = u.origin;
      if (!path) path = decodeURIComponent(u.pathname.replace(/^\/+/, '').replace(/\.git$/, ''));
    } catch {
      base = cfg.url.replace(/\/+$/, '');
    }
  }
  return { base: base.replace(/\/+$/, ''), path };
}

async function gitlabFetch(url: string): Promise<unknown> {
  const token = config.GITLAB_TOKEN;
  if (!token) throw new Error('未配置 GITLAB_TOKEN');
  const res = await fetch(url, {
    headers: { 'PRIVATE-TOKEN': token },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitLab HTTP ${res.status}`);
  return res.json();
}

export function createGitCodeSourceAdapter(cfg: CodeSource): CodeSourceAdapter {
  const stub = createStubCodeSourceAdapter();
  // 明确的兼容性提示：Gitee/Gitea 等非 GitLab/GitHub 平台暂不支持，提前给出可读错误而非静默失败
  const nonGitlabHost = /(^|\.)(gitee\.com|gitea\.com|gitcode\.com)$/i.test(
    (() => { try { return new URL(cfg.url ?? '').hostname; } catch { return ''; } })(),
  );
  const unsupported = nonGitlabHost ? '当前版本仅支持 GitLab 与 GitHub 仓库（检测到 Gitee/Gitea 等地址，其 API 协议不同）' : '';
  const { base, path } = resolveGitInfo(cfg);
  const ref = cfg.branch || 'main';
  const ready = Boolean(base && path && config.GITLAB_TOKEN);

  return {
    name: 'git-code',
    async locate({ errorText, stack }) {
      if (unsupported) throw new Error(unsupported);
      // 优先从堆栈解析 “File.java:128”；真实代码搜索可后续补 GitLab search?scope=blobs
      const m = stack?.match(/([A-Za-z0-9_./-]+\.(?:java|ts|js|py|go|kt)):(\d+)/);
      if (m) return [{ file: m[1] as string, line: Number(m[2]) }];
      return stub.locate({ errorText, stack });
    },
    async blame(file, line) {
      if (unsupported) throw new Error(unsupported);
      if (!ready) throw new Error('GitLab 仓库已配置但缺少项目路径或访问 Token，请在「配置 → 代码仓库」补充');
      try {
        // GET /api/v4/projects/:id/repository/files/:file/blame?ref=:ref
        const url = `${base}/api/v4/projects/${encodeURIComponent(path)}/repository/files/${encodeURIComponent(file)}/blame?ref=${encodeURIComponent(ref)}`;
        const ranges = (await gitlabFetch(url)) as { commit: Record<string, unknown>; lines?: string[] }[];
        let start = 1;
        let commit: Record<string, unknown> | undefined;
        for (const r of ranges) {
          const len = (r.lines ?? []).length;
          if (line >= start && line < start + len) {
            commit = r.commit;
            break;
          }
          start += len;
        }
        if (!commit) commit = ranges[0]?.commit;
        if (!commit) throw new Error('GitLab blame 返回空结果');
        const sha = String(commit.id ?? '');
        return {
          shortSha: String(commit.short_id ?? sha.slice(0, 8)),
          authorName: String(commit.author_name ?? '未知'),
          authorEmployeeId: '', // GitLab 无工号；组织架构映射为后续（PRD 13.1 可绕过依赖）
          committedAt: String(commit.committed_date ?? ''),
          message: String(commit.title ?? commit.message ?? ''),
          commitUrl: `${base}/${path}/-/blob/${sha}/${file}#L${line}`,
          isLastModifier: true,
          note: 'blame 仅表示最后修改者，不代表责任人',
        };
      } catch (e) {
        // 网络/权限失败不产出假数据：抛错由编排器转成报告中的未验证说明
        throw new Error(`GitLab blame 查询失败: ${(e as Error).message || e}`);
      }
    },
    async resolveCommitAt(time) {
      if (!ready) return { sha: 'HEAD', versionAligned: Boolean(time) };
      try {
        const params = new URLSearchParams({ ref_name: ref, per_page: '1' });
        if (time) params.set('until', time);
        const url = `${base}/api/v4/projects/${encodeURIComponent(path)}/repository/commits?${params.toString()}`;
        const arr = (await gitlabFetch(url)) as { id?: string }[];
        return { sha: arr[0]?.id ?? 'HEAD', versionAligned: Boolean(time) };
      } catch {
        return { sha: 'HEAD', versionAligned: Boolean(time) };
      }
    },
  };
}

// ===== GitHub 适配器（REST API v3）=====
// GitHub 无 blame API：用「该文件最近一次提交」近似最后修改者，并在报告中如实标注
function githubHostOf(url?: string): string {
  try { return new URL(url ?? '').hostname.toLowerCase(); } catch { return ''; }
}

export function isGitHubRepo(url?: string): boolean {
  const h = githubHostOf(url);
  return h === 'github.com' || h.endsWith('.github.com');
}

async function githubFetch(url: string): Promise<unknown> {
  const token = config.GITHUB_TOKEN;
  const res = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`GitHub HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

export function createGitHubCodeSourceAdapter(cfg: CodeSource): CodeSourceAdapter {
  const stub = createStubCodeSourceAdapter();
  // owner/repo 从 URL 解析：https://github.com/<owner>/<repo>
  let owner = '';
  let repo = '';
  try {
    const u = new URL(cfg.url ?? '');
    const seg = u.pathname.replace(/^\/+/, '').replace(/\.git$/, '').split('/');
    owner = seg[0] ?? '';
    repo = (seg[1] ?? '').replace(/\/+$/, '');
  } catch { /* url 无效时由 ready 拦截 */ }
  const ref = cfg.branch || 'main';
  const ready = Boolean(owner && repo);
  const api = 'https://api.github.com/repos/' + `${owner}/${repo}`;
  const page = 'https://github.com/' + `${owner}/${repo}`;

  return {
    name: 'github-code',
    async locate({ errorText, stack }) {
      const m = stack?.match(/([A-Za-z0-9_./-]+\.(?:java|ts|js|py|go|kt)):(\d+)/);
      if (m) return [{ file: m[1] as string, line: Number(m[2]) }];
      return stub.locate({ errorText, stack });
    },
    async blame(file, line) {
      if (!ready) throw new Error('GitHub 仓库地址不合法（应为 https://github.com/owner/repo）');
      // 最近一次改动该文件的提交 ≈ 最后修改者（GitHub 无逐行 blame API）
      const arr = (await githubFetch(`${api}/commits?path=${encodeURIComponent(file)}&sha=${encodeURIComponent(ref)}&per_page=1`)) as {
        sha?: string;
        commit?: { author?: { name?: string; date?: string }; message?: string };
      }[];
      const c = arr[0];
      if (!c?.sha) throw new Error('GitHub 未返回该文件的提交记录（文件可能不存在或分支不对）');
      return {
        shortSha: c.sha.slice(0, 8),
        authorName: c.commit?.author?.name ?? '未知',
        authorEmployeeId: '',
        committedAt: c.commit?.author?.date ?? '',
        message: String(c.commit?.message ?? '').split('\n')[0] || '（无提交信息）',
        commitUrl: `${page}/commit/${c.sha}`,
        isLastModifier: true,
        note: 'GitHub 无逐行 blame API，此处为该文件最近一次提交的作者（最后修改该文件的人），不代表该行的责任人',
      };
    },
    async resolveCommitAt(time) {
      if (!ready) return { sha: 'HEAD', versionAligned: Boolean(time) };
      try {
        const params = new URLSearchParams({ sha: ref, per_page: '1' });
        if (time) params.set('until', time);
        const arr = (await githubFetch(`${api}/commits?${params.toString()}`)) as { sha?: string }[];
        return { sha: arr[0]?.sha ?? 'HEAD', versionAligned: Boolean(time) };
      } catch {
        return { sha: 'HEAD', versionAligned: Boolean(time) };
      }
    },
  };
}

// 选择器：配置了 git 类型且带 http(s) 仓库地址 → 按托管平台分 GitLab / GitHub；否则 stub
export function selectCodeAdapter(cfg?: CodeSource): CodeSourceAdapter {
  if (cfg?.type === 'git' && cfg.url && /^https?:\/\//i.test(cfg.url)) {
    if (isGitHubRepo(cfg.url)) return createGitHubCodeSourceAdapter(cfg);
    return createGitCodeSourceAdapter(cfg);
  }
  return createStubCodeSourceAdapter();
}
