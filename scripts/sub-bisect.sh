#!/bin/bash
# profiles 内部细分：web 文件逐个 vs node_modules
export PATH="$HOME/.dsh-desktop/node/bin:$PATH"
BIN="$HOME/.dsh-desktop/node_modules/@deepseek-ai/dsh/lib/bin.js"
SRC="$HOME/.dsh-desktop/dsh-home"
TMP="$HOME/.dsh-desktop/inc3"
PORT=3087

pkill -f 'lib/bin.js' 2>/dev/null
sleep 1
rm -rf "$TMP"
mkdir -p "$TMP/home"
cp -a "$SRC/settings.yaml" "$SRC/pet.json" "$TMP/home/" 2>/dev/null

t() {
  DSH_HOME="$TMP/home" setsid nohup node "$BIN" --profile web --port $PORT > /dev/null 2>&1 < /dev/null &
  sleep 5
  echo "  [$1] -> http=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:$PORT)"
  for p in $(pgrep -f 'lib/bin.js' | grep -v $$); do kill "$p" 2>/dev/null; done
  sleep 1
}

echo "=== A: profiles/web only (no node_modules) ==="
mkdir -p "$TMP/home/profiles"
cp -a "$SRC/profiles/web" "$TMP/home/profiles/" 2>/dev/null
t "profiles/web"

echo "=== B: only package.json ==="
rm -rf "$TMP/home/profiles"
mkdir -p "$TMP/home/profiles/web"
cp -a "$SRC/profiles/web/package.json" "$TMP/home/profiles/web/" 2>/dev/null
t "package.json"

echo "=== C: only cordis.yml ==="
rm -rf "$TMP/home/profiles"
mkdir -p "$TMP/home/profiles/web"
cp -a "$SRC/profiles/web/cordis.yml" "$TMP/home/profiles/web/" 2>/dev/null
t "cordis.yml"

echo "=== D: only cordis.patch.yml ==="
rm -rf "$TMP/home/profiles"
mkdir -p "$TMP/home/profiles/web"
cp -a "$SRC/profiles/web/cordis.patch.yml" "$TMP/home/profiles/web/" 2>/dev/null
t "cordis.patch.yml"

echo "=== E: only pnpm-workspace.yaml ==="
rm -rf "$TMP/home/profiles"
mkdir -p "$TMP/home/profiles/web"
cp -a "$SRC/profiles/web/pnpm-workspace.yaml" "$TMP/home/profiles/web/" 2>/dev/null
t "pnpm-workspace.yaml"

echo "=== F: only pnpm-lock.yaml ==="
rm -rf "$TMP/home/profiles"
mkdir -p "$TMP/home/profiles/web"
cp -a "$SRC/profiles/web/pnpm-lock.yaml" "$TMP/home/profiles/web/" 2>/dev/null
t "pnpm-lock.yaml"

echo "=== G: only node_modules (510 links) ==="
rm -rf "$TMP/home/profiles"
mkdir -p "$TMP/home/profiles"
cp -a "$SRC/profiles/node_modules" "$TMP/home/profiles/" 2>/dev/null
t "node_modules"

pkill -f 'lib/bin.js' 2>/dev/null
true
