# Drive v2 Node-Side Bulk Logical Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Drive v2's per-item browser/API Pull path with a bounded-memory companion server plugin that restores an authenticated logical snapshot inside the local SillyTavern Node process.

**Architecture:** The browser extension selects and decrypts the Drive v2 manifest, obtains a short-lived Drive token, exports only the v2 chunk-decryption subkey, and starts a local companion job. The companion downloads immutable packs to temporary files, reconstructs and verifies logical items, stages type-specific outputs, applies them through a journaled transaction, moves deletions last, and reports the committed Drive head back to the extension.

**Tech Stack:** TypeScript/WebCrypto/Vitest/Webpack for the browser extension; dependency-free Node ESM (`.mjs`), Node crypto/fs/streams, Express router supplied by SillyTavern, and Vitest for the companion.

## Global Constraints

- Preserve the existing Drive v2 `schema: 2` and `storage: "drive-pack-v2"` format.
- Preserve HTTP/OG synchronization and the verified Drive v2 Push path.
- Do not modify SillyTavern core; install the companion under `SillyTavern/plugins/tavernsync-companion/`.
- Do not add npm dependencies or modify `package-lock.json`.
- Never persist or log the Drive token, passphrase, root key, manifest key, pack-name key, or chunk-decryption key.
- Permit Fast Pull only over loopback or authenticated HTTPS.
- Validate every AES-GCM chunk and complete item hash before changing live data.
- Apply deletions only after every required remote item is staged and verified.
- Failed, cancelled, or rolled-back restores must not advance `baseCommitId`.
- Fast Pull must not silently fall back to Legacy Pull.
- Initial gates: PC full restore at most 5 minutes; iPhone full restore at most 15 minutes with no Jetsam; exact enabled-scope manifest equality.
- Preserve the user's existing uncommitted `package-lock.json` change.

## File Structure

### Companion package

- `server-plugin/package.json` — separately installable ESM package metadata.
- `server-plugin/index.mjs` — SillyTavern `info`/`init`/`exit` exports and route registration.
- `server-plugin/src/protocol.mjs` — protocol constants, capability response, restore request validation.
- `server-plugin/src/security.mjs` — transport checks, Google URL allow-list, secret redaction/disposal.
- `server-plugin/src/job-manager.mjs` — per-user lock, job states, cancellation, in-memory secrets.
- `server-plugin/src/retry.mjs` — bounded exponential retry classification.
- `server-plugin/src/drive-client.mjs` — paginated listing and streamed pack download.
- `server-plugin/src/crypto.mjs` — WebCrypto-compatible AES-GCM chunk open and hashing.
- `server-plugin/src/reconstruct.mjs` — chunk/item validation and staged logical item reconstruction.
- `server-plugin/src/path-policy.mjs` — logical-ID parsing and path-containment enforcement.
- `server-plugin/src/journal.mjs` — non-secret apply journal and restart recovery.
- `server-plugin/src/transaction.mjs` — staging, atomic moves, deletion-last, rollback.
- `server-plugin/src/adapters/simple.mjs` — character/chat/groupchat/group/lorebook/preset adapters.
- `server-plugin/src/adapters/compound.mjs` — settings/persona/theme/quick-reply merge adapters.
- `server-plugin/src/restore-service.mjs` — end-to-end restore orchestration and metrics.
- `server-plugin/test/*.test.mjs` — unit/integration tests with temporary user directories and mock Drive.

### Browser extension

- `src/backend/drive/companion-types.ts` — protocol types shared by extension callers.
- `src/backend/drive/companion-client.ts` — capability/start/status/cancel HTTP client.
- `src/backend/drive/fast-restore.ts` — token/subkey handoff, polling, and result validation.
- `src/crypto/subkeys.ts` — opt-in extractable chunk subkey derivation only.
- `src/sync/engine.ts` — route Drive v2 Pull to companion before browser scanning.
- `src/index.ts` — explicit Fast Pull unavailable/Legacy Pull confirmation and progress wiring.
- Existing adjacent `__tests__` directories — browser-side protocol and routing regression tests.

### Packaging and evidence

- `server-plugin/README.md` — desktop install/enable/remove instructions and SillyiOS boundary.
- `scripts/install-server-plugin.mjs` — explicit-root copy installer that never edits `config.yaml`.
- `server-plugin/test/fixtures/` — deterministic encrypted packs and logical payloads only; no private user data.
- `.omo/evidence/drive-v2-fast-restore/` — ignored runtime benchmark evidence, never committed.

---

### Task 1: Companion Package, Capabilities, and Restore Protocol

**Files:**
- Create: `server-plugin/package.json`
- Create: `server-plugin/index.mjs`
- Create: `server-plugin/src/protocol.mjs`
- Test: `server-plugin/test/protocol.test.mjs`

**Interfaces:**
- Consumes: SillyTavern's plugin loader contract: named `info`, `init(router)`, and optional `exit()` exports.
- Produces: `PROTOCOL_VERSION`, `CAPABILITIES`, `validateRestoreStart(value)`, `info`, `init(router)`, and `/capabilities`.

- [ ] **Step 1: Write the failing protocol tests**

```js
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, validateRestoreStart } from '../src/protocol.mjs';

const request = {
  requestId: 'restore-1',
  commitId: 'head-a',
  packsFolderId: 'packs-folder',
  manifest: { schema: 2, storage: 'drive-pack-v2', device: 'pc', updatedAt: 1, chunkBytes: 1048576, packBytes: 33554432, items: {} },
  scopes: ['settings', 'characters', 'chats'],
  baseCommitId: 'head-old',
  accessToken: 'short-lived-token',
  chunkKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  expected: { items: 0, packs: 0, plaintextBytes: 0 },
};

describe('companion protocol', () => {
  it('advertises protocol 1 and Drive pack schema 2', () => {
    expect(CAPABILITIES).toMatchObject({ protocol: 1, drivePackSchemas: [2] });
  });

  it('accepts a complete start request and rejects an unknown item type', () => {
    expect(validateRestoreStart(request).requestId).toBe('restore-1');
    expect(() => validateRestoreStart({
      ...request,
      manifest: { ...request.manifest, items: { x: { id: 'x', type: 'secret', hash: '00', size: 1, mtime: 1, chunks: [] } } },
    })).toThrow(/unsupported item type/i);
  });
});
```

