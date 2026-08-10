# Drive v2 Extension-Only Adaptive Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Drive v2 Core/fixed-batch Pull with an extension-only, bounded-memory rolling restore that always Pulls the newest committed Drive snapshot, resumes after interruption, propagates deletions last, and preserves every existing sync and maintenance control.

**Architecture:** Keep encrypted-pack Push and HTTP/OG unchanged. Drive v2 Pull resolves the newest manifest, builds a lightweight local ID inventory, range-downloads and verifies one item at a time under encrypted/plaintext byte budgets, then feeds cost-aware rolling writers backed by existing SillyTavern APIs. Checkpoints persist in extension settings; deletions and base advancement occur only after all writes succeed.

**Tech Stack:** TypeScript 5.8, Vitest 3, Web Crypto, Google Drive REST range requests, SillyTavern extension APIs, jQuery UI, Webpack 5.

## Global Constraints

- The user installs or updates TavernSync only; no Core patch, Companion, server plugin, configuration edit, terminal, Git, native addon, WASM, child process, or special IPA.
- The TavernSync Encryption passphrase remains the only encryption secret the user creates and remembers.
- Pull always selects the newest committed Drive snapshot; Pull never runs full local content scan, content diff, merge, or a local/Drive chooser.
- Stale Push still shows **Use Drive snapshot**, **Make this device latest**, and **Cancel**.
- Encrypted prefetch is capped at 64 MiB; reconstructed plaintext in flight is capped at 48 MiB.
- Pull has no fixed four-item batch barrier; a free writer immediately accepts the next ready job.
- Writes finish before serial deletion; failure or cancellation runs no deletion and does not advance `baseCommitId`.
- Checkpoint every 25 completions or two seconds and immediately on error/cancel.
- Preserve Push, Pull, Check Status, scopes, auto-sync, deletion propagation, Google connection, encryption, rescan, logs, reset, wipe, cleanup, Root reset, and Push resume controls.
- HTTP/OG behavior and encrypted-pack Push remain unchanged.
- Live tests use a disposable Data Root on a separate port; never replace the owner's primary port or Data Root.
- Do not stage, commit, delete, or modify the pre-existing `.omo/` directory.

## File Structure

- `src/backend/drive/drive-v2-head.ts` — deterministic newest-head selection.
- `src/st-adapter/inventory.ts` — lightweight ID/type inventory using list endpoints only.
- `src/backend/drive/byte-budget.ts` — abortable encrypted/plaintext byte permits and peak tracking.
- `src/backend/drive/verified-item-reader.ts` — range-download, decrypt, authenticate, and assemble one item.
- `src/backend/drive/adaptive-pull-queue.ts` — dependency-aware rolling writers and adaptive concurrency.
- `src/backend/drive/pull-checkpoint.ts` — throttled, server-persisted extension checkpoint.
- `src/backend/drive/drive-v2-pull.ts` — end-to-end extension-only Pull orchestration.
- `src/sync/engine.ts` — Drive v2 routing and ST adapter integration.
- `src/backend/drive/drive-v2-ui-state.ts`, `src/index.ts`, `panel.html` — progress and preserved controls.
- `src/backend/drive/gc-v2.ts` — manual, active-head-safe v2 cleanup.
- Remove `src/backend/drive/core-restore.ts`, `src/backend/restore-session/`, and Core-only tests/UI copy after replacement tests pass.

---

### Task 1: Deterministic Newest Snapshot Selection

**Files:**
- Modify: `src/backend/drive/drive-v2-head.ts`
- Modify: `src/backend/drive/drive-v2-sync.ts`
- Modify: `src/backend/drive/__tests__/drive-v2-head.test.ts`
- Modify: `src/backend/drive/__tests__/drive-v2-sync.test.ts`

**Interfaces:**
- Consumes: `DriveV2CommitMeta`.
- Produces: `selectNewestDriveV2Head(heads: readonly DriveV2CommitMeta[]): DriveV2CommitMeta`.

- [ ] **Step 1: Write failing newest-head tests**

```ts
it('selects by Drive createdTime then Drive fileId, never device time or commit name', () => {
    const heads = [
        { fileId: 'file-z', commitId: 'commit-a', parents: [], createdTime: '2026-08-10T01:00:00Z' },
        { fileId: 'file-a', commitId: 'commit-z', parents: [], createdTime: '2026-08-10T02:00:00Z' },
        { fileId: 'file-z', commitId: 'commit-b', parents: [], createdTime: '2026-08-10T02:00:00Z' },
    ];
    expect(selectNewestDriveV2Head(heads).commitId).toBe('commit-b');
});

it('Pull chooses newest head without invoking chooseSource', async () => {
    const h = syncHarness({ base: 'old', heads: ['older', 'newer'], direction: 'pull' });
    h.options.runtime.store.listCommits = async () => [
        { fileId: 'f1', commitId: 'older', parents: [], createdTime: '2026-08-10T01:00:00Z' },
        { fileId: 'f2', commitId: 'newer', parents: [], createdTime: '2026-08-10T02:00:00Z' },
    ];
    await runDriveV2Sync(h.options);
    expect(h.choiceCalls).toBe(0);
    expect(h.events).toEqual(['pull:newer']);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/drive-v2-head.test.ts src/backend/drive/__tests__/drive-v2-sync.test.ts`

Expected: FAIL because `selectNewestDriveV2Head` is missing and current tie-breaking uses `commitId`.

- [ ] **Step 3: Implement newest-head selection and use it only for Pull**

```ts
export function selectNewestDriveV2Head(
    heads: readonly DriveV2CommitMeta[],
): DriveV2CommitMeta {
    if (heads.length === 0) throw new Error('Drive v2 has no committed snapshot');
    return [...heads].sort((a, b) =>
        b.createdTime.localeCompare(a.createdTime)
        || b.fileId.localeCompare(a.fileId))[0];
}
```

Replace the inline Pull sort in `runDriveV2Sync` with:

```ts
const newestHead = selectNewestDriveV2Head(heads);
const manifest = await store.readManifest(newestHead);
return { kind: 'pulled', result: await options.runPull(newestHead, manifest) };
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run src/backend/drive/__tests__/drive-v2-head.test.ts src/backend/drive/__tests__/drive-v2-sync.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/drive-v2-head.ts src/backend/drive/drive-v2-sync.ts src/backend/drive/__tests__/drive-v2-head.test.ts src/backend/drive/__tests__/drive-v2-sync.test.ts
git commit -m "fix(drive): select latest snapshot deterministically"
```

---

### Task 2: Lightweight Local Inventory and Complete Scope Writers

**Files:**
- Create: `src/st-adapter/inventory.ts`
- Create: `src/st-adapter/__tests__/inventory.test.ts`
- Modify: `src/st-adapter/write.ts`
- Create: `src/st-adapter/__tests__/write.test.ts`

**Interfaces:**
- Consumes: `ReadonlySet<ItemType>` and existing ST list endpoints.
- Produces: `listLocalInventory(allowedTypes: ReadonlySet<ItemType>, api?: InventoryApi): Promise<Map<string, ItemType>>`.

- [ ] **Step 1: Write failing inventory tests**

```ts
it('lists IDs without downloading chat bodies or character PNG bytes', async () => {
    const calls: string[] = [];
    const api = {
        async postJson<T>(url: string): Promise<T> {
            calls.push(url);
            const values: Record<string, unknown> = {
                '/api/settings/get': { settings: JSON.stringify({ power_user: { personas: { 'me.png': 'Me' } } }), world_names: ['Lore'], themes: [{ name: 'Dark' }], quickReplyPresets: [{ name: 'QR' }], koboldai_setting_names: ['K'], koboldai_settings: [{}] },
                '/api/characters/all': [{ avatar: 'Alice.png' }],
                '/api/characters/chats': [{ file_id: 'chat-1', file_name: 'chat-1.jsonl' }],
                '/api/groups/all': [{ id: 'g1', chats: ['gc1'] }],
            };
            return values[url] as T;
        },
    };
    const inventory = await listLocalInventory(new Set<ItemType>([
        'settings', 'worldinfo', 'preset', 'theme', 'quickreply', 'persona',
        'character', 'chat', 'group', 'groupchat',
    ]), api);
    expect([...inventory.keys()].sort()).toEqual([
        'character/Alice.png', 'chat/Alice.png/chat-1', 'group/g1', 'groupchat/gc1',
        'persona/me.png', 'preset/kobold/K', 'quickreply/QR', 'settings/root',
        'theme/Dark', 'worldinfo/Lore',
    ]);
    expect(calls).not.toContain('/api/chats/get');
    expect(calls.every(url => !url.startsWith('/characters/'))).toBe(true);
});

it('never lists disabled scopes', async () => {
    const api: InventoryApi = {
        async postJson<T>(url: string): Promise<T> {
            if (url === '/api/settings/get') return { settings: '{}' } as T;
            if (url === '/api/characters/all') return [{ avatar: 'Alice.png' }] as T;
            if (url === '/api/groups/all') return [] as T;
            return [] as T;
        },
    };
    const inventory = await listLocalInventory(new Set<ItemType>(['character']), api);
    expect([...inventory.values()]).toEqual(['character']);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/st-adapter/__tests__/inventory.test.ts`

