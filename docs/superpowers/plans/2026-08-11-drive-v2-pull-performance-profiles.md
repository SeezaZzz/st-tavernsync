# Drive v2 Pull Performance Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add device-local Mobile / Stable and PC / Fast Pull profiles, bounded mobile concurrency, resumable fallback, and stage-aware diagnostics without changing Push or snapshot formats.

**Architecture:** A focused profile module owns local preference and runtime limits. The Drive Pull scheduler consumes immutable per-run limits with an aggregate cap and bounded transient retry. The UI chooses and remembers a profile, passes it through the sync engine, and offers checkpoint resume in Mobile mode after PC WebView failure.

**Tech Stack:** TypeScript, Vitest, jQuery/SillyTavern popup APIs, browser `localStorage`, Web Crypto/Google Drive APIs, Webpack.

## Global Constraints

- One encrypted snapshot, manifest, Root, and Encryption passphrase remains portable across PC, Android, and SillyiOS.
- Mobile / Stable: initial class limits `2/1/1/1`, aggregate cap `4`, one cached 32 MiB pack, 24 MiB normal plaintext budget.
- PC / Fast: initial class limits `12/8/2/1`, aggregate cap `23`, two cached 32 MiB packs, 48 MiB plaintext budget.
- The profile is device-local and excluded from Push, Pull payloads, settings restore, and deletion propagation.
- Push and HTTP/OG behavior remain unchanged.
- Failed Pull never runs deletion-last or advances the base.
- Preserve the owner's existing `package-lock.json` change.

---

### Task 1: Device-local profile model and store

**Files:**
- Create: `src/backend/drive/pull-performance-profile.ts`
- Test: `src/backend/drive/__tests__/pull-performance-profile.test.ts`

**Interfaces:**
- Produces: `PullPerformanceProfile`, `PullPerformanceConfig`, `createPullPerformanceStore()`, `recommendPullPerformanceProfile()`, and `getPullPerformanceConfig()`.

- [ ] **Step 1: Write failing model/store tests**

```ts
expect(createPullPerformanceStore(storage).load()).toBeNull();
store.save('mobile');
expect(store.load()).toBe('mobile');
expect(getPullPerformanceConfig('mobile').aggregateCap).toBe(4);
expect(getPullPerformanceConfig('pc').aggregateCap).toBe(23);
expect(recommendPullPerformanceProfile({ userAgent: 'iPhone' })).toBe('mobile');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run src/backend/drive/__tests__/pull-performance-profile.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the focused module**

```ts
export type PullPerformanceProfile = 'mobile' | 'pc';
export interface PullPerformanceConfig {
    readonly profile: PullPerformanceProfile;
    readonly label: 'Mobile / Stable' | 'PC / Fast';
    readonly limits: PullLimits;
    readonly aggregateCap: number;
    readonly minimumAggregateCap: number;
    readonly encryptedBudgetBytes: number;
    readonly plaintextBudgetBytes: number;
    readonly transientRetries: number;
}
```

Use key `tavernsync:drive-v2-pull-profile`; reject/remove unknown stored values; default recommendation is mobile only for mobile user agents.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --run src/backend/drive/__tests__/pull-performance-profile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/pull-performance-profile.ts src/backend/drive/__tests__/pull-performance-profile.test.ts
git commit -m "feat(drive): add device pull profiles"
```

### Task 2: Aggregate scheduler caps and mobile retry/downshift

**Files:**
- Modify: `src/backend/drive/adaptive-pull-queue.ts`
- Modify: `src/backend/drive/__tests__/adaptive-pull-queue.test.ts`

**Interfaces:**
- Consumes: `PullLimits` from Task 1.
- Produces: `aggregateLimit`, `minimumAggregateLimit`, `transientRetries`, `isTransientError`, and `retryDelay` options; snapshot field `aggregateLimit`.

- [ ] **Step 1: Add failing concurrency/retry tests**

```ts
expect(maxActive).toBeLessThanOrEqual(4);
expect(snapshots.at(-1)?.aggregateLimit).toBe(3);
expect(attempts.get('preset/retry')).toBe(2);
```

Cover a 20-job mixed queue capped at four, transient failure requeue with cap `4→3`, minimum cap two, and non-transient immediate rejection.

- [ ] **Step 2: Run focused test and verify RED**

Run: `npm test -- --run src/backend/drive/__tests__/adaptive-pull-queue.test.ts`
Expected: FAIL because aggregate options and retry behavior are absent.

- [ ] **Step 3: Implement aggregate dispatch and retry**

```ts
if (active >= aggregateLimit || activeByClass[job.cost] >= limits[job.cost]) continue;
if (options.isTransientError?.(error) && attempt < transientRetries) {
    aggregateLimit = Math.max(minimumAggregateLimit, aggregateLimit - 1);
    pending.unshift(job);
    await options.retryDelay?.(attempt + 1);
    return;
}
```

