# TavernSync Core Restore Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace TavernSync's Companion/Legacy Drive v2 Pull routing with one bounded-memory client that range-downloads and decrypts Drive chunks, uploads verified plaintext batches to SillyTavern's transactional restore API, commits the selected snapshot, and advances the Drive base only after matching success.

**Architecture:** The client probes the provider-neutral core capability, selects the Drive head exactly as today, reads encrypted chunk ranges rather than whole 32 MiB packs, and pipelines one 8 MiB batch upload while preparing the next. SillyTavern owns staging, logical path mapping, transaction, deletion, and rollback; TavernSync retains Google access, WebCrypto keys, Drive pack knowledge, progress, and final base/reload behavior.

**Tech Stack:** TypeScript 5.8, WebCrypto, browser Fetch/FormData, Google Drive v3 range requests, Vitest 3, Webpack 5.

## Global Constraints

- Depend on the core Restore Session protocol from `2026-08-09-st-core-transactional-bulk-restore.md`.
- Preserve the verified Drive v2 Push path and encrypted pack/manifest format.
- Preserve HTTP/OG synchronization.
- Do not ship, install, detect, or fall back to TavernSync Companion.
- Do not offer Legacy Pull for Drive v2 in this first private release.
- If the core API is missing or incompatible, stop with a clear SillyTavern-update-required error.
- Download/decrypt one 1 MiB chunk at a time; never load a complete 32 MiB pack for this path.
- Build batches with at most 8,388,608 plaintext bytes and at most eight segments.
- Keep at most two batch requests in flight and release plaintext buffers after settlement.
- Never send Google tokens or encryption keys to SillyTavern core.
- Save `baseCommitId` only after core returns `committed` with the selected snapshot ID.
- Push, cancel, failure, and update-required paths must not advance the base.
- Preserve the user's existing uncommitted `package-lock.json` change.
- Initial live gates: PC at most 5 minutes; physical mobile backend at most 15 minutes; no Jetsam; exact selected-scope inventory after reload.

## File Structure

- `src/backend/restore-session/types.ts` — provider-neutral protocol types and stable error codes.
- `src/backend/restore-session/client.ts` — capability/start/batch/status/commit/cancel same-origin client.
- `src/backend/restore-session/batch-builder.ts` — bounded segment batching and multipart construction.
- `src/backend/drive/range-source.ts` — Drive pack listing and authenticated byte-range downloads.
- `src/backend/drive/chunk-stream.ts` — ordered range decrypt/hash iterator over selected manifest items.
- `src/backend/drive/core-restore.ts` — end-to-end Drive head to core restore orchestration.
- `src/sync/engine.ts` — route Drive v2 Pull exclusively through core restore.
- `src/index.ts` — update-required/error/reload UX without Companion or Legacy fallback.
- Adjacent `__tests__` files — protocol, range, batching, routing, cancellation, and regression coverage.

---

### Task 1: Provider-Neutral Restore Session Client

**Files:**
- Create: `src/backend/restore-session/types.ts`
- Create: `src/backend/restore-session/client.ts`
- Test: `src/backend/restore-session/__tests__/client.test.ts`

**Interfaces:**
- Consumes: same-origin `fetch`, `SillyTavern.getContext().getRequestHeaders()`, core protocol 1.
- Produces: `RestoreSessionClient`, `RestoreCapabilities`, `RestoreStartRequest`, `RestoreSessionStatus`, `RestoreCommittedResult`, and `RestoreApiError`.

- [ ] **Step 1: Write failing capability and stable-error tests**

~~~ts
import { describe, expect, it, vi } from 'vitest';
import { RestoreApiError, RestoreSessionClient } from '../client';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
});