- [ ] **Step 2: Run the test and confirm the missing-module failure**

Run: `npx vitest run server-plugin/test/protocol.test.mjs`

Expected: FAIL because `server-plugin/src/protocol.mjs` does not exist.

- [ ] **Step 3: Add package metadata and the minimal validated protocol**

```json
{
  "name": "tavernsync-companion",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "index.mjs"
}
```

```js
export const PROTOCOL_VERSION = 1;
export const ITEM_TYPES = Object.freeze([
  'settings', 'preset', 'worldinfo', 'persona', 'character',
  'chat', 'group', 'groupchat', 'quickreply', 'theme',
]);
export const CAPABILITIES = Object.freeze({
  protocol: PROTOCOL_VERSION,
  pluginVersion: '0.1.0',
  drivePackSchemas: [2],
  itemTypes: ITEM_TYPES,
  supportsRollback: true,
  supportsCancellation: true,
});

export function validateRestoreStart(value) {
  if (!value || typeof value !== 'object') throw new TypeError('restore request must be an object');
  for (const key of ['requestId', 'commitId', 'packsFolderId', 'accessToken', 'chunkKeyBase64']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) throw new TypeError(`invalid ${key}`);
  }
  if (value.manifest?.schema !== 2 || value.manifest?.storage !== 'drive-pack-v2') {
    throw new TypeError('unsupported Drive pack manifest');
  }
  for (const [id, item] of Object.entries(value.manifest.items ?? {})) {
    if (item.id !== id || !ITEM_TYPES.includes(item.type)) throw new TypeError(`unsupported item type for ${id}`);
  }
  return structuredClone(value);
}
```

```js
import { CAPABILITIES } from './src/protocol.mjs';

export const info = Object.freeze({
  id: 'tavernsync',
  name: 'TavernSync Companion',
  description: 'Local bounded-memory restore service for TavernSync',
});

export async function init(router) {
  router.get('/capabilities', (_request, response) => response.json(CAPABILITIES));
}

export async function exit() {}
```

- [ ] **Step 4: Run protocol tests and syntax checks**

Run: `npx vitest run server-plugin/test/protocol.test.mjs && node --check server-plugin/index.mjs && node --check server-plugin/src/protocol.mjs`

Expected: protocol tests PASS and both syntax checks exit 0.

- [ ] **Step 5: Commit the protocol slice**

```bash
git add server-plugin/package.json server-plugin/index.mjs server-plugin/src/protocol.mjs server-plugin/test/protocol.test.mjs
git commit -m "feat(companion): define fast restore protocol"
```

### Task 2: Trusted Transport, Secret Lifetime, and Job Locking

**Files:**
- Create: `server-plugin/src/security.mjs`
- Create: `server-plugin/src/job-manager.mjs`
- Test: `server-plugin/test/security.test.mjs`
- Test: `server-plugin/test/job-manager.test.mjs`

**Interfaces:**
- Consumes: validated request from `validateRestoreStart`.
- Produces: `assertTrustedTransport(request)`, `assertGoogleDriveUrl(url)`, `redactError(error)`, `createSecretLease(input)`, and `createJobManager(options)`.

- [ ] **Step 1: Write failing security and per-user lock tests**

```js
import { describe, expect, it } from 'vitest';
import { assertGoogleDriveUrl, assertTrustedTransport, redactError } from '../src/security.mjs';

describe('restore security boundary', () => {
  it('permits loopback and HTTPS but rejects remote HTTP', () => {
    expect(() => assertTrustedTransport({ protocol: 'http', socket: { remoteAddress: '127.0.0.1' } })).not.toThrow();
    expect(() => assertTrustedTransport({ protocol: 'https', socket: { remoteAddress: '10.0.0.8' } })).not.toThrow();
    expect(() => assertTrustedTransport({ protocol: 'http', socket: { remoteAddress: '10.0.0.8' } })).toThrow(/trusted transport/i);
  });

  it('allows only Google Drive API URLs and redacts bearer text', () => {
    expect(() => assertGoogleDriveUrl('https://www.googleapis.com/drive/v3/files/x?alt=media')).not.toThrow();
    expect(() => assertGoogleDriveUrl('https://evil.example/steal')).toThrow(/Google Drive/i);
    expect(redactError(new Error('Bearer abc123'))).not.toContain('abc123');
  });
});
```

```js
import { expect, it } from 'vitest';
import { createJobManager } from '../src/job-manager.mjs';

it('permits one active restore per user and disposes key bytes', async () => {
  const manager = createJobManager({ id: () => 'job-1' });
  const key = Buffer.alloc(32, 7);
  const job = manager.start('alice', { accessToken: 'token', chunkKey: key });
  expect(() => manager.start('alice', { accessToken: 'other', chunkKey: Buffer.alloc(32) })).toThrow(/already active/i);
  manager.finish(job.id, { state: 'committed' });
  expect([...key]).toEqual(new Array(32).fill(0));
});
```

- [ ] **Step 2: Run both files and verify they fail before implementation**

Run: `npx vitest run server-plugin/test/security.test.mjs server-plugin/test/job-manager.test.mjs`

Expected: FAIL because both source modules are missing.

- [ ] **Step 3: Implement the narrow security and job APIs**

```js
import { isIP } from 'node:net';

const GOOGLE_HOSTS = new Set(['www.googleapis.com']);
export function assertGoogleDriveUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !GOOGLE_HOSTS.has(url.hostname)) throw new TypeError('URL is not a Google Drive API URL');
  return url;
}
export function assertTrustedTransport(request) {
  const raw = request.socket?.remoteAddress?.replace(/^::ffff:/, '') ?? '';
  const loopback = raw === '127.0.0.1' || raw === '::1' || (isIP(raw) === 6 && raw === '0:0:0:0:0:0:0:1');
  if (!loopback && request.protocol !== 'https') throw new Error('Fast Pull requires a trusted transport');
}
export function redactError(error) {
  return String(error?.message ?? error).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}
export function createSecretLease({ accessToken, chunkKey }) {
  let token = accessToken;
  const key = chunkKey;
  return { token: () => token, key: () => key, dispose() { key.fill(0); token = ''; } };
}
```

