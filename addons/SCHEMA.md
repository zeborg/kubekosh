# Add-on Manifest Schema

Each add-on lives in its own sub-directory under `addons/` and contains a single `addon.json` manifest file. The folder name **must** match the `id` field.

```
addons/
└── <addon-id>/
    └── addon.json
```

---

## Full Schema Reference

```jsonc
{
  // ── Identity ─────────────────────────────────────────────────────────────

  // [required] Unique identifier. Must match the parent folder name.
  //            Use lowercase kebab-case (e.g. "kube-prometheus-stack").
  "id": "my-addon",

  // [required] Human-readable display name shown in the catalog.
  "name": "My Addon",

  // [required] One or two sentence summary of what the tool does and why a
  //            learner would install it.
  "description": "One-sentence summary.",

  // [required] Catalog grouping. Current values in use:
  //            "Observability", "Networking", "Security & Policy",
  //            "Package Management", "Service Mesh", "Uncategorized"
  "category": "Uncategorized",

  // [optional] Emoji shown as a fallback icon when `logo` is absent or fails
  //            to load. Defaults to "📦" if omitted.
  "icon": "📦",

  // [optional] URL to an image (SVG, PNG) used as the catalog card logo.
  //            Falls back to `icon` if omitted or unreachable.
  "logo": "https://example.com/logo.svg",

  // ── Target & versioning ───────────────────────────────────────────────────

  // [required] Deployment target.
  //   "os"      — installs a CLI binary onto the terminal PATH
  //               (under /data/addons/bin, i.e. ${ADDON_BIN}).
  //   "cluster" — deploys workloads into the K3s cluster via Helm / kubectl.
  "target": "os",

  // [required] Default version string substituted as ${VERSION} in commands.
  "version": "1.0.0",

  // [optional] URL to official documentation, shown as a link in the catalog.
  "docs_url": "https://example.com/docs",

  // [required] Estimated install duration in seconds. Shown in the UI and used
  //            by the job engine to derive the per-command timeout:
  //              timeout = est_seconds × 3  (so each step gets 3× the total
  //              estimated time before it is killed and the job fails).
  //            Defaults to 60 if omitted, which is too tight for slow cluster
  //            add-ons — always set this explicitly.
  "est_seconds": 30,

  // [optional] List of supported CPU architectures. Omit to allow all.
  //            Accepted values: "amd64", "arm64"
  "arch_support": ["amd64", "arm64"],

  // [optional] Free-form string tags for search/filtering in the catalog.
  "tags": ["cli", "example"],

  // ── Dependency resolution ─────────────────────────────────────────────────

  // [optional] IDs of other add-ons that must be installed before this one.
  //            The backend resolves and installs them automatically in order.
  //            Example: ["helm", "kube-prometheus-stack"]
  "dependencies": [],

  // ── Lifecycle commands ────────────────────────────────────────────────────
  // Each entry is an object with two fields:
  //   "command" — shell command to execute (run as root inside the container).
  //   "label"   — short human-readable label streamed in the install log UI.
  //
  // Runtime substitutions available in every command string:
  //   ${VERSION}   → the value of the `version` field above
  //   ${ARCH}      → the container CPU arch ("amd64" or "arm64")
  //   ${ADDON_BIN} → /data/addons/bin  (on the terminal PATH)

  // [required] Ordered list of commands that install the add-on.
  //            For "os" add-ons: download and place binary in ${ADDON_BIN}.
  //            For "cluster" add-ons: use helm/kubectl; prefer --wait flags.
  "setup_commands": [
    {
      "command": "echo 'replace with real install commands'",
      "label": "Installing My Addon"
    }
  ],

  // [required] Ordered list of commands that completely remove the add-on.
  //            Must be idempotent — safe to run even if setup was partial
  //            (use --ignore-not-found, || true, etc.).
  "teardown_commands": [
    {
      "command": "echo 'replace with real removal commands'",
      "label": "Removing My Addon"
    }
  ],

  // [required] A single shell command that exits 0 only when the add-on is
  //            fully healthy and ready. Used to poll readiness after install
  //            and to detect drift when the catalog loads.
  //   "os" example:      "helm version --short"
  //   "cluster" example: "helm status my-addon -n my-namespace"
  "health_command": "command -v my-addon"
}
```

---

## Checklist for New Add-ons

### OS add-ons (CLI binaries)

