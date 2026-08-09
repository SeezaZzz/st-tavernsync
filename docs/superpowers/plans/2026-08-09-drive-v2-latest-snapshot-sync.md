# Drive v2 Latest-Snapshot Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded-memory Drive v2 Pull and guarded incremental Push so the account owner can choose Drive, this device, or cancel whenever snapshots diverge, including authoritative deletion propagation.

**Architecture:** Extend the immutable encrypted pack snapshot into a parent-linked commit graph. Persist one namespaced device base, resolve Drive heads before every operation, read items through a two-pack LRU, apply items serially, and execute deletions only after every required item verifies and applies. Keep HTTP/OG on its existing runtime and apply path.

**Tech Stack:** TypeScript ES2020, WebCrypto AES-256-GCM/HMAC-SHA-256, Google Drive API v3, localforage, Vitest, webpack, SillyTavern same-origin APIs.

## Global Constraints

- Work in an isolated worktree on branch `feat/drive-v2-latest-snapshot-sync`; never implement directly in the live extension checkout.
- Preserve the owner's uncommitted `package-lock.json`; never stage, format, or regenerate it.
- Keep `src/backend/http.ts`, legacy Drive v1, and `src/sync-core` behavior unchanged unless a test-backed compatibility change is explicitly approved.
- Existing Phase-1 schema-2 commit is a valid genesis head; no Reset or re-upload is allowed for migration.
- No automatic merge, device-clock winner, safe default, or nested conflict popup.
- Drive / This device / Cancel are equal explicit choices when base and head differ.
- When multiple heads exist, render every decrypted Drive head as a separate `commitId` choice; never collapse them into one generic Drive action.
- Enabled scopes are authoritative; disabled scopes are never deleted.
- A failed or cancelled scan cannot Push, publish a commit, or authorize deletion.
- Pull holds at most two 32 MiB packs plus one reconstructed item and never converts bulk bytes with `Array.from`.
- Apply additions/replacements serially; run deletions serially last; save the device base only after complete success.
- A failed Push cannot publish a manifest. A failed Pull cannot advance `baseCommitId`.
- Gate 1: full iPhone Pull completes within 15 minutes with no Jetsam/WebContent termination.

---

### Task 1: Define the v2 Commit Graph and Backward-Compatible Manifest Metadata

**Files:**
- Modify: `src/backend/drive/pack-types.ts`
- Create: `src/backend/drive/drive-v2-head.ts`
- Create: `src/backend/drive/__tests__/drive-v2-head.test.ts`

**Interfaces:**
- Produces `DriveV2CommitMeta`, `parseDriveV2Commit()`, `computeDriveV2Heads()`, and `parentProperties()`.
- Extends `DrivePackManifestV2` with optional encrypted `baseCommitId` and `forced` fields.

- [ ] **Step 1: Write failing commit-graph tests**

```ts
function file(name: string, appProperties: Record<string, string>): DriveFileMeta {
    return { id: `id:${name}`, name, createdTime: '2026-08-09T00:00:00Z', appProperties };
}

function commit(commitId: string, parents: string[]): DriveV2CommitMeta {
    return parseDriveV2Commit(file(`${commitId}.enc`, { ts: 'commit-v2', ...parentProperties(parents) }));
}

it('treats the Phase-1 commit without parents as a genesis head', () => {
    const genesis = file('g.enc', { ts: 'commit-v2' });
    expect(parseDriveV2Commit(genesis)).toMatchObject({ commitId: 'g', parents: [] });
    expect(computeDriveV2Heads([parseDriveV2Commit(genesis)]).map(x => x.commitId)).toEqual(['g']);
});

it('returns both children when two devices fork from one parent', () => {
    const commits = [
        commit('g', []),
        commit('phone', ['g']),
        commit('pc', ['g']),
    ];
    expect(computeDriveV2Heads(commits).map(x => x.commitId).sort()).toEqual(['pc', 'phone']);
});

it('encodes every current head as a parent of a force commit', () => {
    expect(parentProperties(['pc', 'phone'])).toEqual({ parents: 'pc,phone' });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/drive-v2-head.test.ts`

Expected: FAIL because `drive-v2-head.ts` and optional manifest metadata do not exist.

- [ ] **Step 3: Implement the pure commit graph**

```ts
export interface DriveV2CommitMeta {
    fileId: string;
    commitId: string;
    parents: string[];
    createdTime: string;
}

export function parseDriveV2Commit(file: DriveFileMeta): DriveV2CommitMeta {
    if (file.appProperties?.ts !== 'commit-v2') throw new TypeError('not a Drive v2 commit');
    const parents = (file.appProperties.parents ?? '').split(',').filter(Boolean);
    return {
        fileId: file.id,
        commitId: file.name.replace(/\.enc$/, ''),
        parents,
        createdTime: file.createdTime ?? '',
    };
}

export function computeDriveV2Heads(commits: readonly DriveV2CommitMeta[]): DriveV2CommitMeta[] {
    const referenced = new Set(commits.flatMap(commit => commit.parents));
    return commits.filter(commit => !referenced.has(commit.commitId));
}

export function parentProperties(parents: readonly string[]): Record<string, string> {
    return parents.length ? { parents: parents.join(',') } : {};
}
```

Add to `DrivePackManifestV2`:

```ts
baseCommitId?: string;
forced?: boolean;
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/backend/drive/__tests__/drive-v2-head.test.ts src/backend/drive/__tests__/pack-crypto.test.ts && npx tsc --noEmit`

Expected: all selected tests PASS; TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/pack-types.ts src/backend/drive/drive-v2-head.ts src/backend/drive/__tests__/drive-v2-head.test.ts
git commit -m "feat(drive): model v2 snapshot heads"
```

---

### Task 2: Read Encrypted Commits and Packs, and Publish Parent-Linked Manifests

**Files:**
- Modify: `src/backend/drive/pack-store.ts`
- Modify: `src/backend/drive/__tests__/pack-store.test.ts`

**Interfaces:**
- Produces `listCommits()`, `readManifest()`, and `readPack()`.
- Changes `commitManifest(manifest, parents)` to publish parent hashes without plaintext metadata.

- [ ] **Step 1: Write failing store tests**

Extend the existing `makeStore()` fixture with byte reads and captured commit
properties before adding the assertions:

```ts
// Add to makeStore options and state.
fileBytes?: Record<string, Uint8Array>;
const committedProperties: Record<string, string>[] = [];

