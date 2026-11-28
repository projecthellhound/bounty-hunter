#!/usr/bin/env bash
# ══════════════════════════════════════════════════════
#  BEAST (Bounty Hunter) — Install Script (v12.8.0)
#  Run once from the project root directory.
#  After this, type `beast` from anywhere.
# ══════════════════════════════════════════════════════

set -e

# Support `curl ... | bash`. We must NOT globally `exec < /dev/tty` here:
# when bash is reading THIS script from the pipe (fd 0), reassigning fd 0
# severs bash's own source and the rest of the script is lost (that's the
# curl "(23) Failure writing output" seen on a piped install). Instead, we
# read interactive prompts explicitly from /dev/tty via $TTY below, and
# sudo already reads its password from the tty — so the pipe stays intact.
if [ -e /dev/tty ]; then
    TTY=/dev/tty
else
    TTY=/dev/stdin
fi

RED='\033[91m'
GRN='\033[92m'
CYN='\033[96m'
YLW='\033[93m'
RST='\033[0m'
BLD='\033[1m'

info()    { echo -e "${CYN}[*]${RST} $1"; }
success() { echo -e "${GRN}${BLD}[✓]${RST} $1"; }
warn()    { echo -e "${YLW}[!]${RST} $1"; }
error()   { echo -e "${RED}[✗]${RST} $1"; stop_animation; exit 1; }

# ── Animator Logic (Cinematic) ────────────────────────────────────────────────
ANIM_PID=0

start_animation() {
    local label="$1"
    stop_animation
    
    # T31: Case-Wave for Label
    # P33: Braille-Wave for Progress (Scaled to 'Ultra-Wide' 50 character bar)
    python3 -c "
import math, time, sys, shutil
label = \"$label\"
def wave(label, t):
    res = ''
    for i, c in enumerate(label):
        if not c.isalpha(): res += c; continue
        v = math.sin(t * 10 + i * 0.4)
        if v > 0: res += f'\033[91m\033[1m{c.upper()}\033[0m'
        else: res += f'\033[31m{c.lower()}\033[0m'
    return res
def braille(t, cols):
    chars = '⡀⡄⡆⡇⣇⣧⣷⣿'
    bar = ''
    prefix_len = len(label) + 4
    bar_len = max(10, cols - prefix_len - 10)
    for i in range(bar_len):
        idx = int((math.sin(t * 5 + i * 0.2) + 1) / 2 * (len(chars) - 1))
        bar += f'\033[91m{chars[idx]}\033[0m'
    return bar
start = time.time()
try:
    while True:
        cols = shutil.get_terminal_size((80, 24)).columns
        t = time.time() - start
        sys.stdout.write(f'\r  {wave(label, t)}  {braille(t, cols)} ')
        sys.stdout.flush()
        time.sleep(0.06)
except:
    pass
" &
    ANIM_PID=$!
}

stop_animation() {
    if [ "$ANIM_PID" -ne 0 ]; then
        kill -9 "$ANIM_PID" &>/dev/null || true
        wait "$ANIM_PID" 2>/dev/null || true
        # Clean the line thoroughly
        printf "\r\033[2K\r" 
        ANIM_PID=0
    fi
}

trap "stop_animation" EXIT INT TERM

echo -e "\n${RED}${BLD}  BEAST — Bounty Hunter Install${RST}\n"

# ── 0. System Prerequisites ────────────────────────────
# Install Python, Node/npm, Go, and curl before anything else.
# This is the section that was missing — fresh machines need these
# before pip, npm, or go install can run. All best-effort + explicit
# error messages so users know exactly what failed and why.
_APT_LOCKED() {
    pgrep -x apt >/dev/null 2>&1 || pgrep -x apt-get >/dev/null 2>&1 || \
    pgrep -x dpkg >/dev/null 2>&1 || pgrep -x unattended-upgr >/dev/null 2>&1
}

_HAS_SUDO() { command -v sudo &>/dev/null && { [ "$EUID" -eq 0 ] || sudo -n true 2>/dev/null; }; }

_apt_install() {
    # Install one or more apt packages, skip gracefully if apt is locked or unavailable.
    if ! command -v apt-get &>/dev/null; then return 1; fi
    if _APT_LOCKED; then
        warn "apt is locked by another process — skipping: $*"
        warn "Re-run install.sh after the other package manager finishes."
        return 1
    fi
    if _HAS_SUDO && [ "$EUID" -ne 0 ]; then
        sudo apt-get install -y -q "$@" 2>&1 | grep -v "^Reading\|^Building\|^Setting" || true
    else
        apt-get install -y -q "$@" 2>&1 | grep -v "^Reading\|^Building\|^Setting" || true
    fi
}

info "Checking system prerequisites…"

# ── Python 3.10+ ──────────────────────────────────────
PYTHON_OK=false
for py in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$py" &>/dev/null; then
        VER="$("$py" -c 'import sys; print(sys.version_info[:2])'  2>/dev/null)"
        if "$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
            PYTHON_OK=true
            # Ensure `python3` resolves to this binary
            if ! command -v python3 &>/dev/null; then
                ln -sf "$(command -v "$py")" "$HOME/.local/bin/python3" 2>/dev/null || true
            fi
            break
        fi
    fi
