# OS-level Loop Worker Isolation — 実測と残るGate

Status: **Linux disposable Docker sandbox tested / Windows Job Object test pending / real AI NOT_RUN**
Source of truth: `EliteMay/web-project-guide/LOOP_ENGINEERING_REQUIREMENTS.md`.
This is an implementation evidence memo, not a second policy owner.

## Linux: pinned offline Docker worker

`tools/loop-engineering/docker-isolated-agent.mjs`:
- Operator-selected absolute Docker binary and **locally present image ID `sha256:...` only**.
- `docker --host unix:///var/run/docker.sock`: remote daemon is not accepted.
- Child container: `--network=none`, `--read-only`, `--cap-drop=ALL`,
  `--security-opt=no-new-privileges`, `--pids-limit=32`,
  `--memory=256m` and matching swap limit, `--cpus=1`.
- Host's non-root UID/GID; writable mount **only** isolated worktree at `/workspace`;
  limited `/tmp` tmpfs; no Docker socket, host home or credentials mounted.
- `--pull=never`: the worker cannot pull images and only executes the pinned
  already-present image. CI alone fetches its disposable Alpine fixture before
  running the worker; the test-pinned local image ID comes from `docker image inspect`.
- Worker receives bounded JSON stdin. No Worker stdout or claim is used as the
  completion oracle, and no model token/cost estimate is invented.
- Timeout / excessive output triggers `docker kill` + `docker rm --force`,
  followed by `docker inspect` absence check. Cleanup uncertainty is a failure,
  never PASS. Orphan containers after force-killing **the controller itself**
  need an independent reaper; this remains unverified.

### Linux observed fault-injection

`tools/loop-engineering/test-docker-isolated-agent.mjs` on
[Ubuntu CI run #](https://github.com/EliteMay/web-project-runtime/actions/runs/37805708513):

1. Executes real Docker with the same restriction flags used by the adapter.
2. Writes a valid change to `/workspace`; host observes it.
3. Attempts to write to `/etc`; denied by readonly root + non-root identity.
4. Checks that an ordinary external network interface is not exposed (no `eth0`).
   The definitive policy is `--network=none`; this test does **not** represent
   comprehensive network intrusion testing.
5. Tries a long-running heartbeat worker, times it out, and checks the marker
   stops changing. The container cleanup is independently checked via `inspect`.
6. Rejects unsafe Loop Policy and unpinned image IDs before any worker launch.

This proves a bounded **representative** test under a trusted Docker daemon,
not a formal proof against Docker/kernel vulnerabilities, daemon compromise,
symlink abuse, arbitrary external dependencies, or malicious locally supplied
images. A production system must pin known-good images and assess its daemon,
host permission and storage threat model.

## Windows: native Job Object supervisor

`windows-job-supervisor/Program.cs` implements:
- `CreateProcessW(CREATE_SUSPENDED)`, then `AssignProcessToJobObject`,
  then `ResumeThread`: prevents running before membership.
- Job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and
  `JOB_OBJECT_LIMIT_ACTIVE_PROCESS`.
- On worker timeout: `TerminateJobObject` followed by the process wait.
- On normal parent exit: closing the job handle terminates associated children.
- Sanitized minimum environment and no inherited handles.
- No breakaway flags are granted.

`test-windows-job-supervisor.mjs` launches a worker that creates a detached
grandchild writing a heartbeat. It asserts the heartbeat ends both after
supervisor timeout and after the parent exits normally.

**Important:** Job Object is **process lifecycle containment only**.
It does not deny the worker host filesystem access, the internet, token access,
or Windows desktop APIs. It is not integrated into the worker launch path as a
trusted filesystem+network sandbox. On Windows, the original
`createLocalAgentImplement` must continue to deny ordinary execution.

## Unattended real-model launch remains blocked

- No provider SDK/API secrets, new spending or PC Agent linkage added.
- Windows needs separate Restricted Token/AppContainer/VM/Windows Sandbox or
  comparable OS boundary with demonstrated filesystem/network denial.
- Linux needs unprivileged image provenance verification and a controller-death
  orphan cleanup/reconciliation test before long-running unattended use.
- Both OSes still need independent protected acceptance fixtures, trusted cost
  metering when billable, kill-switch tests and model-usage control.
- Only `L1_WORKTREE` / single worker; no merge, push or deploy in the pilot.

**No completion claim** should treat a Job Object as a full security sandbox,
or a GitHub CI PASS as proof of production-grade OS security.