// Add to the fake DriveClient.
async getFileData(fileId: string): Promise<Uint8Array> {
    const bytes = options.fileBytes?.[fileId];
    if (!bytes) throw new Error(`missing fixture bytes: ${fileId}`);
    return bytes;
}

// Replace the fixture's old exact `{ ts: 'commit-v2' }` assertion inside
// createFile() with this capture; individual tests assert the full properties.
committedProperties.push(properties ?? {});

// Return the new capture with the existing fixture values.
return { store, client, events, commitBytes, committedProperties };

it('lists v2 commits and decrypts the selected manifest', async () => {
    const { store } = makeStore({
        manifests: [{ id: 'm1', name: 'abc.enc', createdTime: '2026-08-09T00:00:00Z', appProperties: { ts: 'commit-v2' } }],
        fileBytes: { m1: new Uint8Array([7]) },
    });
    const [head] = await store.listCommits();
    expect(head.commitId).toBe('abc');
    await expect(store.readManifest(head)).resolves.toMatchObject({ schema: 2 });
});

it('reads a pack by deterministic name and rejects an absent pack', async () => {
    const { store } = makeStore({ existing: [{ id: 'p1', name: 'pack-a', size: '4' }], fileBytes: { p1: new Uint8Array(4) } });
    await expect(store.readPack('pack-a')).resolves.toHaveLength(4);
    await expect(store.readPack('missing')).rejects.toThrow('missing pack');
});