done
if ! $PYTHON_OK; then
    info "Python 3.10+ not found — installing…"
    if [ -f /etc/debian_version ]; then
        _apt_install python3 python3-pip python3-venv python3-dev || true
    elif command -v brew &>/dev/null; then
        brew install python@3.12 &>/dev/null || true
    elif command -v dnf &>/dev/null; then
        dnf install -y python3 python3-pip &>/dev/null || true
    elif command -v pacman &>/dev/null; then
        pacman -Sy --noconfirm python python-pip &>/dev/null || true
    fi
    if ! command -v python3 &>/dev/null; then
        error "Python 3.10+ is required but could not be installed automatically.
  On Debian/Kali/Ubuntu:  sudo apt install python3 python3-venv python3-pip
  On macOS:               brew install python@3.12
  On Fedora/RHEL:         sudo dnf install python3
  On Arch:                sudo pacman -S python
Then re-run: ./install.sh"
    fi
fi
success "Python ready: $(python3 --version 2>&1)"

# Ensure python3-venv is installed (Debian splits it into a separate package)
if [ -f /etc/debian_version ] && ! python3 -m venv --help &>/dev/null 2>&1; then
    info "Installing python3-venv…"
    _apt_install python3-venv python3-dev || true
fi

# ── Node.js / npm (needed for beast --gui brain tab) ──
if ! command -v node &>/dev/null || ! command -v npm &>/dev/null; then
    info "Node.js / npm not found — installing…"
    if [ -f /etc/debian_version ]; then
        # Use NodeSource for a modern LTS (Debian repos often ship an ancient Node)
        if command -v curl &>/dev/null; then
            curl -fsSL https://deb.nodesource.com/setup_lts.x 2>/dev/null | \
                { _HAS_SUDO && sudo bash || bash; } &>/dev/null || true
        fi
        _apt_install nodejs || true
    elif command -v brew &>/dev/null; then
        brew install node &>/dev/null || true
    elif command -v dnf &>/dev/null; then
        dnf install -y nodejs npm &>/dev/null || true
    elif command -v pacman &>/dev/null; then
        pacman -Sy --noconfirm nodejs npm &>/dev/null || true
    fi
    if command -v node &>/dev/null; then
        success "Node.js ready: $(node --version)"
    else
        warn "Node.js not installed — the Brain tab in 'beast --gui' won't be available.
  Install Node.js (https://nodejs.org/en/download) then re-run: ./install.sh"
    fi
else
    success "Node.js ready: $(node --version)"
fi

# ── Go (needed for the entire recon arsenal) ───────────
if ! command -v go &>/dev/null; then
    info "Go not found — installing…"
    if [ -f /etc/debian_version ]; then
        _apt_install golang-go || true
    elif command -v brew &>/dev/null; then
        brew install go &>/dev/null || true
    elif command -v dnf &>/dev/null; then
        dnf install -y golang &>/dev/null || true
    elif command -v pacman &>/dev/null; then
        pacman -Sy --noconfirm go &>/dev/null || true
    fi
    # If apt's Go is too old (< 1.21), try downloading the official binary
    if ! command -v go &>/dev/null || ! go version 2>/dev/null | grep -qE 'go1\.(2[1-9]|[3-9][0-9])'; then
        info "Fetching official Go binary (repo version may be outdated)…"
        ARCH="$(uname -m)"
        case "$ARCH" in x86_64) GOARCH="amd64" ;; aarch64|arm64) GOARCH="arm64" ;; *) GOARCH="" ;; esac
        if [ -n "$GOARCH" ] && command -v curl &>/dev/null; then
            GO_VER="$(curl -fsSL 'https://go.dev/VERSION?m=text' 2>/dev/null | head -1 || echo 'go1.22.5')"
            TMP_GO="$(mktemp -d)"
            if curl -fsSL "https://go.dev/dl/${GO_VER}.linux-${GOARCH}.tar.gz" -o "$TMP_GO/go.tar.gz" 2>/dev/null; then
                rm -rf /usr/local/go 2>/dev/null || true
                if _HAS_SUDO; then sudo tar -C /usr/local -xzf "$TMP_GO/go.tar.gz" &>/dev/null
                else tar -C "$HOME" -xzf "$TMP_GO/go.tar.gz" &>/dev/null && mv "$HOME/go" "$HOME/.go-sdk"; fi
                rm -rf "$TMP_GO"
                export PATH="/usr/local/go/bin:$HOME/.go-sdk/bin:$PATH"
            else
                rm -rf "$TMP_GO"
            fi
        fi
    fi
    if command -v go &>/dev/null; then
        success "Go ready: $(go version)"
    else
        warn "Go not installed — the recon arsenal (subfinder, httpx, nuclei, etc.) won't be available.
  Install Go from https://go.dev/dl/ then re-run: ./install.sh"
    fi
else
    success "Go ready: $(go version)"
fi