describe('RestoreSessionClient', () => {
    it('uses authenticated same-origin routes and validates protocol limits', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(json({
            protocol: 1, maxSegmentBytes: 1_048_576,
            maxBatchBytes: 8_388_608, maxBatchSegments: 8, maxInFlightBatches: 2,
        }));
        const client = new RestoreSessionClient(fetchImpl, () => ({ 'X-CSRF-Token': 'csrf' }));
        await expect(client.capabilities()).resolves.toMatchObject({ protocol: 1, maxBatchBytes: 8_388_608 });
        expect(fetchImpl).toHaveBeenCalledWith('/api/users/restore/capabilities', expect.objectContaining({ method: 'GET' }));
    });

    it('surfaces stable server codes without leaking server details', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(json({ error: { code: 'RESTORE_BUSY', message: 'Restore rejected' } }, 409));
        const client = new RestoreSessionClient(fetchImpl, () => ({}));
        await expect(client.capabilities()).rejects.toEqual(expect.objectContaining({ name: 'RestoreApiError', code: 'RESTORE_BUSY' }));
    });
});
~~~

- [ ] **Step 2: Run the test and verify red**

Run: `npx vitest run src/backend/restore-session/__tests__/client.test.ts`

Expected: FAIL because the client modules do not exist.

- [ ] **Step 3: Implement strict response parsing and same-origin methods**

~~~ts
export class RestoreApiError extends Error {
    constructor(readonly code: string, message: string, readonly status: number) {
        super(message);
        this.name = 'RestoreApiError';
    }
}

export interface RestoreCapabilities {
    readonly protocol: 1;
    readonly maxSegmentBytes: 1_048_576;
    readonly maxBatchBytes: 8_388_608;
    readonly maxBatchSegments: 8;
    readonly maxInFlightBatches: 2;
}
~~~

`RestoreSessionClient` exposes `capabilities()`, `start(body)`, `uploadBatch(sessionId, form)`, `status(sessionId)`, `commit(sessionId)`, and `cancel(sessionId)`. Every method merges current ST request headers, validates JSON shape, and encodes `sessionId`. Do not set `Content-Type` manually for FormData.

- [ ] **Step 4: Run tests and TypeScript**

Run: `npx vitest run src/backend/restore-session/__tests__/client.test.ts && npx tsc --noEmit`

Expected: PASS and TypeScript exits 0.

- [ ] **Step 5: Commit the core client contract**

~~~bash
git add src/backend/restore-session/types.ts src/backend/restore-session/client.ts src/backend/restore-session/__tests__/client.test.ts
git commit -m "feat(restore): add core session client"
~~~

### Task 2: Google Drive Byte-Range Pack Source

**Files:**
- Modify: `src/backend/drive/client.ts`
- Create: `src/backend/drive/range-source.ts`
- Test: `src/backend/drive/__tests__/range-source.test.ts`
- Modify: `src/backend/drive/__tests__/client.test.ts`

**Interfaces:**
- Consumes: current `DriveClient`, cached pack listing, manifest chunk refs `{ packName, offset, boxedLength }`, AbortSignal.
- Produces: `DriveClient.getFileRange(id, start, length, signal)`, `DriveRangeSource.readChunk(ref, signal)`, and request/retry metrics.

- [ ] **Step 1: Write failing range header, 206, and truncation tests**

~~~ts
import { expect, it, vi } from 'vitest';
import { DriveClient } from '../client';

it('downloads only the requested inclusive Drive byte range', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=10-19');
        return new Response(new Uint8Array(10), {
            status: 206, headers: { 'Content-Range': 'bytes 10-19/100' },
        });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const client = new DriveClient({ getToken: async () => 'token' });
    await expect(client.getFileRange('file-1', 10, 10)).resolves.toHaveLength(10);
});

it('rejects a server that ignores or truncates a non-full range', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(9), { status: 200 })));
    const client = new DriveClient({ getToken: async () => 'token' });
    await expect(client.getFileRange('file-1', 10, 10)).rejects.toThrow(/range/i);
});
~~~

- [ ] **Step 2: Run focused tests and verify red**

Run: `npx vitest run src/backend/drive/__tests__/client.test.ts src/backend/drive/__tests__/range-source.test.ts`

Expected: FAIL because `getFileRange` and `DriveRangeSource` are missing.

