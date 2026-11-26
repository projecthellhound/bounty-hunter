# Bounty Hunter ("Beast") — containerized so ANY host OS (Linux, macOS, Windows)
# can run the full Linux recon/exploit toolchain without a native install.
#
#   docker build -t beast .
#   docker run --rm -it -p 8787:8787 -v beast-data:/root/.beast beast
#   # then open http://localhost:8787 in your browser
#
# The container runs the GUI backend in web mode (no desktop window — you point
# your own browser at it). All agent state lives in the mounted /root/.beast
# volume so targets, sessions, findings and config survive restarts.

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/root \
    PATH="/root/.beast-env/bin:/root/go/bin:/root/.pdtm/go/bin:/usr/local/go/bin:${PATH}"

# Base toolchain: git/curl for install, Python for the agent, Go for the
# ProjectDiscovery recon tools, Node for the Brain app, nmap for service scans.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git curl build-essential \
      python3 python3-venv python3-pip python3-dev \
      golang-go nodejs npm nmap \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/bounty-hunter
COPY . .

# Run the project's own installer: venv at /root/.beast-env, Python deps, the
# headless browser, the recon arsenal, and the Brain build. Best-effort steps
# inside it (apt browser libs, some Go tools) stay non-fatal.
RUN chmod +x install.sh && ./install.sh

# Serve the browser UI on all interfaces so the host can reach it.
ENV BEAST_GUI_HOST=0.0.0.0 \
    BEAST_GUI_PORT=8787
EXPOSE 8787

# Persist all agent state (targets, sessions, findings, keys) across runs.
VOLUME ["/root/.beast"]

ENTRYPOINT ["/root/.beast-env/bin/python", "-m", "beast_gui.backend.server"]