# ── curl (used throughout install) ────────────────────
if ! command -v curl &>/dev/null; then
    info "curl not found — installing…"
    if [ -f /etc/debian_version ]; then _apt_install curl || true
    elif command -v brew &>/dev/null; then brew install curl &>/dev/null || true
    elif command -v dnf &>/dev/null; then dnf install -y curl &>/dev/null || true
    fi
    command -v curl &>/dev/null && success "curl ready" || warn "curl unavailable — some downloads may fail"
fi

# ── git (needed for repo bootstrap) ───────────────────
if ! command -v git &>/dev/null; then
    info "git not found — installing…"
    if [ -f /etc/debian_version ]; then _apt_install git || true
    elif command -v brew &>/dev/null; then brew install git &>/dev/null || true
    elif command -v dnf &>/dev/null; then dnf install -y git &>/dev/null || true
    fi
fi

echo ""

# ── 1. Preparation & Remote Bootstrap ─────────────────
if [ ! -f "setup.py" ]; then
    info "setup.py not found in current directory. Bootstrapping Bounty Hunter repository..."
    INSTALL_TARGET="$HOME/.hellhound-src"
    if [ -d "$INSTALL_TARGET/.git" ]; then
        info "Updating existing repository at $INSTALL_TARGET..."
        git -C "$INSTALL_TARGET" pull --quiet origin main || true
    else
        info "Cloning Bounty Hunter into $INSTALL_TARGET..."
        git clone --depth 1 https://github.com/projecthellhound/bounty-hunter.git "$INSTALL_TARGET" || error "Failed to clone repository. Ensure git is installed and network connectivity is active."
    fi
    cd "$INSTALL_TARGET" || error "Could not enter $INSTALL_TARGET"
fi

PROJECT_ROOT="$(pwd)"
VENV_DIR="$HOME/.beast-env"

# Detect shell rc file
if [ "$(basename "$SHELL")" = "zsh" ]; then
    SHELL_RC="$HOME/.zshrc"
elif [ "$(basename "$SHELL")" = "bash" ]; then
    SHELL_RC="$HOME/.bashrc"
else
    SHELL_RC="$HOME/.profile"
fi

# ── 2. Virtual Environment ────────────────────────────
start_animation "ISOLATING CORE"
python3 -m venv --clear "$VENV_DIR" 2>/dev/null || { rm -rf "$VENV_DIR" && python3 -m venv "$VENV_DIR"; } || error "Failed to create virtual environment."
stop_animation
success "Virtual environment ready at $VENV_DIR"

# ── 3. Core Engine ────────────────────────────────────
# pip's default read-timeout is 15s -- plenty on a fast campus/office
# connection, nowhere near enough on a slow/congested one (mobile
# hotspot, shared hostel wifi, a VPS with throttled egress), where a
# single slow chunk from pypi.org trips "ReadTimeoutError" mid-download
# and, since install.sh runs under `set -e`, kills the WHOLE install
# with a bare pip traceback instead of a clear Hellhound-style error.
# --timeout 100 --retries 5 gives a slow connection room to actually
# finish instead of just failing faster and more often; wrapped in an
# explicit retry loop of its own so a single dropped connection doesn't
# still take the whole install down with it.
PIP_NET_ARGS=(--timeout 100 --retries 5)

_pip_install_with_retry() {
    # Up to 3 attempts, short backoff between them -- transient network
    # blips (not a real missing-package error) are exactly what this is
    # for; a genuinely broken install (bad package name, syntax error in
    # setup.py) will fail identically on every attempt and still surface
    # pip's real error message on the final one.
    local attempt rc tmp
    for attempt in 1 2 3; do
        tmp="$(mktemp)"
        "$VENV_DIR/bin/pip" install --quiet "${PIP_NET_ARGS[@]}" "$@" >"$tmp" 2>&1
        rc=$?
        # setuptools prints a benign "BuildBackendWarning: Editable installation
        # / Please be careful with folders…" block for every `pip install -e .`
        # of a flat-layout package. It alarms new users for no reason (the
        # install is fine), so drop just that block — real errors still show.
        grep -vE 'BuildBackendWarning|Please be careful with folders|name as your package|take precedence during imports|with strategy, WheelFile|editable_wheel\.py:[0-9]+|^[[:space:]]*!![[:space:]]*$|^[[:space:]]*\*{10,}[[:space:]]*$' "$tmp" \
            | grep -vE '^[[:space:]]*$' || true
        rm -f "$tmp"
        [ "$rc" -eq 0 ] && return 0
        if [ "$attempt" -lt 3 ]; then
            warn "pip install attempt $attempt/3 failed (likely a slow/unstable connection) — retrying in 5s..."
            sleep 5
        fi
    done
    return 1
}

