// 端到端冒烟：登录 -> 提交分析 -> 查报告 -> 反馈 -> 审计 -> 越权拦截 -> 降级
const BASE = 'http://localhost:' + (process.env.PORT || 3000);
let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
  if (!cond) failures++;
}

async function main() {
  const h = await fetch(BASE + '/health');
  check('GET /health 200', h.status === 200);

  const login = await fetch(BASE + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ employeeId: '1001', password: 'dev123' }),
  });
  const ld = await login.json();
  check('admin login 200', login.status === 200 && !!ld.token);
  const H = { authorization: 'Bearer ' + ld.token, 'content-type': 'application/json' };

  const noauth = await fetch(BASE + '/projects/demo-project-1/runs', { headers: {} });
  check('no token -> 401', noauth.status === 401);

  const occ = new Date().toISOString();
  const az = await fetch(BASE + '/projects/demo-project-1/analyze', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      inputType: 'text',
      inputRef: 'NullPointerException at OrderDetailService.java:128',
      supplemental: { occurredAt: occ },
    }),
  });
  const run = await az.json();
  check('analyze 201', az.status === 201, 'status=' + run.status);
  check('report completed', run.report && run.report.status === 'completed', 'confidence=' + run.report?.confidence);
  check('evidence mounted', Array.isArray(run.report?.evidenceChain) && run.report.evidenceChain.length > 0);
  // stub 场景：不产出假代码位置/假数据查询，报告只含真实来源部分
  check('no fake codeLocation (stub skipped)', run.report?.findings?.[0]?.codeLocation === undefined);
  check('no fake dataProbe (stub skipped)', run.report?.findings?.[0]?.dataProbe === undefined);

  const gr = await fetch(BASE + '/runs/' + run.id, { headers: H });
  check('GET /runs/:id 200', gr.status === 200);

  const fb = await fetch(BASE + '/runs/' + run.id + '/feedback', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ findingId: run.report.findings[0].id, verdict: 'correct' }),
  });
  check('feedback 201', fb.status === 201);

  const au = await fetch(BASE + '/audit', { headers: H });
  const al = await au.json();
  check('audit list > 0', au.status === 200 && Array.isArray(al) && al.length > 0, 'entries=' + al.length);

  // 越权：member 访问 demo project 报告 -> 403
  const ml = await fetch(BASE + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ employeeId: '2002', password: 'dev123' }),
  });
  const mt = (await ml.json()).token;
  const cross = await fetch(BASE + '/runs/' + run.id, { headers: { authorization: 'Bearer ' + mt } });
  check('member cross-project -> 403', cross.status === 403);

  // 降级：日志源不可达 -> 部分完成（低置信）
  const deg = await fetch(BASE + '/projects/demo-project-1/analyze', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ inputType: 'text', inputRef: 'error', forceDegrade: 'log', supplemental: {} }),
  });
  const dr = await deg.json();
  check('degrade(log) -> partial', deg.status === 201 && dr.status === 'partial', 'status=' + dr.status);

  // 配置生效：外部大模型 + HTTP 日志地址 + Git 仓库地址
  const createProj = await fetch(BASE + '/projects', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      name: '配置生效演示',
      env: 'staging',
      codeSources: [{ type: 'git', url: 'https://git.internal/repo2', branch: 'main' }],
      logSources: [
        { kind: 'platform', endpoint: 'http://127.0.0.1:59999/log', supportsTraceId: true, maxReturn: 2000 },
      ],
      dataSources: [
        { dbType: 'mysql', credentialRefId: 'cred-db-1', tableWhitelist: ['order'], columnBlacklist: ['password'], rowLimit: 20, timeoutMs: 5000 },
      ],
      modelPolicy: 'external',
      llmConfig: { baseUrl: 'http://127.0.0.1:59999/v1', model: 'demo-model' },
    }),
  });
  const proj = await createProj.json();
  check('create project 201', createProj.status === 201, 'id=' + proj.id);
  check('config persisted: modelPolicy', proj.modelPolicy === 'external');
  check('config persisted: log endpoint', proj.logSources?.[0]?.endpoint === 'http://127.0.0.1:59999/log');
  check('config persisted: git url', proj.codeSources?.[0]?.url === 'https://git.internal/repo2');

  // 依赖不可达 -> 真实适配器被启用且优雅降级为 partial（而非崩溃）
  const az2 = await fetch(BASE + '/projects/' + proj.id + '/analyze', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ inputType: 'text', inputRef: 'demo error', supplemental: { occurredAt: new Date().toISOString() } }),
  });
  const run2 = await az2.json();
  check('configured project analyze 201', az2.status === 201);
  check('unreachable deps -> partial (graceful)', run2.status === 'partial', 'status=' + run2.status);

  // 截图输入（image）走 OCR 占位链路
  const img = await fetch(BASE + '/projects/demo-project-1/analyze', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ inputType: 'image', inputRef: 'data:image/png;base64,AAAA', supplemental: { occurredAt: new Date().toISOString() } }),
  });
  const ir = await img.json();
  check('image input analyze 201', img.status === 201);
  check('image input report generated', !!ir.report, 'status=' + ir.status);

  // 清理：删除本次创建的项目，避免污染用户的项目列表
  const del = await fetch(BASE + '/projects/' + proj.id, { method: 'DELETE', headers: H });
  check('cleanup temp project', del.status === 200);

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURES'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('SMOKE ERROR', e);
  process.exit(1);
});