Expected: FAIL because `inventory.ts` does not exist.

- [ ] **Step 3: Implement list-only inventory**

```ts
import type { ItemType } from '../sync-core/types';
import { stFetchJson } from './http';

export interface InventoryApi {
    postJson<T>(url: string, body?: unknown): Promise<T>;
}

const defaultApi: InventoryApi = { postJson: stFetchJson };

function add(out: Map<string, ItemType>, allowed: ReadonlySet<ItemType>, type: ItemType, id: string): void {
    if (allowed.has(type) && id) out.set(`${type}/${id}`, type);
}

export async function listLocalInventory(
    allowed: ReadonlySet<ItemType>,
    api: InventoryApi = defaultApi,
): Promise<Map<string, ItemType>> {
    const out = new Map<string, ItemType>();
    const settingsTypes: ItemType[] = ['settings', 'worldinfo', 'preset', 'theme', 'quickreply', 'persona'];
    if (settingsTypes.some(type => allowed.has(type))) {
        const raw = await api.postJson<Record<string, unknown>>('/api/settings/get', {});
        if (allowed.has('settings')) out.set('settings/root', 'settings');
        for (const name of (raw.world_names as string[] | undefined) ?? []) add(out, allowed, 'worldinfo', name);
        for (const theme of (raw.themes as Array<{ name?: string }> | undefined) ?? []) add(out, allowed, 'theme', theme.name ?? '');
        for (const qr of (raw.quickReplyPresets as Array<{ name?: string }> | undefined) ?? []) add(out, allowed, 'quickreply', qr.name ?? '');
        const settings = JSON.parse(typeof raw.settings === 'string' ? raw.settings : '{}') as Record<string, unknown>;
        const power = settings.power_user as { personas?: Record<string, unknown> } | undefined;
        for (const avatar of Object.keys(power?.personas ?? {})) add(out, allowed, 'persona', avatar);
        const presetSources = [
            ['kobold', 'koboldai_setting_names'], ['novel', 'novelai_setting_names'],
            ['openai', 'openai_setting_names'], ['textgenerationwebui', 'textgenerationwebui_preset_names'],
        ] as const;
        for (const [apiId, key] of presetSources) {
            for (const name of (raw[key] as string[] | undefined) ?? []) add(out, allowed, 'preset', `${apiId}/${name}`);
        }
        for (const apiId of ['instruct', 'context', 'sysprompt', 'reasoning'] as const) {
            for (const preset of (raw[apiId] as Array<{ name?: string }> | undefined) ?? []) {
                if (preset.name) add(out, allowed, 'preset', `${apiId}/${preset.name}`);
            }
        }
    }
    if (allowed.has('character') || allowed.has('chat')) {
        const chars = await api.postJson<Array<{ avatar?: string }>>('/api/characters/all', {});
        for (const character of Array.isArray(chars) ? chars : []) {
            if (!character.avatar) continue;
            add(out, allowed, 'character', character.avatar);
            if (!allowed.has('chat')) continue;
            const chats = await api.postJson<Array<{ file_id?: string; file_name?: string }>>('/api/characters/chats', { avatar_url: character.avatar });
            for (const chat of Array.isArray(chats) ? chats : []) {
                const id = chat.file_id ?? chat.file_name?.replace(/\.jsonl$/i, '');
                if (id) add(out, allowed, 'chat', `${character.avatar}/${id}`);
            }
        }
    }
    if (allowed.has('group') || allowed.has('groupchat')) {
        const groups = await api.postJson<Array<{ id?: string; chats?: string[] }>>('/api/groups/all', {});
        for (const group of Array.isArray(groups) ? groups : []) {
            if (group.id) add(out, allowed, 'group', group.id);
            for (const chatId of group.chats ?? []) add(out, allowed, 'groupchat', chatId);
        }
    }
    return out;
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run src/st-adapter/__tests__/inventory.test.ts`

Expected: PASS and no mocked content endpoint is called.

- [ ] **Step 5: Write failing theme and quick-reply writer tests**

```ts
const postJson = vi.fn(async () => undefined);
vi.mock('../http', () => ({
    stFetchJson: (...args: unknown[]) => postJson(...args),
    stFetchForm: vi.fn(),
}));

it.each([
    ['theme', 'theme/Dark', '/api/themes/save'],
    ['quickreply', 'quickreply/QR', '/api/quick-replies/save'],
] as const)('writes %s through its existing ST endpoint', async (type, id, url) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ name: id.split('/')[1] }));
    await applyLocalItem(id, type, bytes, false);
    expect(postJson).toHaveBeenCalledWith(url, { name: id.split('/')[1] });
});
```

- [ ] **Step 6: Run writer tests and verify RED**

Run: `npx vitest run src/st-adapter/__tests__/write.test.ts`

Expected: FAIL because current `applyLocalItem` logs and skips both types.

- [ ] **Step 7: Implement both existing endpoint calls**

Replace the skip branch with:

```ts
case 'theme': {
    await stFetchJson('/api/themes/save', decodeUtf8Json(bytes));
    break;
}
case 'quickreply': {
    await stFetchJson('/api/quick-replies/save', decodeUtf8Json(bytes));
    break;
}
```

- [ ] **Step 8: Run inventory and writer tests**

Run: `npx vitest run src/st-adapter/__tests__/inventory.test.ts src/st-adapter/__tests__/write.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/st-adapter/inventory.ts src/st-adapter/__tests__/inventory.test.ts src/st-adapter/write.ts src/st-adapter/__tests__/write.test.ts
git commit -m "feat(drive): complete scoped restore adapters"
```

---

### Task 3: Abortable Byte Budgets

**Files:**
- Create: `src/backend/drive/byte-budget.ts`
- Create: `src/backend/drive/__tests__/byte-budget.test.ts`

**Interfaces:**
- Produces: `ByteBudget.acquire(bytes: number, signal?: AbortSignal): Promise<BytePermit>`.
- `BytePermit.release()` is idempotent.
- Oversized single items may acquire exclusively to avoid deadlock but remain visible in peak usage.

- [ ] **Step 1: Write failing budget tests**

```ts
it('blocks until enough bytes are released and reports peak usage', async () => {
    const budget = new ByteBudget(10);
    const first = await budget.acquire(8);
    let secondReady = false;
    const secondPromise = budget.acquire(5).then(value => { secondReady = true; return value; });
    await Promise.resolve();
    expect(secondReady).toBe(false);
    first.release();
    const second = await secondPromise;
    expect(budget.peakBytes).toBe(8);
    second.release();
    expect(budget.usedBytes).toBe(0);
});

it('allows one oversized item only when the budget is otherwise empty', async () => {
    const budget = new ByteBudget(10);
    const permit = await budget.acquire(15);
    expect(budget.usedBytes).toBe(15);
    permit.release();
});

it('removes an aborted waiter without leaking capacity', async () => {
    const budget = new ByteBudget(1);
    const held = await budget.acquire(1);
    const abort = new AbortController();
    const waiting = budget.acquire(1, abort.signal);
    abort.abort(new DOMException('cancelled', 'AbortError'));
    await expect(waiting).rejects.toThrow(/cancelled/);
    held.release();
    expect(budget.usedBytes).toBe(0);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/byte-budget.test.ts`

Expected: FAIL because `ByteBudget` is missing.

- [ ] **Step 3: Implement `ByteBudget`**