start_animation "DECRYPTING DEPENDENCIES"
_pip_install_with_retry --upgrade pip || warn "Could not upgrade pip itself after 3 attempts — continuing with whatever pip version is already in the venv."
# Clean any stale editable artifacts or old version metadata to avoid site-packages loader conflicts
rm -rf "$VENV_DIR"/lib/python*/site-packages/__editable__* 2>/dev/null || true
rm -rf "$VENV_DIR"/lib/python*/site-packages/hellhound*.dist-info 2>/dev/null || true
"$VENV_DIR/bin/pip" uninstall -y hellhound --quiet 2>/dev/null || true
if ! _pip_install_with_retry -e "$PROJECT_ROOT"; then
    stop_animation
    error "Could not install Beast's core dependencies after 3 attempts, even with an extended network timeout. This usually means the connection to pypi.org is too unstable/slow — check your network and re-run ./install.sh, or run \`/update deps\` once Beast is running."
fi
stop_animation
success "Beast core engine installed"
info "Interactive Textual TUI ready — run 'beast' or 'beast --classic' for the console."

# ── GUI extras (beast --gui native desktop window) ─────
info "Installing GUI backend dependencies (FastAPI + pywebview)..."
if _pip_install_with_retry -e "$PROJECT_ROOT[gui]"; then
    success "GUI backend ready"
    # The GUI ships with a prebuilt frontend (beast_gui/frontend/dist), so
    # 'beast --gui' works out of the box with no Node/npm. If Node/npm is
    # present we refresh it from source so local edits are picked up.
    FRONTEND_DIR="$PROJECT_ROOT/beast_gui/frontend"
    if [ -f "$FRONTEND_DIR/package.json" ] && command -v npm &>/dev/null; then
        info "Refreshing GUI frontend from source…"
        if (cd "$FRONTEND_DIR" && npm install --silent 2>/dev/null && npm run build --silent 2>/dev/null); then
            success "GUI frontend built — 'beast --gui' launches the native desktop window"
        else
            warn "Frontend rebuild failed — the prebuilt GUI still works. To rebuild: cd beast_gui/frontend && npm install && npm run build"
        fi
    elif [ -f "$FRONTEND_DIR/dist/index.html" ]; then
        success "GUI frontend ready (prebuilt) — 'beast --gui' works without Node/npm"
    else
        warn "No prebuilt GUI found and npm is missing. To build it: cd beast_gui/frontend && npm install && npm run build"
    fi

    # The Brain tab is a Next app (beast_gui/brain) that runs locally on :3220.
    # It needs its own node deps installed once; without them the Brain tab just
    # shows an "offline" banner (the rest of the GUI is unaffected).
    BRAIN_DIR="$PROJECT_ROOT/beast_gui/brain"
    if [ -f "$BRAIN_DIR/package.json" ]; then
        if command -v npm &>/dev/null; then
            # The Brain declares "packageManager": "pnpm@..." — use npx to auto-
            # download the right pnpm version without requiring a global install.
            # Install deps (once) then build, so the GUI serves the Brain with
            # `next start` — it binds in ~1s, vs a slow `next dev` first-compile
            # that makes the Brain tab look stuck on first open.
            if [ ! -x "$BRAIN_DIR/node_modules/.bin/next" ]; then
                info "Installing Brain dependencies (one-time, ~a minute)…"
                (cd "$BRAIN_DIR" && npx --yes pnpm install --frozen-lockfile 2>/dev/null) \
                    || (cd "$BRAIN_DIR" && npx --yes pnpm install 2>/dev/null) \
                    || warn "Brain deps didn't install — Brain tab offline until: cd beast_gui/brain && npx pnpm install && npx pnpm run build"
            fi
            if [ -x "$BRAIN_DIR/node_modules/.bin/next" ]; then
                if [ -f "$BRAIN_DIR/.next/BUILD_ID" ]; then
                    success "Brain ready (knowledge graph in 'beast --gui' → Brain tab)"
                else
                    info "Building the Brain (one-time)…"
                    if (cd "$BRAIN_DIR" && npx --yes pnpm run build >/dev/null 2>&1); then
                        success "Brain ready (knowledge graph in 'beast --gui' → Brain tab)"
                    else
                        warn "Brain build didn't finish — it still runs in dev mode (slower first open)."
                    fi
                fi
            fi
        else
            warn "Node/npm missing — the GUI works, but its Brain tab needs: cd beast_gui/brain && npx pnpm install && npx pnpm run build"
        fi
    fi
else
    warn "GUI deps could not be installed — 'beast' (TUI) and 'beast --classic' still work."
fi

stop_animation
info "Mounting SPA Engine..."

if [ -f /etc/debian_version ] || grep -q "Kali" /etc/os-release 2>/dev/null; then
    info "Debian/Kali detected — applying dependency patches..."
    # Fix for Kali's t64 transition and missing Ubuntu font packages
    DUMMY_DIR=$(mktemp -d)
    
    # 1. Dummy ttf-unifont -> fonts-unifont
    mkdir -p "$DUMMY_DIR/ttf-unifont/DEBIAN"
    cat <<EOF > "$DUMMY_DIR/ttf-unifont/DEBIAN/control"
Package: ttf-unifont
Version: 1:99.0
Section: fonts
Priority: optional
Architecture: all
Depends: fonts-unifont
Description: Dummy package for ttf-unifont
EOF
    dpkg-deb --build "$DUMMY_DIR/ttf-unifont" "$DUMMY_DIR/ttf-unifont.deb" &>/dev/null
    
    # 2. Dummy libasound2 -> libasound2t64
    mkdir -p "$DUMMY_DIR/libasound2/DEBIAN"
    cat <<EOF > "$DUMMY_DIR/libasound2/DEBIAN/control"
