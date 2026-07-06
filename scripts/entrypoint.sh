#!/bin/bash
set -e

LOG() { echo -e "\033[36m[k8s-lab]\033[0m $*"; }
OK()  { echo -e "\033[32m[k8s-lab]\033[0m ✓ $*"; }
ERR() { echo -e "\033[31m[k8s-lab]\033[0m ✗ $*" >&2; }

LOG "Starting KubeKosh..."

# ── 0. Fix cgroupv2 hierarchy (Docker Desktop / Mac) ─────────────────────────
# cgroupv2 enforces the "no-internal-process constraint": a cgroup with domain
# controllers (cpu, memory, etc.) cannot have processes AND child cgroups at the
# same level. Docker Desktop places our container's processes in the root cgroup,
# making it impossible for containerd/runc to create pod sub-cgroups (k8s.io).
#
# Fix (same as k3d): move all current processes to a leaf cgroup first, then
# enable all available controllers in the root's subtree_control.
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  LOG "Configuring cgroupv2 delegation..."
  mkdir -p /sys/fs/cgroup/init
  # Move every process currently in the root cgroup into the leaf
  xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
  # Enable all available controllers for child cgroups (e.g. k8s.io, kubepods)
  sed -e 's/ / +/g' -e 's/^/+/' \
      < /sys/fs/cgroup/cgroup.controllers \
      > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
  OK "cgroupv2 delegation configured"
fi

# ── 1. Start k3s server ──────────────────────────────────────────────────────
LOG "Starting k3s (Kubernetes)..."

# k3s needs cgroupv2 or cgroupv1 mounted; --disable flags slim it down for lab use
k3s server \
  --disable=traefik \
  --disable=servicelb \
  --write-kubeconfig-mode=644 \
  --node-name=k8s-lab \
  --snapshotter=native \
  --kubelet-arg=cgroups-per-qos=false \
  --kubelet-arg=enforce-node-allocatable="" \
  &>/var/log/k3s.log &
K3S_PID=$!

# Wait for k3s API server to be ready
KUBECONFIG_PATH=/etc/rancher/k3s/k3s.yaml
for i in $(seq 1 60); do
  if [ -f "$KUBECONFIG_PATH" ] && \
     kubectl --kubeconfig="$KUBECONFIG_PATH" get nodes &>/dev/null 2>&1; then
    break
  fi
  sleep 2
  if [ $i -eq 60 ]; then
    ERR "k3s failed to start. Last log lines:"
    tail -20 /var/log/k3s.log >&2
    exit 1
  fi
done
OK "k3s API server is up"

# Symlink kubeconfig to the standard location for convenience
mkdir -p /root/.kube
cp "$KUBECONFIG_PATH" /root/.kube/config
export KUBECONFIG=/root/.kube/config

# ── 2. Wait for node to be Ready ────────────────────────────────────────────
LOG "Waiting for cluster node to become Ready..."

# Phase 1: wait until at least one node is registered
# (kubectl wait --all exits immediately with error if no resources exist yet)
# Stream k3s logs to stdout in background so failures are visible
tail -f /var/log/k3s.log &
TAIL_PID=$!

for i in $(seq 1 90); do
  NODE_COUNT=$(kubectl get nodes --no-headers 2>/dev/null | wc -l)
  if [ "$NODE_COUNT" -gt 0 ]; then
    kill $TAIL_PID 2>/dev/null || true
    break
  fi
  sleep 3
  if [ $i -eq 90 ]; then
    kill $TAIL_PID 2>/dev/null || true
    ERR "Timed out waiting for a node to register (270s)"
    ERR "k3s node status:"
    kubectl get nodes 2>&1 >&2 || true
    exit 1
  fi
done

# Phase 2: wait for the node to reach Ready condition
kubectl wait --for=condition=Ready nodes --all --timeout=120s
OK "Cluster node is Ready"

# Phase 3: on resource-constrained hosts k3s can briefly flap right after
# node Ready. Poll for 10s to confirm the API stays up.
LOG "Verifying API server stability..."
for i in $(seq 1 5); do
  sleep 2
  if ! kubectl get nodes &>/dev/null; then
    LOG "API server not yet stable (attempt $i/5), waiting..."
  fi
done
if ! kubectl get nodes &>/dev/null; then
  ERR "API server became unavailable after node Ready. Aborting."
  tail -20 /var/log/k3s.log >&2
  exit 1
fi
OK "API server is stable"

# Phase 4: wait for flannel CNI to write its subnet config.
# Pods scheduled before flannel is ready get FailedCreatePodSandBox warnings
# (missing /run/flannel/subnet.env). Waiting here avoids that noise.
for i in $(seq 1 30); do
  [ -f /run/flannel/subnet.env ] && break
  sleep 1
done


# ── 3. Install metrics-server ────────────────────────────────────────────────
# LOG "Installing metrics-server..."
# kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml &>/dev/null || true
# kubectl patch deployment metrics-server -n kube-system \
#   --type='json' \
#   -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' \
#   &>/dev/null 2>&1 || true
# OK "Metrics-server applied"

