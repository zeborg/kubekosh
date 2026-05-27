# KubeKosh Configuration Schema Reference

KubeKosh uses two primary JSON files to define its curriculum, learning paths, and exam configurations:
1. **Bundles (`scenarios/bundles.json`)**: Defines the high-level study bundles (e.g., CKA, CKAD, CKS), active highlights, durations for exams, and lists of included scenarios.
2. **Scenarios (`scenarios/scenarios.json`)**: Defines individual exercises, hands-on tasks, multiple-choice questions (MCQs), environment preparations, and automated validation scripts.

---

## 1. Bundles Schema (`scenarios/bundles.json`)

Bundles are defined as a JSON array of objects. Each bundle organizes a learning track or mock exam.

### Schema Fields
* **`id`** *(string, required)*: A unique, kebab-case identifier for the bundle (e.g., `k8s-basics`).
* **`name`** *(string, required)*: The human-readable name of the bundle shown in navigation (e.g., `Kubernetes Basics`).
* **`icon`** *(string, required)*: An emoji or glyph representing the bundle (e.g., `🌱`).
* **`tagline`** *(string, required)*: A short summary of the bundle's objectives.
* **`color`** *(string, required)*: Hex color code representing the bundle's UI identity/accent color (e.g., `#3fb950`).
* **`colorDim`** *(string, required)*: Translucent RGBA color matching the accent color at low opacity, used for UI row highlighting (e.g., `rgba(63,185,80,0.12)`).
* **`exam_minutes`** *(number, required)*: The time limit allocated for the mock exam in minutes (e.g., `60`).
* **`scenario_ids`** *(array of strings, required)*: List of scenario IDs belonging to this bundle in the order they should appear.

### Example Bundle
```json
{
  "id": "k8s-basics",
  "name": "Kubernetes Basics",
  "icon": "🌱",
  "tagline": "Core concepts for beginners",
  "color": "#3fb950",
  "colorDim": "rgba(63,185,80,0.12)",
  "exam_minutes": 60,
  "scenario_ids": [
    "pod-basics-mcq",
    "kubectl-essentials-mcq",
    "namespaces-basics",
    "deploy-nginx"
  ]
}
```

---

## 2. Scenarios Schema (`scenarios/scenarios.json`)

Scenarios are defined as a JSON array of objects. A scenario can be either a hands-on console challenge (`"task"`) or a multiple-choice question (`"mcq"`).

### Common Fields (All Types)
```jsonc
{
  "id": "unique-kebab-case-id",        // string — unique scenario identifier
  "title": "Human-readable Title",      // string — shown in sidebar list
  "category": "Workloads",             // string — groups scenarios in sidebar accordion
  "difficulty": "Easy",                // "Easy" | "Medium" | "Hard"
  "type": "task",                      // "task" | "mcq"
  "weight": 7,                         // number — points value (used for final grade scoring)
  "description": "## Markdown...",     // string — problem statement supporting GitHub-flavored Markdown
  "hints": [...],                      // array — see Hints schema below
  "setup_commands": [...],             // array<object> — commands run on environment preparation
  "teardown_commands": [...],           // array<object> — optional — cleanup commands run after scenario completes
  "default_namespace": "default"       // string — optional — default active namespace for the terminal
}
```

---

### Hints Schema
Each hint is rendered as a collapsible card inside the Hints tab of the UI:
```jsonc
{
  "title": "Short title for the hint card",
  "body":  "Explanation text (plain text, no markdown format).",
  "command": "kubectl run nginx --image=nginx" // optional — renders a copyable code block
}
```

---

### Setup & Teardown Commands
* **`setup_commands`**: Executed sequentially on the Kubernetes cluster when the user starts a scenario or clicks **"Prepare Environment"**. Useful for pre-deploying resources or injecting bugs.
* **`teardown_commands`**: Optional cleanup commands run when moving away from or resetting a scenario.
* Commands must be **objects** with a `command` key:
  ```jsonc
  "setup_commands": [
    { "command": "kubectl create namespace debug" },
    { "command": "kubectl create deployment broken-app --image=nginx:1.25 -n debug" }
  ]
  ```