Package: libasound2
Version: 1:99.0
Section: libs
Priority: optional
Architecture: all
Depends: libasound2t64
Description: Dummy package for libasound2
EOF
    dpkg-deb --build "$DUMMY_DIR/libasound2" "$DUMMY_DIR/libasound2.deb" &>/dev/null

    # 3. Dummy ttf-ubuntu-font-family -> fonts-liberation
    mkdir -p "$DUMMY_DIR/ttf-ubuntu-font-family/DEBIAN"
    cat <<EOF > "$DUMMY_DIR/ttf-ubuntu-font-family/DEBIAN/control"
Package: ttf-ubuntu-font-family
Version: 1:99.0
Section: fonts
Priority: optional
Architecture: all
Depends: fonts-liberation
Description: Dummy package for ttf-ubuntu-font-family
EOF
    dpkg-deb --build "$DUMMY_DIR/ttf-ubuntu-font-family" "$DUMMY_DIR/ttf-ubuntu-font-family.deb" &>/dev/null
    
    if command -v sudo &>/dev/null; then
        sudo dpkg -i "$DUMMY_DIR/ttf-unifont.deb" "$DUMMY_DIR/libasound2.deb" "$DUMMY_DIR/ttf-ubuntu-font-family.deb" &>/dev/null || true
    else
        dpkg -i "$DUMMY_DIR/ttf-unifont.deb" "$DUMMY_DIR/libasound2.deb" "$DUMMY_DIR/ttf-ubuntu-font-family.deb" &>/dev/null || true
    fi
    rm -rf "$DUMMY_DIR"
fi

# Suppress redundant 'BEWARE' warnings on Kali to keep output clean
info "Fetching Chromium (this may take a minute)..."
"$VENV_DIR/bin/python" -m playwright install chromium 2>&1 | grep --line-buffered -vE "BEWARE|fallback" || true

# playwright install-deps shells out to `apt`. If another package manager is
# running (a common cause of the raw "Could not get lock … exit code: 100"
# error new users hit), detect it and skip cleanly instead of dumping apt's
# error — the headless browser usually still works, and this is re-runnable.
info "Hardening system dependencies..."
_PW_DEPS_HINT="$VENV_DIR/bin/python -m playwright install-deps chromium"
if pgrep -x apt >/dev/null 2>&1 || pgrep -x apt-get >/dev/null 2>&1 || pgrep -x dpkg >/dev/null 2>&1 || pgrep -x unattended-upgr >/dev/null 2>&1; then
    warn "Another package manager (apt/dpkg) is running — skipping browser system libs for now. When it finishes, run:  sudo $_PW_DEPS_HINT"
else
    if command -v sudo &>/dev/null && [ "$EUID" -ne 0 ]; then
        sudo "$VENV_DIR/bin/python" -m playwright install-deps chromium >/dev/null 2>&1 \
            || warn "Couldn't install browser system libs via apt. The headless browser may still work; if it doesn't, run:  sudo $_PW_DEPS_HINT"
    else
        "$VENV_DIR/bin/python" -m playwright install-deps chromium >/dev/null 2>&1 \
            || warn "Couldn't install browser system libs via apt. If the headless browser fails later, run:  $_PW_DEPS_HINT"
    fi
fi
success "SPA Engine mounted successfully"

# ── 4b. Offensive Visual Recon Engine (Gowitness) ──────
if command -v gowitness &>/dev/null || [ -x "$HOME/go/bin/gowitness" ] || [ -x "/usr/bin/gowitness" ] || [ -x "/usr/local/bin/gowitness" ]; then
    success "Gowitness screenshot engine verified"
else
    info "Installing Gowitness screenshot utility..."
    if command -v go &>/dev/null; then
        go install github.com/sensepost/gowitness@latest &>/dev/null && success "Gowitness installed via Go" || warn "Could not install gowitness via Go. Run: go install github.com/sensepost/gowitness@latest"
    else
        ARCH="$(uname -m)"
        case "$ARCH" in
            x86_64) GW_ARCH="amd64" ;;
            aarch64|arm64) GW_ARCH="arm64" ;;
            *) GW_ARCH="" ;;
        esac
        if [ -n "$GW_ARCH" ] && [ "$(uname -s)" = "Linux" ]; then
            TMP_GW="$(mktemp -d)"
            if curl -fsSL "https://github.com/sensepost/gowitness/releases/latest/download/gowitness-linux-${GW_ARCH}" -o "$TMP_GW/gowitness" 2>/dev/null; then
                chmod +x "$TMP_GW/gowitness"
                mkdir -p "$HOME/.local/bin"
                mv "$TMP_GW/gowitness" "$HOME/.local/bin/gowitness"
                rm -rf "$TMP_GW"
                success "Gowitness installed to ~/.local/bin/gowitness"
            else
                rm -rf "$TMP_GW"
                warn "Gowitness not installed. Install via: go install github.com/sensepost/gowitness@latest"
            fi
        else
            warn "Gowitness not installed. Install via: go install github.com/sensepost/gowitness@latest"
        fi
    fi