```ts
export interface BytePermit { readonly bytes: number; release(): void }

interface Waiter {
    bytes: number;
    resolve(value: BytePermit): void;
    reject(error: unknown): void;
    signal?: AbortSignal;
}

export class ByteBudget {
    usedBytes = 0;
    peakBytes = 0;
    private readonly waiters: Waiter[] = [];

    constructor(readonly capacityBytes: number) {
        if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 1) throw new RangeError('invalid byte budget');
    }

    acquire(bytes: number, signal?: AbortSignal): Promise<BytePermit> {
        if (!Number.isSafeInteger(bytes) || bytes < 1) return Promise.reject(new RangeError('invalid byte request'));
        signal?.throwIfAborted();
        return new Promise((resolve, reject) => {
            const waiter: Waiter = { bytes, resolve, reject, signal };
            const onAbort = () => {
                const index = this.waiters.indexOf(waiter);
                if (index >= 0) this.waiters.splice(index, 1);
                reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            const originalResolve = waiter.resolve;
            waiter.resolve = value => {
                signal?.removeEventListener('abort', onAbort);
                originalResolve(value);
            };
            this.waiters.push(waiter);
            this.drain();
        });
    }

    private drain(): void {
        for (;;) {
            const next = this.waiters[0];
            if (!next) return;
            const fits = this.usedBytes + next.bytes <= this.capacityBytes;
            const exclusiveOversize = this.usedBytes === 0 && next.bytes > this.capacityBytes;
            if (!fits && !exclusiveOversize) return;
            this.waiters.shift();
            this.usedBytes += next.bytes;
            this.peakBytes = Math.max(this.peakBytes, this.usedBytes);
            let released = false;
            next.resolve({
                bytes: next.bytes,
                release: () => {
                    if (released) return;
                    released = true;
                    this.usedBytes -= next.bytes;
                    this.drain();
                },
            });
        }
    }
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run src/backend/drive/__tests__/byte-budget.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/byte-budget.ts src/backend/drive/__tests__/byte-budget.test.ts
git commit -m "feat(drive): bound pull memory permits"
```

---

### Task 4: Verified Range-Based Item Reader

**Files:**
- Create: `src/backend/drive/verified-item-reader.ts`
- Create: `src/backend/drive/__tests__/verified-item-reader.test.ts`
- Keep: `src/backend/drive/range-source.ts`
- Modify: `src/backend/drive/__tests__/range-source.test.ts`

**Interfaces:**
- Consumes: `DrivePackItemV2`, `DriveRangeSource`, `DrivePackCrypto.decryptChunk`, encrypted and plaintext `ByteBudget`.
- Produces: `readVerifiedItem(...): Promise<PreparedDriveItem>` where caller must invoke `release()` after applying.

- [ ] **Step 1: Write failing reader tests**

```ts
async function packedItem(id: string, parts: Uint8Array[]): Promise<DrivePackItemV2> {
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    const chunks = [];
    for (const part of parts) {
        bytes.set(part, offset);
        chunks.push({
            packName: 'pack-a', offset, boxedLength: part.byteLength,
            plainLength: part.byteLength, chunkHash: await sha256Hex(part),
        });
        offset += part.byteLength;
    }
    return {
        id, type: id.split('/')[0] as ItemType, size: bytes.byteLength,
        hash: await sha256Hex(bytes), mtime: 1, chunks,
    };
}

it('range-reads, decrypts and verifies one item without retaining encrypted chunks', async () => {
    const parts = [new TextEncoder().encode('hello '), new TextEncoder().encode('world')];
    const item = await packedItem('chat/a/one', parts);
    const encrypted = new ByteBudget(64);
    const plaintext = new ByteBudget(64);
    let read = 0;
    const prepared = await readVerifiedItem({
        item,
        source: { readChunk: async () => parts[read++].slice() },
        crypto: { decryptChunk: async bytes => bytes },
        encryptedBudget: encrypted,
        plaintextBudget: plaintext,
    });
    expect(new TextDecoder().decode(prepared.bytes)).toBe('hello world');
    expect(encrypted.usedBytes).toBe(0);
    expect(plaintext.usedBytes).toBe(11);
    prepared.release();
    expect(plaintext.usedBytes).toBe(0);
});

it('zeros and releases plaintext after item hash failure', async () => {
    const item = await packedItem('chat/a/bad', [new Uint8Array([1, 2])]);
    item.hash = '0'.repeat(64);
    const plaintext = new ByteBudget(64);
    await expect(readVerifiedItem({
        item,
        source: { readChunk: async () => new Uint8Array([1, 2]) },
        crypto: { decryptChunk: async bytes => bytes },
        encryptedBudget: new ByteBudget(64), plaintextBudget: plaintext,
    })).rejects.toThrow(/item hash/i);
    expect(plaintext.usedBytes).toBe(0);
});

it.each([408, 429, 500])('retries Drive HTTP %s before succeeding', async status => {
    const getFileRange = vi.fn()
        .mockRejectedValueOnce(new DriveHttpError(status, 'temporary'))
        .mockResolvedValue(new Uint8Array([1]));
    const source = new DriveRangeSource({
        listPacks: async () => new Map([['pack', { id: 'file', name: 'pack', size: 1 }]]),
    }, { getFileRange }, { delays: [0], sleep: async () => undefined });
    await expect(source.readChunk({ packName: 'pack', offset: 0, boxedLength: 1 }))
        .resolves.toEqual(new Uint8Array([1]));
    expect(getFileRange).toHaveBeenCalledTimes(2);
});

it('does not retry expired Google authorization', async () => {
    const getFileRange = vi.fn().mockRejectedValue(new DriveAuthError());
    const source = new DriveRangeSource({
        listPacks: async () => new Map([['pack', { id: 'file', name: 'pack', size: 1 }]]),
    }, { getFileRange }, { delays: [0], sleep: async () => undefined });
    await expect(source.readChunk({ packName: 'pack', offset: 0, boxedLength: 1 }))
        .rejects.toBeInstanceOf(DriveAuthError);
    expect(getFileRange).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/verified-item-reader.test.ts`

Expected: FAIL because `readVerifiedItem` is missing.

- [ ] **Step 3: Implement verified item assembly**

```ts
export interface PreparedDriveItem {
    readonly item: DrivePackItemV2;
    readonly bytes: Uint8Array;
    release(): void;
}

export async function readVerifiedItem(options: {
    item: DrivePackItemV2;
    source: Pick<DriveRangeSource, 'readChunk'>;
    crypto: Pick<DrivePackCrypto, 'decryptChunk'>;
    encryptedBudget: ByteBudget;
    plaintextBudget: ByteBudget;
    signal?: AbortSignal;
}): Promise<PreparedDriveItem> {
    const plainPermit = await options.plaintextBudget.acquire(Math.max(1, options.item.size), options.signal);
    const output = new Uint8Array(options.item.size);
    let offset = 0;
    try {
        for (const ref of options.item.chunks) {
            options.signal?.throwIfAborted();
            const encryptedPermit = await options.encryptedBudget.acquire(ref.boxedLength, options.signal);
            let boxed: Uint8Array | null = null;
            try {
                boxed = await options.source.readChunk(ref, options.signal);
                const plain = await options.crypto.decryptChunk(boxed);
                if (plain.byteLength !== ref.plainLength || await sha256Hex(plain) !== ref.chunkHash) {
                    plain.fill(0);
                    throw new Error(`chunk hash mismatch for ${options.item.id}`);
                }
                output.set(plain, offset);
                offset += plain.byteLength;
                plain.fill(0);
            } finally {
                boxed?.fill(0);
                encryptedPermit.release();
            }
        }
        if (offset !== options.item.size || await sha256Hex(output) !== options.item.hash) {
            throw new Error(`item hash mismatch for ${options.item.id}`);
        }
        let released = false;
        return {
            item: options.item,
            bytes: output,
            release: () => {
                if (released) return;
                released = true;
                output.fill(0);
                plainPermit.release();
            },
        };
    } catch (error) {
        output.fill(0);
        plainPermit.release();
        throw error;
    }
}
```

- [ ] **Step 4: Run reader, range, and crypto tests**

Run: `npx vitest run src/backend/drive/__tests__/verified-item-reader.test.ts src/backend/drive/__tests__/range-source.test.ts src/backend/drive/__tests__/pack-crypto.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/verified-item-reader.ts src/backend/drive/__tests__/verified-item-reader.test.ts
git commit -m "feat(drive): stream verified pull items"
```