`createJobManager` must maintain `queued|preparing|applying|rolling_back|committed|failed|cancelled` states, index active jobs by authenticated user handle, expose an `AbortController`, and call the lease's `dispose()` on every terminal path.

- [ ] **Step 4: Run the focused tests**

Run: `npx vitest run server-plugin/test/security.test.mjs server-plugin/test/job-manager.test.mjs`

Expected: both files PASS with no token/key text printed.

- [ ] **Step 5: Commit the security slice**

```bash
git add server-plugin/src/security.mjs server-plugin/src/job-manager.mjs server-plugin/test/security.test.mjs server-plugin/test/job-manager.test.mjs
git commit -m "feat(companion): secure restore job secrets"
```

### Task 3: Retrying Google Drive Downloader

**Files:**
- Create: `server-plugin/src/retry.mjs`
- Create: `server-plugin/src/drive-client.mjs`
- Test: `server-plugin/test/drive-client.test.mjs`

**Interfaces:**
- Consumes: access-token getter from the active secret lease, packs-folder ID, manifest pack names, job AbortSignal.
- Produces: `createDriveClient(options)`, `listPackFiles(parentId)`, and `downloadPackToFile(fileId, targetPath, signal)`.

- [ ] **Step 1: Write failing pagination, retry, and redaction tests**

```js
import { describe, expect, it, vi } from 'vitest';
import { createDriveClient } from '../src/drive-client.mjs';

describe('companion Drive client', () => {
  it('paginates pack listings and retries a transient download without leaking the token', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ id: 'a', name: 'pack-a', size: '4' }], nextPageToken: 'next' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ id: 'b', name: 'pack-b', size: '5' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const writes = [];
    const client = createDriveClient({
      token: () => 'secret-token',
      fetchImpl,
      sleep: async () => {},
      writeResponseToFile: async (response, target) => writes.push([target, Buffer.from(await response.arrayBuffer())]),
    });
    expect((await client.listPackFiles('folder')).size).toBe(2);
    await client.downloadPackToFile('a', 'pack.tmp');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[2][1].headers.Authorization).toBe('Bearer secret-token');
    expect(writes).toEqual([['pack.tmp', Buffer.from([1, 2, 3])]]);
  });

  it('redacts bearer tokens from terminal errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('denied', { status: 401 }));
    const client = createDriveClient({ token: () => 'secret-token', fetchImpl, sleep: async () => {} });
    await expect(client.listPackFiles('folder')).rejects.not.toThrow(/secret-token/);
  });
});
```

Use a temporary-path writer injection in the test so no repository file is created.

- [ ] **Step 2: Run the test and verify the missing-client failure**

Run: `npx vitest run server-plugin/test/drive-client.test.mjs`

Expected: FAIL because `drive-client.mjs` is missing.

- [ ] **Step 3: Implement allow-listed pagination and streamed download**

The client must construct only these URLs itself:

```js
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const listUrl = new URL(`${DRIVE_API}/files`);
listUrl.searchParams.set('q', `'${parentId}' in parents and trashed=false`);
listUrl.searchParams.set('fields', 'nextPageToken,files(id,name,size)');
listUrl.searchParams.set('pageSize', '1000');
```

`retry.mjs` must retry network failures plus `408`, `429`, and `5xx` up to three retries with delays `250`, `1000`, and `4000` ms plus bounded jitter. It must not retry `400`, `401`, `403`, or authenticated redirects. `downloadPackToFile` must stream `Response.body` through `Readable.fromWeb` into a newly created temporary file and rename it only after the expected byte count matches.

- [ ] **Step 4: Run downloader tests and syntax checks**

Run: `npx vitest run server-plugin/test/drive-client.test.mjs && node --check server-plugin/src/drive-client.mjs && node --check server-plugin/src/retry.mjs`

Expected: PASS and syntax checks exit 0.

- [ ] **Step 5: Commit the downloader**

```bash
git add server-plugin/src/retry.mjs server-plugin/src/drive-client.mjs server-plugin/test/drive-client.test.mjs
git commit -m "feat(companion): stream Drive packs with retry"
```

### Task 4: WebCrypto-Compatible Chunk Reconstruction

**Files:**
- Create: `server-plugin/src/crypto.mjs`
- Create: `server-plugin/src/reconstruct.mjs`
- Test: `server-plugin/test/reconstruct.test.mjs`
- Create: `server-plugin/test/fixtures/crypto-fixture.mjs`

**Interfaces:**
- Consumes: raw 32-byte `chunkEnc` key, validated manifest, downloaded pack paths.
- Produces: `openChunk(key, boxed)`, `sha256Hex(input)`, and `reconstructItems(options)` yielding verified staged logical-item paths.

- [ ] **Step 1: Generate a deterministic non-private fixture and write failing round-trip tests**

The fixture generator inside the test must use Node WebCrypto with a fixed key and IV to create `IV(12) || ciphertext || tag(16)`, matching browser `seal()` framing.

```js
import { createHash, webcrypto } from 'node:crypto';
import { expect, it } from 'vitest';
import { makeCryptoFixture } from './fixtures/crypto-fixture.mjs';
import { openChunk, reconstructItems } from '../src/reconstruct.mjs';

it('opens browser-framed AES-GCM chunks and rejects an item hash mismatch', async () => {
  const key = Buffer.alloc(32, 9);
  const plain = Buffer.from('logical chat payload\n');
  const cryptoKey = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const iv = Buffer.alloc(12, 3);
  const encrypted = Buffer.from(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plain));
  const boxed = Buffer.concat([iv, encrypted]);
  expect(await openChunk(key, boxed)).toEqual(plain);
  const fixture = await makeCryptoFixture({ boxed, plaintext: plain, wrongItemHash: true });
  await expect(reconstructItems({ manifest: fixture.manifest, key, packPaths: fixture.packPaths })).rejects.toThrow(/item hash/i);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails before implementation**

Run: `npx vitest run server-plugin/test/reconstruct.test.mjs`

Expected: FAIL because the reconstruction modules are missing.

- [ ] **Step 3: Implement framing, range, chunk-hash, length, and item-hash checks**

```js
import { createDecipheriv, createHash } from 'node:crypto';

