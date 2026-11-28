# Troubleshooting & FAQ

Encountering an issue installing, updating, or running Beast? This guide covers the most common problems and their quick fixes.

---

## Quick Index
1. [Brain Tab / Node.js & pnpm Issues](#1-brain-tab--nodejs--pnpm-issues)
2. [Recon Tools & Go Version Issues](#2-recon-tools--go-version-issues)
3. [Python & Virtual Environment Issues](#3-python--virtual-environment-issues)
4. [GUI Window & Port Conflicts](#4-gui-window--port-conflicts)
5. [How to Report an Issue / Collect Diagnostics](#5-how-to-report-an-issue--collect-diagnostics)

---

## 1. Brain Tab / Node.js & pnpm Issues

The **Brain** tab in `beast --gui` runs a local Next.js knowledge graph service on `http://127.0.0.1:3220`.

### Issue: "Brain tab offline" or package.json not found
**Cause:** Older repository clones were missing `beast_gui/brain/package.json` due to an overly broad `.gitignore` pattern. This is now fixed in the latest `main` branch.

**Fix:**
Pull the latest code and re-run the brain build:
```bash
git pull origin main
cd beast_gui/brain
npx --yes pnpm install --frozen-lockfile
npx --yes pnpm run build
```

### Issue: `npm install` fails with `packageManager: pnpm` error
**Cause:** The brain uses `pnpm` for deterministic dependency resolution. Running `npm install` directly can trigger Corepack mismatch warnings or dependency drift.

**Fix:**
Use `npx pnpm` (which automatically downloads the matching pnpm runner without needing a global install):
```bash
cd beast_gui/brain
npx --yes pnpm install
npx --yes pnpm run build
```

### Issue: Node.js version is too old
Next.js 16 requires **Node.js 18.18+** or higher (Node 20+ LTS recommended). Check your version:
```bash
node -v
```
If your version is older than v18.18:
* **Debian / Ubuntu / Kali:**
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo bash -
  sudo apt install -y nodejs
  ```
* **macOS:**
  ```bash
  brew install node
  ```
* **Arch Linux:**
  ```bash
  sudo pacman -S nodejs npm
  ```

---

## 2. Recon Tools & Go Version Issues

### Issue: `go: command not found` or Go version < 1.21
The ProjectDiscovery tools (`subfinder`, `httpx`, `naabu`, `nuclei`) and `ffuf` require Go 1.21+.

**Fix:**
`install.sh` automatically fetches the official Go binary if your distro package is outdated. If you need to install Go manually:
```bash
# Download and install Go 1.22+
ARCH="$(uname -m)"
[ "$ARCH" = "x86_64" ] && GOARCH="amd64" || GOARCH="arm64"
curl -fsSL "https://go.dev/dl/go1.22.5.linux-${GOARCH}.tar.gz" -o /tmp/go.tar.gz
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf /tmp/go.tar.gz
export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"
```

### Issue: Recon tools missing after install
Inside Beast, enable automatic tool installation on demand:
```text
> /setup tools auto-install on
```
Or check tool health:
```text
> /setup
```

---

## 3. Python & Virtual Environment Issues

### Issue: `python3-venv` is missing on Debian/Ubuntu/Kali
Debian-based distros split the `venv` module into a separate package. If you see `Error: Command '['.../bin/python3', '-m', 'ensurepip', ...]' returned non-zero exit status 1`:
```bash
sudo apt update && sudo apt install -y python3-venv python3-pip python3-dev
```
Then re-run `./install.sh`.

### Issue: Corrupted virtualenv or package conflict
If Python dependencies get into an inconsistent state:
```bash
rm -rf ~/.beast-env
./install.sh
```

---

## 4. GUI Window & Port Conflicts

`beast --gui` binds two local loopback ports:
* `127.0.0.1:8790` — Beast Backend API (FastAPI)
* `127.0.0.1:3220` — Brain Knowledge Graph (Next.js)

### Issue: Port already in use (8790 or 3220)
If a previous session didn't terminate cleanly:
```bash
# Check what's listening
lsof -i :8790 -i :3220

# Kill leftover processes
kill $(lsof -t -i :8790) 2>/dev/null || true
kill $(lsof -t -i :3220) 2>/dev/null || true
```

---

## 5. How to Report an Issue / Collect Diagnostics

If you encounter an issue not covered here, please run these commands and paste the output when opening an issue or asking in the community:

```bash
echo "=== SYSTEM INFO ==="
uname -a
[ -f /etc/os-release ] && cat /etc/os-release | grep PRETTY_NAME

echo "=== ENVIRONMENT ==="
python3 --version
node -v 2>/dev/null || echo "Node: not found"
npm -v 2>/dev/null || echo "npm: not found"
go version 2>/dev/null || echo "Go: not found"

echo "=== BRAIN STATUS ==="
cd beast_gui/brain && npx pnpm -v && npx pnpm run build
```
