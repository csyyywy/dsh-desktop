#!/bin/bash
# 二分定位：哪个同步项导致 dsh 启动卡死
export PATH="$HOME/.dsh-desktop/node/bin:$PATH"
HOME_DIR="$HOME/.dsh-desktop/dsh-home"
TMP="$HOME/.dsh-desktop/bisect"
BIN="$HOME/.dsh-desktop/node_modules/@deepseek-ai/dsh/lib/bin.js"

mkdir -p "$TMP"

test_item() {
  local item="$1"
  # 移走全部顶层项，只保留 item
  for e in "$HOME_DIR"/* "$HOME_DIR"/.[!.]*; do
    [ -e "$e" ] || continue
    local base
    base=$(basename "$e")
    [ "$base" = "$item" ] && continue
    mv "$e" "$TMP/$base" 2>/dev/null
  done
  # 启动
  DSH_HOME="$HOME_DIR" setsid nohup node "$BIN" --profile web --port 3081 > /dev/null 2>&1 < /dev/null &
  sleep 5
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3081 2>/dev/null)
  echo "  [$item] -> http=$code"
  # 清理
  for p in $(pgrep -f 'lib/bin.js' | grep -v $$); do kill "$p" 2>/dev/null; done
  sleep 1
  for e in "$TMP"/* "$TMP"/.[!.]*; do
    [ -e "$e" ] && mv "$e" "$HOME_DIR/" 2>/dev/null
  done
}

echo "=== bisect ==="
test_item "sessions"
test_item ".agent-presets"
test_item "profiles"
test_item "settings.yaml"
test_item "super-injector"
test_item "storages"
test_item "pet.json"
test_item ".credentials.yaml"
echo "=== done ==="
ls "$HOME_DIR" | head -15
