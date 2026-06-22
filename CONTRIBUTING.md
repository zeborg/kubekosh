# Contributing to KubeKosh

Whether you are fixing a typo, updating scenario descriptions, adding new exercises, or modifying the application code, your efforts are highly appreciated.

---

## Creating Issues

Before opening a new issue, please search the existing issues to see if it has already been reported or discussed. 

If you need to open a new issue, please follow these guidelines:

### Bug Reports
* **Title:** Use a clear and descriptive title.
* **Describe the Bug:** Provide a clear and concise description of what the problem is.
* **Steps to Reproduce:** List the step-by-step actions required to reproduce the behavior.
* **Expected Behavior:** Describe what you expected to happen.
* **Environment:** Specify your operating system, Docker version, and browser if relevant.
* **Screenshots:** If applicable, add screenshots to help explain the problem.

### Feature Requests
* **Goal:** Describe the goal or problem this feature solves.
* **Proposed Solution:** Provide a clear description of what you want to happen.
* **Alternatives:** List any alternative solutions or features you have considered.

---

## Adding Scenarios

Each scenario is a single JSON file in the `scenarios/data` directory; each bundle is a single JSON file in the `scenarios/bundles` directory. See [`scenarios/SCHEMA.md`](scenarios/SCHEMA.md) for the full schema.

**Task checklist:**
- `validation.commands` — idempotent `kubectl` commands only
- `setup_commands` / `teardown_commands` — `kubectl` or native Ubuntu commands only

**MCQ checklist:**
- `correct_option` must match one of the `options[].id` values
- Always include an `explanation`

---

## In-Memory Cache & Hot Reloading

To ensure high performance and zero disk-I/O bottlenecking, scenarios and bundles are cached in memory on backend startup. When developing or updating scenarios, you can hot-reload the definitions without rebuilding the image or restarting the container:

1. **Mount Scenarios Directory:** Run the container with the local `scenarios/` directory mounted to `/app/scenarios`:
   ```bash
   docker run --rm -itd --privileged -p 7554:80 --name kubekosh -v <path_to_scenarios_directory>:/app/scenarios zeborg/kubekosh:latest
   ```
2. **Reload Cache:** Click the **Reload Scenario Cache** (↻) button in the top right corner of the header in the web user interface, or send an API request:
   ```bash
   curl -X POST http://localhost:7554/api/cache/reload
   ```

> [!NOTE]
> The content in `<path_to_scenarios_directory>` should be the path to the local `scenarios/` directory of the cloned repository with your updates, i.e., it should contain the updated `scenarios/data` and `scenarios/bundles` directories.

---

## Workflow

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/<your-username>/kubekosh.git
cd kubekosh

# 2. Create a branch
git checkout -b feat/my-scenario

# 3. Add a new scenario file (copy an existing scenario as a template or create a new one)
cp scenarios/data/deploy-nginx.json scenarios/data/my-new-scenario.json
vim scenarios/data/my-new-scenario.json # edit the new scenario as per [SCHEMA.md](scenarios/SCHEMA.md)

# 4. Add the scenario ID to the relevant bundle
vim scenarios/bundles/k8s-basics.json # edit the bundle to include the new scenario ID

# 5. Build and test locally
# Run the built container directly:
docker build -t kubekosh . && docker run --rm -itd --privileged -p 7554:80 --name kubekosh kubekosh
# Or mount the scenarios folder for hot-reloading:
docker run --rm -itd --privileged -p 7554:80 -v $PWD/scenarios:/app/scenarios --name kubekosh zeborg/kubekosh:dev

# 6. Commit and push to your fork (example for adding `my-new-scenario` to `k8s-basics` bundle)
git add scenarios/data/my-new-scenario.json scenarios/bundles/k8s-basics.json
git commit -m "feat: add my-new-scenario to k8s-basics bundle"
git push -u origin feat/my-scenario
```

Open a Pull Request from your fork's branch against `main`.