export function openChunk(key, boxed) {
  if (boxed.length < 28) throw new TypeError('boxed chunk is too short');
  const iv = boxed.subarray(0, 12);
  const ciphertext = boxed.subarray(12, -16);
  const tag = boxed.subarray(-16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
export const sha256Hex = input => createHash('sha256').update(input).digest('hex');
```

`reconstructItems` must reject negative/non-safe offsets, pack-range overflow, boxed/plain length mismatch, chunk hash mismatch, duplicate logical IDs, complete item size mismatch, and complete item hash mismatch. It must append plaintext to a staging file rather than concatenating an entire large item in memory.

- [ ] **Step 4: Run reconstruction tests**

Run: `npx vitest run server-plugin/test/reconstruct.test.mjs`

Expected: PASS for valid browser framing and PASS for every rejection assertion.

- [ ] **Step 5: Commit crypto reconstruction**

```bash
git add server-plugin/src/crypto.mjs server-plugin/src/reconstruct.mjs server-plugin/test/reconstruct.test.mjs server-plugin/test/fixtures/crypto-fixture.mjs
git commit -m "feat(companion): reconstruct verified pack items"
```

### Task 5: Safe Paths, Transaction Journal, and Rollback

**Files:**
- Create: `server-plugin/src/path-policy.mjs`
- Create: `server-plugin/src/journal.mjs`
- Create: `server-plugin/src/transaction.mjs`
- Test: `server-plugin/test/transaction.test.mjs`

**Interfaces:**
- Consumes: authenticated `request.user.directories`, staged adapter targets, and deletion targets.
- Produces: `parseLogicalId(id)`, `assertInside(parent, candidate)`, `createJournal(jobRoot)`, and `createRestoreTransaction(options)`.

- [ ] **Step 1: Write failing traversal, deletion-order, and rollback tests**

```js
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { assertInside } from '../src/path-policy.mjs';
import { createRestoreTransaction } from '../src/transaction.mjs';

it('rejects escaped targets and restores originals after an apply fault', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ts-restore-'));
  const staged = path.join(root, 'staged.tmp');
  await writeFile(staged, 'new');
  expect(() => assertInside(root, path.join(root, '..', 'escape'))).toThrow(/outside/i);
  const live = path.join(root, 'live.json');
  await writeFile(live, 'old');
  const tx = await createRestoreTransaction({ root, failAfterOperations: 1 });
  await expect(tx.apply([{ target: live, staged }], [{ target: path.join(root, 'stale.json') }])).rejects.toThrow();
  expect(await readFile(live, 'utf8')).toBe('old');
});
```

- [ ] **Step 2: Run the test and verify it fails before transaction code exists**

Run: `npx vitest run server-plugin/test/transaction.test.mjs`

Expected: FAIL because the transaction modules are missing.

- [ ] **Step 3: Implement containment and journaled move semantics**

`assertInside` must compare resolved paths with a trailing separator and reject the parent itself when a file target is required. The journal must contain only operation IDs, relative paths, phase, and completion flags. It must never contain Drive tokens, key bytes, decrypted payloads, or absolute paths outside the authenticated user's root.

Before creating staging files, `createRestoreTransaction` must call an injected `availableBytes(root)` preflight (production uses `statfs`; tests use a deterministic fake) and reject when estimated staging + backup bytes exceed available space. The rejection happens before any live mutation. If the runtime cannot report free space, return a typed `SPACE_UNKNOWN` failure rather than guessing.

The transaction sequence is fixed:

```js
await journal.setPhase('applying');
for (const op of writes) await moveOldThenStage(op);
await journal.setPhase('deleting');
for (const op of deletions) await moveLiveToRollback(op);
await verifyResult();
await journal.setPhase('committed');
```

Any failure after `applying` begins must reverse completed operations in journal reverse order.

- [ ] **Step 4: Run transaction tests, including simulated restart recovery**

Run: `npx vitest run server-plugin/test/transaction.test.mjs`

Expected: traversal, rollback, deletion-last, and restart-recovery cases PASS.

- [ ] **Step 5: Commit the transaction core**

```bash
git add server-plugin/src/path-policy.mjs server-plugin/src/journal.mjs server-plugin/src/transaction.mjs server-plugin/test/transaction.test.mjs
git commit -m "feat(companion): apply restores with rollback"
```

### Task 6: Simple Logical Type Adapters

**Files:**
- Create: `server-plugin/src/adapters/simple.mjs`
- Test: `server-plugin/test/simple-adapters.test.mjs`

**Interfaces:**
- Consumes: verified staged logical items plus `request.user.directories`.
- Produces: `createSimpleAdapters(directories)` with adapters for `character`, `chat`, `groupchat`, `group`, `worldinfo`, and `preset`.

- [ ] **Step 1: Write failing table-driven adapter tests**

```js
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createSimpleAdapters } from '../src/adapters/simple.mjs';

