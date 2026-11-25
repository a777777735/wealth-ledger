// 從 public/index.html 抽出所有 inline <script>（不含 src 外連），逐一以
// `node --check` 做語法解析（只解析、不執行）。外連 CDN script 不檢查。
// 用法：node scripts/check-inline-scripts.mjs
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const htmlPath = new URL('../public/index.html', import.meta.url);
const html = readFileSync(htmlPath, 'utf8');

// 只抓沒有 src 屬性的 <script>；程式碼內不含字面 `</script>`（已確認），故非貪婪比對是安全的
const re = /<script(?![^>]*\bsrc\s*=)([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const blocks = [];
let m;
while ((m = re.exec(html)) !== null) {
  const attrs = m[1] || '';
  const code = m[2];
  if (!code.trim()) continue;
  const isModule = /\btype\s*=\s*["']module["']/.test(attrs);
  blocks.push({ code, isModule });
}

if (blocks.length === 0) {
  console.error('在 public/index.html 中找不到 inline <script>');
  process.exit(1);
}

console.log(`找到 ${blocks.length} 個 inline <script>，逐一做 node --check…`);
const dir = mkdtempSync(join(tmpdir(), 'wl-inline-'));
let failed = false;
blocks.forEach((b, i) => {
  const ext = b.isModule ? '.mjs' : '.js';
  const file = join(dir, `inline-${i}${ext}`);
  writeFileSync(file, b.code);
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed = true;
    console.error(`inline <script> #${i + 1} 語法檢查失敗：\n${r.stderr || r.stdout}`);
  } else {
    console.log(`inline <script> #${i + 1} OK (${b.isModule ? 'module' : 'classic'})`);
  }
});
rmSync(dir, { recursive: true, force: true });
if (failed) process.exit(1);
console.log('全部 inline script 語法檢查通過');