Track attempts by item ID, decrement active counts before redispatch, and never mark a retried item complete.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --run src/backend/drive/__tests__/adaptive-pull-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/adaptive-pull-queue.ts src/backend/drive/__tests__/adaptive-pull-queue.test.ts
git commit -m "feat(drive): cap mobile pull writers"
```

### Task 3: Apply profiles to Drive Pull runtime

**Files:**
- Modify: `src/backend/drive/drive-v2-pull.ts`
- Modify: `src/backend/drive/drive-v2-ui-state.ts`
- Modify: `src/backend/drive/__tests__/drive-v2-pull.test.ts`
- Modify: `src/backend/drive/__tests__/drive-v2-ui-state.test.ts`

**Interfaces:**
- Consumes: `PullPerformanceProfile` and `getPullPerformanceConfig()`.
- Produces: `DriveV2PullOptions.profile`; progress field `profile`; profile-specific budgets and queue limits.

- [ ] **Step 1: Write failing integration and copy tests**

```ts
const result = await runDriveV2Pull({ ...h.options, profile: 'mobile' });
expect(result.maxActiveWriters).toBeLessThanOrEqual(4);
expect(formatDriveV2PullProgress(event)).toContain('Mobile / Stable');
```

Also assert PC permits more than four writers and Push progress formatting is unchanged.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- --run src/backend/drive/__tests__/drive-v2-pull.test.ts src/backend/drive/__tests__/drive-v2-ui-state.test.ts`
Expected: FAIL because profile is not wired.

- [ ] **Step 3: Wire immutable per-run configuration**

```ts
const config = getPullPerformanceConfig(options.profile ?? 'pc');
const encryptedBudget = options.encryptedBudget ?? new ByteBudget(config.encryptedBudgetBytes);
const plaintextBudget = options.plaintextBudget ?? new ByteBudget(config.plaintextBudgetBytes);
```

Pass class limits, aggregate cap, retry policy, and profile to queue/progress. Keep `ByteBudget` exclusive-oversize behavior.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --run src/backend/drive/__tests__/drive-v2-pull.test.ts src/backend/drive/__tests__/drive-v2-ui-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/drive-v2-pull.ts src/backend/drive/drive-v2-ui-state.ts src/backend/drive/__tests__/drive-v2-pull.test.ts src/backend/drive/__tests__/drive-v2-ui-state.test.ts
git commit -m "feat(drive): apply pull performance profiles"
```

### Task 4: Stage-aware sanitized Pull errors

**Files:**
- Create: `src/backend/drive/pull-stage-error.ts`
- Create: `src/backend/drive/__tests__/pull-stage-error.test.ts`
- Modify: `src/backend/drive/pack-reader.ts`
- Modify: `src/backend/drive/client.ts`
- Modify: `src/backend/drive/__tests__/client.test.ts`
- Modify: `src/st-adapter/http.ts`

**Interfaces:**
- Produces: `PullStage`, `PullStageError`, `withPullStage()`, `isTransientPullError()`, and `sanitizedPullErrorDetails()`.

- [ ] **Step 1: Write failing sanitization/classification tests**

```ts
const error = new PullStageError('pack-download', 'GET', 'https://www.googleapis.com/x?token=secret', new TypeError('Load failed'));
expect(error.message).toContain('pack-download');
expect(error.message).not.toContain('secret');
expect(isTransientPullError(error)).toBe(true);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- --run src/backend/drive/__tests__/pull-stage-error.test.ts src/backend/drive/__tests__/client.test.ts`
Expected: FAIL because contextual errors are absent.

- [ ] **Step 3: Implement contextual wrapping**

Wrap Drive fetch rejection as `pack-download`, pack decryption as `decrypt`, ST reads/writes as `local-read`/`local-write`, verifier as `verify`, and deletions as `delete`. Preserve `DriveAuthError` identity. Log only method plus sanitized host/path; strip query/hash and never include headers/body.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --run src/backend/drive/__tests__/pull-stage-error.test.ts src/backend/drive/__tests__/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/pull-stage-error.ts src/backend/drive/__tests__/pull-stage-error.test.ts src/backend/drive/pack-reader.ts src/backend/drive/client.ts src/backend/drive/__tests__/client.test.ts src/st-adapter/http.ts
git commit -m "feat(drive): diagnose pull request failures"
```

### Task 5: First-Pull chooser and Advanced selector

**Files:**
- Create: `src/ui/pull-performance-choice.ts`
- Create: `src/ui/__tests__/pull-performance-choice.test.ts`
- Modify: `panel.html`
- Modify: `src/index.ts`
- Modify: `src/ui/__tests__/control-compatibility.test.ts`