---

### Task 5: Dependency-Aware Adaptive Rolling Queue

**Files:**
- Create: `src/backend/drive/adaptive-pull-queue.ts`
- Create: `src/backend/drive/__tests__/adaptive-pull-queue.test.ts`

**Interfaces:**
- Produces `classifyPullJob(item, remoteIds): PullJob`.
- Produces `runAdaptivePullQueue(options): Promise<AdaptivePullMetrics>`.
- Cost classes and bounds: small 4-16 (start 8), medium 2-8 (start 4), heavy 1-2 (start 1), serial 1.

- [ ] **Step 1: Write failing rolling/adaptation tests**

```ts
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function jobs(ids: string[]): PullJob[] {
    const remoteIds = new Set(ids);
    return ids.map(id => classifyPullJob({
        id,
        type: id.split('/')[0] as ItemType,
        size: 1,
        hash: id,
        mtime: 1,
        chunks: [],
    }, remoteIds));
}

function testLimits(overrides: Partial<Record<PullCostClass, number>>) {
    return {
        initial: { small: overrides.small ?? 8, medium: overrides.medium ?? 4, heavy: overrides.heavy ?? 1, serial: 1 },
        minimum: { small: 4, medium: 2, heavy: 1, serial: 1 },
        maximum: { small: 16, medium: 8, heavy: 2, serial: 1 },
    };
}

function fakeClock(durations: number[]): () => number {
    let now = 0;
    let index = 0;
    return () => {
        now += durations[Math.min(index++, durations.length - 1)] ?? 1;
        return now;
    };
}

it('starts the next ready job as soon as one slot frees without a batch barrier', async () => {
    const gate = deferred<void>();
    const started: string[] = [];
    const running = runAdaptivePullQueue({
        jobs: jobs(['preset/a', 'preset/b', 'preset/c']),
        limits: testLimits({ small: 2 }),
        async run(job) {
            started.push(job.item.id);
            if (job.item.id === 'preset/a') await gate.promise;
        },
    });
    await vi.waitFor(() => expect(started).toEqual(['preset/a', 'preset/b', 'preset/c']));
    gate.resolve(undefined);
    await running;
});

it('waits for a matching character before its chat but does not block unrelated small jobs', async () => {
    const events: string[] = [];
    await runAdaptivePullQueue({
        jobs: jobs(['chat/A.png/one', 'preset/x', 'character/A.png']),
        async run(job) { events.push(job.item.id); },
    });
    expect(events.indexOf('character/A.png')).toBeLessThan(events.indexOf('chat/A.png/one'));
    expect(events).toContain('preset/x');
});

it('raises a class after 16 stable completions and lowers it after doubled p95 latency', async () => {
    const snapshots: AdaptivePullSnapshot[] = [];
    await runAdaptivePullQueue({
        jobs: jobs(Array.from({ length: 34 }, (_, i) => `preset/${i}`)),
        now: fakeClock([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 40]),
        async run() {},
        onSnapshot(value) { snapshots.push(value); },
    });
    expect(snapshots.some(value => value.limits.small > 8)).toBe(true);
    expect(snapshots.at(-1)!.limits.small).toBeLessThanOrEqual(8);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/adaptive-pull-queue.test.ts`

Expected: FAIL because the scheduler is missing.

- [ ] **Step 3: Implement job classification and rolling dispatch**

```ts
export type PullCostClass = 'small' | 'medium' | 'heavy' | 'serial';

export interface PullJob {
    readonly item: DrivePackItemV2;
    readonly cost: PullCostClass;
    readonly dependencies: readonly string[];
}

export function classifyPullJob(
    item: DrivePackItemV2,
    remoteIds: ReadonlySet<string>,
): PullJob {
    const dependencies: string[] = [];
    if (item.type === 'chat') {
        const avatar = item.id.split('/')[1];
        const characterId = `character/${avatar}`;
        if (remoteIds.has(characterId)) dependencies.push(characterId);
    }
    const cost: PullCostClass = item.type === 'settings' || item.type === 'persona'
        ? 'serial'
        : item.size > 4 * 1024 * 1024
            ? 'heavy'
            : item.size > 256 * 1024 || item.type === 'chat' || item.type === 'character'
                ? 'medium'
                : 'small';
    return { item, cost, dependencies };
}
```

Implement `runAdaptivePullQueue` as one dispatcher loop; never call `Promise.all` on fixed-size slices:

```ts
export interface AdaptivePullSnapshot {
    completed: number;
    total: number;
    lastItemType: string;
    itemsPerSecond: number;
    activeWriters: number;
    etaSeconds: number;
    limits: Record<PullCostClass, number>;
}

export interface AdaptivePullMetrics {
    completed: number;
    maxActiveWriters: number;
    elapsedMs: number;
}

export interface AdaptivePullQueueOptions {
    jobs: readonly PullJob[];
    run(job: PullJob): Promise<void>;
    signal?: AbortSignal;
    now?: () => number;
    limits?: {
        initial: Record<PullCostClass, number>;
        minimum: Record<PullCostClass, number>;
        maximum: Record<PullCostClass, number>;
    };
    onSnapshot?(snapshot: AdaptivePullSnapshot): void;
}

const DEFAULT_LIMITS = {
    initial: { small: 8, medium: 4, heavy: 1, serial: 1 },
    minimum: { small: 4, medium: 2, heavy: 1, serial: 1 },
    maximum: { small: 16, medium: 8, heavy: 2, serial: 1 },
} satisfies NonNullable<AdaptivePullQueueOptions['limits']>;

function percentile95(values: readonly number[]): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

export function runAdaptivePullQueue(
    options: AdaptivePullQueueOptions,
): Promise<AdaptivePullMetrics> {
    const now = options.now ?? (() => performance.now());
    const bounds = options.limits ?? DEFAULT_LIMITS;
    const limits = { ...bounds.initial };
    const pending = [...options.jobs];
    const completedIds = new Set<string>();
    const activeByClass: Record<PullCostClass, number> = { small: 0, medium: 0, heavy: 0, serial: 0 };
    const sampleDurations: number[] = [];
    const startedAt = now();
    let previousP95 = 0;
    let completed = 0;
    let active = 0;
    let maxActiveWriters = 0;
    let settled = false;

    return new Promise((resolve, reject) => {
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            reject(error);
        };

        const adjust = (cost: PullCostClass): void => {
            if (sampleDurations.length < 16) return;
            const p95 = percentile95(sampleDurations.splice(0));
            if (previousP95 > 0 && p95 >= previousP95 * 2) {
                limits[cost] = Math.max(bounds.minimum[cost], limits[cost] - 1);
            } else {
                limits[cost] = Math.min(bounds.maximum[cost], limits[cost] + 1);
            }
            previousP95 = p95;
        };

        const dispatch = (): void => {
            if (settled) return;
            try { options.signal?.throwIfAborted(); } catch (error) { fail(error); return; }
            let launched = false;
            for (let index = 0; index < pending.length;) {
                const job = pending[index];
                const ready = job.dependencies.every(id => completedIds.has(id));
                if (!ready || activeByClass[job.cost] >= limits[job.cost]) {
                    index += 1;
                    continue;
                }
                pending.splice(index, 1);
                launched = true;
                active += 1;
                activeByClass[job.cost] += 1;
                maxActiveWriters = Math.max(maxActiveWriters, active);
                const jobStartedAt = now();
                void options.run(job).then(() => {
                    const duration = Math.max(0, now() - jobStartedAt);
                    sampleDurations.push(duration);
                    completed += 1;
                    completedIds.add(job.item.id);
                    adjust(job.cost);
                    const elapsedMs = Math.max(1, now() - startedAt);
                    const itemsPerSecond = completed / (elapsedMs / 1_000);
                    options.onSnapshot?.({
                        completed,
                        total: options.jobs.length,
                        lastItemType: job.item.type,
                        itemsPerSecond,
                        activeWriters: active,
                        etaSeconds: itemsPerSecond > 0
                            ? (options.jobs.length - completed) / itemsPerSecond
                            : 0,
                        limits: { ...limits },
                    });
                }, error => {
                    limits[job.cost] = Math.max(bounds.minimum[job.cost], limits[job.cost] - 1);
                    fail(error);
                }).finally(() => {
                    active -= 1;
                    activeByClass[job.cost] -= 1;
                    if (settled) return;
                    if (completed === options.jobs.length) {
                        settled = true;
                        resolve({ completed, maxActiveWriters, elapsedMs: Math.max(0, now() - startedAt) });
                        return;
                    }
                    queueMicrotask(dispatch);
                });
            }
            if (!launched && active === 0 && pending.length > 0) {
                fail(new Error(`Pull dependency deadlock: ${pending.map(job => job.item.id).join(', ')}`));
            }
            if (!launched && active === 0 && pending.length === 0 && !settled) {
                settled = true;
                resolve({ completed, maxActiveWriters, elapsedMs: Math.max(0, now() - startedAt) });
            }
        };

        dispatch();
    });
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run src/backend/drive/__tests__/adaptive-pull-queue.test.ts`