* *Note:* Non-zero exit codes are tolerated (e.g., "namespace already exists" errors won't halt the pipeline). All commands execute as `root`.

---

### Type: `"task"` — Hands-On Scenario
Requires the user to run shell commands in the interactive terminal. The system runs an automated validation sequence to check the cluster state.

```jsonc
{
  "type": "task",
  "validation": {
    "mode": "cluster_state",          // optional — "cluster_state" (default) | "command_submission"
    "description": "Check that deployment has been correctly configured",
    "commands": [
      {
        "description": "Checks the running pods count",
        "command": "kubectl get deploy nginx -o jsonpath='{.status.readyReplicas}'",
        "expected_output": "3",
        "match": "exact" // "exact" | "contains" | "regex"
      }
    ]
  }
}
```

#### Validation Modes
| Mode | Behaviour |
| :--- | :--- |
| `cluster_state` | **Default.** The backend runs the `command` fields in `validation.commands` against the live cluster and checks the output. |
| `command_submission` | The user must type the kubectl command in a text input. The backend runs the user's command and checks its output against `expected_output` from the first `commands` entry. Used for observation/query tasks where the validation command would otherwise be the answer itself. |

When `mode` is omitted, `"cluster_state"` is assumed for backwards compatibility.

#### Match Modes
| Mode | Behaviour |
| :--- | :--- |
| `exact` | Trimmed stdout must exactly equal `expected_output`. |
| `contains` | stdout must contain `expected_output` as a substring. |
| `not_contains` | stdout must **not** contain `expected_output` as a substring. |
| `regex` | stdout must match the regular expression in `expected_output`. |

---

### Type: `"mcq"` — Multiple Choice Question
Renders a questionnaire block. No terminal is shown. The user answers by selecting an option.

```jsonc
{
  "type": "mcq",
  "options": [
    { "id": "a", "text": "Option A explanation" },
    { "id": "b", "text": "Option B explanation" },
    { "id": "c", "text": "Option C explanation" },
    { "id": "d", "text": "Option D explanation" }
  ],
  "correct_option": "c",               // must match one of the option IDs
  "explanation": "Detailed explanation of why C is the correct answer." // shown after submitting
}
```

---

## 3. Full Examples

### Full Example — Hands-On Task Scenario
```json
{
  "id": "scale-deployment",
  "title": "Scale a Deployment",
  "category": "Workloads",
  "difficulty": "Easy",
  "type": "task",
  "weight": 4,
  "description": "## Scale the Deployment\n\nA deployment named `myapp` exists in the `default` namespace.\n\n**Scale it to 5 replicas.**",
  "hints": [
    {
      "title": "Using kubectl scale",
      "body": "The scale subcommand lets you change the replica count imperatively.",
      "command": "kubectl scale deployment myapp --replicas=5"
    }
  ],
  "setup_commands": [
    { "command": "kubectl create deployment myapp --image=nginx:1.25 --replicas=1" }
  ],
  "teardown_commands": [
    { "command": "kubectl delete deployment myapp --ignore-not-found" }
  ],
  "default_namespace": "default",
  "validation": {
    "description": "Checks that myapp has 5 ready replicas.",
    "commands": [
      {
        "description": "myapp has 5 ready replicas",
        "command": "kubectl get deployment myapp -o jsonpath='{.status.readyReplicas}'",
        "expected_output": "5",
        "match": "exact"
      }
    ]
  }
}
```

### Full Example — MCQ Scenario
```json
{
  "id": "service-types-mcq",
  "title": "Kubernetes Service Types",
  "category": "Networking",
  "difficulty": "Easy",
  "type": "mcq",
  "weight": 3,
  "description": "## Kubernetes Service Types\n\nWhich `kubectl` command creates a ClusterIP service named `my-svc` exposing port 80 for a deployment named `my-app`?",
  "options": [
    { "id": "a", "text": "kubectl expose deployment my-app --name=my-svc --port=80 --type=ClusterIP" },
    { "id": "b", "text": "kubectl create service my-svc --port=80" },
    { "id": "c", "text": "kubectl apply service my-app --port=80" },
    { "id": "d", "text": "kubectl expose pod my-app --name=my-svc --port=80 --type=NodePort" }
  ],
  "correct_option": "a",
  "explanation": "`kubectl expose deployment` is the correct imperative command. It creates a Service targeting the deployment's pods. `--type=ClusterIP` is the default but explicit here for clarity.",
  "hints": [
    {
      "title": "kubectl expose syntax",
      "body": "Use kubectl expose to create a Service from an existing resource. Specify the resource type, name, port, and service type.",
      "command": "kubectl expose deployment my-app --name=my-svc --port=80 --type=ClusterIP"
    }
  ],
  "setup_commands": [],
  "teardown_commands": [],
  "default_namespace": "default"
}
```
