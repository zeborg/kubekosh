FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV KUBECONFIG=/etc/rancher/k3s/k3s.yaml
ENV PROGRESS_FILE=/data/progress.json
# k3s writes its kubeconfig here; make kubectl pick it up automatically
ENV K3S_KUBECONFIG_MODE=644

# ── System deps ─────────────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    curl wget git vim nano jq bash bash-completion \
    ca-certificates gnupg lsb-release \
    nginx \
    iproute2 iptables iputils-ping \
    procps htop \
    mount kmod \
    tar unzip \
    python3 python3-yaml make g++ \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 20 ────────────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── k3s (bundles kubectl, containerd, everything) ────────────────────────────
# We download the binary and the airgap images so the cluster starts offline.
RUN set -eux && \
    case "$(uname -m)" in \
      x86_64)  K3S_BIN="k3s" ;; \
      aarch64) K3S_BIN="k3s-arm64" ;; \
      *) echo "Unsupported arch: $(uname -m)" && exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/k3s-io/k3s/releases/latest/download/${K3S_BIN}" \
      -o /usr/local/bin/k3s && \
    chmod +x /usr/local/bin/k3s && \
    ln -sf /usr/local/bin/k3s /usr/local/bin/kubectl && \
    ln -sf /usr/local/bin/k3s /usr/local/bin/crictl


# ── App files ─────────────────────────────────────────────────────────────────
WORKDIR /app

# Install backend dependencies
COPY backend/package.json ./backend/
RUN cd backend && npm install --production

# Build frontend
COPY frontend/package.json frontend/vite.config.js ./frontend/
RUN cd frontend && npm install

COPY frontend/ ./frontend/
# ARG is declared here so it only busts the cache for this layer
ARG VITE_APP_VERSION=dev
RUN cd frontend && VITE_APP_VERSION=${VITE_APP_VERSION} npm run build

# Copy everything else
COPY backend/  ./backend/
COPY scenarios/ ./scenarios/
COPY addons/ ./addons/
COPY scripts/entrypoint.sh /entrypoint.sh
COPY scripts/nginx.conf /etc/nginx/nginx.conf

# Strip any Windows-style \r from the entrypoint so heredocs inside it
# don't produce scripts with \r in shebang lines (causes execvp ENOENT).
RUN sed -i 's/\r//' /entrypoint.sh && chmod +x /entrypoint.sh


# ── Directories & k3s static config ─────────────────────────────────────────
RUN mkdir -p /root/.kube /data /var/log /tmp/k8s-state \
    && mkdir -p /var/log/nginx \
    && mkdir -p /etc/rancher/k3s \
    && mkdir -p /var/lib/rancher/k3s

# Tell k3s to use the native snapshotter.
# We rely on k3s to generate its full default containerd config.toml
# (which includes CNI paths, runtimes, etc.) and only override the snapshotter.
# Do NOT place a custom config.toml.tmpl here — a minimal template breaks
# node registration by omitting the CNI and internal-opt sections.
RUN printf 'snapshotter: "native"\nwrite-kubeconfig-mode: "644"\n' \
    > /etc/rancher/k3s/config.yaml

# ── Expose ────────────────────────────────────────────────────────────────────
# Single port - nginx proxies everything
EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]