it.each([
  ['chat/alice.png/day-1', 'chat', 'chats/alice.png/day-1.jsonl'],
  ['groupchat/room-1', 'groupchat', 'group chats/room-1.jsonl'],
  ['group/42', 'group', 'groups/42.json'],
  ['worldinfo/book', 'worldinfo', 'worlds/book.json'],
  ['preset/openai/main', 'preset', 'OpenAI Settings/main.json'],
])('maps %s without leaving the user root', async (id, type, expected) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ts-adapter-'));
  const payloadPath = path.join(root, `${type}.payload`);
  await writeFile(payloadPath, type === 'chat' || type === 'groupchat' ? '{}\n' : '{}');
  const directories = {
    root,
    characters: path.join(root, 'characters'),
    chats: path.join(root, 'chats'),
    groupChats: path.join(root, 'group chats'),
    groups: path.join(root, 'groups'),
    worlds: path.join(root, 'worlds'),
    presets: path.join(root, 'OpenAI Settings'),
  };
  const adapters = createSimpleAdapters(directories);
  const result = await adapters[type].stage({ id, payloadPath });
  expect(path.relative(root, result.target).replaceAll('\\', '/')).toBe(expected);
});
```

Add separate assertions that character data begins with the PNG signature, chat/groupchat contain valid JSON on every non-empty line, JSON items parse successfully, unsafe names are rejected rather than silently renamed, and unsupported preset API IDs fail during Prepare.

- [ ] **Step 2: Run the adapter tests and verify they fail**

Run: `npx vitest run server-plugin/test/simple-adapters.test.mjs`

Expected: FAIL because `simple.mjs` is absent.

- [ ] **Step 3: Implement adapters matching SillyTavern directory conventions**

Use these target rules:

```js
const rules = {
  character: ({ avatar }) => path.join(directories.characters, avatar),
  chat: ({ avatar, name }) => path.join(directories.chats, avatar, `${name}.jsonl`),
  groupchat: ({ id }) => path.join(directories.groupChats, `${id}.jsonl`),
  group: ({ id }) => path.join(directories.groups, `${id}.json`),
  worldinfo: ({ name }) => path.join(directories.worlds, `${name}.json`),
};
```

Preset API IDs map exactly to SillyTavern's `koboldAI_Settings`, `novelAI_Settings`, `openAI_Settings`, `textGen_Settings`, `instruct`, `context`, `sysprompt`, and `reasoning` directories. JSON output uses four-space indentation to match existing endpoints. The adapter returns staged write descriptors; it never changes live data directly.

- [ ] **Step 4: Run simple adapter tests**

Run: `npx vitest run server-plugin/test/simple-adapters.test.mjs`

Expected: all mappings, validators, and rejection cases PASS.

- [ ] **Step 5: Commit simple adapters**

```bash
git add server-plugin/src/adapters/simple.mjs server-plugin/test/simple-adapters.test.mjs
git commit -m "feat(companion): stage simple sync item types"
```

### Task 7: Compound Settings, Persona, Theme, and Quick-Reply Adapters

**Files:**
- Create: `server-plugin/src/adapters/compound.mjs`
- Test: `server-plugin/test/compound-adapters.test.mjs`

**Interfaces:**
- Consumes: filtered remote settings, persona payloads, canonical theme/quick-reply objects, and the current user settings file.
- Produces: `stageCompoundItems(options)` returning one coherent staged settings file plus persona/theme/quick-reply file writes.

- [ ] **Step 1: Write failing preservation and merge tests**

```js
import { expect, it } from 'vitest';
import { stageCompoundItems } from '../src/adapters/compound.mjs';

it('merges synchronized settings while preserving excluded local values', async () => {
  const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const local = { device_name: 'local-device', power_user: { personas: { 'old.png': 'Old' } }, theme: 'local-only' };
  const remote = { power_user: { movingUIState: { x: 1 } }, selected_group: '42' };
  const persona = { avatarId: 'new.png', name: 'New', description: { description: 'text' }, imageBase64: ONE_PIXEL_PNG };
  const staged = await stageCompoundItems({ localSettings: local, remoteSettings: remote, personas: [persona], themes: [], quickReplies: [] });
  expect(staged.settings.device_name).toBe('local-device');
  expect(staged.settings.power_user.personas['new.png']).toBe('New');
  expect(staged.settings.selected_group).toBe('42');
});
```

Add tests for deleted remote personas, base64 validation, avatar filename containment, theme and quick-reply replacement by name, preservation of unrelated local entries, and deterministic output.

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `npx vitest run server-plugin/test/compound-adapters.test.mjs`

Expected: FAIL because `compound.mjs` is absent.

- [ ] **Step 3: Implement one compound merge transaction**

The adapter must parse current `settings.json`, deep-merge only keys present in the filtered remote settings object, preserve absent local keys, then apply persona metadata into `power_user.personas` and `power_user.persona_descriptions`. Persona avatars stage under `directories.avatars`. Themes and quick replies stage by validated `name` under `directories.themes` and `directories.quickreplies`; entries absent from the selected complete snapshot are returned as deletion descriptors, not removed during staging.

```js
export function mergePresent(remote, local) {
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return structuredClone(remote);
  const out = local && typeof local === 'object' && !Array.isArray(local) ? structuredClone(local) : {};
  for (const [key, value] of Object.entries(remote)) out[key] = mergePresent(value, out[key]);
  return out;
}
```

- [ ] **Step 4: Run compound adapter tests**

Run: `npx vitest run server-plugin/test/compound-adapters.test.mjs`

Expected: preservation, deletion planning, and deterministic merge cases PASS.

- [ ] **Step 5: Commit compound adapters**

```bash
git add server-plugin/src/adapters/compound.mjs server-plugin/test/compound-adapters.test.mjs
git commit -m "feat(companion): merge compound sync item types"
```

### Task 8: Restore Service and Plugin Routes

**Files:**
- Create: `server-plugin/src/restore-service.mjs`
- Modify: `server-plugin/index.mjs`
- Create: `server-plugin/test/restore-harness.mjs`
- Test: `server-plugin/test/restore-service.test.mjs`
- Test: `server-plugin/test/routes.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–7 modules and authenticated Express requests with `request.user.profile.handle` and `request.user.directories`.
- Produces: `createRestoreService(deps)` plus `POST /restore/start`, `GET /restore/:jobId`, and `POST /restore/:jobId/cancel`.

- [ ] **Step 1: Write failing orchestration and route tests**

```js
import { expect, it, vi } from 'vitest';
import { fixtureStartRequest, fixtureUser, restoreHarness } from './restore-harness.mjs';
import { createRestoreService } from '../src/restore-service.mjs';

it('fully prepares before writes, deletes last, and commits metrics', async () => {
  const events = [];
  const service = createRestoreService(restoreHarness(events));
  const result = await service.run(fixtureStartRequest(), fixtureUser());
  expect(events.indexOf('verified:all')).toBeLessThan(events.indexOf('apply:first'));
  expect(events.indexOf('apply:last')).toBeLessThan(events.indexOf('delete:first'));
  expect(events.at(-1)).toBe('commit');
  expect(result).toMatchObject({ state: 'committed', commitId: 'head-a' });
});

it('never deletes or commits when a pack is missing', async () => {
  const events = [];
  const service = createRestoreService(restoreHarness(events, { missingPack: true }));
  await expect(service.run(fixtureStartRequest(), fixtureUser())).rejects.toThrow(/missing pack/i);
  expect(events.some(x => x.startsWith('delete:'))).toBe(false);
  expect(events).not.toContain('commit');
});
```