- [ ] **Step 3: Implement authenticated 206 validation and one listing cache**

`getFileRange` must validate safe integer bounds, send `Range: bytes=start-end`, require `206`, validate `Content-Range`, require exact byte length, propagate AbortSignal, and reuse current `DriveAuthError`/`DriveHttpError`. `DriveRangeSource` calls `store.listPacks()` once, resolves pack name to file ID/size, validates `offset + boxedLength <= file size`, and calls `getFileRange`. Add bounded retries for network errors, `408`, `429`, and `5xx` with delays 250/1000/4000 ms; never retry `401`, other `4xx`, hash errors, or cancellation.

- [ ] **Step 4: Run range tests and full Drive client tests**

Run: `npx vitest run src/backend/drive/__tests__/client.test.ts src/backend/drive/__tests__/range-source.test.ts && npx tsc --noEmit`

Expected: PASS and TypeScript exits 0.

- [ ] **Step 5: Commit range reads**

~~~bash
git add src/backend/drive/client.ts src/backend/drive/range-source.ts src/backend/drive/__tests__/client.test.ts src/backend/drive/__tests__/range-source.test.ts
git commit -m "feat(drive): stream encrypted chunk ranges"
~~~

### Task 3: Ordered Chunk Decrypt and Bounded Multipart Batches

**Files:**
- Create: `src/backend/drive/chunk-stream.ts`
- Create: `src/backend/restore-session/batch-builder.ts`
- Test: `src/backend/drive/__tests__/chunk-stream.test.ts`
- Test: `src/backend/restore-session/__tests__/batch-builder.test.ts`

**Interfaces:**
- Consumes: selected `DrivePackManifestV2`, `DriveRangeSource`, `DrivePackCrypto`, core capability limits.
- Produces: `streamRestoreSegments(options)` async iterator and `buildRestoreBatches(segments, limits)` async iterator of `{ metadata, form, plaintextBytes, release() }`.

- [ ] **Step 1: Write failing decrypt/order/memory-limit tests**

~~~ts
import { expect, it } from 'vitest';
import { streamRestoreSegments } from '../chunk-stream';
import { buildRestoreBatches } from '../../restore-session/batch-builder';

it('yields verified 1 MiB segments in manifest item/index order', async () => {
    const fixture = await makeChunkStreamFixture({ items: 3, chunksPerItem: 2 });
    const values = [];
    for await (const segment of streamRestoreSegments(fixture.options)) values.push([segment.itemId, segment.index, segment.bytes.byteLength]);
    expect(values).toEqual(fixture.expectedOrder);
    expect(fixture.peakRequestedBytes()).toBeLessThanOrEqual(1_048_604);
});

it('packs at most 8 MiB/eight segments and releases buffers after upload', async () => {
    const fixture = makePlainSegments({ count: 17, bytes: 1_048_576 });
    const batches = [];
    for await (const batch of buildRestoreBatches(fixture, { maxBatchBytes: 8_388_608, maxBatchSegments: 8 })) {
        batches.push(batch);
        expect(batch.plaintextBytes).toBeLessThanOrEqual(8_388_608);
        expect(batch.metadata.segments.length).toBeLessThanOrEqual(8);
        batch.release();
    }
    expect(batches).toHaveLength(3);
});
~~~

- [ ] **Step 2: Run focused tests and verify red**

Run: `npx vitest run src/backend/drive/__tests__/chunk-stream.test.ts src/backend/restore-session/__tests__/batch-builder.test.ts`

Expected: FAIL because both modules and test fixtures are absent.

- [ ] **Step 3: Implement chunk integrity and multipart construction**

For each selected item, read each boxed range, call `crypto.decryptChunk`, require `plainLength`, require `chunkHash`, and update an incremental item SHA-256 accumulator; after the last segment require item size/hash. Yield metadata `{ itemId, itemType, index, length, hash }` plus bytes. `batch-builder.ts` appends one JSON Blob field named `metadata` and repeated binary fields named `segments`; it copies no more than the active batch, exposes `release()` that zeroes owned plaintext arrays, and never stores a full item or pack.