**Interfaces:**
- Produces: `promptPullPerformanceChoice(recommended)` returning `{ profile, remember } | null`; Advanced control `#tavernsync_pull_performance`.

- [ ] **Step 1: Write failing model/UI presence tests**

```ts
expect(buildPullPerformanceChoiceModel('mobile').selected).toBe('mobile');
expect(html).toContain('id="tavernsync_pull_performance"');
expect(html.indexOf('tavernsync_pull_performance')).toBeGreaterThan(html.indexOf('<b>Advanced</b>'));
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- --run src/ui/__tests__/pull-performance-choice.test.ts src/ui/__tests__/control-compatibility.test.ts`
Expected: FAIL because chooser/control do not exist.

- [ ] **Step 3: Implement chooser and selector binding**

Use the existing `callGenericPopup` pattern. Preselect the recommendation, default Remember checked, persist only through `createPullPerformanceStore()`, and hydrate the Advanced selector from local state. Capturing a profile for a running Pull makes later selector changes affect only the next run.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --run src/ui/__tests__/pull-performance-choice.test.ts src/ui/__tests__/control-compatibility.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/pull-performance-choice.ts src/ui/__tests__/pull-performance-choice.test.ts panel.html src/index.ts src/ui/__tests__/control-compatibility.test.ts
git commit -m "feat(ui): choose pull performance"
```

### Task 6: Engine propagation and PC-to-Mobile resume

**Files:**
- Modify: `src/sync/engine.ts`
- Modify: `src/index.ts`
- Create: `src/sync/__tests__/pull-performance-routing.test.ts`

**Interfaces:**
- Extends: `SyncRunOptions.pullPerformanceProfile?: PullPerformanceProfile`.
- Consumes: device-local chooser/store and `PullStageError`.

- [ ] **Step 1: Write failing routing/fallback tests**

Assert manual Pull passes the chosen profile, automatic/Slash Pull uses remembered or recommended profile without popup, PC `Load failed` offers switch-and-resume, switch persists `mobile`, and the second run uses the existing checkpoint.

- [ ] **Step 2: Run focused test and verify RED**

Run: `npm test -- --run src/sync/__tests__/pull-performance-routing.test.ts`
Expected: FAIL because profile routing/fallback is absent.

- [ ] **Step 3: Implement profile capture and fallback**

```ts
runSync({
    direction: 'pull',
    pullPerformanceProfile: selected.profile,
    onProgress: message => setStatusLine(message),
});
```

On transient PC WebView failure, flush checkpoint through the existing Pull boundary and show **Switch to Mobile / Stable and resume**, **Keep PC / Fast**, and **Cancel**. Switch calls the same Pull execution with profile `mobile`; it does not Reset Drive or local data.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --run src/sync/__tests__/pull-performance-routing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/engine.ts src/index.ts src/sync/__tests__/pull-performance-routing.test.ts
git commit -m "feat(drive): resume failed pc pulls on mobile"
```

### Task 7: Full regression, build, and release evidence

**Files:**
- Modify if needed: `docs/superpowers/specs/2026-08-10-drive-v2-pull-performance-profiles-design.md`
- Create: `.omo/evidence/drive-v2-pull-profiles/verification.txt` (uncommitted evidence only)

**Interfaces:**
- Validates all tasks; produces no runtime API.

- [ ] **Step 1: Run complete automated gates**

Run:

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
git diff --check
```

Expected: all commands exit 0; Push/HTTP regression tests remain green.

- [ ] **Step 2: Inspect release diff and protected files**

Run `git status --short`, `git diff origin/master...HEAD --stat`, and `git diff origin/master...HEAD -- package-lock.json`. Expected: requested source/tests/docs only; no `package-lock.json` diff from this feature.

- [ ] **Step 3: Install the verified bundle to the live extension folder**

Copy only built TavernSync artifacts through the existing supported extension update path, refresh port 8000, and verify served bundle SHA-256 equals the built bundle. Do not change the owner's data root.

- [ ] **Step 4: Commit any final source/test corrections atomically**

Use a scoped commit matching the repository's `fix(drive): ...` or `test(drive): ...` style. Keep `.omo/evidence` untracked.

- [ ] **Step 5: Push feature branch, merge, and verify remote master**

```bash
git push origin feat/drive-v2-core-fast-pull
git checkout master
git merge --no-ff feat/drive-v2-core-fast-pull -m "merge: mobile pull performance profiles"
git push origin master
git rev-parse HEAD
git rev-parse origin/master
```

Expected: local `master` and `origin/master` hashes are identical.

- [ ] **Step 6: Schedule owner-authorized shutdown only after every gate passes**

Run `shutdown.exe /s /t 120 /c "TavernSync mobile Pull profiles verified and published"`, then report the published commit and cancellation command `shutdown.exe /a` before the timer expires.