- [ ] **Step 2: Run service tests and verify they fail before orchestration exists**

Run: `npx vitest run server-plugin/test/restore-service.test.mjs server-plugin/test/routes.test.mjs`

Expected: FAIL because the service and routes are absent.

- [ ] **Step 3: Implement service phases and thin routes**

Create `restore-harness.mjs` with exactly these exports: `fixtureStartRequest()` returns a schema-2 start request with commit `head-a`; `fixtureUser()` returns a temporary authenticated user root/directories object; `restoreHarness(events, options = {})` returns deterministic fake Drive/reconstruct/adapter/transaction/job dependencies, and `options.missingPack === true` throws before emitting `verified:all`. This makes both tests above complete without private fixtures.

`restore-service.mjs` must own timing/metrics and call these phases exactly:

```js
await job.transition('preparing');
const packs = await drive.downloadReferencedPacks(request.manifest, signal);
const logicalItems = await reconstructItems({ manifest: request.manifest, key: secrets.key(), packs });
const plan = await adapters.stageAll({ logicalItems, directories: user.directories, scopes: request.scopes });
await job.transition('applying');
const commit = await transaction.apply(plan.writes, plan.deletions);
await job.transition('committed', { commitId: request.commitId, metrics: commit.metrics });
```

Routes call `assertTrustedTransport`, validate the authenticated user, parse through `validateRestoreStart`, return `202 { jobId }`, expose redacted status, and make cancellation idempotent. Route handlers never contain restore logic.

- [ ] **Step 4: Run all companion tests**

Run: `npx vitest run server-plugin/test`

Expected: all companion test files PASS; no secret fixture value appears in stdout/stderr.

- [ ] **Step 5: Commit service and routes**

```bash
git add server-plugin/index.mjs server-plugin/src/restore-service.mjs server-plugin/test/restore-service.test.mjs server-plugin/test/routes.test.mjs
git commit -m "feat(companion): expose transactional restore jobs"
```

### Task 9: Browser Companion Client and Exportable Chunk Subkey

**Files:**
- Create: `src/backend/drive/companion-types.ts`
- Create: `src/backend/drive/companion-client.ts`
- Create: `src/backend/drive/__tests__/companion-client.test.ts`
- Modify: `src/crypto/subkeys.ts`
- Modify: `src/crypto/__tests__/subkeys.test.ts`

**Interfaces:**
- Consumes: SillyTavern `getRequestHeaders`, selected Drive v2 manifest/head, GIS token provider, and root raw key.
- Produces: `CompanionClient`, `deriveDrivePackSubkeys(rootRaw, folderId, options?)`, and `exportDriveV2ChunkKey(...)`.

- [ ] **Step 1: Write failing client and extractability tests**

```ts
it('exports only an explicitly extractable chunk key', async () => {
  const keys = await deriveDrivePackSubkeys(new Uint8Array(32).fill(1), 'root', { chunkExtractable: true });
  await expect(crypto.subtle.exportKey('raw', keys.chunkEnc)).resolves.toBeInstanceOf(ArrayBuffer);
  await expect(crypto.subtle.exportKey('raw', keys.manifestEnc)).rejects.toThrow();
  await expect(crypto.subtle.exportKey('raw', keys.packName)).rejects.toThrow();
});
```

```ts
import { vi } from 'vitest';
import { CompanionClient } from '../companion-client';

const CAPABILITIES = { protocol: 1, drivePackSchemas: [2], transactionalRestore: true };
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fixtureStart = () => ({ protocol: 1, commitId: 'head-a', rootFolderId: 'root', packsFolderId: 'packs', manifest: { schema: 2, items: [], packs: [] }, accessToken: 'token', chunkKey: 'key' });

it('uses same-origin authenticated endpoints and never stores start secrets', async () => {
  const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(CAPABILITIES)).mockResolvedValueOnce(jsonResponse({ jobId: 'j1' }, 202));
  const client = new CompanionClient(fetchImpl, () => ({ 'X-CSRF-Token': 'csrf' }));
  await client.capabilities();
  await client.start(fixtureStart());
  expect(fetchImpl.mock.calls[1][0]).toBe('/api/plugins/tavernsync/restore/start');
  expect(localStorage.getItem('accessToken')).toBeNull();
});
```

- [ ] **Step 2: Run focused browser tests and verify red**

Run: `npx vitest run src/crypto/__tests__/subkeys.test.ts src/backend/drive/__tests__/companion-client.test.ts`

Expected: FAIL because the options/client do not exist.

- [ ] **Step 3: Implement opt-in extractability and protocol client**

Change the internal `hkdf` helper to accept `extractable = false`; pass `options?.chunkExtractable === true` only for `chunk-enc-v2`. Leave `packName` and `manifestEnc` non-extractable.