- [ ] **Step 4: Run chunk/batch tests, full Vitest, and TypeScript**

Run: `npx vitest run src/backend/drive/__tests__/chunk-stream.test.ts src/backend/restore-session/__tests__/batch-builder.test.ts && npm test && npx tsc --noEmit`

Expected: focused and full suites PASS; TypeScript exits 0.

- [ ] **Step 5: Commit bounded batching**

~~~bash
git add src/backend/drive/chunk-stream.ts src/backend/restore-session/batch-builder.ts src/backend/drive/__tests__/chunk-stream.test.ts src/backend/restore-session/__tests__/batch-builder.test.ts
git commit -m "feat(restore): batch verified plaintext segments"
~~~

### Task 4: Two-Stage Pipeline, Retry, Cancellation, and Atomic Commit

**Files:**
- Create: `src/backend/drive/core-restore.ts`
- Test: `src/backend/drive/__tests__/core-restore.test.ts`

**Interfaces:**
- Consumes: selected commit/manifest, `RestoreSessionClient`, range/decrypt stream, batch builder, AbortSignal, progress callback, `saveBase`.
- Produces: `runDriveV2CoreRestore(options) -> DriveV2PullResult`.

- [ ] **Step 1: Write failing concurrency/base/cancel tests**

~~~ts
import { expect, it, vi } from 'vitest';
import { runDriveV2CoreRestore } from '../core-restore';

it('keeps at most two uploads in flight and commits the selected head', async () => {
    const h = coreRestoreHarness({ batches: 5, commitId: 'head-a' });
    const result = await runDriveV2CoreRestore(h.options);
    expect(h.peakUploads()).toBe(2);
    expect(h.commit).toHaveBeenCalledOnce();
    expect(h.saveBase).toHaveBeenCalledWith('head-a');
    expect(result.commitId).toBe('head-a');
});

it.each(['upload-failure', 'cancelled', 'wrong-snapshot'])('%s never advances base', async fault => {
    const h = coreRestoreHarness({ batches: 3, fault });
    await expect(runDriveV2CoreRestore(h.options)).rejects.toBeDefined();
    expect(h.saveBase).not.toHaveBeenCalled();
    expect(h.cancel).toHaveBeenCalledTimes(fault === 'cancelled' ? 1 : 0);
});
~~~

- [ ] **Step 2: Run the orchestration test and verify red**

Run: `npx vitest run src/backend/drive/__tests__/core-restore.test.ts`

Expected: FAIL because `core-restore.ts` and harness are absent.

- [ ] **Step 3: Implement the N+1 pipeline and safe terminal rules**

The orchestration sequence is exact:

~~~text
capabilities -> start -> prepare batch N+1 while upload N runs
-> await all uploads -> poll ready -> commit -> verify snapshotId
-> save base -> return result
~~~

Reject incompatible/missing capability with `SILLYTAVERN_UPDATE_REQUIRED`. Keep a Set of at most two upload promises; call each batch's `release()` in `finally`. Retry the same FormData batch only for connection loss, `408`, `429`, and `5xx`; core idempotency makes a lost response safe. On AbortSignal, stop producing batches, await settlement, call `cancel`, and throw `AbortError`. Poll status no faster than 250 ms. Accept success only when state is `committed` and returned `snapshotId === selected commitId`.

- [ ] **Step 4: Run orchestration tests and full TypeScript suite**

Run: `npx vitest run src/backend/drive/__tests__/core-restore.test.ts && npm test && npx tsc --noEmit`

Expected: PASS and TypeScript exits 0.

- [ ] **Step 5: Commit orchestration**

~~~bash
git add src/backend/drive/core-restore.ts src/backend/drive/__tests__/core-restore.test.ts
git commit -m "feat(drive): restore snapshots through core sessions"
~~~

### Task 5: Replace Companion/Legacy Routing and UX