fi

# ── 4c. Recon Arsenal (ProjectDiscovery suite + fuzzers) ──
# The agent drives external recon binaries — subfinder, httpx, naabu, nuclei,
# dnsx, katana, ffuf, gau. It degrades gracefully when one is missing, but a
# fresh machine should have the core set. All best-effort; never fatal.
info "Installing the recon arsenal (subfinder, httpx, naabu, nuclei, dnsx, katana, ffuf)…"

# Go drives both pdtm (the ProjectDiscovery tool manager) and the fuzzers.
if ! command -v go &>/dev/null; then
    if [ -f /etc/debian_version ] && command -v apt-get &>/dev/null && command -v sudo &>/dev/null \
       && ! { pgrep -x apt >/dev/null 2>&1 || pgrep -x apt-get >/dev/null 2>&1 || pgrep -x dpkg >/dev/null 2>&1; }; then
        sudo apt-get install -y -q golang-go &>/dev/null || true
    fi
fi

if command -v go &>/dev/null; then
    GO_BIN="$(go env GOPATH 2>/dev/null)/bin"
    # pdtm installs/updates the whole ProjectDiscovery suite in one shot.
    if ! command -v pdtm &>/dev/null && [ ! -x "$GO_BIN/pdtm" ]; then
        go install -v github.com/projectdiscovery/pdtm/cmd/pdtm@latest &>/dev/null || true
    fi
    PDTM="$(command -v pdtm 2>/dev/null || echo "$GO_BIN/pdtm")"
    if [ -x "$PDTM" ]; then
        "$PDTM" -ia -nc &>/dev/null || warn "pdtm couldn't install every tool — re-run later: pdtm -ia"
    fi
    # Fuzzer + URL miner that aren't part of pdtm.
    go install github.com/ffuf/ffuf/v2@latest &>/dev/null || true
    go install github.com/lc/gau/v2/cmd/gau@latest &>/dev/null || true
    # Keep nuclei's templates current (first run also self-updates).
    if command -v nuclei &>/dev/null || [ -x "$HOME/.pdtm/go/bin/nuclei" ]; then
        ("$(command -v nuclei 2>/dev/null || echo "$HOME/.pdtm/go/bin/nuclei")" -update-templates -silent &>/dev/null || true) &
    fi
    success "Recon arsenal installed (ProjectDiscovery suite + ffuf, gau)"
else
    warn "Go not found — skipping the recon arsenal. Install Go, then: go install github.com/projectdiscovery/pdtm/cmd/pdtm@latest && pdtm -ia"
fi

# feroxbuster / amass / massdns ship in the Debian/Kali repos.
if [ -f /etc/debian_version ] && command -v apt-get &>/dev/null && command -v sudo &>/dev/null \
   && ! { pgrep -x apt >/dev/null 2>&1 || pgrep -x apt-get >/dev/null 2>&1 || pgrep -x dpkg >/dev/null 2>&1; }; then
    sudo apt-get install -y -q feroxbuster amass massdns &>/dev/null || true
fi

# Make the go-installed tools reachable from new shells.
for _bindir in "$(command -v go &>/dev/null && echo "$(go env GOPATH 2>/dev/null)/bin")" "$HOME/.pdtm/go/bin" "$HOME/go/bin" "$HOME/.local/bin"; do
    [ -n "$_bindir" ] || continue
    if ! grep -qF "$_bindir" "$SHELL_RC" 2>/dev/null; then
        echo "export PATH=\"$_bindir:\$PATH\"" >> "$SHELL_RC"
    fi
done

# ── 5. System Integration ──────────────────────────────
start_animation "FINALIZING INTEGRATION"

# Alias integration — `beast` is the command; keep a `hellhound` alias for
# back-compat so existing muscle memory / scripts still work.
ALIAS_LINE="alias beast='$VENV_DIR/bin/beast'"
if grep -qF "alias beast=" "$SHELL_RC" 2>/dev/null; then
    sed -i "s|alias beast=.*|$ALIAS_LINE|" "$SHELL_RC"
else
    echo "" >> "$SHELL_RC"
    echo "# BEAST (Project Hellhound — Bounty Hunter)" >> "$SHELL_RC"
    echo "$ALIAS_LINE" >> "$SHELL_RC"
fi
# Back-compat alias (old name)
HH_ALIAS_LINE="alias hellhound='$VENV_DIR/bin/beast'"
if grep -qF "alias hellhound=" "$SHELL_RC" 2>/dev/null; then
    sed -i "s|alias hellhound=.*|$HH_ALIAS_LINE|" "$SHELL_RC"
else
    echo "$HH_ALIAS_LINE" >> "$SHELL_RC"
fi

# Local bin symlink (beast primary + hellhound back-compat)
mkdir -p "$HOME/.local/bin"
ln -sf "$VENV_DIR/bin/beast" "$HOME/.local/bin/beast"
ln -sf "$VENV_DIR/bin/beast" "$HOME/.local/bin/hellhound"