```ts
export class CompanionClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly headers: () => Record<string, string> = () => SillyTavern.getContext().getRequestHeaders(),
  ) {}
  capabilities(): Promise<CompanionCapabilities> { return this.request('/api/plugins/tavernsync/capabilities', { method: 'GET' }); }
  start(body: CompanionRestoreStart): Promise<{ jobId: string }> { return this.request('/api/plugins/tavernsync/restore/start', { method: 'POST', body: JSON.stringify(body) }); }
  status(jobId: string): Promise<CompanionJobStatus> { return this.request(`/api/plugins/tavernsync/restore/${encodeURIComponent(jobId)}`, { method: 'GET' }); }
  cancel(jobId: string): Promise<void> { return this.request(`/api/plugins/tavernsync/restore/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', body: '{}' }); }
}
```

- [ ] **Step 4: Run client/subkey tests and TypeScript**

Run: `npx vitest run src/crypto/__tests__/subkeys.test.ts src/backend/drive/__tests__/companion-client.test.ts && npx tsc --noEmit`

Expected: tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit browser protocol support**

```bash
git add src/backend/drive/companion-types.ts src/backend/drive/companion-client.ts src/backend/drive/__tests__/companion-client.test.ts src/crypto/subkeys.ts src/crypto/__tests__/subkeys.test.ts
git commit -m "feat(drive): add companion restore client"
```

### Task 10: Fast Restore Orchestration and Pull Routing

**Files:**
- Create: `src/backend/drive/fast-restore.ts`
- Create: `src/backend/drive/__tests__/fast-restore.test.ts`
- Modify: `src/sync/engine.ts`
- Modify: `src/backend/__tests__/drive-v2-engine-routing.test.ts`

**Interfaces:**
- Consumes: `CompanionClient`, Drive v2 runtime/head/manifest, GIS token provider, current namespace, and progress callback.
- Produces: `runDriveV2FastRestore(options)` and engine routing that skips browser `scanLocal()` when Fast Pull is available.

- [ ] **Step 1: Write failing routing and terminal-state tests**

```ts
const COMPATIBLE_CAPABILITIES = { protocol: 1, drivePackSchemas: [2], transactionalRestore: true };
const fixtureMetrics = () => ({ downloadMs: 10, verifyMs: 10, stageMs: 10, applyMs: 10, deleteMs: 0, totalMs: 40, peakRssBytes: 1, temporaryBytes: 1, retries: 0 });

it('routes Drive v2 Pull to companion before browser scan', async () => {
  companionCapabilities.mockResolvedValue(COMPATIBLE_CAPABILITIES);
  companionRestore.mockResolvedValue({ state: 'committed', commitId: 'head-a', metrics: fixtureMetrics() });
  await runSync({ direction: 'pull' });
  expect(scanLocal).not.toHaveBeenCalled();
  expect(companionRestore).toHaveBeenCalledWith(expect.objectContaining({ commitId: 'head-a' }));
  expect(saveDriveV2Base).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ commitId: 'head-a' }));
});