Expected: PASS and the no-barrier test starts job C while job A remains blocked.

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/adaptive-pull-queue.ts src/backend/drive/__tests__/adaptive-pull-queue.test.ts
git commit -m "feat(drive): add adaptive rolling pull queue"
```

---

### Task 6: Throttled Extension Checkpoint

**Files:**
- Modify: `src/settings.ts`
- Create: `src/backend/drive/pull-checkpoint.ts`
- Create: `src/backend/drive/__tests__/pull-checkpoint.test.ts`

**Interfaces:**
- Adds `driveV2PullCheckpoint: DriveV2PullCheckpointState | null` to `TavernSyncSettings`.
- Produces `DriveV2PullCheckpoint` with `completedIds`, `markCompleted`, `flush`, and `finish`.

- [ ] **Step 1: Write failing checkpoint tests**

```ts
it('flushes after 25 completions or two seconds and resumes only the same commit', () => {
    const saved: Array<DriveV2PullCheckpointState | null> = [];
    let now = 0;
    const checkpoint = new DriveV2PullCheckpoint('head-a', {
        load: () => ({ commitId: 'head-a', completedItemIds: ['preset/old'], updatedAt: 0 }),
        save: value => { saved.push(value); },
    }, () => now);
    expect(checkpoint.completedIds.has('preset/old')).toBe(true);
    for (let i = 0; i < 24; i++) checkpoint.markCompleted(`preset/${i}`);
    expect(saved).toHaveLength(0);
    checkpoint.markCompleted('preset/24');
    expect(saved).toHaveLength(1);
    now = 2_100;
    checkpoint.markCompleted('preset/25');
    checkpoint.flushIfDue();
    expect(saved).toHaveLength(2);
});

