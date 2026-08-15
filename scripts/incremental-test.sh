#!/bin/bash
# 正向逐增：从全新 home 逐个加入同步项，定位致卡组合
export PATH="$HOME/.dsh-desktop/node/bin:$PATH"
SRC="$HOME/.dsh-desktop/dsh-home"
TMP="$HOME/.dsh-desktop/inc-test"
BIN="$HOME/.dsh-desktop/node_modules/@deepseek-ai/dsh/lib/bin.js"
PORT=3085

rm -rf "$TMP"; mkdir -p "$TMP/home"
pkill -f 'lib/bin.js' 2>/dev/null; sleep 1

probe() {
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:$PORT 2>/dev/null)
  echo "$code"
}

add() {
  local name="$1"
  if [ -e "$SRC/$name" ]; then
    cp -r "$SRC/$name" "$TMP/home/$name" 2>/dev/null
  fi
}

# 空 home 基线
DSH_HOME="$TMP/home" setsid nohup node "$BIN" --profile web --port $PORT > /dev/null 2>&1 < /dev/null &
sleep 4
echo "  [baseline empty] -> http=$(probe)"
for p in $(pgrep -f 'lib/bin.js' | grep -v $$); do kill "$p" 2>/dev/null; done
sleep 1

for item in settings.yaml pet.json profiles sessions storages .agent-presets super-injector .anonymous-user-id .credentials.yaml.synced; do
  add "$item"
  DSH_HOME="$TMP/home" setsid nohup node "$BIN" --profile web --port $PORT > /dev/null 2>&1 < /dev/null &
  sleep 5
  echo "  [+$item] -> http=$(probe)"
  for p in $(pgrep -f 'lib/bin.js' | grep -v $$); do kill "$p" 2>/dev/null; done
  sleep 1
done
echo "=== done ==="
rm -rf "$TMP"
pkill -f 'lib/bin.js' 2>/dev/null; true
