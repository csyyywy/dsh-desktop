#!/bin/bash
# 尝试不同 package.json 内容，找 dsh 可接受的最小形态
export PATH="$HOME/.dsh-desktop/node/bin:$PATH"
BIN="$HOME/.dsh-desktop/node_modules/@deepseek-ai/dsh/lib/bin.js"
SRC="$HOME/.dsh-desktop/dsh-home"
TMP="$HOME/.dsh-desktop/inc4"
PORT=3088

pkill -f 'lib/bin.js' 2>/dev/null
sleep 1
rm -rf "$TMP"
mkdir -p "$TMP/home/profiles/web"
cp -a "$SRC/settings.yaml" "$SRC/pet.json" "$TMP/home/" 2>/dev/null

t() {
  DSH_HOME="$TMP/home" setsid nohup node "$BIN" --profile web --port $PORT > /dev/null 2>&1 < /dev/null &
  sleep 5
  echo "  [$1] -> http=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:$PORT)"
  for p in $(pgrep -f 'lib/bin.js' | grep -v $$); do kill "$p" 2>/dev/null; done
  sleep 1
}

echo '{}' > "$TMP/home/profiles/web/package.json"
t "empty object {}"

echo '{"name":"web"}' > "$TMP/home/profiles/web/package.json"
t "only name"

echo '{"name":"web","private":true,"dependencies":{}}' > "$TMP/home/profiles/web/package.json"
t "name+private+deps{}"

echo '{"name":"web","private":true}' > "$TMP/home/profiles/web/package.json"
t "name+private (current pure)"

# 完整版（syncbak）：预期崩溃（明确报错）而非卡
cp -a "$SRC/profiles/web/package.json.syncbak" "$TMP/home/profiles/web/package.json" 2>/dev/null
t "full syncbak version"

pkill -f 'lib/bin.js' 2>/dev/null
true