**Files:**
- Modify: `src/sync/engine.ts`
- Modify: `src/index.ts`
- Modify: `src/backend/__tests__/drive-v2-engine-routing.test.ts`
- Create: `src/ui/update-required.ts`
- Test: `src/ui/__tests__/update-required.test.ts`
- Delete: `src/backend/drive/companion-client.ts`
- Delete: `src/backend/drive/companion-types.ts`
- Delete: `src/backend/drive/fast-restore.ts`
- Delete: `src/ui/companion-fallback.ts`
- Delete: corresponding Companion/fallback test files after replacement coverage passes.

**Interfaces:**
- Consumes: `runDriveV2CoreRestore`, existing Drive head choice, E2EE session key, scope settings, progress callback.
- Produces: one Drive v2 Pull route, one clear update-required UX, one reload after success.

- [ ] **Step 1: Rewrite routing tests to express the one-path requirement**

~~~ts
it('routes Drive v2 Pull to the core restore client before local scan', async () => {
    await runSync({ direction: 'pull' });
    expect(harness.scanLocal).not.toHaveBeenCalled();
    expect(harness.coreRestore).toHaveBeenCalledOnce();
    expect(harness.legacyPull).not.toHaveBeenCalled();
});

it('stops with update-required and never offers fallback when capability is absent', async () => {
    harness.coreRestore.mockRejectedValue(Object.assign(new Error('update'), { code: 'SILLYTAVERN_UPDATE_REQUIRED' }));
    await expect(runSync({ direction: 'pull' })).rejects.toMatchObject({ code: 'SILLYTAVERN_UPDATE_REQUIRED' });
    expect(harness.scanLocal).not.toHaveBeenCalled();
});
~~~

- [ ] **Step 2: Run routing/UI tests and verify they fail against Companion fallback**

Run: `npx vitest run src/backend/__tests__/drive-v2-engine-routing.test.ts src/ui/__tests__/update-required.test.ts`

Expected: FAIL because the engine still imports Companion and the new UI helper is absent.

- [ ] **Step 3: Route only through core restore and remove dead fallback code**

Remove `driveV2PullMode`, Companion capability/job types, Companion polling, and explicit Legacy fallback UI. Keep the existing source-choice semantics for Push only; Pull always applies the selected Drive snapshot. The update-required toast text is:

~~~text
Fast Pull needs a newer SillyTavern backend. Update SillyTavern or the app that bundles it, restart, then try Pull again.
~~~

After `Fast Pull complete`, ask for one reload exactly as the current UI does. Do not modify Push controls, Google connect, root reset, or HTTP/OG paths.

- [ ] **Step 4: Run focused routing, full tests, TypeScript, lint, and build**

Run:

~~~text
npx vitest run src/backend/__tests__/drive-v2-engine-routing.test.ts src/ui/__tests__/update-required.test.ts
npm test
npx tsc --noEmit
npm run lint
npm run build
git diff --check
~~~

Expected: all tests PASS, TypeScript/lint/build exit 0, and `git diff --check` prints nothing.

- [ ] **Step 5: Commit the one-path routing change**

~~~bash
git add src/sync/engine.ts src/index.ts src/backend src/ui
git commit -m "feat(drive): require core transactional Pull"
~~~

### Task 6: End-to-End Contract Test and Live Benchmark Preparation

**Files:**
- Create: `src/backend/drive/__tests__/core-restore-integration.test.ts`
- Create: `src/backend/drive/__tests__/fixtures/core-restore-fixture.ts`
- Create: `scripts/benchmark-core-restore.mjs`

**Interfaces:**
- Consumes: synthetic Drive v2 packs, mock Drive range endpoint, mock core restore API, all item types, deterministic fault injection.
- Produces: end-to-end batch/commit/base evidence and benchmark JSON compatible with the core benchmark fields.

- [ ] **Step 1: Write failing full-path and fault-matrix tests**

~~~ts
import { expect, it } from 'vitest';
import { buildCoreRestoreFixture } from './fixtures/core-restore-fixture';

