# Google Drive v2 Encrypted Pack Full Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fresh-root Google Drive v2 Full Push path that encrypts 1 MiB chunks, mixes them into immutable 32 MiB packfiles, uploads four packs concurrently with resumable retry, and atomically commits the encrypted manifest.

**Architecture:** Keep the OG HTTP `StorageAdapter` and shared Pull path unchanged. Add a Drive-only v2 pack pipeline with focused crypto, packing, resumable transport, Root lifecycle, storage, orchestration, and UI modules; `runSync()` branches into that pipeline only when `backendMode === 'drive'` and `driveRootVersion === 2`.

**Tech Stack:** TypeScript ES2020, WebCrypto AES-256-GCM/HKDF/HMAC-SHA-256, Google Drive API v3, localforage, Vitest, webpack.

## Global Constraints

- Work in an isolated worktree on branch `feat/drive-v2-pack-push`; do not implement directly in the live extension checkout.
- Preserve the user's existing uncommitted `package-lock.json`; never stage, format, or regenerate it.
- Do not push, merge, trash the live Drive Root, or run a real Drive benchmark until the owner reaches the explicit live-test checkpoint in Task 8.
- Phase 1 supports a fresh v2 Root and Full Push only. Pull, `both`, incremental Push, v1/v2 mixing, and stable release are out of scope.
- Maximum plaintext chunk size is 1 MiB; target pack size is 32 MiB; transport range is 8 MiB; baseline pack concurrency is 4.
- Every chunk uses a fresh random AES-GCM IV. Plaintext IDs, types, filenames, raw hashes, and item sizes must appear only inside the encrypted manifest.
- Upload packs before committing the manifest. Any failed or cancelled pack prevents publication.
- Keep HTTP/OG behavior and generated HTTP wire bytes unchanged.
- Gate 1 is a correct empty-Root Full Push in 15 minutes or less. Competitive target is no more than 2x OG for the same bytes/items; stretch target is 2–3 minutes for 500 MB.
- Each task follows red-green TDD and creates one focused commit.

---

## File Structure

**Create**

- `src/backend/drive/pack-types.ts` — constants and v2 manifest/pack reference types.
- `src/backend/drive/pack-crypto.ts` — protocol-separated chunk encryption, manifest encryption, and pack naming.
- `src/backend/drive/pack-builder.ts` — deterministic single-pass chunking and bounded pack construction.
- `src/backend/drive/pack-uploader.ts` — resumable range upload, retry, pause, cancellation, and progress.
- `src/backend/drive/pack-layout.ts` — v2 Root discovery/creation and destructive v1→v2 reset service.
- `src/backend/drive/pack-store.ts` — pack listing/reuse, size verification, and encrypted v2 commit publication.
- `src/backend/drive/drive-v2-push.ts` — Full Push orchestration and benchmark metrics.
- Matching tests under `src/backend/drive/__tests__/`.
- `src/st-adapter/__tests__/scan-store.test.ts` — typed-array local blob regression coverage.

**Modify**

- `src/st-adapter/scan.ts` — store binary values without converting bytes to JavaScript number arrays.
- `src/crypto/subkeys.ts` — derive Drive v2 protocol-separated keys.
- `src/backend/drive/client.ts` — low-level Drive v2 Root search and resumable range operations.
- `src/backend/runtime.ts` — construct a Drive v2 runtime without changing HTTP runtime behavior.
- `src/settings.ts` — persist `driveRootVersion: 1 | 2` with v1-safe backfill.
- `src/sync/engine.ts` — route Drive v2 Full Push before the shared v1/HTTP pipeline and block unsupported directions.
- `src/index.ts` — explicit reset confirmation, v2 status, Push progress, and `Connect & Resume` action.
- `docs/superpowers/specs/2026-08-09-drive-v2-encrypted-pack-push-design.md` — mark owner approval.

---

### Task 1: Store Local Blobs as Binary Values

**Files:**
- Create: `src/st-adapter/__tests__/scan-store.test.ts`
- Modify: `src/st-adapter/scan.ts:39-47`

**Interfaces:**
- Preserves: `storeBlob(hash: string, bytes: Uint8Array): Promise<void>`
- Preserves: `loadBlob(hash: string): Promise<Uint8Array | null>`
- Adds compatibility for stored `Uint8Array`, `ArrayBuffer`, and legacy `number[]` values.

- [ ] **Step 1: Write failing binary-storage tests**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setItem = vi.fn();
const getItem = vi.fn();
vi.mock('../../state/store', () => ({
    getSyncStore: () => ({ setItem, getItem }),
}));

import { loadBlob, storeBlob } from '../scan';