# Global bin symlink (if sudo available)
if [ "$EUID" -eq 0 ]; then
    ln -sf "$VENV_DIR/bin/beast" "/usr/local/bin/beast"
    ln -sf "$VENV_DIR/bin/beast" "/usr/local/bin/hellhound"
elif sudo -n true 2>/dev/null; then
    sudo ln -sf "$VENV_DIR/bin/beast" "/usr/local/bin/beast" 2>/dev/null || true
    sudo ln -sf "$VENV_DIR/bin/beast" "/usr/local/bin/hellhound" 2>/dev/null || true
fi

chmod +x "$PROJECT_ROOT/update.sh"
chmod +x "$PROJECT_ROOT/install.sh"

stop_animation
success "System integration complete"

# ── 6. Ollama + Local Model Setup ─────────────────────
# HELLHOUND can use a local model (via Ollama) or a cloud provider (NVIDIA NIM, OpenAI, etc.).
# Skip with: SKIP_OLLAMA=1 ./install.sh

OLLAMA_MODEL=""
if [ "${SKIP_OLLAMA:-0}" = "1" ]; then
    warn "Skipping Ollama install (SKIP_OLLAMA=1)"
else
    echo ""
    info "Beast can use a local model (via Ollama) or a cloud provider (OpenAI, Anthropic, NVIDIA NIM, etc.)."
    read -p "$(echo -e "${CYN}[?]${RST} Set up a local model now? [Y/n]: ")" -r PROMPT_REPLY < "$TTY" || PROMPT_REPLY=""

    if [[ "$PROMPT_REPLY" =~ ^[Nn]$ ]]; then
        info "Skipping local model setup — configure a cloud provider via /model after first launch."
    else
        echo -e "${CYN}[?]${RST} Which local model?"
        echo "  1) qwen2.5:3b-instruct   (recommended — fast, ~2GB, good tool-calling reliability)"
        echo "  2) gemma2:2b             (smaller, ~1.6GB)"
        echo "  3) custom (enter Ollama model name)"
        read -p "Choice [1]: " MODEL_CHOICE < "$TTY" || MODEL_CHOICE=""
        case "$MODEL_CHOICE" in
            2) OLLAMA_MODEL="gemma2:2b" ;;
            3) read -p "Ollama model name: " OLLAMA_MODEL < "$TTY" || OLLAMA_MODEL="" ;;
            *) OLLAMA_MODEL="qwen2.5:3b-instruct" ;;
        esac

        info "Setting up Local AI Engine (Ollama + $OLLAMA_MODEL)..."
        
        if command -v ollama &>/dev/null; then
            success "Ollama already installed: $(ollama --version 2>/dev/null || echo 'unknown')"
        else
            info "Installing Ollama..."
            if curl -fsSL https://ollama.com/install.sh | sh 2>&1 | tail -3; then
                success "Ollama installed successfully"
            else
                warn "Ollama install failed — you can install it manually: https://ollama.com/download"
                warn "Beast will still work with cloud API keys (/model after first launch)."
            fi
        fi

        # Pull the chosen model if Ollama is available
        if command -v ollama &>/dev/null && [ -n "$OLLAMA_MODEL" ]; then
            # Check if model is already pulled
            if ollama list 2>/dev/null | grep -q "^$OLLAMA_MODEL"; then
                success "Model $OLLAMA_MODEL already available"
            else
                info "Pulling $OLLAMA_MODEL (this may take a few minutes)..."
                start_animation "DOWNLOADING MODEL"
                if ollama pull "$OLLAMA_MODEL" 2>&1 | tail -1; then
                    stop_animation
                    success "$OLLAMA_MODEL model ready for local AI pentesting"
                else
                    stop_animation
                    warn "Failed to pull $OLLAMA_MODEL — you can pull it later: ollama pull $OLLAMA_MODEL"
                fi
            fi

            # Set orchestrator_model in ~/.beast/config.json for fast local tool routing
            mkdir -p "$HOME/.beast"
            CONFIG_FILE="$HOME/.beast/config.json"
            python3 -c "
import json, os
p = '$CONFIG_FILE'
cfg = {}
if os.path.exists(p):
    try:
        with open(p, 'r') as f:
            cfg = json.load(f)
    except: pass
cfg['ai_provider'] = cfg.get('ai_provider', 'ollama')
cfg['orchestrator_provider'] = 'ollama'
cfg['orchestrator_model'] = '$OLLAMA_MODEL'
cfg['ai_model'] = '$OLLAMA_MODEL'
with open(p, 'w') as f:
    json.dump(cfg, f, indent=2)
" 2>/dev/null || true
        fi
    fi
fi

# ── 7. Desktop Launcher (opens the CLI in a terminal) ──
echo ""
info "Registering Beast as a desktop application..."
mkdir -p "$HOME/.local/share/applications" "$HOME/.local/share/beast" "$HOME/.local/share/icons/hicolor/512x512/apps" "$HOME/.local/share/pixmaps"

