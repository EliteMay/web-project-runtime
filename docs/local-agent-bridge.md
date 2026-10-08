# Loop Engineering: local coding agent bridge (Issue #4)

## Status

This is an **opt-in transport adapter**, not a deployed or proven autonomous coding agent.
The current loop uses `Phase C → Phase B` with externally supplied `implement`
and `verify` callbacks. This bridge implements only the `implement` side by
launching an operator-selected **local executable** once per attempt.
No OpenAI / Claude / Groq / LM Studio account, API key, or model is configured by the runtime.

**Do not point it at the production PC Agent.** The first real pilot must use a
separate disposable repository with no private user data.

## How the interface works

The trusted operator constructs the function in a separate, privileged
orchestration layer, then supplies it to `runPhaseCLoop()`:

```js
import { runPhaseCLoop } from './tools/loop-engineering/phase-c-controller.mjs';
import { createLocalAgentImplement } from './tools/loop-engineering/local-agent-adapter.mjs';

// Example only. Use a trusted, fixed executable outside the worker's worktree.
// It must implement the protocol below; it is NOT an arbitrary interactive CLI.
const implement = createLocalAgentImplement({
  executable: '/absolute/path/to/operator-approved-worker',
  args: ['--loop-worker-protocol=1'],
  timeoutMs: 90_000
});

const result = await runPhaseCLoop({
  policyPath, schemaPath, queueDir, repoRoot, taskId, lane, holderId,
  implement,
  verify: independentVerifier // MUST run separately, with protected acceptance checks.
});
```

The worker is spawned with `shell:false`, its working directory is the isolated
Git worktree, and an empty environment (Windows gets `SystemRoot` when present).
Neither the model's stdout nor its claims determine task completion.

### Version 1 worker input

The executable reads **one UTF-8 JSON object on stdin** and edits only the
worktree. Fields: `schemaVersion: 1`, `task: {taskId,title,scope,completionCriteria}`,
`strategy`, `attempt`, `allowedPaths`, `protectedPaths`.

- Exit 0: implementation process finished. It is **not** a PASS.
- Nonzero exit, executable failure, timeout or excessive output: failed attempt.
- A timeout/output overflow now attempts **process tree cleanup**: on POSIX by a
  private process-group SIGKILL; on Windows by the system `taskkill.exe /T /F`.
  A failed cleanup returns `LOCAL_AGENT_TREE_KILL_UNVERIFIED`, never PASS.
  This does **not** contain intentionally detached descendants or prove that a
  subsequent normal exit cannot leave a background process running.
- stdout/stderr are deliberately discarded rather than copied to public logs.
- No model tokens or external cost are inferred from child-provided data.
  Finite usage budgets require **trusted independently gathered metering**.
  Without it, Phase C stops as blocked instead of interpreting missing usage as zero.
- A local model is a possible implementation, not an assumption. An external
  API worker may incur charges, and must never be started without explicit approval.

### Security requirements outside this library

This bridge is **not** an OS-level sandbox. A local process can still read files,
write outside the worktree, start child processes or access the network when its
OS account permits it. For real use, the operator must provide an independently
restricted OS user/container/VM, filesystem and network restrictions, a verified
fixed executable, and an out-of-worker `verify` process. On Windows, a Job Object configured with kill-on-close and independent
lifecycle ownership is required if complete child-process tree termination
matters. On Linux, use a cgroup/container-based supervisor. The subprocess
cleanup helper is a limited defense in depth, not that supervisor.

An isolated Git worktree and checked `allowedPaths` do **not** by themselves
prevent malicious tools from writing elsewhere. Do not hand credentials, tokens,
network privileges or default-branch access to the worker. Keep protected
acceptance fixtures and control files outside worker write access.

## What qualifies as progress

`progress-evidence.mjs` now counts progress only when a protected verifier
records an actual reduction in failing checks **with an unchanged check inventory
and no new regression**, or when the whole task passes. A new error signature,
renamed/deleted/disabled check, or a changed commit is not progress. Continuous
no-progress attempts stop at `maxSameFailure`, even when errors rotate.

## Pilot acceptance gate

1. Verify the subprocess can complete an offline, disposable test task.
2. Bind it to a real, independently sandboxed coding model and protected verifier.
3. Observe one failed first attempt, a distinct retry strategy and final PASS.
4. Check evidence receipts, Git refs, queue status, no-progress and cost guards.
5. Confirm no default-branch write, push, merge, deploy or unapproved paid request.

**Pilot status: NOT_RUN.** Unit/CI regression PASS does not prove real-provider
or real-project E2E operation. Do not enable Phase D/E or production deployment
to compensate for a missing single-worker proof.
