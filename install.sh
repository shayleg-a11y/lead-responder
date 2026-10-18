#!/usr/bin/env bash
# Lead Responder — one-line installer for macOS / Linux
#   curl -fsSL https://raw.githubusercontent.com/shayleg-a11y/lead-responder/main/install.sh | bash
#   ... | bash -s -- --key sk-ant-...        pre-load the activation key
#   ... | bash -s -- --no-autostart           skip the login item
set -euo pipefail

REPO_URL="${LEAD_RESPONDER_REPO:-https://github.com/shayleg-a11y/lead-responder.git}"
BRANCH="${LEAD_RESPONDER_BRANCH:-main}"
HOME_DIR="$HOME/.lead-responder"
APP_DIR="$HOME_DIR/app"
KEY=""
AUTOSTART=1
PORT=4747

while [[ $# -gt 0 ]]; do
  case "$1" in
    --key) KEY="$2"; shift 2 ;;
    --no-autostart) AUTOSTART=0; shift ;;
    --port) PORT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Lead Responder installer"
mkdir -p "$HOME_DIR"

# ---- Node 22.13+ -----------------------------------------------------------
need_node=1
if command -v node >/dev/null 2>&1; then
  v=$(node -p "process.versions.node")
  major=${v%%.*}; rest=${v#*.}; minor=${rest%%.*}
  if [[ $major -gt 22 || ( $major -eq 22 && $minor -ge 13 ) ]]; then need_node=0; fi
fi
if [[ $need_node -eq 1 ]]; then
  say "Installing Node.js (22+)"
  if [[ "$(uname)" == "Darwin" ]]; then
    if ! command -v brew >/dev/null 2>&1; then
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
    fi
    brew install node@22 >/dev/null
    brew link --overwrite --force node@22 >/dev/null || true
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
fi
NODE_BIN="$(command -v node)"
say "Node: $($NODE_BIN -v) at $NODE_BIN"

# ---- code --------------------------------------------------------------------
if [[ -d "$APP_DIR/.git" ]]; then
  say "Updating existing install"
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  git -C "$APP_DIR" reset --quiet --hard "origin/$BRANCH"
else
  say "Downloading Lead Responder"
  rm -rf "$APP_DIR"
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
say "Installing dependencies (this also downloads a private Chromium, ~150 MB)"
npm install --no-audit --no-fund --loglevel=error
say "Building"
npm run build --silent

# ---- key ---------------------------------------------------------------------
if [[ -n "$KEY" ]]; then
  node -e '
    const fs=require("fs"),p=process.argv[1];let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}
    s.anthropicApiKey=process.argv[2];fs.writeFileSync(p,JSON.stringify(s,null,2));' "$HOME_DIR/settings.json" "$KEY"
  say "Activation key saved"
fi

# ---- autostart ---------------------------------------------------------------
LOG="$HOME_DIR/app.log"
if [[ $AUTOSTART -eq 1 && "$(uname)" == "Darwin" ]]; then
  PLIST="$HOME/Library/LaunchAgents/com.leadresponder.app.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.leadresponder.app</string>
  <key>ProgramArguments</key><array>
    <string>$NODE_BIN</string><string>$APP_DIR/dist/index.js</string><string>start</string><string>--no-open</string><string>--port</string><string>$PORT</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>LEAD_RESPONDER_QUIET</key><string>1</string>
  </dict>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/com.leadresponder.app" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  launchctl kickstart -k "gui/$(id -u)/com.leadresponder.app"
  say "Installed as a login item (com.leadresponder.app)"
elif [[ $AUTOSTART -eq 1 ]]; then
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/lead-responder.service" <<EOF
[Unit]
Description=Lead Responder
[Service]
ExecStart=$NODE_BIN $APP_DIR/dist/index.js start --no-open --port $PORT
WorkingDirectory=$APP_DIR
Environment=LEAD_RESPONDER_QUIET=1
Restart=always
[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload && systemctl --user enable --now lead-responder.service
  say "Installed as a user service (lead-responder.service)"
else
  (LEAD_RESPONDER_QUIET=1 nohup "$NODE_BIN" "$APP_DIR/dist/index.js" start --no-open --port "$PORT" >>"$LOG" 2>&1 &)
fi

# ---- open the setup page -----------------------------------------------------
for i in $(seq 1 30); do
  if curl -fs "http://localhost:$PORT/api/state" >/dev/null 2>&1; then break; fi
  sleep 1
done
URL="http://localhost:$PORT"
say "Done. Setup page: $URL"
if [[ "$(uname)" == "Darwin" ]]; then open "$URL" || true; elif command -v xdg-open >/dev/null; then xdg-open "$URL" || true; fi
echo "Logs: $LOG   ·   Start over: node $APP_DIR/dist/index.js reset"