# Migrate away from the old "hellhound" branding so an upgrading user doesn't
# end up with TWO menu entries (the stale HELLHOUND one + the new Beast one).
rm -f "$HOME/.local/share/applications/hellhound.desktop" \
      "$HOME/.local/bin/hellhound-launch.sh" \
      "$HOME/.local/share/icons/hellhound.png" \
      "$HOME/.local/share/pixmaps/hellhound.png" 2>/dev/null || true
rm -f /usr/local/bin/hellhound-launch.sh 2>/dev/null || true

# Ensure stable icon location (copied, not symlinked)
if [ -f "$PROJECT_ROOT/Images/logo.png" ]; then
    ICON_SRC="$PROJECT_ROOT/Images/logo.png"
else
    ICON_SRC="$PROJECT_ROOT/Images/hellhound.png"
fi
cp "$ICON_SRC" "$HOME/.local/share/beast/logo.png" 2>/dev/null || true
cp "$ICON_SRC" "$HOME/.local/share/icons/beast.png" 2>/dev/null || true
cp "$ICON_SRC" "$HOME/.local/share/pixmaps/beast.png" 2>/dev/null || true

# Generate hicolor icon hierarchy for Linux application launchers (best-effort
# — only runs if Pillow happens to be available; a missing Pillow just means
# a lower-resolution icon, never blocks the install)
"$VENV_DIR/bin/python" -c "
import os
try:
    from PIL import Image
except ImportError:
    raise SystemExit(0)
src = '$ICON_SRC'
if os.path.exists(src):
    try:
        img = Image.open(src)
        base = os.path.expanduser('~/.local/share/icons/hicolor')
        for s in [16, 24, 32, 48, 64, 128, 256, 512]:
            d = os.path.join(base, f'{s}x{s}', 'apps')
            os.makedirs(d, exist_ok=True)
            img.resize((s, s), Image.Resampling.LANCZOS).save(os.path.join(d, 'beast.png'))
        os.makedirs(os.path.join(base, 'scalable', 'apps'), exist_ok=True)
        img.save(os.path.join(base, 'scalable', 'apps', 'beast.png'))
    except Exception: pass
" 2>/dev/null || true

# Install the terminal-aware launcher wrapper alongside the `beast`
# symlink so it's resolvable by bare name from Exec=. This wrapper picks an
# explicit terminal emulator (user preference, via `beast terminal set`,
# or auto-detected) instead of relying on Terminal=true's DE-default
# handoff, which had no way to honor a user's own terminal choice (e.g.
# ghostty) and no consistent starting window size.
cp "$PROJECT_ROOT/packaging/beast-launch.sh" "$HOME/.local/bin/beast-launch.sh"
chmod +x "$HOME/.local/bin/beast-launch.sh"
if [ -w "/usr/local/bin" ] 2>/dev/null; then
    ln -sf "$HOME/.local/bin/beast-launch.sh" "/usr/local/bin/beast-launch.sh" 2>/dev/null || true
elif command -v sudo &>/dev/null; then
    sudo ln -sf "$HOME/.local/bin/beast-launch.sh" "/usr/local/bin/beast-launch.sh" 2>/dev/null || true
fi

# Install .desktop file. Exec points at the wrapper above (Terminal=false —
# the wrapper opens its own terminal window itself, so the desktop
# environment doesn't need to supply one).
cp "$PROJECT_ROOT/packaging/beast.desktop" "$HOME/.local/share/applications/beast.desktop"
chmod +x "$HOME/.local/share/applications/beast.desktop"

# Update system desktop database & GTK icon cache for app menu visibility
if command -v gtk-update-icon-cache &>/dev/null; then
    gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" &>/dev/null || true
fi
if command -v update-desktop-database &>/dev/null; then
    update-desktop-database "$HOME/.local/share/applications/" &>/dev/null || true
fi
touch "$HOME/.local/share/applications/beast.desktop"

success "Beast registered — search for it in your application menu (opens the CLI in a terminal)."

# ── 8. Done ──────────────────────────────────────────
echo ""
echo -e "  ${GRN}${BLD}Beast installed successfully.${RST}"
echo -e "  Venv    : ${CYN}$VENV_DIR${RST}"
echo -e "  Command : ${CYN}beast${RST}  (also works as: hellhound)"
if [ -n "$OLLAMA_MODEL" ] && command -v ollama &>/dev/null; then
    echo -e "  Local AI: ${CYN}Ollama ($OLLAMA_MODEL)${RST} — configured as orchestrator"
elif command -v ollama &>/dev/null; then
    echo -e "  Local AI: ${CYN}Ollama${RST} — use ${YLW}/model orchestrator ollama <model>${RST} to pick a model"
else
    echo -e "  Local AI: ${YLW}Not installed${RST} — run /model inside Beast to set a cloud provider"
fi
echo ""
echo -e "  ${YLW}Activate now (required once):${RST}"
echo -e "    source $SHELL_RC"
echo ""
echo -e "  ${CYN}Quick start:${RST}"
echo -e "    beast                  # Interactive TUI"
echo -e "    beast --classic        # Classic console"
echo -e "    beast --gui            # Desktop GUI window"
echo ""