it('range-decrypts, batches, commits, and advances the exact Drive head', async () => {
    const h = await buildCoreRestoreFixture({ items: 2347, packs: 30, includeAllTypes: true });
    const result = await h.run();
    expect(h.server.receivedInventory()).toEqual(h.expectedInventory);
    expect(h.server.peakBatchBytes()).toBeLessThanOrEqual(8_388_608);
    expect(h.clientPeakPlaintextBytes()).toBeLessThanOrEqual(18 * 1024 * 1024);
    expect(result.commitId).toBe('head-a');
});

it.each(['network', '429', 'chunk-tag', 'chunk-hash', 'item-hash', 'cancel', 'core-rollback'])
('%s preserves the old base and reports a stable failure', async fault => {
    const h = await buildCoreRestoreFixture({ fault });
    await expect(h.run()).rejects.toBeDefined();
    expect(h.savedBase()).toBe('head-old');
});
~~~

- [ ] **Step 2: Run the integration test and verify red**

Run: `npx vitest run src/backend/drive/__tests__/core-restore-integration.test.ts`

Expected: FAIL until the fixture server and complete orchestration are wired.

- [ ] **Step 3: Implement deterministic fixture and benchmark output**

The fixture creates only synthetic payloads, real Drive v2 AES-GCM framing, at least one multi-chunk item, two concurrent core uploads, and a fake server that applies the core contract. `scripts/benchmark-core-restore.mjs` runs three synthetic restores and prints `items`, `packs`, `encryptedBytes`, `plaintextBytes`, `rangeRequests`, `uploadRequests`, `downloadMs`, `decryptMs`, `uploadMs`, `commitMs`, `totalMs`, `peakClientPlaintextBytes`, and `inventoryEqual`.

- [ ] **Step 4: Run the complete extension verification matrix**

Run:

~~~text
npx vitest run src/backend/drive/__tests__/core-restore-integration.test.ts
npm test
npx tsc --noEmit
npm run lint
npm run build
node scripts/benchmark-core-restore.mjs --items 2347 --packs 30 --runs 3 --output .omo/evidence/drive-v2-core-restore/client.json
git diff --check
~~~

Expected: all automated checks PASS, benchmark reports `inventoryEqual: true`, and no token/key/plaintext appears in evidence.

- [ ] **Step 5: Commit integration evidence harness**

~~~bash
git add src/backend/drive/__tests__/core-restore-integration.test.ts src/backend/drive/__tests__/fixtures/core-restore-fixture.ts scripts/benchmark-core-restore.mjs
git commit -m "test(drive): verify core transactional Pull"
~~~

## Final Review Gate

1. Core protocol mismatch produces update-required and no fallback.
2. Drive v2 Push and HTTP/OG regression suites remain unchanged and passing.
3. No whole-pack read occurs in the core restore path.
4. Every chunk tag/hash and final item size/hash is verified before upload/commit.
5. Each request is at most 8 MiB/eight segments; at most two uploads are live.
6. Google token and encryption keys remain in the browser and never enter core requests/logs/evidence.
7. Cancel/failure/wrong-snapshot paths never advance the base.
8. Committed matching snapshot advances the base once and triggers one reload offer.
9. Full Vitest, TypeScript, ESLint, production build, benchmark, and `git diff --check` pass freshly.
10. The owner's `package-lock.json`, Drive data, primary PC user, GitHub branches, and upstream repositories remain untouched unless separately authorized.

## Live Verification Boundary

After both plans pass automated checks, first restore the real 30-pack snapshot into a throwaway desktop user and compare the selected-scope logical inventory. Only then bundle/test the matching SillyTavern core on a physical mobile backend while capturing native logs. A synthetic pass does not prove the 5-minute PC or 15-minute mobile gates.

## Execution Boundary

This plan authorizes local TavernSync feature-branch implementation only after the execution route is selected and the core contract exists. It does not authorize resetting Drive, restoring into the owner's primary user, merging to `master`, pushing, releasing, or asking SillyiOS users to install a build.