it('does not advance base after companion failure or cancellation', async () => {
  companionRestore.mockResolvedValue({ state: 'cancelled' });
  await expect(runSync({ direction: 'pull' })).rejects.toThrow(/cancelled/i);
  expect(saveDriveV2Base).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run focused tests and confirm existing engine fails the expectations**

Run: `npx vitest run src/backend/drive/__tests__/fast-restore.test.ts src/backend/__tests__/drive-v2-engine-routing.test.ts`

Expected: FAIL because current Pull calls `scanLocal()` and has no companion path.

- [ ] **Step 3: Implement token/subkey handoff, polling, and engine branch**

`runDriveV2FastRestore` must:

1. resolve the selected single Drive head and decrypted manifest;
2. obtain a fresh GIS access token from the existing provider;
3. derive Drive v2 keys with only `chunkEnc` extractable;
4. export/base64 the 32-byte chunk key;
5. start the local job and immediately drop local raw key/token references;
6. poll no faster than 250 ms and forward phase/bytes/ETA progress;
7. cancel through both local `AbortSignal` and companion endpoint;
8. accept success only when returned `commitId` equals the selected head;
9. save the new base after committed success, then request one reload.

In `runDriveV2FromEngine`, branch to this path before `scanLocal()` for `direction === 'pull'`. Push and explicit Legacy Pull retain the existing scan path.

- [ ] **Step 4: Run focused tests, full Vitest, and TypeScript**

Run: `npx vitest run src/backend/drive/__tests__/fast-restore.test.ts src/backend/__tests__/drive-v2-engine-routing.test.ts && npm test && npx tsc --noEmit`

Expected: focused and full suites PASS; TypeScript exits 0.

- [ ] **Step 5: Commit fast routing**

```bash
git add src/backend/drive/fast-restore.ts src/backend/drive/__tests__/fast-restore.test.ts src/sync/engine.ts src/backend/__tests__/drive-v2-engine-routing.test.ts
git commit -m "feat(drive): route Pull through companion restore"
```

### Task 11: Explicit Fallback UX and Desktop Packaging

**Files:**
- Modify: `src/index.ts`
- Create: `src/ui/companion-fallback.ts`
- Create: `src/ui/__tests__/companion-fallback.test.ts`
- Create: `server-plugin/README.md`
- Create: `scripts/install-server-plugin.mjs`
- Test: `server-plugin/test/package.test.mjs`

**Interfaces:**
- Consumes: incompatible/missing capability result and the built companion directory.
- Produces: `promptFastRestoreUnavailable(reason)`, explicit Legacy Pull selection, and an installer that copies only `server-plugin/` to a user-supplied SillyTavern root.

- [ ] **Step 1: Write failing fallback and package tests**

```ts
import { expect, it, vi } from 'vitest';
import { promptFastRestoreUnavailable } from '../companion-fallback';

it('never starts Legacy Pull without explicit confirmation', async () => {
  const confirm = vi.fn().mockResolvedValue(false);
  const choice = await promptFastRestoreUnavailable('plugin missing', confirm);
  expect(choice).toBe('cancel');
  expect(confirm).toHaveBeenCalledOnce();
});
```

```js
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { installCompanion } from '../../scripts/install-server-plugin.mjs';

it('installer rejects a root without server.js and never edits config.yaml', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ts-package-'));
  await expect(installCompanion(root)).rejects.toThrow(/SillyTavern root/i);
  await expect(access(path.join(root, 'config.yaml'))).rejects.toThrow();
});
```

- [ ] **Step 2: Run fallback/package tests and verify red**

Run: `npx vitest run src/ui/__tests__/companion-fallback.test.ts server-plugin/test/package.test.mjs`

Expected: FAIL because the UI helper and installer are missing.

- [ ] **Step 3: Implement explicit fallback and reversible installer**

The UI copy must state that Fast Pull needs TavernSync Companion and that Legacy Pull may take roughly the prior measured duration. Choices are exactly `Cancel` and `Use Legacy Pull`; cancel is default.

`scripts/install-server-plugin.mjs` must export `installCompanion(root)` for the test and execute its CLI only when `import.meta.url` matches the invoked script. The installer invocation is:

```text
node scripts/install-server-plugin.mjs --sillytavern-root "E:\ST\SillyTavern"
```

It verifies `server.js` and `plugins/`, copies to `plugins/tavernsync-companion`, refuses to overwrite a non-TavernSync directory, and prints the exact manual config requirement:

```yaml
enableServerPlugins: true
```

It never edits `config.yaml`, starts/stops SillyTavern, or installs npm packages. `server-plugin/README.md` documents install, update, disable, remove, security boundary, and the unverified SillyiOS packaging status.

- [ ] **Step 4: Run UI/package tests and production build**

Run: `npx vitest run src/ui/__tests__/companion-fallback.test.ts server-plugin/test/package.test.mjs && npm run build`

Expected: tests PASS and Webpack production build exits 0.

- [ ] **Step 5: Commit UX and packaging**

```bash
git add src/index.ts src/ui/companion-fallback.ts src/ui/__tests__/companion-fallback.test.ts server-plugin/README.md scripts/install-server-plugin.mjs server-plugin/test/package.test.mjs
git commit -m "feat(companion): package explicit fast Pull support"
```

### Task 12: End-to-End Restore Verification and Benchmark Gate

**Files:**
- Create: `server-plugin/test/restore-integration.test.mjs`
- Create: `server-plugin/test/fixtures/build-fixture.mjs`
- Create: `scripts/benchmark-fast-restore.mjs`

**Interfaces:**
- Consumes: complete companion, extension client, deterministic encrypted fixture, temporary user directory, and optional live authenticated test surface.
- Produces: exact manifest-equivalence evidence and stage/throughput/memory/disk metrics.

- [ ] **Step 1: Write the failing end-to-end test**

```js
import { expect, it } from 'vitest';
import { buildEncryptedFixture, runRestoreFixture, scanLogicalFixture } from './fixtures/build-fixture.mjs';

it('restores every enabled logical item and deletion exactly once', async () => {
  const fixture = await buildEncryptedFixture({ includeAllItemTypes: true, staleLocalItems: 3 });
  const result = await runRestoreFixture(fixture);
  const rescanned = await scanLogicalFixture(result.userRoot);
  expect(rescanned.items).toEqual(fixture.manifest.items);
  expect(result.metrics.deleted).toBe(3);
  expect(result.events.filter(x => x === 'reload')).toHaveLength(1);
});
```

Add fault-matrix cases for network loss, `429`, missing pack, AES-GCM failure, chunk hash mismatch, item hash mismatch, cancellation during Prepare, cancellation during Apply, simulated restart, insufficient temporary space, and failed rollback. Every fault must assert final live-state and base-commit invariants.

- [ ] **Step 2: Run the integration file and verify it fails before the fixture harness exists**

Run: `npx vitest run server-plugin/test/restore-integration.test.mjs`

Expected: FAIL because fixture helpers are absent.

- [ ] **Step 3: Implement deterministic fixture and benchmark scripts**

`build-fixture.mjs` creates only synthetic names/content, uses schema 2 framing, and emits at least one item spanning packs. `benchmark-fast-restore.mjs` accepts `--fixture synthetic:full`, calls the builder in a temporary directory, runs three restores into fresh temporary user roots, verifies manifest equality after each run, and prints JSON containing:

```json
{
  "items": 2347,
  "packs": 30,
  "encryptedBytes": 0,
  "plaintextBytes": 0,
  "downloadMs": 0,
  "verifyMs": 0,
  "stageMs": 0,
  "applyMs": 0,
  "deleteMs": 0,
  "totalMs": 0,
  "peakRssBytes": 0,
  "temporaryBytes": 0,
  "retries": 0,
  "manifestEqual": true
}
```

The zeros above are initialized fields; the script replaces each with measured values before printing and exits nonzero if `manifestEqual` is false.

- [ ] **Step 4: Run the complete verification matrix**

Run:

```text
npx vitest run server-plugin/test/restore-integration.test.mjs
npx vitest run server-plugin/test
npm test
npx tsc --noEmit
npm run build
node --check server-plugin/index.mjs
git diff --check
```

Expected: all tests PASS, TypeScript/build/syntax checks exit 0, and `git diff --check` prints nothing. Repository lint remains outside this plan because the current repository lacks an ESLint flat configuration; do not weaken or bypass lint rules to manufacture a pass.

- [ ] **Step 5: Run isolated PC benchmark and record evidence**

Run: `node scripts/benchmark-fast-restore.mjs --fixture synthetic:full --runs 3 --output .omo/evidence/drive-v2-fast-restore/pc.json`

Expected: three manifest-equal runs, median at most 300,000 ms, no secret output, and evidence written only under ignored `.omo/evidence/`.

For the owner's real 2,347-item/30-pack snapshot, use a throwaway SillyTavern user and the normal UI only after synthetic integration passes. Never target the primary PC user directory for the first live restore. Record actual outcome separately from the synthetic gate.

- [ ] **Step 6: Commit integration and benchmark harness**

```bash
git add server-plugin/test/restore-integration.test.mjs server-plugin/test/fixtures/build-fixture.mjs scripts/benchmark-fast-restore.mjs
git commit -m "test(companion): verify transactional fast restore"
```

## Final Review Gate

Before merging or pushing implementation:

1. Inspect `git status --short` and account for the owner's `package-lock.json` change.
2. Inspect every commit and verify no SillyTavern core, HTTP/OG, private fixture, token, key, or live data entered the diff.
3. Run the complete Task 12 verification matrix fresh.
4. Compare synthetic restored manifest with its source exactly.
5. Install the companion into the PC test SillyTavern only through the explicit installer path.
6. Run the real Drive snapshot against a throwaway user and record stage timings.
7. Treat SillyiOS as unverified until its owner confirms packaging and a native-log-backed iPhone restore completes.
8. Request code review before merging the feature branch into `master`.

## Execution Boundary

Implementation starts in a dedicated worktree/feature branch. The approved spec
and this plan do not authorize enabling server plugins globally, editing
`config.yaml`, modifying the primary user directory, deleting Drive data,
merging to `master`, pushing to GitHub, or changing SillyiOS packaging without
the corresponding explicit owner action at that stage.
