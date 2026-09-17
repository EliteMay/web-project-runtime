# Web Project Runtime

`web-project-runtime` は [`EliteMay/web-project-guide`](https://github.com/EliteMay/web-project-guide) の共通Contractを実行側へ接続する、公開可能なRuntime / Validator / Test基盤です。

## Repository roles

- `web-project-guide` — 共通Rule、Product Contract、Routing、Quality基準
- `web-project-runtime` — 再利用可能なPublic Runtime code、Schema、Regression Test、CI
- `web-project-data` — PrivateなConversation、Work Queue state、Loop run evidence、Recovery data等
- 各Target Project Repository — Current Requirements、Code、Data、実装状態

## Public / Private Boundary

このRepositoryへ保存してよいもの:

- Runtime Controller code
- Runtime Schema
- Generic regression fixture / test
- Generic reliability helper
- Public GitHub Actions workflow
- Runtime利用方法

このRepositoryへ保存しないもの:

- Conversation history
- 実ProjectのWork Queue内容
- 実Loop Run State / Receipt
- Private Evidence
- Trusted Recovery Capsule
- Secret / token / credential
- Project固有のCurrent Requirements / Code / Data

Public Runtimeを作るためにPrivate Dataをコピーしません。

## Current implementation status

### Phase E — Remote Publication / Human Review Gate — Implemented

Phase EのCurrent Runtime OwnerはこのRepositoryです。

Phase Eは、Phase Dで検証済みのIntegration Branchを対象に:

```text
verified Phase D Receipt
↓
current Guide Policy validation
↓
base / integration / remote reconciliation
↓
non-force review branch push
↓
PR creation / reuse
↓
required checks observation
↓
human approval gate
↓
ready_for_human_merge
```

までを扱います。

安全境界:

- `L2_PR`専用
- default branch direct writeなし
- force pushなし
- RuntimeによるMergeなし
- Deployなし
- Human Review必須
- Required Check failureは`blocked`
- stale base / divergent remote branchは`needs_reconcile`
- review branchとbase branchの同一指定を拒否

Regression TestはPublic `web-project-guide` のCurrent `maintenance/loop-policy.schema.json`を取得してUbuntu / Windowsで実行します。Private `web-project-data`はCIへcheckoutしません。

Validation evidence:

- Migration PR: `EliteMay/web-project-runtime#1`
- PR head `24b0197170df9d6b193c3c6886f90730287263f3` — `Validate Loop Runtime #2` PASS
- main `4ba80487fe7210e4150381b859cf6af1315de0a4` — `Validate Loop Runtime #3` PASS
- Ubuntu / WindowsのPhase E regression PASS

Private `web-project-data#153` のPhase E重複実装はmergeせずsupersededとしてcloseしています。

### Phase A–D

Phase A–Dは現在 `web-project-data` 側の既存実装を維持しています。Public / Private責務をさらに明確にするため、今後段階的にこのRepositoryへ移行します。

移行完了前にData側Runtimeを削除せず、Public Runtime側のRegression PASSとSource of Truth切替を先に行います。
