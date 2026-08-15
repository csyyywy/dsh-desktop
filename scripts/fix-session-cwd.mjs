/**
 * Rewrite session JSONL header cwd (Windows path -> WSL path) in a session
 * store copy, then move sessions into the project dir matching the new cwd.
 * Usage: node fix-session-cwd.mjs <storeRoot> <newCwd> [--move]
 * - storeRoot: e.g. ~/.dsh/sessions  (contains --*-* project dirs)
 * - rewrites header cwd of EVERY session under project dirs whose current
 *   header cwd is a Windows-style absolute path (drive letter), so those
 *   sessions become attachable by a WSL dsh whose workspace == newCwd.
 * - --move: move rewritten sessions into <storeRoot>/<projectKey(newCwd)>
 */
import { readdirSync, mkdirSync, renameSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib';

const [storeRoot, newCwd, moveFlag] = process.argv.slice(2);
if (!storeRoot || !newCwd) { console.error('usage: fix-session-cwd.mjs <storeRoot> <newCwd> [--move]'); process.exit(1); }
const doMove = moveFlag === '--move';

function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('empty cwd');
  let readable = '';
  let sepRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!sepRun) readable += '-';
      sepRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch; sepRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0'); sepRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

const isWinAbs = (p) => /^[A-Za-z]:[\\/]/.test(p);
const targetKey = projectKey(newCwd);
console.log(`storeRoot=${storeRoot}\nnewCwd=${newCwd}\ntargetKey=${targetKey} doMove=${doMove}`);

let rewritten = 0, moved = 0, skipped = 0;
const backups = [];

for (const proj of readdirSync(storeRoot, { withFileTypes: true })) {
  if (!proj.isDirectory()) continue;
  const projDir = join(storeRoot, proj.name);
  for (const sess of readdirSync(projDir, { withFileTypes: true })) {
    if (!sess.isDirectory()) continue;
    const sessDir = join(projDir, sess.name);
    const logPath = join(sessDir, 'session.jsonl.zstd');
    const plainPath = join(sessDir, 'session.jsonl');
    const useZstd = existsSync(logPath);
    const usePlain = !useZstd && existsSync(plainPath);
    if (!useZstd && !usePlain) continue;
    const raw = readFileSync(useZstd ? logPath : plainPath);
    const buf = useZstd ? zstdDecompressSync(raw) : raw;
    const text = buf.toString('utf8');
    const nl = text.indexOf('\n');
    if (nl < 0) { skipped++; continue; }
    const headerLine = text.slice(0, nl);
    let header;
    try { header = JSON.parse(headerLine); } catch { skipped++; continue; }
    if (!header || header.type !== 'session') { skipped++; continue; }
    if (!isWinAbs(header.cwd)) { skipped++; continue; }
    // backup original (only first time per file)
    const bak = useZstd ? `${logPath}.bak` : `${plainPath}.bak`;
    if (!existsSync(bak)) {
      writeFileSync(bak, raw);
      backups.push(bak);
    }
    header.cwd = newCwd;
    const newHeaderLine = JSON.stringify(header);
    const newText = newHeaderLine + text.slice(nl);
    const newRaw = useZstd ? zstdCompressSync(Buffer.from(newText, 'utf8'), { level: 3 }) : Buffer.from(newText, 'utf8');
    if (useZstd) writeFileSync(logPath, newRaw);
    else writeFileSync(plainPath, newRaw);
    rewritten++;
    console.log(`rewrote ${sess.name} (${proj.name}) cwd -> ${newCwd}`);
    if (doMove && proj.name !== targetKey) {
      const dst = join(storeRoot, targetKey, sess.name);
      mkdirSync(join(storeRoot, targetKey), { recursive: true });
      // 目标已存在旧副本时覆盖：同一 session id 出现在多个 project 目录会触发
      // dsh duplicate id 报错，而本次复制来的 Windows 副本更新（Windows 侧是权威源）。
      if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
      renameSync(sessDir, dst);
      moved++;
      console.log(`moved ${sess.name} -> ${targetKey}/`);
    }
  }
  // remove emptied project dir
  if (doMove) {
    const left = readdirSync(projDir);
    if (left.length === 0) { rmSync(projDir, { recursive: true }); console.log(`removed empty ${proj.name}/`); }
  }
}
console.log(`DONE rewritten=${rewritten} moved=${moved} skipped=${skipped} backups=${backups.length}`);