describe('scan blob storage', () => {
    beforeEach(() => { setItem.mockReset(); getItem.mockReset(); });

    it('stores Uint8Array directly instead of expanding it to number[]', async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        await storeBlob('abc', bytes);
        expect(setItem).toHaveBeenCalledWith('blob:abc', bytes);
        expect(Array.isArray(setItem.mock.calls[0][1])).toBe(false);
    });

    it.each([
        new Uint8Array([1, 2, 3]),
        new Uint8Array([1, 2, 3]).buffer,
        [1, 2, 3],
    ])('loads binary and legacy values', async (stored) => {
        getItem.mockResolvedValue(stored);
        await expect(loadBlob('abc')).resolves.toEqual(new Uint8Array([1, 2, 3]));
    });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/st-adapter/__tests__/scan-store.test.ts`

Expected: FAIL because `storeBlob()` passes `Array.from(bytes)` and `loadBlob()` assumes `number[]`.

- [ ] **Step 3: Implement typed binary storage**

```ts
export async function storeBlob(hash: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) return;
    await getSyncStore().setItem(BLOB_PREFIX + hash, bytes);
}

export async function loadBlob(hash: string): Promise<Uint8Array | null> {
    const value = await getSyncStore().getItem<Uint8Array | ArrayBuffer | number[]>(BLOB_PREFIX + hash);
    if (!value) return null;
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return new Uint8Array(value);
}
```

- [ ] **Step 4: Run focused and full tests**

Run: `npx vitest run src/st-adapter/__tests__/scan-store.test.ts && npm test`

Expected: focused test PASS; full Vitest suite reports zero failures.

- [ ] **Step 5: Commit**

```bash
git add src/st-adapter/scan.ts src/st-adapter/__tests__/scan-store.test.ts
git commit -m "perf(scan): store local blobs as typed bytes"
```

---

### Task 2: Define Drive v2 Types and Cryptographic Boundaries

**Files:**
- Create: `src/backend/drive/pack-types.ts`
- Create: `src/backend/drive/pack-crypto.ts`
- Create: `src/backend/drive/__tests__/pack-crypto.test.ts`
- Modify: `src/crypto/subkeys.ts`
- Modify: `src/crypto/__tests__/subkeys.test.ts`

**Interfaces:**
- Produces: `DrivePackManifestV2`, `DrivePackItemV2`, `DrivePackChunkRef`, `EncryptedPack`.
- Produces: `deriveDrivePackSubkeys(rootRaw, folderId): Promise<DrivePackSubkeys>`.
- Produces: `makeDrivePackCrypto(subkeys): DrivePackCrypto`.

Define test-local `digestHex()`, `makeKeys()`, and `manifestFixture(id)` in
`pack-crypto.test.ts`. `makeKeys()` calls `deriveDrivePackSubkeys()` with a
32-byte fixture key and fixed Root ID; `manifestFixture()` returns a complete
schema 2 manifest containing exactly one item whose ID is the supplied string.

- [ ] **Step 1: Add failing v2 subkey and crypto tests**

```ts
it('derives isolated v2 keys and seals chunks with random IVs', async () => {
    const keys = await deriveDrivePackSubkeys(new Uint8Array(32).fill(7), 'root-v2');
    const crypto = makeDrivePackCrypto(keys);
    const plain = new TextEncoder().encode('secret-character-data');
    const first = await crypto.encryptChunk(plain);
    const second = await crypto.encryptChunk(plain);
    expect(first).not.toEqual(second);
    await expect(crypto.decryptChunk(first)).resolves.toEqual(plain);
    expect(await crypto.packName([{ chunkHash: await digestHex(plain), plainLength: plain.length }]))
        .toMatch(/^[0-9a-f]{64}$/);
});

