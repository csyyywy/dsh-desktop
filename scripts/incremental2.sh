#!/bin/bash
# 干净逐增测试（cp -a 保留属性，每步验证复制成功）
export PATH="$HOME/.dsh-desktop/node/bin:$PATH"
SRC="$HOME/.dsh-desktop/dsh-home"
TMP="$HOME/.dsh-desktop/inc2"
BIN="$HOME/.dsh-desktop/node_modules/@deepseek-ai/dsh/lib/bin.js"
PORT=3086

pkill -f 'lib/bin.js' 2>/dev/null
sleep 1
rm -rf "$TMP"
mkdir -p "$TMP/home"

probe() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:$PORT 2>/dev/null
}

start_test() {
  DSH_HOME="$TMP/home" setsid nohup node "$BIN" --profile web --port $PORT > /dev/null 2>&1 < /dev/null &
  sleep 6
  echo "    -> http=$(probe)"
  for p in $(pgrep -f 'lib/bin.js' | grep -v $$); do kill "$p" 2>/dev/null; done
  sleep 1
}

echo "  [baseline empty]"
start_test

for item in settings.yaml pet.json profiles sessions storages .agent-presets super-injector .anonymous-user-id .credentials.yaml.synced; do
  if [ -e "$SRC/$item" ]; then
    cp -a "$SRC/$item" "$TMP/home/" 2>/dev/null
    echo "  [+$item] (home now has $(ls -A "$TMP/home" | wc -l) items)"
    start_test
  else
    echo "  [$item MISSING in SRC]"
  fi
done
echo "=== final home content ==="
ls -la "$TMP/home"
pkill -f 'lib/bin.js' 2>/dev/null
true
