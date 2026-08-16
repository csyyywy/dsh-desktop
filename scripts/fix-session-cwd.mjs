/**
 * Rewrite session JSONL header cwd (Windows path -> WSL path) in a session
 * store copy, then move sessions into the project dir matching the new cwd.
 *
 * v0.2.2 FIX: frame-preserving rewrite. The artifact is a concatenation of
 * independent zstd frames: frame 0 = the header line, then one frame per
 * event batch. zstdDecompressSync() only decodes the FIRST frame, so the old
 * implementation rewrote the file as a single header-only frame and silently
 * DESTROYED all event content. This version parses the first frame's byte
 * range (same algorithm as dsh-session-persistence-jsonl scanZstdFrames),
 * decompresses ONLY that frame, swaps the cwd, recompresses a new header
 * frame and concatenates the untouched tail — content preserved.
 *
 * Also remaps stale workspace records: <storeRoot>/../storages/workspace.json
 * may carry workspace records whose path is the old Windows cwd; those are
 * rewritten to newCwd so sessions attach (otherwise the UI hides them).
 *
 * Usage: node fix-session-cwd.mjs <storeRoot> <newCwd> [--move]
 */
import { readdirSync, mkdirSync, renameSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, zstdDecompressSync, zstdCompressSync } from 'node:zlib';

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
// 迁移目标工作区目录需真实存在（attachSession 会 realpath 校验）；不存在则补建
try { mkdirSync(newCwd, { recursive: true }); } catch (e) { console.warn('cannot ensure workspace dir:', e.message); }

/** Zstandard frame-header parse (mirrors dsh-session-persistence-jsonl scanZstdFrames).
 *  Returns the byte offset just past the first complete frame. */
function firstFrameEnd(buf) {
  let offset = 0;
  if (buf.length - offset < 4 || buf.readUInt32LE(offset) !== 4247762216) throw new Error('invalid zstd frame magic');
  offset += 4;
  const descriptor = buf.readUInt8(offset); offset += 1;
  if ((descriptor & 24) !== 0) throw new Error('reserved frame-header bit');
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 32) !== 0;
  const checksum = (descriptor & 4) !== 0;
  const dictionaryFlag = descriptor & 3;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  if (buf.length - offset < remainingHeaderBytes) throw new Error('torn frame header');
  offset += remainingHeaderBytes;
  for (;;) {
    if (buf.length - offset < 3) throw new Error('torn block header');
    const blockHeader = buf.readUIntLE(offset, 3);
    offset += 3;
    const lastBlock = (blockHeader & 1) !== 0;
    const blockType = (blockHeader >>> 1) & 3;
    const blockSize = blockHeader >>> 3;
    if (blockType === 3) throw new Error('reserved block type');
    const payloadBytes = blockType === 1 ? 1 : blockSize;
    if (buf.length - offset < payloadBytes) throw new Error('torn block payload');
    offset += payloadBytes;
    if (lastBlock) break;
  }
  if (checksum) {
    if (buf.length - offset < 4) throw new Error('torn checksum');
    offset += 4;
  }
  return offset;
}

/** Count complete frames in a zstd artifact (sanity check). */
function countFrames(buf) {
  let n = 0, offset = 0;
  while (offset < buf.length) {
    const end = firstFrameEnd(buf.subarray(offset));
    n++;
    offset += end;
  }
  return n;
}

/** Remap stale workspace records (old Windows path -> newCwd). Best-effort. */
function remapWorkspaceJson(storeRoot, oldCwd, newCwd) {
  const wsPath = join(storeRoot, '..', 'storages', 'workspace.json');
  if (!existsSync(wsPath)) { console.log('no workspace.json at', wsPath, '(skip remap)'); return; }
  try {
    const j = JSON.parse(readFileSync(wsPath, 'utf8'));
    const ws = j.tables?.workspaces;
    if (!ws) return console.log('workspace.json has no tables.workspaces (skip remap)');
    let changed = 0;
    for (const [id, w] of Object.entries(ws)) {
      if (w.path === oldCwd) { w.path = newCwd; changed++; console.log(`workspace record ${id} path: ${JSON.stringify(oldCwd)} -> ${JSON.stringify(newCwd)}`); }
    }
    if (changed > 0) {
      const bak = `${wsPath}.bak`;
      if (!existsSync(bak)) writeFileSync(bak, readFileSync(wsPath));
      writeFileSync(wsPath, JSON.stringify(j, null, 2) + '\n');
      console.log(`workspace.json remapped ${changed} record(s)`);
    }
  } catch (e) {
    console.log('workspace.json remap failed (best-effort):', e.message);
  }
}

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
    // --- zstd: decode ONLY the first (header) frame; keep the tail intact ---
    let tail = Buffer.alloc(0);
    let headerBuf;
    if (useZstd) {
      const firstEnd = firstFrameEnd(raw);
      headerBuf = zstdDecompressSync(raw.subarray(0, firstEnd));
      tail = raw.subarray(firstEnd);
    } else {
      headerBuf = raw;
    }
    const text = headerBuf.toString('utf8');
    const nl = text.indexOf('\n');
    if (nl < 0) { skipped++; continue; }
    const headerLine = text.slice(0, nl);
    let header;
    try { header = JSON.parse(headerLine); } catch { skipped++; continue; }
    if (!header || header.type !== 'session') { skipped++; continue; }
    if (!isWinAbs(header.cwd)) { skipped++; continue; }
    const oldCwd = header.cwd;
    // backup original (only first time per file)
    const bak = useZstd ? `${logPath}.bak` : `${plainPath}.bak`;
    if (!existsSync(bak)) {
      writeFileSync(bak, raw);
      backups.push(bak);
    }
    header.cwd = newCwd;
    const newHeaderLine = JSON.stringify(header) + '\n';
    const newRaw = useZstd
      ? Buffer.concat([
          zstdCompressSync(Buffer.from(newHeaderLine, 'utf8'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } }),
          tail
        ])
      : Buffer.concat([Buffer.from(newHeaderLine, 'utf8'), raw.subarray(nl + 1)]);
    if (useZstd) {
      writeFileSync(logPath, newRaw);
      const after = countFrames(newRaw);
      const before = countFrames(raw);
      console.log(`rewrote ${sess.name} (${proj.name}) cwd -> ${newCwd} | frames ${before} -> ${after} | bytes ${raw.length} -> ${newRaw.length}`);
    } else {
      writeFileSync(plainPath, newRaw);
      console.log(`rewrote ${sess.name} (${proj.name}) cwd -> ${newCwd} (plain)`);
    }
    rewritten++;
    remapWorkspaceJson(storeRoot, oldCwd, newCwd);
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