it('publishes only parent hashes in appProperties', async () => {
    const { store, committedProperties } = makeStore();
    await store.verifyPacks([]);
    await store.commitManifest(manifestFixture('chat/private'), ['head-a', 'head-b']);
    expect(committedProperties[0]).toEqual({ ts: 'commit-v2', parents: 'head-a,head-b' });
    expect(JSON.stringify(committedProperties[0])).not.toContain('private');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/pack-store.test.ts`

Expected: FAIL because read APIs and parent-aware commit do not exist.

- [ ] **Step 3: Implement read and parent-aware commit APIs**

```ts
async listCommits(): Promise<DriveV2CommitMeta[]> {
    return (await this.client.listChildren(this.layout.manifestsId))
        .filter(file => file.appProperties?.ts === 'commit-v2')
        .map(parseDriveV2Commit);
}

async readManifest(commit: DriveV2CommitMeta): Promise<DrivePackManifestV2> {
    return this.crypto.decryptManifest(await this.client.getFileData(commit.fileId));
}

async readPack(name: string): Promise<Uint8Array> {
    const file = (await this.listPacks()).get(name);
    if (!file) throw new Error(`missing pack: ${name}`);
    return this.client.getFileData(file.id);
}

async commitManifest(manifest: DrivePackManifestV2, parents: readonly string[] = []): Promise<{ commitId: string }> {
    const bytes = await this.crypto.encryptManifest(manifest);
    const commitId = await sha256Hex(bytes);
    await this.client.createFile(
        this.layout.manifestsId,
        `${commitId}.enc`,
        bytes,
        { ts: 'commit-v2', ...parentProperties(parents) },
    );
    return { commitId };
}
```

- [ ] **Step 4: Run store, crypto, client tests and typecheck**

Run: `npx vitest run src/backend/drive/__tests__/pack-store.test.ts src/backend/drive/__tests__/pack-crypto.test.ts src/backend/drive/__tests__/client.test.ts && npx tsc --noEmit`

Expected: selected tests PASS; Phase-1 genesis commit remains readable.

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/pack-store.ts src/backend/drive/__tests__/pack-store.test.ts
git commit -m "feat(drive): read encrypted v2 snapshots"
```

---

### Task 3: Persist the Device Base and Compute Explicit Source-Choice Previews

**Files:**
- Modify: `src/state/store.ts`
- Create: `src/backend/drive/drive-v2-choice.ts`
- Create: `src/backend/drive/__tests__/drive-v2-choice.test.ts`
- Modify: `src/sync/__tests__/base-namespace.test.ts`

**Interfaces:**
- Produces `DriveV2BaseState`, `loadDriveV2Base()`, `saveDriveV2Base()`, and `clearDriveV2Base()`.
- Produces `DriveV2SnapshotPreview`, `DriveV2SnapshotSummary`, `DriveV2ChoiceInput`, and `buildDriveV2SnapshotPreview()`.

- [ ] **Step 1: Write failing base and preview tests**

```ts
const allTypes = new Set<ItemType>([
    'settings', 'preset', 'worldinfo', 'persona', 'character',
    'chat', 'group', 'groupchat', 'quickreply', 'theme',
]);

function item(id: string, hash: string, type: ItemType = 'character'): SyncItem {
    return { id, hash, type, size: 1, mtime: 1 };
}

function manifest(items: Record<string, SyncItem>): Manifest {
    return { schema: 1, version: 1, device: 'phone', updatedAt: 1, items };
}

function packItem(id: string, hash: string, type: ItemType = 'character'): DrivePackItemV2 {
    return { id, hash, type, size: 1, mtime: 1, chunks: [] };
}

function packManifest(items: Record<string, DrivePackItemV2>): DrivePackManifestV2 {
    return {
        schema: 2, storage: 'drive-pack-v2', device: 'pc', updatedAt: 2,
        chunkBytes: DRIVE_V2_CHUNK_BYTES, packBytes: DRIVE_V2_PACK_BYTES, items,
    };
}

it('namespaces the device base by Drive root', async () => {
    await saveDriveV2Base('drive:root-a', { commitId: 'a', syncedAt: 1 });
    await saveDriveV2Base('drive:root-b', { commitId: 'b', syncedAt: 2 });
    await expect(loadDriveV2Base('drive:root-a')).resolves.toEqual({ commitId: 'a', syncedAt: 1 });
});

it('previews add replace and delete for Drive-authoritative Pull', () => {
    const local = manifest({ same: item('same', 'h1'), old: item('old', 'h0'), localOnly: item('localOnly', 'x') });
    const remote = packManifest({ same: packItem('same', 'h1'), old: packItem('old', 'h2'), remoteOnly: packItem('remoteOnly', 'r') });
    expect(buildDriveV2SnapshotPreview(local, remote, allTypes)).toEqual({ add: 1, replace: 1, delete: 1, inSync: 1 });
});

it('never deletes items from a disabled scope', () => {
    const preview = buildDriveV2SnapshotPreview(
        manifest({ chat: item('chat', 'h', 'chat') }),
        packManifest({}),
        new Set(['character']),
    );
    expect(preview.delete).toBe(0);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/drive-v2-choice.test.ts src/sync/__tests__/base-namespace.test.ts`

Expected: FAIL because v2 base state and preview do not exist.

- [ ] **Step 3: Implement the namespaced base and pure preview**

```ts
export interface DriveV2BaseState { commitId: string; syncedAt: number; }

export function driveV2BaseStorageKey(namespace: string): string {
    return `tavernsync_drive_v2_base:${namespace}`;
}

export async function loadDriveV2Base(namespace: string): Promise<DriveV2BaseState | null> {
    return getSyncStore().getItem<DriveV2BaseState>(driveV2BaseStorageKey(namespace));
}

export async function saveDriveV2Base(namespace: string, base: DriveV2BaseState): Promise<void> {
    await getSyncStore().setItem(driveV2BaseStorageKey(namespace), base);
}

export async function clearDriveV2Base(namespace: string): Promise<void> {
    await getSyncStore().removeItem(driveV2BaseStorageKey(namespace));
}
```

```ts
export interface DriveV2SnapshotPreview { add: number; replace: number; delete: number; inSync: number; }

export interface DriveV2SnapshotSummary extends DriveV2SnapshotPreview {
    commitId?: string;
    device: string;
    createdTime?: string;
    itemCount: number;
}

export interface DriveV2ChoiceInput {
    local: DriveV2SnapshotSummary;
    heads: DriveV2SnapshotSummary[];
}

export function buildDriveV2SnapshotPreview(
    local: Manifest,
    remote: DrivePackManifestV2,
    allowedTypes: ReadonlySet<ItemType>,
): DriveV2SnapshotPreview;
```

`clearBackendState(namespace)` must remove the legacy base, remembered E2EE key,
and the v2 base for that exact namespace only.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/backend/drive/__tests__/drive-v2-choice.test.ts src/sync/__tests__/base-namespace.test.ts && npx tsc --noEmit`

Expected: selected tests PASS and roots remain isolated.

- [ ] **Step 5: Commit**

```bash
git add src/state/store.ts src/backend/drive/drive-v2-choice.ts src/backend/drive/__tests__/drive-v2-choice.test.ts src/sync/__tests__/base-namespace.test.ts
git commit -m "feat(drive): track v2 device bases"
```

---

### Task 4: Reconstruct Items Through a Two-Pack LRU

**Files:**
- Create: `src/backend/drive/pack-reader.ts`
- Create: `src/backend/drive/__tests__/pack-reader.test.ts`

**Interfaces:**
- Produces `DriveV2PackSource` and `DriveV2PackReader.readItem()`.
- Exposes measured cache count/bytes for tests and benchmark telemetry.

- [ ] **Step 1: Write failing bounded-memory and integrity tests**

```ts
function sourceFixture(packs: Record<string, Uint8Array>) {
    const reads = new Map<string, number>();
    return {
        reads,
        async readPack(name: string): Promise<Uint8Array> {
            reads.set(name, (reads.get(name) ?? 0) + 1);
            const pack = packs[name];
            if (!pack) throw new Error(`missing pack: ${name}`);
            return pack;
        },
    };
}

function cryptoStub(): DrivePackCrypto {
    return {
        async encryptChunk(value) { return value; },
        async decryptChunk(value) { return value; },
        async packName() { return 'unused'; },
        async encryptManifest() { return new Uint8Array(); },
        async decryptManifest() { throw new Error('not used'); },
    };
}

async function itemFixture(
    id: string,
    chunks: Array<{ packName: string; offset: number; bytes: Uint8Array }>,
): Promise<DrivePackItemV2> {
    const plain = concatBytes(chunks.map(chunk => chunk.bytes));
    return {
        id, type: 'chat', size: plain.byteLength, mtime: 1,
        hash: await sha256Hex(plain),
        chunks: await Promise.all(chunks.map(async chunk => ({
            packName: chunk.packName,
            offset: chunk.offset,
            boxedLength: chunk.bytes.byteLength,
            plainLength: chunk.bytes.byteLength,
            chunkHash: await sha256Hex(chunk.bytes),
        }))),
    };
}

it('never retains more than two packs and reuses a shared pack', async () => {
    const source = sourceFixture({
        'pack-a': new Uint8Array([1]),
        'pack-b': new Uint8Array([2]),
        'pack-c': new Uint8Array([3]),
    });
    const reader = new DriveV2PackReader(source, cryptoStub(), 2);
    await reader.readItem(await itemFixture('one', [
        { packName: 'pack-a', offset: 0, bytes: new Uint8Array([1]) },
        { packName: 'pack-b', offset: 0, bytes: new Uint8Array([2]) },
    ]));
    await reader.readItem(await itemFixture('two', [
        { packName: 'pack-b', offset: 0, bytes: new Uint8Array([2]) },
        { packName: 'pack-c', offset: 0, bytes: new Uint8Array([3]) },
    ]));
    expect(reader.getPeakCachedPacks()).toBe(2);
    expect(source.reads.get('pack-b')).toBe(1);
});

it('rejects an out-of-bounds chunk before decrypting', async () => {
    const reader = new DriveV2PackReader(sourceFixture({ p: new Uint8Array(8) }), cryptoStub(), 2);
    const item = await itemFixture('bad-range', [{ packName: 'p', offset: 7, bytes: new Uint8Array(4) }]);
    await expect(reader.readItem(item))
        .rejects.toThrow('chunk range outside pack');
});

it('rejects bad chunk and complete-item hashes', async () => {
    const source = sourceFixture({ p: new Uint8Array([1]) });
    const good = await itemFixture('bad-hash', [{ packName: 'p', offset: 0, bytes: new Uint8Array([1]) }]);
    const reader = new DriveV2PackReader(source, cryptoStub(), 2);
    await expect(reader.readItem({ ...good, chunks: [{ ...good.chunks[0], chunkHash: 'wrong' }] }))
        .rejects.toThrow('chunk hash mismatch');
    await expect(reader.readItem({ ...good, hash: 'wrong' })).rejects.toThrow('item hash mismatch');
});
```

Use this test-local byte joiner; it allocates the exact combined length and
copies each part once:

```ts
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
    const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/pack-reader.test.ts`

Expected: FAIL because `DriveV2PackReader` does not exist.

- [ ] **Step 3: Implement the reader**

```ts
export interface DriveV2PackSource { readPack(name: string): Promise<Uint8Array>; }

export class DriveV2PackReader {
    private readonly cache = new Map<string, Uint8Array>();
    private peakCachedPacks = 0;
    private peakCachedBytes = 0;

    constructor(
        private readonly source: DriveV2PackSource,
        private readonly crypto: DrivePackCrypto,
        private readonly maxCachedPacks = 2,
    ) {}

    async readItem(item: DrivePackItemV2): Promise<Uint8Array> {
        const output = new Uint8Array(item.size);
        let written = 0;
        for (const ref of item.chunks) {
            const pack = await this.getPack(ref.packName);
            const end = ref.offset + ref.boxedLength;
            if (ref.offset < 0 || end > pack.byteLength) throw new RangeError('chunk range outside pack');
            const plain = await this.crypto.decryptChunk(pack.subarray(ref.offset, end));
            if (plain.byteLength !== ref.plainLength || await sha256Hex(plain) !== ref.chunkHash) {
                throw new Error('chunk hash mismatch');
            }
            output.set(plain, written);
            written += plain.byteLength;
        }
        if (written !== item.size || await sha256Hex(output) !== item.hash) throw new Error('item hash mismatch');
        return output;
    }

    getDownloadedPackCount(): number { return this.downloadedPackCount; }
    getPeakCachedPacks(): number { return this.peakCachedPacks; }
    getPeakCachedBytes(): number { return this.peakCachedBytes; }
}
```

`getPack()` refreshes LRU order, downloads once, evicts until the cache contains
at most two entries, and updates peak byte counters. It stores `Uint8Array`
directly and never expands bytes into JavaScript number arrays.

- [ ] **Step 4: Run reader tests and typecheck**

Run: `npx vitest run src/backend/drive/__tests__/pack-reader.test.ts && npx tsc --noEmit`

Expected: integrity and cache tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/pack-reader.ts src/backend/drive/__tests__/pack-reader.test.ts
git commit -m "feat(drive): read v2 packs with bounded memory"
```

---

### Task 5: Add Idempotent Local Deletion by Sync Item Type

**Files:**
- Create: `src/st-adapter/delete.ts`
- Create: `src/st-adapter/__tests__/delete.test.ts`
- Modify: `src/st-adapter/http.ts`

**Interfaces:**
- Produces `stFetchDelete()` that accepts successful deletion plus configured missing statuses.
- Produces `deleteLocalItem(id, type)` for every deletable sync type.

- [ ] **Step 1: Write failing endpoint-mapping tests**

```ts
const post = vi.fn<(...args: [string, unknown, readonly number[]]) => Promise<void>>();
const savedSettings = { power_user: { personas: { 'me.png': 'Me' }, persona_descriptions: { 'me.png': { description: 'x' } } } };

vi.mock('../http', () => ({ stFetchDelete: (...args: [string, unknown, readonly number[]]) => post(...args) }));
vi.mock('../read', () => ({ readSettingsBundle: async () => structuredClone(savedSettings) }));
vi.mock('../write', () => ({ writeSettingsBundle: async (value: typeof savedSettings) => Object.assign(savedSettings, value) }));

it.each([
    ['worldinfo/book', 'worldinfo', '/api/worldinfo/delete', { name: 'book' }],
    ['preset/openai/main', 'preset', '/api/presets/delete', { apiId: 'openai', name: 'main' }],
    ['theme/moon', 'theme', '/api/themes/delete', { name: 'moon' }],
    ['quickreply/common', 'quickreply', '/api/quick-replies/delete', { name: 'common' }],
    ['character/alice.png', 'character', '/api/characters/delete', { avatar_url: 'alice.png', delete_chats: false }],
    ['chat/alice.png/day-1', 'chat', '/api/chats/delete', { avatar_url: 'alice.png', chatfile: 'day-1' }],
    ['group/42', 'group', '/api/groups/delete', { id: '42' }],
    ['groupchat/room-1', 'groupchat', '/api/chats/group/delete', { id: 'room-1' }],
])('maps %s to its SillyTavern delete endpoint', async (id, type, url, body) => {
    await deleteLocalItem(id, type as ItemType);
    expect(post).toHaveBeenCalledWith(url, body, [400, 404]);
});

it('removes persona image and metadata together', async () => {
    await deleteLocalItem('persona/me.png', 'persona');
    expect(post).toHaveBeenCalledWith('/api/avatars/delete', { avatar: 'me.png' }, [400, 404]);
    expect(savedSettings.power_user.personas['me.png']).toBeUndefined();
    expect(savedSettings.power_user.persona_descriptions['me.png']).toBeUndefined();
});

it('refuses to delete settings/root', async () => {
    await expect(deleteLocalItem('settings/root', 'settings')).rejects.toThrow('settings snapshot cannot be deleted');
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run src/st-adapter/__tests__/delete.test.ts`

Expected: FAIL because the deletion adapter does not exist.

- [ ] **Step 3: Implement strict, retry-safe deletion**

Add to `http.ts`:

```ts
export async function stFetchDelete(
    url: string,
    body: unknown,
    missingStatuses: readonly number[] = [404],
): Promise<void> {
    const ctx = getCtx();
    const res = await fetch(url, {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (res.ok || missingStatuses.includes(res.status)) return;
    throw new Error(`ST API ${url} failed: ${res.status}`);
}
```

`deleteLocalItem()` uses `parseItemId()` and the payloads asserted above.
For persona deletion, load current settings, remove both persona maps, save
settings, then delete the avatar file. For `settings`, throw before any request.

- [ ] **Step 4: Run deletion tests and typecheck**

Run: `npx vitest run src/st-adapter/__tests__/delete.test.ts && npx tsc --noEmit`

Expected: all endpoint and idempotency tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/st-adapter/delete.ts src/st-adapter/__tests__/delete.test.ts src/st-adapter/http.ts
git commit -m "feat(sync): apply snapshot deletions locally"
```

---

### Task 6: Apply a Drive Snapshot Serially with Deletions Last

**Files:**
- Create: `src/backend/drive/drive-v2-pull.ts`
- Create: `src/backend/drive/__tests__/drive-v2-pull.test.ts`
- Modify: `src/backend/drive/drive-v2-ui-state.ts`

**Interfaces:**
- Produces `runDriveV2Pull()` and `DriveV2PullResult`.
- Consumes `DriveV2PackReader`, authoritative preview, serial apply/delete callbacks, and base persistence.

- [ ] **Step 1: Write failing Pull-order and failure tests**

```ts
function pullHarness(input: {
    remote?: string[];
    localOnly?: string[];
    inSync?: string[];
    failItem?: string;
}) {
    const typeOf = (id: string): ItemType => id.split('/')[0] as ItemType;
    const remoteIds = [...new Set([...(input.remote ?? []), ...(input.inSync ?? []), ...(input.failItem ? [input.failItem] : [])])];
    const localIds = [...new Set([...(input.localOnly ?? []), ...(input.inSync ?? [])])];
    const events: string[] = [];
    let activeApplies = 0;
    let maxConcurrentApplies = 0;
    const remoteItems = Object.fromEntries(remoteIds.map(id => [id, {
        id, type: typeOf(id), hash: `hash:${id}`, size: 1, mtime: 1, chunks: [],
    } satisfies DrivePackItemV2]));
    const localItems = Object.fromEntries(localIds.map(id => [id, {
        id, type: typeOf(id), hash: `hash:${id}`, size: 1, mtime: 1,
    } satisfies SyncItem]));
    const options: DriveV2PullOptions = {
        commit: { fileId: 'manifest-id', commitId: 'head-b', parents: ['head-a'], createdTime: '' },
        manifest: {
            schema: 2, storage: 'drive-pack-v2', device: 'pc', updatedAt: 2,
            chunkBytes: DRIVE_V2_CHUNK_BYTES, packBytes: DRIVE_V2_PACK_BYTES, items: remoteItems,
        },
        local: { schema: 1, version: 1, device: 'phone', updatedAt: 1, items: localItems },
        localScanComplete: true,
        allowedTypes: new Set(remoteIds.concat(localIds).map(typeOf)),
        reader: {
            async readItem(item: DrivePackItemV2) {
                events.push(`read:${item.id}`);
                if (item.id === input.failItem) throw new Error(item.id);
                return new Uint8Array([1]);
            },
            getDownloadedPackCount: () => 0,
            getPeakCachedBytes: () => 0,
        } as unknown as DriveV2PackReader,
        async applyItem(id) {
            activeApplies += 1;
            maxConcurrentApplies = Math.max(maxConcurrentApplies, activeApplies);
            events.push(`apply:${id}`);
            await Promise.resolve();
            activeApplies -= 1;
        },
        async deleteItem(id) { events.push(`delete:${id}`); },
        async saveBlob() {},
        async saveBase(commitId) { events.push(`save-base:${commitId}`); },
        journal: {
            async start(commitId) { events.push(`journal-start:${commitId}`); },
            async markCompleted(itemId) { events.push(`journal-item:${itemId}`); },
            async finish(commitId) { events.push(`journal-finish:${commitId}`); },
        },
    };
    return {
        options,
        events,
        get maxConcurrentApplies() { return maxConcurrentApplies; },
    };
}

it('applies changed items serially and runs deletions last', async () => {
    const h = pullHarness({ remote: ['settings/root', 'character/a.png'], localOnly: ['chat/a.png/old'] });
    await runDriveV2Pull(h.options);
    expect(h.maxConcurrentApplies).toBe(1);
    expect(h.events).toEqual([
        'journal-start:head-b',
        'read:settings/root', 'apply:settings/root',
        'journal-item:settings/root',
        'read:character/a.png', 'apply:character/a.png',
        'journal-item:character/a.png',
        'delete:chat/a.png/old',
        'save-base:head-b',
        'journal-finish:head-b',
    ]);
});

it('does not delete or advance base after decrypt/apply failure', async () => {
    const h = pullHarness({ failItem: 'character/a.png', localOnly: ['chat/a.png/old'] });
    await expect(runDriveV2Pull(h.options)).rejects.toThrow('character/a.png');
    expect(h.events).not.toContain('delete:chat/a.png/old');
    expect(h.events.some(event => event.startsWith('save-base:'))).toBe(false);
    expect(h.events).not.toContain('journal-finish:head-b');
});

it('rejects an incomplete local scan before any read apply or deletion', async () => {
    const h = pullHarness({ remote: ['character/a.png'], localOnly: ['chat/a.png/old'] });
    h.options.localScanComplete = false;
    await expect(runDriveV2Pull(h.options)).rejects.toThrow('local scan incomplete');
    expect(h.events).toEqual([]);
});

it('skips items already matching the selected snapshot on retry', async () => {
    const h = pullHarness({ inSync: ['character/a.png'], remote: ['character/a.png', 'chat/a.png/new'] });
    const result = await runDriveV2Pull(h.options);
    expect(h.events).not.toContain('read:character/a.png');
    expect(result.skippedInSync).toBe(1);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/drive-v2-pull.test.ts`

Expected: FAIL because Pull orchestration does not exist.

- [ ] **Step 3: Implement authoritative Pull**

```ts
export interface DriveV2PullOptions {
    commit: DriveV2CommitMeta;
    manifest: DrivePackManifestV2;
    local: Manifest;
    localScanComplete: boolean;
    allowedTypes: ReadonlySet<ItemType>;
    reader: DriveV2PackReader;
    applyItem(id: string, type: ItemType, bytes: Uint8Array): Promise<void>;
    deleteItem(id: string, type: ItemType): Promise<void>;
    saveBlob(hash: string, bytes: Uint8Array): Promise<void>;
    saveBase(commitId: string): Promise<void>;
    journal: {
        start(commitId: string): Promise<void>;
        markCompleted(itemId: string): Promise<void>;
        finish(commitId: string): Promise<void>;
    };
    onProgress?(message: string): void;
    signal?: AbortSignal;
}
```

Build stable additions/replacements using the existing type order. For each,
read and verify one item, save typed bytes, apply serially, and release the
buffer. Only after that list completes, process authoritative deletions
serially. Call `saveBase(commit.commitId)` last. Report elapsed time, applied,
deleted, skipped, downloaded packs, and peak cached bytes.

Reject before `journal.start()` when `localScanComplete` is false. Otherwise
record the selected commit before the first read, call `markCompleted(id)`
after each successful apply, and call `finish(commitId)` only after deletions
and base persistence succeed. A retry still rescans and uses item hashes as the
source of truth; the journal is crash evidence and progress telemetry, not a
license to skip a mismatching local item.

Settings use the existing `mergePulledSettings()` path to preserve local-only
SillyTavern settings. Persona/settings completion still requests a page reload.

- [ ] **Step 4: Run Pull tests, typecheck, and memory assertions**

Run: `npx vitest run src/backend/drive/__tests__/drive-v2-pull.test.ts src/backend/drive/__tests__/pack-reader.test.ts && npx tsc --noEmit`

Expected: Pull ordering, no-delete-on-failure, resume, and byte-budget tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/drive-v2-pull.ts src/backend/drive/__tests__/drive-v2-pull.test.ts src/backend/drive/drive-v2-ui-state.ts
git commit -m "feat(drive): pull v2 snapshots with bounded memory"
```

---

### Task 7: Add Guarded Incremental Push and Resolve Stale Devices Explicitly

**Files:**
- Create: `src/backend/drive/drive-v2-sync.ts`
- Create: `src/backend/drive/__tests__/drive-v2-sync.test.ts`
- Modify: `src/backend/drive/drive-v2-push.ts`
- Modify: `src/backend/drive/__tests__/drive-v2-push.test.ts`
- Modify: `src/backend/runtime.ts`

**Interfaces:**
- Produces `DriveV2SourceChoice = 'drive' | 'local' | 'cancel'` and `runDriveV2Sync()`.
- Changes Push to accept `parents`, `baseCommitId`, and `forced` rather than rejecting an existing snapshot.

- [ ] **Step 1: Write failing head/base choice tests**

```ts
function syncHarness(input: {
    base: string | null;
    heads: string[];
    direction?: 'push' | 'pull';
    choice?: DriveV2SourceChoice;
}) {
    const events: string[] = [];
    let choiceCalls = 0;
    let committedParents: string[] = [];
    let committedManifest: Partial<DrivePackManifestV2> = {};
    const commits = input.heads.map(commitId => ({
        fileId: `file:${commitId}`, commitId, parents: [], createdTime: '',
    }));
    const remoteManifest: DrivePackManifestV2 = {
        schema: 2, storage: 'drive-pack-v2', device: 'remote', updatedAt: 2,
        chunkBytes: DRIVE_V2_CHUNK_BYTES, packBytes: DRIVE_V2_PACK_BYTES, items: {},
    };
    const runtime = {
        store: {
            async listCommits() { return commits; },
            async readManifest() { return remoteManifest; },
        },
    } as unknown as DriveV2Runtime;
    const options: DriveV2SyncOptions = {
        direction: input.direction ?? 'push',
        runtime,
        namespace: 'drive:root',
        local: { schema: 1, version: 1, device: 'local', updatedAt: 1, items: {} },
        allowedTypes: new Set<ItemType>(),
        loadBase: async () => input.base ? { commitId: input.base, syncedAt: 1 } : null,
        async chooseSource() { choiceCalls += 1; return input.choice ?? { kind: 'cancel' }; },
        async runPull(commit) { events.push(`pull:${commit.commitId}`); return {} as DriveV2PullResult; },
        async runPush(push) {
            committedParents = [...push.parents];
            committedManifest = { baseCommitId: push.baseCommitId, forced: push.forced };
            events.push(`push:${push.parents.join(',')}`);
            return { commitId: 'new-head', manifest: committedManifest } as DriveV2PushResult;
        },
    };
    return {
        options,
        events,
        get choiceCalls() { return choiceCalls; },
        get committedParents() { return committedParents; },
        get committedManifest() { return committedManifest; },
    };
}

it('pushes directly when device base equals the single Drive head', async () => {
    const h = syncHarness({ base: 'head-a', heads: ['head-a'], direction: 'push' });
    await runDriveV2Sync(h.options);
    expect(h.choiceCalls).toBe(0);
    expect(h.committedParents).toEqual(['head-a']);
});

it('pulls the selected head when a stale device chooses a Drive snapshot', async () => {
    const h = syncHarness({ base: 'head-a', heads: ['head-b'], choice: { kind: 'drive', commitId: 'head-b' } });
    await runDriveV2Sync(h.options);
    expect(h.events).toContain('pull:head-b');
    expect(h.events.some(event => event.startsWith('push:'))).toBe(false);
});

it('force-pushes this device and closes every current head', async () => {
    const h = syncHarness({ base: 'head-a', heads: ['head-b', 'head-c'], choice: { kind: 'local' } });
    await runDriveV2Sync(h.options);
    expect(h.committedParents.sort()).toEqual(['head-b', 'head-c']);
    expect(h.committedManifest).toMatchObject({ baseCommitId: 'head-a', forced: true });
});

it('changes nothing when the owner cancels', async () => {
    const h = syncHarness({ base: 'head-a', heads: ['head-b'], choice: { kind: 'cancel' } });
    await expect(runDriveV2Sync(h.options)).resolves.toMatchObject({ kind: 'cancelled' });
    expect(h.events).toEqual([]);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/drive-v2-sync.test.ts src/backend/drive/__tests__/drive-v2-push.test.ts`

Expected: FAIL because v2 sync coordinator and incremental Push options do not exist.

- [ ] **Step 3: Implement the coordinator and incremental Push**

```ts
export type DriveV2SourceChoice =
    | { kind: 'drive'; commitId: string }
    | { kind: 'local' }
    | { kind: 'cancel' };

export interface DriveV2SyncOptions {
    direction: 'push' | 'pull';
    runtime: DriveV2Runtime;
    namespace: string;
    local: Manifest;
    allowedTypes: ReadonlySet<ItemType>;
    loadBase(): Promise<DriveV2BaseState | null>;
    chooseSource(input: DriveV2ChoiceInput): Promise<DriveV2SourceChoice>;
    runPull(commit: DriveV2CommitMeta, manifest: DrivePackManifestV2): Promise<DriveV2PullResult>;
    runPush(input: { parents: string[]; baseCommitId?: string; forced: boolean }): Promise<DriveV2PushResult>;
}
```

Resolve and decrypt Drive heads before choosing. A Phase-1 commit without
parents is the genesis head. For direct Push, parent the current head and set
`forced=false`. For owner-selected local replacement, parent every current
head and set `forced=true`. Save the returned commit as the device base only
after Push success. Remove the `hasCommittedSnapshot()` rejection from the
Push path; pack reuse and atomic commit stay unchanged.

- [ ] **Step 4: Run sync, Push, store, and full tests**

Run: `npx vitest run src/backend/drive/__tests__/drive-v2-sync.test.ts src/backend/drive/__tests__/drive-v2-push.test.ts src/backend/drive/__tests__/pack-store.test.ts && npm test && npx tsc --noEmit`

Expected: selected and full tests PASS; Phase-1 Push tests remain valid as a
zero-parent genesis Push.

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/drive-v2-sync.ts src/backend/drive/__tests__/drive-v2-sync.test.ts src/backend/drive/drive-v2-push.ts src/backend/drive/__tests__/drive-v2-push.test.ts src/backend/runtime.ts
git commit -m "feat(drive): guard v2 snapshot updates"
```

---

### Task 8: Expose Pull, Status, and the Single Source-Choice Dialog

**Files:**
- Create: `src/ui/drive-v2-source-choice.ts`
- Create: `src/ui/__tests__/drive-v2-source-choice.test.ts`
- Modify: `src/index.ts`
- Modify: `src/sync/engine.ts`
- Modify: `src/backend/__tests__/runtime-drive.test.ts`
- Modify: `src/backend/drive/__tests__/drive-v2-ui-state.test.ts`
- Modify: `panel.html`
- Modify generated: `dist/index.0.2.0.js`

**Interfaces:**
- Produces `buildDriveV2ChoiceModel()`, `promptDriveV2SourceChoice()`, and `driveV2Visibility()` with one dialog and no nested popup.
- Routes v2 Push, Pull, and Check Status through `runDriveV2Sync()`.

- [ ] **Step 1: Write failing UI and engine routing tests**

```ts
// In the engine-routing test file, keep module mocks explicit and resettable.
const settingsFixture = { backendMode: 'drive', driveRootVersion: 2 };
const driveV2SyncMock = vi.fn();
vi.mock('../../settings', () => ({ getSettings: () => settingsFixture }));
vi.mock('../../backend/drive/drive-v2-sync', () => ({
    runDriveV2Sync: (...args: unknown[]) => driveV2SyncMock(...args),
}));

function mockSettings(value: Partial<typeof settingsFixture>): void {
    Object.assign(settingsFixture, value);
}

function mockRunDriveV2Sync(implementation: (...args: any[]) => any): void {
    driveV2SyncMock.mockImplementation(implementation);
}

function choiceFixture(): DriveV2ChoiceInput {
    return {
        local: { device: 'Zzz_pc', itemCount: 2347, add: 1, replace: 2, delete: 3 },
        heads: [{
            commitId: 'phone-head', device: 'Zzz_iPhone', createdTime: '2026-08-09T12:00:00Z',
            itemCount: 2350, add: 4, replace: 5, delete: 3,
        }],
    };
}

it('renders Drive, this device, and cancel in one decision model', () => {
    const model = buildDriveV2ChoiceModel(choiceFixture());
    expect(model.actions.map(action => action.choice)).toEqual([
        { kind: 'drive', commitId: 'phone-head' },
        { kind: 'local' },
        { kind: 'cancel' },
    ]);
    expect(model.selectedActionId).toBeNull();
    expect(model.text).toContain('Zzz_iPhone');
    expect(model.text).toContain('3 deleted');
});

it.each(['push', 'pull'] as const)('routes Drive v2 %s through the v2 coordinator', async direction => {
    const directions: string[] = [];
    mockSettings({ backendMode: 'drive', driveRootVersion: 2 });
    mockRunDriveV2Sync(async options => {
        directions.push(options.direction);
        return { kind: 'cancelled' };
    });
    await runSync({ direction, chooseDriveV2Source: async () => ({ kind: 'drive', commitId: 'phone-head' }) });
    expect(directions).toContain(direction);
});

it('shows v2 Pull and Status controls', () => {
    expect(driveV2Visibility()).toEqual({ push: true, pull: true, status: true, autoSync: false });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run src/ui/__tests__/drive-v2-source-choice.test.ts src/backend/drive/__tests__/drive-v2-ui-state.test.ts src/backend/__tests__/runtime-drive.test.ts`

Expected: FAIL because v2 choice UI/routing is absent and Pull remains hidden.

- [ ] **Step 3: Implement one explicit chooser and engine integration**

```ts
export async function promptDriveV2SourceChoice(
    input: DriveV2ChoiceInput,
): Promise<DriveV2SourceChoice>;

export interface DriveV2ChoiceModel {
    text: string;
    actions: readonly { id: string; label: string; choice: DriveV2SourceChoice }[];
    selectedActionId: string | null;
}

export function buildDriveV2ChoiceModel(input: DriveV2ChoiceInput): DriveV2ChoiceModel {
    const headText = input.heads.map(head =>
        `${head.device} · ${head.itemCount} items · ${head.add} added · ${head.replace} replaced · ${head.delete} deleted`,
    ).join('\n');
    const local = input.local;
    return {
        text: `${headText}\n${local.device} · ${local.itemCount} items · ${local.add} added · ${local.replace} replaced · ${local.delete} deleted`,
        actions: [
            ...input.heads.map(head => ({
                id: `drive:${head.commitId}`,
                label: `Use Drive snapshot from ${head.device}`,
                choice: { kind: 'drive' as const, commitId: head.commitId! },
            })),
            { id: 'local', label: 'Make this device latest', choice: { kind: 'local' as const } },
            { id: 'cancel', label: 'Cancel', choice: { kind: 'cancel' as const } },
        ],
        selectedActionId: null,
    };
}

export function driveV2Visibility(): { push: true; pull: true; status: true; autoSync: false } {
    return { push: true, pull: true, status: true, autoSync: false };
}
```

Render one `callGenericPopup` containing one radio group for every decrypted
Drive head, **This device**, and **Cancel**. Each row includes device name,
Drive server-created time, item count, and add/replace/delete counts. No radio
button starts selected; closing the dialog returns `cancel`.

In `updateBackendFieldsVisibility()`, show Push, Pull, and Status for Drive v2;
keep automatic startup/chat-close sync disabled. Remove Phase-1 Pull/status
toasts and the non-push engine rejection. `handlePush()` and `handlePull()` pass
the same v2 chooser. `handleStatus()` reports Drive head(s), device base, and
current/stale state without mutating either side.

Engine Pull integrates `PullCrashJournal`, typed `storeBlob`, settings merge,
serial `applyLocalItem`, `deleteLocalItem`, and base persistence. Only v2 code
uses the new coordinator; legacy runtime remains byte-compatible.

- [ ] **Step 4: Run UI, runtime, full tests, typecheck, and build**

Run:

```bash
npx vitest run src/ui/__tests__/drive-v2-source-choice.test.ts src/backend/drive/__tests__/drive-v2-ui-state.test.ts src/backend/__tests__/runtime-drive.test.ts
npm test
npx tsc --noEmit
npm run build
git diff --check
```

Expected: all tests PASS, TypeScript/build exit 0, and diff-check is empty.

- [ ] **Step 5: Commit**

```bash
git add src/ui/drive-v2-source-choice.ts src/ui/__tests__/drive-v2-source-choice.test.ts src/index.ts src/sync/engine.ts src/backend/__tests__/runtime-drive.test.ts src/backend/drive/__tests__/drive-v2-ui-state.test.ts panel.html dist/index.0.2.0.js
git commit -m "feat(drive): expose latest-snapshot sync"
```

---

### Task 9: Verify Compatibility and Run the Real iPhone Round Trip

**Files:**
- Create after live runs: `docs/superpowers/evidence/2026-08-09-drive-v2-latest-snapshot-sync.md`

- [ ] **Step 1: Run the complete automated gate**

Run:

```bash
npm test
npx tsc --noEmit
npm run build
git diff --check
git diff origin/master...HEAD -- src/backend/http.ts src/sync-core package-lock.json
```

Expected:

- every Vitest test passes;
- TypeScript and webpack exit 0;
- diff-check prints nothing;
- HTTP/OG and `package-lock.json` are absent from the feature diff;
- only the owner's pre-existing `package-lock.json` remains dirty in the live checkout.

- [ ] **Step 2: Inspect encrypted metadata boundaries**

Use fixture secrets in tests and inspect Drive test doubles. Verify device
names, item IDs, types, counts, base commit, and force flag appear only inside
encrypted manifest bytes. App properties may contain only `ts=commit-v2` and
parent ciphertext hashes.

- [ ] **Step 3: Pull the existing PC snapshot to iPhone**

1. Update SillyiOS TavernSync to the tested commit.
2. Connect Google and unlock the same passphrase.
3. Start native USB syslog capture.
4. Press Pull and choose the Drive snapshot.
5. Record item count, pack downloads, elapsed seconds, peak byte budget,
   retries, skipped items, deletions, and final base commit.
6. Verify representative settings, personas, characters, chats, groups,
   images, lorebooks, presets, themes, and quick replies.
7. Restart SillyiOS and verify data persists.

Expected: 2,347 items match the PC snapshot, no skipped items, no Jetsam or
WebContent termination, and elapsed time is at most 15 minutes.

- [ ] **Step 4: Verify iPhone edit/delete → PC round trip**

1. On iPhone, modify one chat, create one chat, and delete one old chat.
2. Push from iPhone; when stale, choose **This device**.
3. On PC, Check Status and Pull; choose the iPhone Drive snapshot.
4. Verify the changed/new/deleted chats match the preview exactly.
5. Attempt a stale PC Push, choose **This device**, and verify PC becomes the
   new single head without an automatic merge.

- [ ] **Step 5: Record evidence and commit**

Write the tested commits, exact timings, item counts, choice flows, native log
result, failures/retries, and remaining risks in the evidence document.

```bash
git add docs/superpowers/evidence/2026-08-09-drive-v2-latest-snapshot-sync.md
git commit -m "docs(drive): record latest-snapshot sync benchmark"
```

## Final Verification Gate

- [ ] Existing Phase-1 commit is read as a genesis head without Reset.
- [ ] Drive / This device / Cancel appear in one dialog with no default.
- [ ] A stale device never Pushes without the owner's explicit choice.
- [ ] Drive-authoritative Pull applies additions/replacements and then deletions.
- [ ] Disabled scopes and incomplete scans cannot cause deletion.
- [ ] Pull failure leaves deletion queue untouched and base commit unchanged.
- [ ] Incremental Push reuses existing packs and publishes one parent-linked encrypted manifest last.
- [ ] Pack reader retains at most two packs plus one item buffer.
- [ ] HTTP/OG, legacy Drive v1, and `package-lock.json` remain unchanged.
- [ ] Full automated gate and live iPhone round trip pass before merge to stable.
