#!/usr/bin/env node
/**
 * 生成可分发的发布包：release/exception-insight.zip
 *
 * 包含：编译产物 dist、静态资源 public、文档、启动脚本、生产依赖 node_modules。
 * 目标机器只需安装 Node.js 18+，解压后双击 start.bat（Windows）或 ./start.sh（Linux/macOS）即可运行。
 *
 * 用法：npm run pack
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'release');
const appDir = path.join(outDir, 'exception-insight');
const zipPath = path.join(outDir, 'exception-insight.zip');

const step = (n, msg) => console.log(`\n[${n}/4] ${msg}`);

step(1, '编译 TypeScript');
execSync('npm run build', { cwd: root, stdio: 'inherit' });

step(2, '复制运行所需文件');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });
for (const dir of ['dist', 'public', 'docs']) {
  fs.cpSync(path.join(root, dir), path.join(appDir, dir), { recursive: true });
}
for (const file of [
  'package.json',
  'package-lock.json',
  '.env.example',
  'README.md',
  'AGENTS.md',
  'start.bat',
  'start.sh',
  'Dockerfile',
  'docker-compose.yml',
]) {
  const src = path.join(root, file);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(appDir, file));
}
fs.mkdirSync(path.join(appDir, 'data'), { recursive: true });

step(3, '安装生产依赖（--omit=dev）');
execSync('npm ci --omit=dev', { cwd: appDir, stdio: 'inherit' });

step(4, '打包 zip');
if (process.platform === 'win32') {
  // 优先用系统 bsdtar：生成正斜杠路径的 zip，跨平台解压兼容
  // （PowerShell Compress-Archive 会写反斜杠，Linux unzip 会报错）
  const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (fs.existsSync(bsdtar)) {
    execSync(`"${bsdtar}" -a -c -f "${zipPath}" exception-insight`, { cwd: outDir, stdio: 'inherit' });
  } else {
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${appDir}\\*' -DestinationPath '${zipPath}' -Force"`,
      { stdio: 'inherit' },
    );
  }
} else {
  execSync(`zip -qr "${zipPath}" exception-insight`, { cwd: outDir, stdio: 'inherit' });
}

const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
console.log(`\n完成：${zipPath}（${sizeMb} MB）`);
console.log('分发说明：目标机器安装 Node.js 18+，解压后运行 start.bat / ./start.sh');
