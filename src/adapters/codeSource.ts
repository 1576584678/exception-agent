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
  // 明确的兼容性提示：GitHub/Gitee 等非 GitLab 仓库当前不支持（API 协议不同），提前给出可读错误而非静默失败
  const nonGitlabHost = /(^|\.)(github\.com|gitee\.com|gitea\.com|gitcode\.com)$/i.test(
    (() => { try { return new URL(cfg.url ?? '').hostname; } catch { return ''; } })(),
  );
  const unsupported = nonGitlabHost ? '当前版本仅支持 GitLab 仓库（检测到 GitHub/Gitee 等地址，其 API 协议不同）' : '';
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

// 选择器：配置了 git 类型且带 http(s) 仓库地址 → 真实 Git 适配器；否则 stub
export function selectCodeAdapter(cfg?: CodeSource): CodeSourceAdapter {
  if (cfg?.type === 'git' && cfg.url && /^https?:\/\//i.test(cfg.url)) return createGitCodeSourceAdapter(cfg);
  return createStubCodeSourceAdapter();
}