# ── 4. Shell environment ─────────────────────────────────────────────────────
LOG "Configuring shell environment..."

if [ ! -f /root/.kubekosh_initialized ]; then

# Persistent install target for OS-level addons (on the /data mount so it
# survives container restarts); put it on PATH for the interactive terminal.
mkdir -p /data/addons/bin

cat >> /root/.bashrc << 'BASHRC'

# KubeKosh aliases
export KUBECONFIG=/root/.kube/config
export PATH=/data/addons/bin:$PATH
shopt -s checkhash
alias k='kubectl'
alias kgp='kubectl get pods'
alias kga='kubectl get pods --all-namespaces'
alias kgd='kubectl get deployments'
alias kgs='kubectl get services'
alias kgn='kubectl get nodes'
alias kgns='kubectl get namespaces'
alias kdp='kubectl describe pod'
alias kaf='kubectl apply -f'
alias kdf='kubectl delete -f'
alias kg='kubectl get'
alias kd='kubectl describe'
alias krm='kubectl delete'
alias kex='kubectl exec -it'
alias klogs='kubectl logs'

# Useful functions
kns() { kubectl config set-context --current --namespace="$1"; }
kctx() { kubectl config use-context "$1"; }

# Load bash-completion framework
[ -f /usr/share/bash-completion/bash_completion ] && source /usr/share/bash-completion/bash_completion

source <(kubectl completion bash) 2>/dev/null || true
complete -F __start_kubectl k 2>/dev/null || true

PS1='\[\033[01;32m\]\u@k8s-lab\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '

echo ""
echo "  ⎈ KubeKosh - Node: k8s-lab"
KUBECTL_VER=$(kubectl version --client 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+[^ ]*' | head -1)
echo "    kubectl ${KUBECTL_VER}"
echo "    Aliases: k=kubectl, kgp=get pods, kaf=apply -f, kns=set-namespace, kgns=get namespaces, kex=kubectl exec -it"
echo "             kgd=get deployments, kgn=get nodes, kgs=get services, kdp=describe pod, krm=kubectl delete, klogs=kubectl logs"
echo ""
BASHRC

touch /root/.kubekosh_initialized

OK "Shell configured"
else
OK "Shell already configured, skipping"
fi

# ── 5. k3s watchdog — restart k3s if it crashes ─────────────────────────────
# This loop detects if k3s has crashed and restarts it, keeping the cluster available.
watchdog_k3s() {
  while true; do
    sleep 15
    if ! kill -0 "$K3S_PID" 2>/dev/null; then
      LOG "⚠ k3s process died (PID $K3S_PID), restarting..."
      k3s server \
        --disable=traefik \
        --disable=servicelb \
        --write-kubeconfig-mode=644 \
        --node-name=k8s-lab \
        --snapshotter=native \
        --kubelet-arg=cgroups-per-qos=false \
        --kubelet-arg=enforce-node-allocatable="" \
        &>>/var/log/k3s.log &
      K3S_PID=$!
      LOG "k3s restarted (new PID $K3S_PID), waiting for API..."
      for i in $(seq 1 30); do
        sleep 2
        if kubectl get nodes &>/dev/null; then
          # Re-sync the kubeconfig in case it was regenerated
          cp /etc/rancher/k3s/k3s.yaml /root/.kube/config 2>/dev/null || true
          OK "k3s recovered successfully"
          break
        fi
      done
    fi
  done
}
watchdog_k3s &
WATCHDOG_PID=$!

# ── 6. Start Node.js API server ──────────────────────────────────────────────
LOG "Starting API server..."
cd /app/backend && node server.js &>/var/log/api.log &
OK "API server started (port 4000)"

# ── 7. Browser terminal ──────────────────────────────────────────────────────
# Terminal is served via WebSocket at /shell-ws by the Node.js API server
# using node-pty — no external ttyd binary needed.


# ── 8. Start nginx reverse proxy ────────────────────────────────────────────
LOG "Starting nginx proxy..."
nginx -g 'daemon off;' &>/var/log/nginx.log &
OK "nginx started (port 80)"

# ── 8. Keep Alive & Graceful Shutdown ────────────────────────────────────────
cleanup() {
  LOG "Caught signal, shutting down KubeKosh..."
  kill -TERM "$WATCHDOG_PID" 2>/dev/null || true
  kill -TERM "$K3S_PID" 2>/dev/null || true
  kill $(jobs -p) 2>/dev/null || true
  exit 0
}

trap cleanup SIGINT SIGTERM

LOG "══════════════════════════════════════════════════"
LOG "   KubeKosh is ready!  →  http://localhost:7554   "
LOG "══════════════════════════════════════════════════"

# Wait for background jobs. When a signal is caught, wait returns instantly and triggers cleanup.
wait