- [ ] `target` is `"os"`
- [ ] `setup_commands` downloads the binary and places it in `${ADDON_BIN}`
- [ ] `teardown_commands` removes the binary from `${ADDON_BIN}` with `rm -f`
- [ ] `health_command` uses `command -v <binary>` or `<binary> version`
- [ ] `teardown_commands` is fully idempotent (safe even if the binary is absent)

### Cluster add-ons (Helm / kubectl workloads)

- [ ] `target` is `"cluster"`
- [ ] `dependencies` includes `"helm"` if Helm is used
- [ ] `setup_commands` is idempotent (`helm upgrade --install` or `kubectl apply`); prefer `--wait` / `rollout status`
- [ ] `teardown_commands` fully reverses setup with `--ignore-not-found` / `|| true` (idempotent)
- [ ] `health_command` verifies the workload is actually ready (e.g. `helm status <release> -n <ns>` or `kubectl rollout status deploy/... -n <ns>`)

### All add-ons

- [ ] Folder name matches `"id"` exactly
- [ ] `"id"` is lowercase kebab-case
- [ ] `"version"` is pinned (no floating tags like `latest`)
- [ ] `"arch_support"` is set if the add-on does not support both `amd64` and `arm64`
- [ ] `"est_seconds"` is a realistic estimate (run a test install to measure)
- [ ] `"description"` does not leak install instructions — describe *what*, not *how*

---

## Runtime Variable Reference

| Variable | Value | Notes |
|---|---|---|
| `${VERSION}` | value of the manifest's `version` field | Pin to a specific release tag |
| `${ARCH}` | `amd64` or `arm64` | Detected from the container at runtime |
| `${ADDON_BIN}` | `/data/addons/bin` | Persisted across restarts when `/data` is mounted |

---

## Example: OS add-on

```json
{
  "id": "kustomize",
  "name": "Kustomize",
  "description": "Template-free customization of Kubernetes YAML — manage overlays, patches, and environments without forking manifests.",
  "category": "Package Management",
  "icon": "🧱",
  "logo": "https://kustomize.io/favicons/favicon-32x32.png",
  "target": "os",
  "version": "5.8.1",
  "docs_url": "https://kustomize.io/",
  "est_seconds": 30,
  "arch_support": ["amd64", "arm64"],
  "tags": ["yaml", "overlays", "cli"],
  "dependencies": [],
  "setup_commands": [
    {
      "command": "curl -fsSL -o /tmp/kustomize-${VERSION}.tar.gz https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv${VERSION}/kustomize_v${VERSION}_linux_${ARCH}.tar.gz",
      "label": "Downloading Kustomize"
    },
    {
      "command": "tar -xzf /tmp/kustomize-${VERSION}.tar.gz -C /tmp && install -m 0755 /tmp/kustomize ${ADDON_BIN}/kustomize && rm -f /tmp/kustomize-${VERSION}.tar.gz /tmp/kustomize",
      "label": "Installing kustomize binary"
    }
  ],
  "teardown_commands": [
    {
      "command": "rm -f ${ADDON_BIN}/kustomize",
      "label": "Removing kustomize binary"
    }
  ],
  "health_command": "kustomize version"
}
```

## Example: Cluster add-on

```json
{
  "id": "kyverno",
  "name": "Kyverno",
  "description": "Kubernetes-native policy engine — validate, mutate, and generate resources with policies written as Kubernetes resources, no new language to learn.",
  "category": "Security & Policy",
  "icon": "🛡️",
  "logo": "https://raw.githubusercontent.com/cncf/artwork/master/projects/kyverno/icon/color/kyverno-icon-color.svg",
  "target": "cluster",
  "version": "1.18.1",
  "docs_url": "https://kyverno.io/docs/",
  "est_seconds": 300,
  "arch_support": ["amd64", "arm64"],
  "tags": ["policy", "security", "admission", "governance"],
  "dependencies": [],
  "setup_commands": [
    {
      "command": "kubectl apply --server-side --force-conflicts -f https://github.com/kyverno/kyverno/releases/download/v${VERSION}/install.yaml",
      "label": "Applying Kyverno manifests"
    },
    {
      "command": "set -e; for d in admission background cleanup reports; do kubectl -n kyverno rollout status deploy/kyverno-$d-controller --timeout=600s; done",
      "label": "Waiting for Kyverno to become ready"
    }
  ],
  "teardown_commands": [
    {
      "command": "kubectl delete --ignore-not-found -f https://github.com/kyverno/kyverno/releases/download/v${VERSION}/install.yaml",
      "label": "Removing Kyverno"
    }
  ],
  "health_command": "kubectl -n kyverno rollout status deploy/kyverno-admission-controller --timeout=20s"
}
```