it('discards a checkpoint from another Drive head', () => {
    let stored: DriveV2PullCheckpointState | null = {
        commitId: 'head-a', completedItemIds: ['chat/a/one'], updatedAt: 1,
    };
    const checkpoint = new DriveV2PullCheckpoint('head-b', {
        load: () => stored,
        save: value => { stored = value; },
    });
    expect([...checkpoint.completedIds]).toEqual([]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/pull-checkpoint.test.ts`

Expected: FAIL because the checkpoint class and setting are missing.

- [ ] **Step 3: Add checkpoint schema and implementation**

```ts
export interface DriveV2PullCheckpointState {
    commitId: string;
    completedItemIds: string[];
    updatedAt: number;
}
```

Add `driveV2PullCheckpoint` to settings defaults as `null`, validate its shape during migration, and implement:

```ts
export class DriveV2PullCheckpoint {
    readonly completedIds: Set<string>;
    private dirty = 0;
    private lastSavedAt: number;

    constructor(
        readonly commitId: string,
        private readonly store: PullCheckpointStore = extensionCheckpointStore(),
        private readonly now: () => number = () => Date.now(),
    ) {
        const loaded = store.load();
        this.completedIds = new Set(loaded?.commitId === commitId ? loaded.completedItemIds : []);
        this.lastSavedAt = this.now();
    }

    markCompleted(id: string): void {
        if (this.completedIds.has(id)) return;
        this.completedIds.add(id);
        this.dirty += 1;
        this.flushIfDue();
    }

    flushIfDue(force = false): void {
        if (!this.dirty) return;
        if (!force && this.dirty < 25 && this.now() - this.lastSavedAt < 2_000) return;
        this.store.save({ commitId: this.commitId, completedItemIds: [...this.completedIds], updatedAt: this.now() });
        this.dirty = 0;
        this.lastSavedAt = this.now();
    }

    finish(): void { this.store.save(null); }
}
```

- [ ] **Step 4: Run checkpoint and settings tests**

Run: `npx vitest run src/backend/drive/__tests__/pull-checkpoint.test.ts src/ui/__tests__/encryption-passphrase-warning.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts src/backend/drive/pull-checkpoint.ts src/backend/drive/__tests__/pull-checkpoint.test.ts
git commit -m "feat(drive): persist pull resume checkpoints"
```

---

### Task 7: Extension-Only Pull Orchestrator

**Files:**
- Rewrite: `src/backend/drive/drive-v2-pull.ts`
- Rewrite: `src/backend/drive/__tests__/drive-v2-pull.test.ts`
- Create: `src/backend/drive/__tests__/adaptive-pull-harness.ts`

**Interfaces:**
- Consumes: manifest, lightweight inventory, range source, crypto, budgets, checkpoint, ST apply/delete callbacks.
- Preserves: `DriveV2PullResult` fields and adds peak encrypted/plaintext bytes plus max writers.
- Produces writes before deletions and base/checkpoint completion last.

- [ ] **Step 1: Replace fixed-batch tests with failing rolling-pull tests**

```ts
it('restores every remote item without local hashes and deletes inventory-only IDs last', async () => {
    const h = await createAdaptivePullHarness({
        remote: ['character/A.png', 'chat/A.png/new', 'preset/x'],
        local: ['character/A.png', 'chat/A.png/old'],
    });
    await runDriveV2Pull(h.options);
    expect(h.events).toContain('apply:character/A.png');
    expect(h.events).toContain('apply:chat/A.png/new');
    expect(h.events.indexOf('apply:character/A.png')).toBeLessThan(h.events.indexOf('apply:chat/A.png/new'));
    expect(h.events.at(-3)).toBe('delete:chat/A.png/old');
    expect(h.events.at(-2)).toBe('save-base:head-b');
    expect(h.events.at(-1)).toBe('checkpoint-finish');
});

it('resumes completed IDs and performs no delete/base advance after failure', async () => {
    const h = await createAdaptivePullHarness({
        remote: ['preset/done', 'preset/fails'], local: ['preset/old'],
        completed: ['preset/done'], fail: 'preset/fails',
    });
    await expect(runDriveV2Pull(h.options)).rejects.toThrow('preset/fails');
    expect(h.events).not.toContain('read:preset/done');
    expect(h.events.some(value => value.startsWith('delete:'))).toBe(false);
    expect(h.events.some(value => value.startsWith('save-base:'))).toBe(false);
    expect(h.events).toContain('checkpoint-flush');
});
```

Create `adaptive-pull-harness.ts` with a real in-memory Drive/ST harness. It must export:

```ts
export interface AdaptivePullHarnessInput {
    remote: string[];
    local?: string[];
    completed?: string[];
    fail?: string;
    fault?: 'network-loss' | 'http-408' | 'http-429' | 'http-500' | 'wrong-passphrase'
        | 'chunk-hash' | 'item-hash' | 'apply-failure' | 'cancel';
}

export interface AdaptivePullHarness {
    options: DriveV2PullOptions;
    events: string[];
    deletedIds: string[];
    savedBase: string | null;
    checkpointState: DriveV2PullCheckpointState | null;
    inventory(): string[];
    remoteInventory(): string[];
}

export async function createAdaptivePullHarness(
    input: AdaptivePullHarnessInput,
): Promise<AdaptivePullHarness> {
    const events: string[] = [];
    const deletedIds: string[] = [];
    let savedBase: string | null = null;
    let checkpointState: DriveV2PullCheckpointState | null = {
        commitId: 'head-b', completedItemIds: input.completed ?? [], updatedAt: 1,
    };
    const bytes = new Uint8Array([1]);
    const hash = await sha256Hex(bytes);
    const items = Object.fromEntries(input.remote.map((id, index) => [id, {
        id, type: id.split('/')[0] as ItemType,
        hash: input.fault === 'item-hash' && index === 0 ? '0'.repeat(64) : hash,
        size: 1, mtime: 1,
        chunks: [{ packName: 'pack', offset: index, boxedLength: 1, plainLength: 1, chunkHash: hash }],
    }]));
    const localInventory = new Map((input.local ?? []).map(id => [id, id.split('/')[0] as ItemType]));
    const checkpoint = new DriveV2PullCheckpoint('head-b', {
        load: () => checkpointState,
        save: value => { checkpointState = value; events.push(value ? 'checkpoint-flush' : 'checkpoint-finish'); },
    });
    const abort = new AbortController();
    if (input.fault === 'cancel') abort.abort(new DOMException('cancelled', 'AbortError'));
    let firstRead = true;
    const options: DriveV2PullOptions = {
        commit: { fileId: 'file-b', commitId: 'head-b', parents: [], createdTime: '2026-08-10T00:00:00Z' },
        manifest: { schema: 2, storage: 'drive-pack-v2', device: 'pc', updatedAt: 1, chunkBytes: 1, packBytes: 32, items },
        localInventory, allowedTypes: new Set(Object.values(items).map(item => item.type)), checkpoint,
        source: { readChunk: async ref => {
            const item = Object.values(items).find(value => value.chunks[0].offset === ref.offset)!;
            events.push(`read:${item.id}`);
            if (firstRead && input.fault && ['network-loss', 'http-408', 'http-429', 'http-500'].includes(input.fault)) {
                firstRead = false;
                throw new Error(input.fault);
            }
            if (input.fault === 'chunk-hash') return new Uint8Array([2]);
            return bytes.slice();
        } },
        crypto: { decryptChunk: async value => {
            if (input.fault === 'wrong-passphrase') throw new DOMException('authentication failed', 'OperationError');
            return value;
        } },
        applyItem: async id => {
            events.push(`apply:${id}`);
            if (id === input.fail || input.fault === 'apply-failure') throw new Error(id);
        },
        deleteItem: async id => { events.push(`delete:${id}`); deletedIds.push(id); },
        saveBase: async id => { events.push(`save-base:${id}`); savedBase = id; },
        signal: abort.signal,
    };
    return {
        options, events, deletedIds,
        get savedBase() { return savedBase; },
        get checkpointState() { return checkpointState; },
        inventory: () => [...new Set([...localInventory.keys(), ...input.remote])].sort(),
        remoteInventory: () => [...input.remote].sort(),
    };
}
```

- [ ] **Step 2: Run the Pull test and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/drive-v2-pull.test.ts`

Expected: FAIL because the existing options require a full `Manifest`, full-scan flag, pack reader, and fixed batches.

- [ ] **Step 3: Implement the orchestrator**

Define options around extension-only dependencies:

```ts
export interface DriveV2PullOptions {
    commit: DriveV2CommitMeta;
    manifest: DrivePackManifestV2;
    localInventory: ReadonlyMap<string, ItemType>;
    allowedTypes: ReadonlySet<ItemType>;
    source: Pick<DriveRangeSource, 'readChunk'>;
    crypto: Pick<DrivePackCrypto, 'decryptChunk'>;
    checkpoint: DriveV2PullCheckpoint;
    applyItem(id: string, type: ItemType, bytes: Uint8Array): Promise<void>;
    deleteItem(id: string, type: ItemType): Promise<void>;
    saveBase(commitId: string): Promise<void>;
    onProgress?(event: DriveV2PullProgressEvent): void;
    signal?: AbortSignal;
    encryptedBudget?: ByteBudget;
    plaintextBudget?: ByteBudget;
}
```

Implement this sequence without `pullBatches`, `Promise.allSettled` over slices, `saveBlob`, local hashes, or `localScanComplete`:

```ts
const remote = Object.values(options.manifest.items)
    .filter(item => options.allowedTypes.has(item.type));
const remoteIds = new Set(remote.map(item => item.id));
const jobs = remote
    .filter(item => !options.checkpoint.completedIds.has(item.id))
    .map(item => classifyPullJob(item, remoteIds));
const deletions = [...options.localInventory]
    .filter(([id, type]) => options.allowedTypes.has(type) && !remoteIds.has(id));

const resumedCount = options.checkpoint.completedIds.size;
try {
    const metrics = await runAdaptivePullQueue({
        jobs,
        signal: options.signal,
        async run(job) {
            const prepared = await readVerifiedItem({
                item: job.item, source: options.source, crypto: options.crypto,
                encryptedBudget, plaintextBudget, signal: options.signal,
            });
            try {
                await options.applyItem(job.item.id, job.item.type, prepared.bytes);
                options.checkpoint.markCompleted(job.item.id);
            } finally {
                prepared.release();
            }
        },
        onSnapshot: snapshot => options.onProgress?.({
            stage: 'apply',
            completedItems: snapshot.completed,
            totalItems: remote.length,
            itemType: snapshot.lastItemType,
            itemsPerSecond: snapshot.itemsPerSecond,
            activeWriters: snapshot.activeWriters,
            etaSeconds: snapshot.etaSeconds,
        }),
    });
    for (const [id, type] of deletions.sort(([a], [b]) => a.localeCompare(b))) {
        options.signal?.throwIfAborted();
        await options.deleteItem(id, type);
    }
    await options.saveBase(options.commit.commitId);
    options.checkpoint.finish();
    return {
        commitId: options.commit.commitId,
        applied: metrics.completed,
        deleted: deletions.length,
        skippedInSync: resumedCount,
        downloadedPacks: new Set(remote.flatMap(item => item.chunks.map(chunk => chunk.packName))).size,
        peakCachedBytes: encryptedBudget.peakBytes,
        peakEncryptedBytes: encryptedBudget.peakBytes,
        peakPlaintextBytes: plaintextBudget.peakBytes,
        maxActiveWriters: metrics.maxActiveWriters,
        elapsedMs: metrics.elapsedMs,
    };
} catch (error) {
    options.checkpoint.flushIfDue(true);
    throw error;
}
```

- [ ] **Step 4: Run Pull, reader, scheduler, checkpoint, and inventory tests**

Run: `npx vitest run src/backend/drive/__tests__/drive-v2-pull.test.ts src/backend/drive/__tests__/verified-item-reader.test.ts src/backend/drive/__tests__/adaptive-pull-queue.test.ts src/backend/drive/__tests__/pull-checkpoint.test.ts src/st-adapter/__tests__/inventory.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/drive/drive-v2-pull.ts src/backend/drive/__tests__/drive-v2-pull.test.ts
git commit -m "feat(drive): restore snapshots with rolling writers"
```

---

### Task 8: Route Engine to Extension-Only Pull and Remove Core Artifacts

**Files:**
- Modify: `src/sync/engine.ts`
- Modify: `src/backend/__tests__/drive-v2-engine-routing.test.ts`
- Delete: `src/backend/drive/core-restore.ts`
- Delete: `src/backend/drive/__tests__/core-restore.test.ts`
- Delete: `src/backend/drive/chunk-stream.ts`
- Delete: `src/backend/drive/__tests__/chunk-stream.test.ts`
- Delete: `src/backend/restore-session/client.ts`
- Delete: `src/backend/restore-session/types.ts`
- Delete: `src/backend/restore-session/batch-builder.ts`
- Delete: `src/backend/restore-session/__tests__/client.test.ts`
- Delete: `src/backend/restore-session/__tests__/batch-builder.test.ts`
- Delete: `src/ui/update-required.ts`
- Delete: `src/ui/__tests__/update-required.test.ts`

**Interfaces:**
- Pull engine constructs `DriveRangeSource`, `listLocalInventory`, `DriveV2PullCheckpoint`, and `runDriveV2Pull`.
- Existing settings merge helper remains for `settings/root`.
- Push continues through `createDriveV2PushController` and `runDriveV2Sync`.

- [ ] **Step 1: Rewrite the routing test to fail against Core**

```ts
it('routes Drive v2 Pull to extension-only restore before full browser scan', async () => {
    await runSync({ direction: 'pull' });
    expect(harness.scanLocal).not.toHaveBeenCalled();
    expect(harness.listLocalInventory).toHaveBeenCalledOnce();
    expect(harness.adaptivePull).toHaveBeenCalledWith(expect.objectContaining({
        commit: expect.objectContaining({ commitId: 'head-a' }),
    }));
});

it('contains no Core restore or restore-session imports', async () => {
    const source = readFileSync(new URL('../../../sync/engine.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/core-restore|restore-session|RestoreSessionClient|runDriveV2CoreRestore/);
});
```

- [ ] **Step 2: Run routing tests and verify RED**

Run: `npx vitest run src/backend/__tests__/drive-v2-engine-routing.test.ts`

Expected: FAIL because the engine still imports Core restore and restore-session modules.

- [ ] **Step 3: Replace `runDriveV2FastPullFromEngine` dependencies**

Use the existing `runDriveV2Sync({ direction: 'pull' })`, but implement `runPull` as:

```ts
runPull: async (commit, manifest) => {
    const selected = Object.values(manifest.items)
        .filter(item => allowedTypes.has(item.type));
    pulledItemCount = selected.length;
    const checkpoint = new DriveV2PullCheckpoint(commit.commitId);
    return runDriveV2Pull({
        commit,
        manifest,
        allowedTypes,
        localInventory: await listLocalInventory(allowedTypes),
        source: new DriveRangeSource(runtime.store, new DriveClient(provider)),
        crypto: runtime.crypto,
        checkpoint,
        applyItem: applyDriveV2Item,
        deleteItem: deleteLocalItem,
        saveBase: commitId => saveDriveV2Base(currentNamespace, { commitId, syncedAt: Date.now() }),
        onProgress: event => options.onProgress?.(formatDriveV2PullProgress(event)),
    });
},
```

Extract `applyDriveV2Item` from the existing settings-merge path so settings continue merging excluded/device-local values before `applyLocalItem`.

- [ ] **Step 4: Delete Core-only modules and imports**

Delete the files listed in this task only after routing tests pass against the new mocks. Run:

`rg -n "core-restore|restore-session|RestoreSessionClient|runDriveV2CoreRestore|RESTORE_UPDATE_REQUIRED" src`

Expected: no matches.

- [ ] **Step 5: Run routing and full unit suite**

Run: `npx vitest run src/backend/__tests__/drive-v2-engine-routing.test.ts`

Run: `npm test`

Expected: PASS with zero failed tests.

- [ ] **Step 6: Commit**

```bash
git add src/sync/engine.ts src/backend/__tests__/drive-v2-engine-routing.test.ts src/backend/drive src/backend/restore-session src/ui
git commit -m "refactor(drive): remove core restore dependency"
```

---

### Task 9: Preserve Auto-Sync, Maintenance Controls, and v2 Cleanup

**Files:**
- Create: `src/backend/drive/gc-v2.ts`
- Create: `src/backend/drive/__tests__/gc-v2.test.ts`
- Modify: `src/backend/drive/drive-v2-ui-state.ts`
- Modify: `src/backend/drive/__tests__/drive-v2-ui-state.test.ts`
- Modify: `src/index.ts`
- Modify: `panel.html`
- Create: `src/ui/__tests__/control-compatibility.test.ts`

**Interfaces:**
- Produces `collectDriveV2Garbage(store, client, options?)` that never trashes an active head or a pack referenced by retained commits.
- `driveV2Visibility().autoSync` becomes `true`.
- Progress includes throughput, writers, and ETA.

- [ ] **Step 1: Write failing compatibility and v2 GC tests**

```ts
it('keeps every approved control in the panel', () => {
    const html = readFileSync(new URL('../../../../panel.html', import.meta.url), 'utf8');
    for (const id of [
        'tavernsync_push', 'tavernsync_pull', 'tavernsync_status_btn',
        'tavernsync_auto_startup', 'tavernsync_auto_chat_close',
        'tavernsync_propagate_deletes', 'tavernsync_google_connect',
        'tavernsync_google_disconnect', 'tavernsync_rebuild_index',
        'tavernsync_view_log', 'tavernsync_reset_state', 'tavernsync_wipe_remote',
        'tavernsync_gc', 'tavernsync_reset_drive_v2', 'tavernsync_resume_drive_v2_push',
    ]) expect(html).toContain(`id="${id}"`);
});

it('enables Drive v2 auto-sync controls', () => {
    expect(driveV2Visibility().autoSync).toBe(true);
});

it('recognizes expired Google authorization as reconnect-and-resume', () => {
    expect(isDriveReconnectRequired(new DriveAuthError())).toBe(true);
    expect(isDriveReconnectRequired(new Error('ordinary failure'))).toBe(false);
});

it('trashes only old unreferenced packs and never the active head', async () => {
    const trashed: string[] = [];
    const store = {
        listCommits: async () => [{ fileId: 'head-file', commitId: 'head', parents: [], createdTime: '2026-08-10T00:00:00Z' }],
        readManifest: async () => ({
            schema: 2 as const, storage: 'drive-pack-v2' as const, device: 'pc', updatedAt: 1,
            chunkBytes: 1, packBytes: 32,
            items: { a: { id: 'preset/a', type: 'preset' as const, hash: 'h', size: 1, mtime: 1, chunks: [{ packName: 'live-pack', offset: 0, boxedLength: 1, plainLength: 1, chunkHash: 'h' }] } },
        }),
        listPacks: async () => new Map([
            ['live-pack', { id: 'file:live-pack', name: 'live-pack', createdTime: '2026-07-01T00:00:00Z' }],
            ['old-pack', { id: 'file:old-pack', name: 'old-pack', createdTime: '2026-07-01T00:00:00Z' }],
        ]),
    };
    const client = { trashFile: async (id: string) => { trashed.push(id); } };
    const result = await collectDriveV2Garbage(store, client, { now: () => Date.parse('2026-08-10T00:00:00Z') });
    expect(trashed).toEqual(['file:old-pack']);
    expect(result).toEqual({ trashedPacks: 1, trashedCommits: 0 });
});
```

- [ ] **Step 2: Run focused UI/GC tests and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/drive-v2-ui-state.test.ts src/backend/drive/__tests__/gc-v2.test.ts src/ui/__tests__/control-compatibility.test.ts`

Expected: FAIL because v2 auto-sync and v2 garbage collection are disabled/missing.

- [ ] **Step 3: Implement active-head-safe v2 cleanup**

```ts
import { computeDriveV2Heads, selectNewestDriveV2Head, type DriveV2CommitMeta } from './drive-v2-head';
import type { DriveFileMeta } from './client';
import type { DrivePackManifestV2 } from './pack-types';

const KEEP_COMMITS = 10;
const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

interface V2GcStore {
    listCommits(): Promise<DriveV2CommitMeta[]>;
    readManifest(commit: DriveV2CommitMeta): Promise<DrivePackManifestV2>;
    listPacks(): Promise<Map<string, DriveFileMeta>>;
}

interface V2GcClient { trashFile(id: string): Promise<void> }

export async function collectDriveV2Garbage(
    store: V2GcStore,
    client: V2GcClient,
    options: { now?: () => number } = {},
): Promise<{ trashedPacks: number; trashedCommits: number }> {
    const commits = await store.listCommits();
    const heads = computeDriveV2Heads(commits);
    if (heads.length > 1) throw new Error('Drive v2 has concurrent heads; resolve them before cleanup');
    if (!heads.length) return { trashedPacks: 0, trashedCommits: 0 };
    const byId = new Map(commits.map(commit => [commit.commitId, commit]));
    const retained: DriveV2CommitMeta[] = [];
    const queue = [selectNewestDriveV2Head(heads)];
    const retainedIds = new Set<string>();
    while (queue.length && retained.length < KEEP_COMMITS) {
        const commit = queue.shift()!;
        if (retainedIds.has(commit.commitId)) continue;
        retainedIds.add(commit.commitId);
        retained.push(commit);
        for (const parent of commit.parents) {
            const value = byId.get(parent);
            if (value) queue.push(value);
        }
    }
    const livePacks = new Set<string>();
    for (const commit of retained) {
        const manifest = await store.readManifest(commit);
        for (const item of Object.values(manifest.items)) {
            for (const chunk of item.chunks) livePacks.add(chunk.packName);
        }
    }
    const now = (options.now ?? (() => Date.now()))();
    let trashedPacks = 0;
    for (const [name, file] of await store.listPacks()) {
        const age = now - Date.parse(file.createdTime ?? '');
        if (!livePacks.has(name) && Number.isFinite(age) && age > ORPHAN_GRACE_MS) {
            await client.trashFile(file.id);
            trashedPacks += 1;
        }
    }
    let trashedCommits = 0;
    for (const commit of commits) {
        if (retainedIds.has(commit.commitId)) continue;
        await client.trashFile(commit.fileId);
        trashedCommits += 1;
    }
    return { trashedPacks, trashedCommits };
}
```

- [ ] **Step 4: Enable auto-sync and preserve the stale-Push chooser**

Change visibility to:

```ts
export function driveV2Visibility() {
    return { push: true, pull: true, status: true, autoSync: true } as const;
}

export function isDriveReconnectRequired(error: unknown): boolean {
    return error instanceof DriveAuthError
        || (error instanceof Error && error.name === 'DriveAuthError');
}
```

Remove the Drive v2 early-return blocks from both auto-sync checkbox handlers. For automatic Push, pass the same `chooseDriveV2Source: showDriveV2SourceChoice` callback used by manual Push. Automatic Pull needs no chooser.

- [ ] **Step 5: Wire v2 cleanup and continuous progress copy**

Show `#tavernsync_gc` for all Drive versions. Route v1 to `collectGarbage` and v2 to `collectDriveV2Garbage`. Format adaptive Pull progress as:

```ts
return `Restoring ${event.completedItems}/${event.totalItems} · ${event.itemsPerSecond.toFixed(1)} items/s · ${event.activeWriters} writers · ETA ${formatEta(event.etaSeconds)}`;
```

In the Pull handler, preserve the checkpoint and show reconnect/resume copy for 401:

```ts
} catch (error) {
    if (isDriveReconnectRequired(error)) {
        toastr.warning('Google connection expired — Connect Google แล้วกด Pull อีกครั้ง ระบบจะทำต่อจาก checkpoint', 'TavernSync');
        return;
    }
    toastr.error(`Pull failed: ${String(error)}`, 'TavernSync');
}
```

Keep the three destructive/maintenance actions distinct in button copy and confirmation text.

- [ ] **Step 6: Run focused tests, browser build, and inspect generated panel**

Run: `npx vitest run src/backend/drive/__tests__/drive-v2-ui-state.test.ts src/backend/drive/__tests__/gc-v2.test.ts src/ui/__tests__/control-compatibility.test.ts`

Run: `npm run build`

Expected: tests PASS and build exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/backend/drive/gc-v2.ts src/backend/drive/__tests__/gc-v2.test.ts src/backend/drive/drive-v2-ui-state.ts src/backend/drive/__tests__/drive-v2-ui-state.test.ts src/index.ts panel.html src/ui/__tests__/control-compatibility.test.ts
git commit -m "feat(drive): preserve adaptive sync controls"
```

---

### Task 10: End-to-End Fault Matrix, Benchmark, and Release Gate

**Files:**
- Create: `src/backend/drive/__tests__/adaptive-pull.integration.test.ts`
- Modify: `docs/google-drive-setup.md`

**Interfaces:**
- Synthetic harness uses the real scheduler, budgets, verified reader, checkpoint, and orchestrator with fake Drive/ST transports.
- Live harness never contains tokens, passphrases, decrypted payloads, or primary Data Root paths.

- [ ] **Step 1: Write failing integration fault tests**

```ts
it.each([
    'network-loss', 'http-408', 'http-429', 'http-500', 'wrong-passphrase',
    'chunk-hash', 'item-hash', 'apply-failure', 'cancel',
] as const)('preserves checkpoint, skips deletion, and does not advance base after %s', async fault => {
    const ids = Array.from({ length: 2_347 }, (_, index) => `preset/${index}`);
    const h = await createAdaptivePullHarness({ remote: ids, local: ['preset/old'], fault });
    await expect(runDriveV2Pull(h.options)).rejects.toBeDefined();
    expect(h.deletedIds).toEqual([]);
    expect(h.savedBase).toBeNull();
    expect(h.checkpointState).not.toBeNull();
});

it('restores 2347 items with exact inventory and bounded peak bytes', async () => {
    const ids = Array.from({ length: 2_347 }, (_, index) => `preset/${index}`);
    const h = await createAdaptivePullHarness({ remote: ids });
    const result = await runDriveV2Pull(h.options);
    expect(h.inventory()).toEqual(h.remoteInventory());
    expect(result.peakEncryptedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(result.peakPlaintextBytes).toBeLessThanOrEqual(48 * 1024 * 1024);
    expect(result.maxActiveWriters).toBeGreaterThan(4);
});
```

- [ ] **Step 2: Run the integration test and verify RED**

Run: `npx vitest run src/backend/drive/__tests__/adaptive-pull.integration.test.ts`

Expected: FAIL until all fault hooks and metrics are exposed consistently.

- [ ] **Step 3: Add a deterministic benchmark test**

Add this non-assertive evidence test to `adaptive-pull.integration.test.ts`; the correctness assertions from Step 1 remain the release gate:

```ts
it('reports five-run adaptive Pull benchmark evidence', async () => {
    const runs: Array<{ elapsedMs: number; itemsPerSecond: number; maxWriters: number; peakEncryptedBytes: number; peakPlaintextBytes: number }> = [];
    for (let run = 0; run < 5; run++) {
        const ids = Array.from({ length: 2_347 }, (_, index) => `preset/${index}`);
        const h = await createAdaptivePullHarness({ remote: ids });
        const result = await runDriveV2Pull(h.options);
        runs.push({
            elapsedMs: result.elapsedMs,
            itemsPerSecond: result.applied / Math.max(0.001, result.elapsedMs / 1_000),
            maxWriters: result.maxActiveWriters,
            peakEncryptedBytes: result.peakEncryptedBytes,
            peakPlaintextBytes: result.peakPlaintextBytes,
        });
    }
    const sorted = runs.map(value => value.elapsedMs).sort((a, b) => a - b);
    console.info('[TavernSync benchmark]', JSON.stringify({ medianElapsedMs: sorted[2], runs }));
    expect(runs.every(value => value.maxWriters > 4)).toBe(true);
});
```

- [ ] **Step 4: Run all automated gates**

Run: `npm test`

Run: `npx tsc --noEmit`

Run: `npm run lint`

Run: `npm run build`

Run: `npx vitest run src/backend/drive/__tests__/adaptive-pull.integration.test.ts --reporter=verbose`

Run: `git diff --check`

Expected: zero failed tests, TypeScript/lint/build exit 0, benchmark reports exact inventory and no fixed barrier, diff check prints nothing.

- [ ] **Step 5: Run disposable desktop live test on a separate port**

Start a test SillyTavern instance with a newly created disposable Data Root and a port other than `8000`. Record the exact port and Data Root in the test evidence before starting. Pull the real 30-pack snapshot, verify enabled inventory, elapsed time, checkpoint cleanup, no deletion before write completion, and one final reload. Do not start or stop the primary server.

Expected first gate: end-to-end Pull at most 5 minutes, exact enabled inventory, no owner data touched.

- [ ] **Step 6: Run iPhone live test with native syslog**

Install/update only TavernSync on the existing SillyiOS build, connect the same Drive account, unlock with the same Encryption passphrase, and Pull. Capture syslog from button press through completion. Verify no Jetsam, WebContent termination, or unexplained app reload; record total time and throughput.

Expected: no crash and completion at most 5 minutes for the current snapshot/network; stretch target approaches 2 minutes.

- [ ] **Step 7: Update user documentation**

Document only the user flow:

```text
Install or update TavernSync → Refresh ST → Connect Google →
Enter the same Encryption passphrase → Push or Pull
```

Document checkpoint resume, the three distinct cleanup/reset actions, and the fact that forgetting the passphrase makes Drive ciphertext unrecoverable. Do not mention Core, Companion, terminal, or IPA steps except in a migration note stating they are no longer required.

- [ ] **Step 8: Commit verification assets and docs**

```bash
git add src/backend/drive/__tests__/adaptive-pull.integration.test.ts docs/google-drive-setup.md
git commit -m "test(drive): gate extension-only adaptive pull"
```

- [ ] **Step 9: Final branch verification**

Run: `git status --short`

Expected: only the pre-existing untracked `.omo/` remains.

Run: `git log --oneline --decorate dd96939..HEAD`

Expected: the implementation commits from Tasks 1-10 in task order.

Do not merge or push until the owner reviews the live evidence and explicitly authorizes Git integration.