it('encrypts schema 2 manifest without plaintext identifiers', async () => {
    const crypto = makeDrivePackCrypto(await makeKeys());
    const manifest = manifestFixture('character/private.png');
    const boxed = await crypto.encryptManifest(manifest);
    expect(new TextDecoder().decode(boxed)).not.toContain('private.png');
    await expect(crypto.decryptManifest(boxed)).resolves.toEqual(manifest);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run src/crypto/__tests__/subkeys.test.ts src/backend/drive/__tests__/pack-crypto.test.ts`

Expected: FAIL because v2 types, subkeys, and crypto functions do not exist.

- [ ] **Step 3: Add exact v2 contracts**

```ts
export const DRIVE_V2_CHUNK_BYTES = 1 * 1024 * 1024;
export const DRIVE_V2_PACK_BYTES = 32 * 1024 * 1024;
export const DRIVE_V2_RANGE_BYTES = 8 * 1024 * 1024;
export const DRIVE_V2_CONCURRENCY = 4;

export interface DrivePackChunkRef {
    packName: string;
    offset: number;
    boxedLength: number;
    plainLength: number;
    chunkHash: string;
}

export interface DrivePackItemV2 {
    id: string;
    type: SyncItem['type'];
    hash: string;
    size: number;
    mtime: number;
    chunks: DrivePackChunkRef[];
}

export interface DrivePackManifestV2 {
    schema: 2;
    storage: 'drive-pack-v2';
    device: string;
    updatedAt: number;
    chunkBytes: number;
    packBytes: number;
    items: Record<string, DrivePackItemV2>;
}

export interface EncryptedPack {
    name: string;
    bytes: Uint8Array;
    chunks: readonly { chunkHash: string; plainLength: number; boxedLength: number }[];
}
```

```ts
export interface DrivePackCrypto {
    encryptChunk(plain: Uint8Array): Promise<Uint8Array>;
    decryptChunk(boxed: Uint8Array): Promise<Uint8Array>;
    packName(entries: readonly { chunkHash: string; plainLength: number }[]): Promise<string>;
    encryptManifest(manifest: DrivePackManifestV2): Promise<Uint8Array>;
    decryptManifest(boxed: Uint8Array): Promise<DrivePackManifestV2>;
}

export function emptyDrivePackManifest(
    device: string,
    chunkBytes = DRIVE_V2_CHUNK_BYTES,
    packBytes = DRIVE_V2_PACK_BYTES,
): DrivePackManifestV2;
```

Add `DrivePackSubkeys { chunkEnc; packName; manifestEnc }` to
`src/crypto/subkeys.ts`; `deriveDrivePackSubkeys()` returns exactly that shape.

Derive keys with HKDF info strings exactly `chunk-enc-v2`, `pack-name-v2`, and `manifest-enc-v2`; reuse existing `seal()`/`open()` and HMAC hex encoding helpers without changing v1 labels.

- [ ] **Step 4: Run crypto tests and typecheck**

Run: `npx vitest run src/crypto/__tests__/subkeys.test.ts src/backend/drive/__tests__/pack-crypto.test.ts && npx tsc --noEmit`

Expected: all selected tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/crypto/subkeys.ts src/crypto/__tests__/subkeys.test.ts src/backend/drive/pack-types.ts src/backend/drive/pack-crypto.ts src/backend/drive/__tests__/pack-crypto.test.ts
git commit -m "feat(drive): add encrypted pack v2 primitives"
```

---

### Task 3: Build Packs in One Bounded Pass

**Files:**
- Create: `src/backend/drive/pack-builder.ts`
- Create: `src/backend/drive/__tests__/pack-builder.test.ts`

**Interfaces:**
- Consumes: `DrivePackCrypto`, `DrivePackManifestV2`, `SyncItem`.
- Produces: `buildDrivePacks(options): Promise<DrivePackManifestV2>`.
- Transfers ownership of each emitted `EncryptedPack.bytes` to `emit()`. The
  promise resolves when the bounded upload queue has accepted ownership, not
  when the network upload finishes; the queue may apply backpressure while all
  four upload slots are occupied.

Define the following test-local fixtures in `pack-builder.test.ts`: `item(id,
size)` returns a complete `SyncItem`; `fixtures` maps its hash to bytes;
`deterministicCryptoStub()` returns ciphertext with a fixed one-byte prefix and
deterministic pack names; `buildFixture()` captures emitted packs and manifest;
`reassembleFixture()` follows manifest offsets and removes the test prefix;
`baseOptions()` returns one valid item and the same crypto stub.

- [ ] **Step 1: Write failing pack-builder tests**

```ts
it('sorts items, chunks once, mixes items, and emits bounded packs', async () => {
    const emitted: EncryptedPack[] = [];
    const loaded: string[] = [];
    const manifest = await buildDrivePacks({
        device: 'pc',
        items: [item('b', 6), item('a', 6)],
        chunkBytes: 4,
        packBytes: 10,
        load: async (hash) => { loaded.push(hash); return fixtures[hash]; },
        crypto: deterministicCryptoStub(),
        emit: async (pack) => { emitted.push(pack); },
    });
    expect(loaded).toEqual(['hash-a', 'hash-b']);
    expect(emitted.every(p => p.bytes.byteLength <= 10)).toBe(true);
    expect(Object.keys(manifest.items)).toEqual(['a', 'b']);
    expect(manifest.items.a.chunks).toHaveLength(2);
});

it.each([0, 1, 4, 5, 8])('round-trips boundary size %i', async (size) => {
    const result = await buildFixture(size, { chunkBytes: 4, packBytes: 10 });
    expect(reassembleFixture(result)).toEqual(new Uint8Array(size).fill(9));
});

it('fails before emit when a source blob is missing', async () => {
    await expect(buildDrivePacks({ ...baseOptions(), load: async () => null }))
        .rejects.toMatchObject({ name: 'MissingLocalBlobError' });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/pack-builder.test.ts`

Expected: FAIL because `buildDrivePacks()` does not exist.

- [ ] **Step 3: Implement the single-pass builder**

```ts
export interface BuildDrivePacksOptions {
    device: string;
    items: readonly SyncItem[];
    chunkBytes?: number;
    packBytes?: number;
    load(hash: string): Promise<Uint8Array | null>;
    crypto: DrivePackCrypto;
    emit(pack: EncryptedPack): Promise<void>;
    onProgress?(packedItems: number, totalItems: number): void;
}

export async function buildDrivePacks(options: BuildDrivePacksOptions): Promise<DrivePackManifestV2> {
    const items = [...options.items].sort((a, b) => a.id.localeCompare(b.id));
    const manifest = emptyDrivePackManifest(options.device, options.chunkBytes, options.packBytes);
    const writer = new PackWriter(options.packBytes ?? DRIVE_V2_PACK_BYTES, options.crypto, options.emit);
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const plain = await options.load(item.hash);
        if (!plain) throw new MissingLocalBlobError(item.id, item.hash);
        manifest.items[item.id] = await writer.appendItem(item, plain, options.chunkBytes ?? DRIVE_V2_CHUNK_BYTES);
        options.onProgress?.(index + 1, items.length);
    }
    await writer.flush();
    return manifest;
}
```

Implement `PackWriter` privately in the same file. It owns one current pack buffer, finalizes before exceeding `packBytes`, computes the HMAC name from ordered chunk hashes/lengths, calls `emit()`, then releases its reference.

- [ ] **Step 4: Run builder tests and typecheck**

Run: `npx vitest run src/backend/drive/__tests__/pack-builder.test.ts && npx tsc --noEmit`

Expected: selected test file PASS and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/pack-builder.ts src/backend/drive/__tests__/pack-builder.test.ts
git commit -m "feat(drive): build encrypted packs in one pass"
```

---

### Task 4: Implement Real Resumable Range Uploads

**Files:**
- Create: `src/backend/drive/pack-uploader.ts`
- Create: `src/backend/drive/__tests__/pack-uploader.test.ts`
- Modify: `src/backend/drive/client.ts:7-99`
- Modify: `src/backend/drive/__tests__/client.test.ts`

**Interfaces:**
- Produces: `DriveHttpError`, `ResumableRangeResult`.
- Produces: `DriveClient.beginResumableFile()`, `queryResumableFile()`, `putResumableRange()`.
- Produces: `uploadPackResumable(options): Promise<DriveFileMeta>`.

- [ ] **Step 1: Write failing Drive client range tests**

```ts
it('handles 308 and parses the acknowledged byte range', async () => {
    stubFetch(async () => new Response('', { status: 308, headers: { Range: 'bytes=0-7' } }));
    const result = await new DriveClient(tp).putResumableRange(
        'https://upload/session', new Uint8Array(8), 0, 32,
    );
    expect(result).toEqual({ kind: 'incomplete', acknowledgedBytes: 8 });
});

it('queries an interrupted session with bytes */total', async () => {
    const headers: Record<string, string>[] = [];
    stubFetch(async (_url, init) => {
        headers.push(init?.headers as Record<string, string>);
        return new Response('', { status: 308, headers: { Range: 'bytes=0-15' } });
    });
    await new DriveClient(tp).queryResumableFile('https://upload/session', 32);
    expect(headers[0]['Content-Range']).toBe('bytes */32');
});
```

- [ ] **Step 2: Write failing retry/pause tests**

```ts
it('retries 429 then continues from Drive acknowledged offset', async () => {
    const sleep = vi.fn(async () => undefined);
    const client = retryClient([httpError(429), incomplete(8), complete('file1')]);
    const file = await uploadPackResumable({ client, pack: pack32(), rangeBytes: 8, sleep, random: () => 0 });
    expect(file.id).toBe('file1');
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(client.starts).toEqual([0, 8]);
});

it('surfaces 401 as DriveAuthError without discarding completed offset', async () => {
    const client = retryClient([incomplete(8), new DriveAuthError()]);
    await expect(uploadPackResumable({ client, pack: pack32(), rangeBytes: 8 }))
        .rejects.toMatchObject({ name: 'DriveUploadPausedError', acknowledgedBytes: 8 });
});
```

Define `retryClient(events)` as a test fake that consumes one event for every
range call and records each start offset. Define `httpError(status)`,
`incomplete(bytes)`, `complete(id)`, and `pack32()` as exact constructors for
`DriveHttpError`, `ResumableRangeResult`, and a 32-byte `EncryptedPack` fixture.

- [ ] **Step 3: Run selected tests and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/client.test.ts src/backend/drive/__tests__/pack-uploader.test.ts`

Expected: FAIL because range/session APIs and retry uploader do not exist.

- [ ] **Step 4: Implement resumable contracts and retry policy**

```ts
export type ResumableRangeResult =
    | { kind: 'incomplete'; acknowledgedBytes: number }
    | { kind: 'complete'; file: DriveFileMeta };

export class DriveHttpError extends Error {
    constructor(readonly status: number, readonly body: string) {
        super(`Drive API ${status}: ${body}`);
        this.name = 'DriveHttpError';
    }
}

export class DriveUploadPausedError extends Error {
    constructor(
        readonly sessionUrl: string,
        readonly acknowledgedBytes: number,
        readonly cause: DriveAuthError,
    ) {
        super('Google authentication required to resume upload');
        this.name = 'DriveUploadPausedError';
    }
}
```

```ts
export interface UploadPackOptions {
    client: Pick<DriveClient, 'beginResumableFile' | 'putResumableRange' | 'queryResumableFile'>;
    parentId: string;
    pack: EncryptedPack;
    rangeBytes?: number;
    sleep?(ms: number): Promise<void>;
    random?(): number;
    resume?: { sessionUrl: string; acknowledgedBytes: number };
    signal?: AbortSignal;
    onUploadedBytes?(uploaded: number, total: number): void;
}

export interface PackUploadControl {
    signal?: AbortSignal;
    onUploadedBytes?(uploaded: number, total: number): void;
    onRetry?(attempt: number, delayMs: number): void;
}
```

Retry connection failures, 408, 429, and 5xx with delays `min(1000 * 2 ** attempt + random() * 1000, 32000)`. After an ambiguous failure, call `queryResumableFile()` before sending another range. A 401 pause preserves the session URL and acknowledged offset so `Connect & Resume` can pass them back through `resume`; other terminal statuses throw `DriveHttpError`.

- [ ] **Step 5: Run selected tests, full client tests, and typecheck**

Run: `npx vitest run src/backend/drive/__tests__/client.test.ts src/backend/drive/__tests__/pack-uploader.test.ts && npx tsc --noEmit`

Expected: all selected tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/backend/drive/client.ts src/backend/drive/pack-uploader.ts src/backend/drive/__tests__/client.test.ts src/backend/drive/__tests__/pack-uploader.test.ts
git commit -m "feat(drive): resume encrypted pack uploads"
```

---

### Task 5: Create and Reset a Fresh v2 Root

**Files:**
- Create: `src/backend/drive/pack-layout.ts`
- Create: `src/backend/drive/__tests__/pack-layout.test.ts`
- Modify: `src/backend/drive/client.ts`
- Modify: `src/backend/drive/__tests__/client.test.ts`
- Modify: `src/settings.ts:25-76,98-136`
- Modify: `src/state/store.ts`

**Interfaces:**
- Produces: `DrivePackLayout { rootId; packsId; manifestsId }`.
- Produces: `createDrivePackLayout(client): Promise<DrivePackLayout>`.
- Produces: `discoverDrivePackLayout(client, knownRootId?): Promise<DrivePackLayout>`.
- Produces: `resetDriveRootToV2(options): Promise<DrivePackLayout>`.
- Produces: `clearBackendState(namespace: string): Promise<void>`.

Define `loadSettingsFixture()` by replacing the mocked extension settings and
calling `getSettings()`. Define `layoutClient(options)` as a stateful fake that
records created folders and trashed IDs. Define `baseResetOptions(client)` with
old Root ID `root-v1-id`, namespace `drive:root-v1-id`, and a resolved
`clearBackendState` spy.

- [ ] **Step 1: Write failing settings and Root-reset tests**

```ts
it('backfills existing users to Drive Root v1', () => {
    const settings = loadSettingsFixture({ backendMode: 'drive', driveFolderId: 'old-root' });
    expect(settings.driveRootVersion).toBe(1);
});

it('trashes only the selected v1 root and creates root-v2 children', async () => {
    const client = layoutClient();
    const layout = await resetDriveRootToV2({
        client,
        oldRootId: 'root-v1-id',
        oldNamespace: 'drive:root-v1-id',
        clearBackendState: vi.fn(async () => undefined),
    });
    expect(client.trashed).toEqual(['root-v1-id']);
    expect(client.createdRootProperties).toEqual({ ts: 'root-v2' });
    expect(layout).toEqual({ rootId: 'root-v2-id', packsId: 'packs-id', manifestsId: 'manifests-id' });
});

it('does not trash anything when v2 folder creation fails', async () => {
    const client = layoutClient({ failCreate: true });
    await expect(resetDriveRootToV2(baseResetOptions(client))).rejects.toThrow('create failed');
    expect(client.trashed).toEqual([]);
});

it('replaces an existing v2 root for a second empty-root benchmark', async () => {
    const client = layoutClient();
    await resetDriveRootToV2({
        client,
        oldRootId: 'previous-root-v2',
        oldNamespace: 'drive:previous-root-v2',
        clearBackendState: vi.fn(async () => undefined),
    });
    expect(client.trashed).toEqual(['previous-root-v2']);
    expect(client.createdRootProperties).toEqual({ ts: 'root-v2' });
});
```

- [ ] **Step 2: Run selected tests and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/pack-layout.test.ts src/backend/drive/__tests__/client.test.ts`

Expected: FAIL because Root v2 APIs and `driveRootVersion` do not exist.

- [ ] **Step 3: Implement v2-safe lifecycle**

```ts
export interface DrivePackLayout {
    rootId: string;
    packsId: string;
    manifestsId: string;
}

export async function resetDriveRootToV2(options: {
    client: DriveClient;
    oldRootId: string;
    oldNamespace: string;
    clearBackendState(namespace: string): Promise<void>;
}): Promise<DrivePackLayout> {
    const layout = await createDrivePackLayout(options.client);
    await options.client.trashFile(options.oldRootId);
    await options.clearBackendState(options.oldNamespace);
    return layout;
}
```

Create the new v2 Root and both children before trashing v1, so a failed create leaves the current backup untouched. Generalize Root search to accept an exact marker (`root-v1` or `root-v2`) while preserving the existing v1 default. `clearBackendState()` removes only `baseStorageKey(namespace)` and `e2eeKeyStorageKey(namespace)`.
The same reset service accepts an existing v2 Root ID so every tuning candidate
can start from a genuinely empty Root without a second deletion code path.

- [ ] **Step 4: Run settings/layout tests and typecheck**

Run: `npx vitest run src/backend/drive/__tests__/pack-layout.test.ts src/backend/drive/__tests__/client.test.ts src/sync/__tests__/base-namespace.test.ts && npx tsc --noEmit`

Expected: selected tests PASS; v1 namespace tests remain unchanged; TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/pack-layout.ts src/backend/drive/client.ts src/settings.ts src/state/store.ts src/backend/drive/__tests__/pack-layout.test.ts src/backend/drive/__tests__/client.test.ts
git commit -m "feat(drive): create fresh encrypted pack roots"
```

---

### Task 6: Upload Packs and Atomically Commit the v2 Manifest

**Files:**
- Create: `src/backend/drive/pack-store.ts`
- Create: `src/backend/drive/__tests__/pack-store.test.ts`

**Interfaces:**
- Consumes: `DrivePackLayout`, `DrivePackCrypto`, `DriveClient`, `uploadPackResumable()`.
- Produces: `DrivePackStore.listPacks()`, `putPack()`, `verifyPacks()`, `commitManifest()`.

Define `makeStore()` as a stateful fake-backed `DrivePackStore` exposing client
events and captured commit bytes. Define `packFixtures()` as two distinct
`EncryptedPack` values and reuse the complete schema 2 `manifestFixture()`
shape from Task 2 inside this test file.

- [ ] **Step 1: Write failing atomicity/reuse tests**

```ts
it('reuses a completed pack with matching name and size', async () => {
    const store = makeStore({ existing: [{ id: 'p1', name: 'pack-a', size: '32' }] });
    await store.putPack({ name: 'pack-a', bytes: new Uint8Array(32) });
    expect(store.client.beginCalls).toBe(0);
});

it('rejects an existing pack name with the wrong size', async () => {
    const store = makeStore({ existing: [{ id: 'p1', name: 'pack-a', size: '31' }] });
    await expect(store.verifyPacks([{ name: 'pack-a', byteLength: 32 }]))
        .rejects.toThrow('pack size mismatch');
});

it('commits schema 2 ciphertext after expected packs verify', async () => {
    const store = makeStore();
    for (const pack of packFixtures()) await store.putPack(pack);
    await store.verifyPacks(packFixtures().map(pack => ({ name: pack.name, byteLength: pack.bytes.byteLength })));
    await store.commitManifest(manifestFixture('character/private.png'));
    expect(store.events.at(-1)).toBe('commit');
    expect(new TextDecoder().decode(store.commitBytes[0])).not.toContain('private.png');
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/pack-store.test.ts`

Expected: FAIL because `DrivePackStore` does not exist.

- [ ] **Step 3: Implement immutable pack storage and publication gate**

```ts
export class DrivePackStore {
    constructor(
        private readonly client: DriveClient,
        private readonly crypto: DrivePackCrypto,
        private readonly layout: DrivePackLayout,
    ) {}

    listPacks(): Promise<Map<string, DriveFileMeta>>;
    putPack(pack: EncryptedPack, options?: PackUploadControl): Promise<void>;
    verifyPacks(expected: readonly { name: string; byteLength: number }[]): Promise<void>;
    commitManifest(manifest: DrivePackManifestV2): Promise<{ commitId: string }>;
}
```

`commitManifest()` encrypts the complete schema 2 manifest, hashes the ciphertext for the commit filename, and creates a manifest file with `appProperties: { ts: 'commit-v2' }`. `putPack()` updates one cached paginated listing after upload. No method publishes a commit before `verifyPacks()` succeeds.

- [ ] **Step 4: Run store tests and typecheck**

Run: `npx vitest run src/backend/drive/__tests__/pack-store.test.ts && npx tsc --noEmit`

Expected: selected tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/pack-store.ts src/backend/drive/__tests__/pack-store.test.ts
git commit -m "feat(drive): publish pack snapshots atomically"
```

---

### Task 7: Route Full Push Through the v2 Pipeline

**Files:**
- Create: `src/backend/drive/drive-v2-push.ts`
- Create: `src/backend/drive/__tests__/drive-v2-push.test.ts`
- Modify: `src/backend/runtime.ts`
- Modify: `src/backend/__tests__/runtime-drive.test.ts`
- Modify: `src/sync/engine.ts:483-817`
- Modify: `src/sync/__tests__/push-batch.test.ts`

**Interfaces:**
- Produces: `requireDriveV2Runtime(): Promise<DriveV2Runtime>`.
- Produces: `runDriveV2FullPush(options): Promise<DriveV2PushResult>`.
- Preserves: existing HTTP and Drive v1 `runSync()` behavior byte-for-byte.

Define `pushHarness(options)` as a fake `DriveV2Runtime` whose upload promises
record concurrency, events, commit count, metrics, and an optional failed pack.
Define `useHttpSettings()` with the existing settings mock used by
`runtime-http.test.ts`; expose `usedLegacyPushHandlers` from its fake HTTP
adapter instead of introducing a production-only flag.

- [ ] **Step 1: Write failing orchestration tests**

```ts
it('overlaps packing with four bounded pack uploads and commits last', async () => {
    const harness = pushHarness({ packCount: 9, concurrency: 4 });
    const result = await runDriveV2FullPush(harness.options);
    expect(harness.maxConcurrentUploads).toBe(4);
    expect(harness.events.at(-1)).toBe('commit');
    expect(result.metrics.packCount).toBe(9);
});

it('does not commit after cancellation or failed pack', async () => {
    const harness = pushHarness({ failPack: 3 });
    await expect(runDriveV2FullPush(harness.options)).rejects.toThrow('pack 3');
    expect(harness.commits).toBe(0);
});

it.each(['pull', 'both'] as const)('blocks unsupported v2 direction %s', async (direction) => {
    await expect(runSync({ direction })).rejects.toThrow('Drive v2 Phase 1 supports Full Push only');
});

it('does not route HTTP through Drive v2', async () => {
    useHttpSettings();
    await runSync({ direction: 'push' });
    expect(httpHarness.usedLegacyPushHandlers).toBe(true);
});
```

- [ ] **Step 2: Run selected tests and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/drive-v2-push.test.ts src/backend/__tests__/runtime-drive.test.ts src/sync/__tests__/push-batch.test.ts`

Expected: FAIL because the Drive v2 runtime/orchestrator and route do not exist.

- [ ] **Step 3: Implement the Drive-only runtime and orchestrator**

```ts
export interface DriveV2PushMetrics {
    itemCount: number;
    plainBytes: number;
    packBytes: number;
    packCount: number;
    retries: number;
    peakInFlightBytes: number;
    scanMs: number;
    packingMs: number;
    uploadMs: number;
    verifyMs: number;
    commitMs: number;
    elapsedMs: number;
}

export interface DriveV2PushResult {
    commitId: string;
    manifest: DrivePackManifestV2;
    metrics: DriveV2PushMetrics;
}

export interface DriveV2Runtime {
    layout: DrivePackLayout;
    crypto: DrivePackCrypto;
    store: DrivePackStore;
}

export interface DriveV2PushController {
    run(): Promise<DriveV2PushResult>;
    pause(): void;
    resume(): Promise<void>;
    cancel(): void;
}

export function runDriveV2FullPushFromEngine(options: {
    onProgress?: (message: string) => void;
}): Promise<{ message: string }>;
```

```ts
if (s.backendMode === 'drive' && s.driveRootVersion === 2) {
    if (opts.direction !== 'push') {
        throw new Error('Drive v2 Phase 1 supports Full Push only');
    }
    return runDriveV2FullPushFromEngine({ onProgress: opts.onProgress });
}
```

Use a bounded four-slot upload queue whose `emit(pack)` promise resolves once
the queue accepts ownership of the bytes. The queue holds at most four
in-flight packs, applies backpressure before accepting a fifth, and exposes a
`drain()` promise that must resolve before verification or manifest commit.
Refuse a second committed snapshot with `Drive v2 incremental Push is not
implemented`; allow a retry when packs exist but no `commit-v2` manifest
exists.

- [ ] **Step 4: Run v2, legacy Push, HTTP runtime, and full tests**

Run: `npx vitest run src/backend/drive/__tests__/drive-v2-push.test.ts src/backend/__tests__/runtime-drive.test.ts src/backend/__tests__/runtime-http.test.ts src/sync/__tests__/push-batch.test.ts && npm test`

Expected: selected tests and full suite PASS with zero failures.

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/drive-v2-push.ts src/backend/drive/__tests__/drive-v2-push.test.ts src/backend/runtime.ts src/backend/__tests__/runtime-drive.test.ts src/sync/engine.ts src/sync/__tests__/push-batch.test.ts
git commit -m "feat(drive): route fresh roots through pack push"
```

---

### Task 8: Add Explicit Reset, Resume UI, Verification, and Real Benchmark

**Files:**
- Create: `src/backend/drive/__tests__/drive-v2-ui-state.test.ts`
- Modify: `src/index.ts:312-391,610-647`
- Modify: `src/settings.ts`
- Create after live runs: `docs/superpowers/evidence/2026-08-09-drive-v2-full-push-benchmark.md`

**Interfaces:**
- UI action: `#tavernsync_reset_drive_v2`.
- UI action: `#tavernsync_resume_drive_v2_push` shown only after `DriveAuthError`.
- Progress formatter: `formatDriveV2PushProgress(event): string`.

```ts
export function canResetDriveV2(typed: string | null, expected: string): boolean {
    return typed === expected;
}

export function formatDriveV2PushProgress(event: DriveV2ProgressEvent): string;
```

- [ ] **Step 1: Write failing progress and reset-state tests**

```ts
it('formats measurable progress with throughput and ETA', () => {
    expect(formatDriveV2PushProgress({
        stage: 'upload', completedPacks: 18, totalPacks: 31,
        bytesPerSecond: 6.2 * 1024 * 1024, etaSeconds: 64,
    })).toBe('Uploading 18/31 · 6.2 MB/s · ETA 01:04');
});

it('requires the exact destructive confirmation phrase', () => {
    expect(canResetDriveV2('RESET DRIVE V2', 'RESET DRIVE V2')).toBe(true);
    expect(canResetDriveV2('reset drive v2', 'RESET DRIVE V2')).toBe(false);
});
```

- [ ] **Step 2: Run UI-state tests and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/drive-v2-ui-state.test.ts`

Expected: FAIL because progress/confirmation helpers do not exist.

- [ ] **Step 3: Implement explicit user-controlled reset and resume**

```ts
async function handleResetDriveV2(): Promise<void> {
    const s = getSettings();
    const phrase = 'RESET DRIVE V2';
    const typed = window.prompt(
        'This moves the current TavernSync Drive folder to trash. PC data stays untouched.\n\nType RESET DRIVE V2 to continue:',
        '',
    );
    if (typed !== phrase) return;
    await withLoader('Creating fresh Drive v2 root…', async () => {
        await lockE2ee({ forgetDevice: true });
        const layout = await resetDriveRootToV2({
            client: makeDriveClient(),
            oldRootId: s.driveFolderId,
            oldNamespace: `drive:${s.driveFolderId}`,
            clearBackendState,
        });
        s.driveFolderId = layout.rootId;
        s.driveRootVersion = 2;
        s.e2eeSalt = encodeSalt(await driveSaltFromFolderIdAsync(layout.rootId));
        saveSettings();
    });
    toastr.success('Drive v2 root is empty. Unlock, then run Full Push from this PC.', 'TavernSync');
}
```

On `DriveAuthError`, keep the in-memory Push controller paused and reveal `Connect & Resume`. The button obtains an interactive token from the shared provider and calls `controller.resume()`; it must not create a second Push controller.
Update `handleDriveConnect()` to use `discoverDrivePackLayout()` and list
`packs/` when `driveRootVersion === 2`; retain the current v1 discovery and
`blobs/` quota display when the version is 1.

- [ ] **Step 4: Run UI-state, full tests, typecheck, build, and diff checks**

Run:

```bash
npx vitest run src/backend/drive/__tests__/drive-v2-ui-state.test.ts
npm test
npx tsc --noEmit
npm run build
git diff --check
git status --short
```

Expected:

- all Vitest files PASS with zero failures;
- TypeScript exits 0;
- webpack production build exits 0;
- `git diff --check` prints nothing;
- `package-lock.json` remains the only unrelated dirty file and is not staged;
- no HTTP/OG source or generated wire asset changes appear without a matching test explanation.

- [ ] **Step 5: Commit the UI and integration gate**

```bash
git add src/index.ts src/settings.ts src/backend/drive/__tests__/drive-v2-ui-state.test.ts
git commit -m "feat(drive): expose encrypted pack full push"
```

- [ ] **Step 6: Stop for the live destructive checkpoint**

Report the tested commit hash and wait for the owner to confirm the PC is the source of truth and the current Drive Root may be moved to trash. Do not click or call reset before that confirmation in the live test session.

- [ ] **Step 7: Run the baseline live benchmark**

On the PC:

1. update the extension to the tested branch;
2. connect Google and verify the intended account;
3. invoke the explicit v2 reset and enter `RESET DRIVE V2`;
4. unlock using the intended passphrase;
5. start Full Push from the empty Root;
6. capture stage timings, bytes, item count, pack count, retries, peak in-flight bytes, Drive errors, and final commit ID;
7. list `packs/` and `manifests/` to prove every manifest reference has a matching pack and expected size;
8. record the result in `docs/superpowers/evidence/2026-08-09-drive-v2-full-push-benchmark.md`.

Expected: zero missing items, one committed v2 manifest, all referenced packs present, no plaintext metadata, and elapsed time at or below 15 minutes.

- [ ] **Step 8: Apply the tuning ladder one variable at a time**

If Gate 1 fails, use measured stage dominance:

- upload underutilized with no 429/5xx: test concurrency 6, then 8;
- resumable/session overhead dominates: test 64 MiB packs;
- memory/retry cost dominates: test 16 MiB packs;
- scan dominates: profile ST read endpoints and typed local blob writes before changing transport.

Run every candidate twice against an empty v2 Root. Keep only the smallest-memory configuration that reaches the competitive target. Revert rejected constant changes before the next candidate so results remain attributable to one variable.

- [ ] **Step 9: Commit benchmark evidence and the selected constants**

```bash
git add src/backend/drive/pack-types.ts docs/superpowers/evidence/2026-08-09-drive-v2-full-push-benchmark.md
git commit -m "perf(drive): tune encrypted pack full push"
```

If baseline constants win unchanged, commit only the benchmark evidence with message `docs(drive): record encrypted pack benchmark`.

---

## Final Verification Gate

- [ ] Confirm `git diff origin/master...HEAD -- src/backend/http.ts src/sync-core` is empty unless an approved, test-backed compatibility change is explicitly documented.
- [ ] Confirm `git status --short` still shows the owner's unrelated `package-lock.json` and no untracked implementation artifacts.
- [ ] Run `npm test`, `npx tsc --noEmit`, `npm run build`, and `git diff --check` from a clean staged implementation state.
- [ ] Review Drive names, `appProperties`, pack bytes, and manifest bytes for plaintext identifiers using fixture secrets that tests can search exactly.
- [ ] Verify no manifest commit occurs in cancellation, 401 pause, network failure, 429, or 5xx failure tests.
- [ ] Verify the live Full Push benchmark meets Gate 1 before proposing merge or stable release.
- [ ] Keep Pull and incremental Push disabled for Root v2 until their separate approved plans land.
