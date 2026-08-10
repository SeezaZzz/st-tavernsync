# SillyTavern Core Transactional Bulk Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-neutral, bounded-memory restore-session API to SillyTavern core that stages authenticated logical user data, verifies every item, commits replacements atomically, applies deletions last, and rolls back failures.

**Architecture:** A new `/api/users/restore` router accepts a validated manifest, disk-backed multipart segment batches, status/cancel requests, and an atomic commit. Restore state lives inside the authenticated user's root; the browser never supplies filesystem paths, and core-owned logical adapters map supported item IDs to user directories. The implementation is split into reviewable protocol, staging, adapter, transaction, and route slices because upstream asks substantial changes to be discussed and kept small.

**Tech Stack:** Node.js 20+ ESM, Express 4, Multer 2 disk storage, Node `crypto`/`fs`, `write-file-atomic`, Jest 30, ESLint 8.

## Global Constraints

- Preserve Drive v2 `schema: 2` and `storage: "drive-pack-v2"`; SillyTavern core never imports that provider schema.
- Keep Google OAuth, Drive API calls, encryption, and pack parsing outside SillyTavern core.
- Accept only fixed logical item types and IDs; never accept destination paths.
- Maximum plaintext segment size is 1,048,576 bytes.
- Maximum plaintext per multipart batch is 8,388,608 bytes.
- Permit at most one active restore session per authenticated user.
- Make identical segment retries idempotent and mismatched duplicates non-committable.
- Do not change live user data until all selected items are staged and hash-verified.
- Apply deletions last and roll back failed or cancelled commits.
- Do not alter HTTP/OG sync, TavernSync Push, or the user's existing extension worktree changes.
- Target SillyTavern `staging`; do not push, open a PR, or message maintainers without separate owner authorization.
- Initial live gates: PC restore at most 5 minutes; mobile restore at most 15 minutes; no WebView/Jetsam crash; exact selected-scope inventory equality.

## File Structure

- `src/restore-sessions/protocol.js` — constants, manifest/request validation, stable public errors.
- `src/restore-sessions/path-policy.js` — logical-ID grammar and contained core-generated targets.
- `src/restore-sessions/session-store.js` — per-user lock, durable journal, expiry, ownership, state transitions.
- `src/restore-sessions/segment-store.js` — disk-backed segment ingestion, idempotency, item assembly/hash verification.
- `src/restore-sessions/adapters.js` — simple/compound logical payload validation and write/deletion plan construction.
- `src/restore-sessions/transaction.js` — disk-space check, atomic moves, deletion-last, rollback, restart recovery.
- `src/endpoints/restore-sessions.js` — thin authenticated HTTP router and route-specific Multer configuration.
- `src/server-startup.js` — mount `/api/users/restore`.
- `src/server-main.js` — bypass the legacy global avatar Multer only for restore-session batch requests.
- `tests/restore-sessions-*.test.js` — protocol, staging, adapter, transaction, routes, and recovery tests.

---

### Task 1: Protocol Limits and Logical Path Policy

**Files:**
- Create: `src/restore-sessions/protocol.js`
- Create: `src/restore-sessions/path-policy.js`
- Test: `tests/restore-sessions-protocol.test.js`

**Interfaces:**
- Consumes: untrusted JSON from `POST /api/users/restore/start` and `request.user.directories`.
- Produces: `RESTORE_PROTOCOL`, `RESTORE_LIMITS`, `RestoreProtocolError`, `validateRestoreStart(value)`, `parseLogicalId(id, declaredType)`, and `targetForLogicalItem(directories, item)`.

- [ ] **Step 1: Write failing protocol and traversal tests**

~~~js
import { describe, expect, test } from '@jest/globals';
import { validateRestoreStart } from '../src/restore-sessions/protocol.js';
import { targetForLogicalItem } from '../src/restore-sessions/path-policy.js';

const start = () => ({
    requestId: 'req-1', snapshotId: 'head-a', scopes: ['chat'],
    expectedItems: 1, expectedBytes: 3,
    items: [{ id: 'chat/Alice.png/chat-1', type: 'chat', size: 3,
        hash: 'a'.repeat(64), segmentCount: 1 }],
});

describe('restore protocol', () => {
    test('accepts a bounded manifest and freezes its clone', () => {
        const value = validateRestoreStart(start());
        expect(value.snapshotId).toBe('head-a');
        expect(Object.isFrozen(value.items)).toBe(true);
    });

    test('rejects duplicate IDs and totals that do not match', () => {
        const item = start().items[0];
        expect(() => validateRestoreStart({ ...start(), items: [item, item], expectedItems: 2, expectedBytes: 6 }))
            .toThrow(/duplicate/i);
        expect(() => validateRestoreStart({ ...start(), expectedBytes: 4 })).toThrow(/expectedBytes/i);
    });

    test('maps only core-known IDs below the authenticated user root', () => {
        const directories = { root: '/data/u', chats: '/data/u/chats' };
        expect(targetForLogicalItem(directories, start().items[0])).toBe('/data/u/chats/Alice/chat-1.jsonl');
        expect(() => targetForLogicalItem(directories, { ...start().items[0], id: 'chat/../x/y' }))
            .toThrow(/logical ID/i);
    });
});
~~~

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run: `npx jest --config tests/jest.config.json tests/restore-sessions-protocol.test.js --runInBand`

Expected: FAIL because both restore-session modules are absent.

- [ ] **Step 3: Implement exact protocol constants and validation**

~~~js
export const RESTORE_PROTOCOL = 1;
export const RESTORE_LIMITS = Object.freeze({
    segmentBytes: 1_048_576,
    batchBytes: 8_388_608,
    batchSegments: 8,
    items: 25_000,
    totalBytes: 64 * 1024 * 1024 * 1024,
    lifetimeMs: 6 * 60 * 60 * 1000,
});
export const RESTORE_ITEM_TYPES = Object.freeze([
    'settings', 'preset', 'worldinfo', 'persona', 'character',
    'chat', 'group', 'groupchat', 'quickreply', 'theme',
]);

export class RestoreProtocolError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'RestoreProtocolError';
        this.code = code;
        this.status = status;
    }
}
~~~

`validateRestoreStart` must clone input, require UUID-like non-empty request/snapshot IDs, validate unique logical IDs, 64-character lowercase SHA-256 values, sizes, segment counts, scopes, exact item/byte totals, and freeze the returned object. `path-policy.js` must use a fixed parser per type, `path.resolve`, and `isPathUnderParent` from `src/util.js`; it must never join an unparsed ID directly.

- [ ] **Step 4: Run focused tests and lint the two modules**

Run: `npx jest --config tests/jest.config.json tests/restore-sessions-protocol.test.js --runInBand && npx eslint src/restore-sessions/protocol.js src/restore-sessions/path-policy.js tests/restore-sessions-protocol.test.js`

Expected: PASS and ESLint exits 0.

- [ ] **Step 5: Commit the protocol slice**

~~~bash
git add src/restore-sessions/protocol.js src/restore-sessions/path-policy.js tests/restore-sessions-protocol.test.js
git commit -m "feat: validate transactional restore manifests"
~~~

### Task 2: Durable Per-User Session Store

**Files:**
- Create: `src/restore-sessions/session-store.js`
- Test: `tests/restore-sessions-store.test.js`

**Interfaces:**
- Consumes: validated start request, authenticated handle/root, and clock/ID injections.
- Produces: `createRestoreSessionStore(options)`, with `start(user, manifest)`, `get(user, sessionId)`, `transition(user, sessionId, state)`, `recordSegment(...)`, `cancel(...)`, `recover(users)`, and `cleanupExpired(users)`.

- [ ] **Step 1: Write failing ownership, lock, and restart tests**

~~~js
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@jest/globals';
import { createRestoreSessionStore } from '../src/restore-sessions/session-store.js';

test('persists non-secret state and enforces one active session per user', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'st-restore-'));
    const user = { profile: { handle: 'alice' }, directories: { root } };
    const store = createRestoreSessionStore({ id: () => 'session-1', now: () => 100 });
    const session = await store.start(user, { requestId: 'req-1', snapshotId: 'head-a', items: [] });
    await expect(store.start(user, { requestId: 'req-2', snapshotId: 'head-b', items: [] }))
        .rejects.toMatchObject({ code: 'RESTORE_BUSY' });
    expect(() => store.get({ profile: { handle: 'bob' } }, session.id)).toThrow(/owner/i);
    const journal = await readFile(path.join(root, '.restore-sessions', 'session-1', 'journal.json'), 'utf8');
    expect(journal).not.toMatch(/token|key|payload/i);
});
~~~

- [ ] **Step 2: Run the test and verify red**

Run: `npx jest --config tests/jest.config.json tests/restore-sessions-store.test.js --runInBand`

Expected: FAIL because `session-store.js` is missing.

- [ ] **Step 3: Implement core-owned workspace and atomic journal writes**

Each session root is exactly `<user root>/.restore-sessions/<opaque server ID>/` with `segments/`, `items/`, `rollback/`, and `journal.json`. Journal states are `receiving`, `ready`, `applying`, `deleting`, `rolling_back`, `committed`, `cancelled`, and `failed`. Use `write-file-atomic` for every journal replacement and keep only IDs, relative core-generated paths, sizes, hashes, state, and completion flags.

~~~js
const ACTIVE_STATES = new Set(['receiving', 'ready', 'applying', 'deleting', 'rolling_back']);
const SESSION_TRANSITIONS = Object.freeze({
    receiving: new Set(['ready', 'cancelled', 'failed']),
    ready: new Set(['applying', 'cancelled', 'failed']),
    applying: new Set(['deleting', 'rolling_back']),
    deleting: new Set(['committed', 'rolling_back']),
    rolling_back: new Set(['rolled_back', 'failed']),
});

function sessionRoot(user, sessionId) {
    const parent = path.resolve(user.directories.root, '.restore-sessions');
    const candidate = path.resolve(parent, sessionId);
    if (!isPathUnderParent(parent, candidate)) throw new RestoreProtocolError('SESSION_INVALID', 'Invalid restore session');
    return candidate;
}

async function persistJournal(session) {
    await writeFileAtomic(
        path.join(session.root, 'journal.json'),
        JSON.stringify(session.journal),
        { encoding: 'utf8' },
    );
}

function assertOwner(session, user) {
    if (session.owner !== user.profile.handle) {
        throw new RestoreProtocolError('SESSION_NOT_FOUND', 'Restore session not found', 404);
    }
}
~~~

`createRestoreSessionStore` must use these helpers for every method: `start` creates the four subdirectories and persists `receiving`; `get` calls `assertOwner`; `transition` checks `SESSION_TRANSITIONS`; `recordSegment` updates only length/hash/index receipts; `cancel` transitions receiving/ready to `cancelled` and applying/deleting to `rolling_back`; `recover` reloads journals from disk; and `cleanupExpired` removes only never-committed sessions older than `RESTORE_LIMITS.lifetimeMs`.

- [ ] **Step 4: Run store tests and syntax/lint checks**

Run: `npx jest --config tests/jest.config.json tests/restore-sessions-store.test.js --runInBand && node --check src/restore-sessions/session-store.js && npx eslint src/restore-sessions/session-store.js tests/restore-sessions-store.test.js`

Expected: PASS and both checks exit 0.

- [ ] **Step 5: Commit the session store**

~~~bash
git add src/restore-sessions/session-store.js tests/restore-sessions-store.test.js
git commit -m "feat: persist bounded restore sessions"
~~~

### Task 3: Idempotent Segment Ingestion and Item Verification

**Files:**
- Create: `src/restore-sessions/segment-store.js`
- Test: `tests/restore-sessions-segments.test.js`

**Interfaces:**
- Consumes: session journal, Multer temporary files, segment metadata `{ itemId, index, length, hash }`.
- Produces: `createSegmentStore(options)`, with `ingestBatch(session, metadata, files)`, `assembleReadyItems(session)`, and `status(session)`.

- [ ] **Step 1: Write failing out-of-order/idempotency/hash tests**

~~~js
import { expect, test } from '@jest/globals';
import { createSegmentHarness } from './util/restore-session-harness.js';

test('accepts out-of-order identical retries and poisons mismatched duplicates', async () => {
    const h = await createSegmentHarness({ text: 'hello world', segmentBytes: 6 });
    await h.store.ingestBatch(h.session, [h.meta(1)], [await h.file(1)]);
    await h.store.ingestBatch(h.session, [h.meta(0)], [await h.file(0)]);
    await expect(h.store.ingestBatch(h.session, [h.meta(0)], [await h.file(0)])).resolves.toMatchObject({ duplicate: 1 });
    await expect(h.store.ingestBatch(h.session, [{ ...h.meta(0), hash: 'f'.repeat(64) }], [await h.file(0)]))
        .rejects.toMatchObject({ code: 'SEGMENT_CONFLICT' });
    await expect(h.store.assembleReadyItems(h.session)).rejects.toMatchObject({ code: 'SESSION_NOT_COMMITTABLE' });
});
~~~

- [ ] **Step 2: Run the focused test and verify red**

Run: `npx jest --config tests/jest.config.json tests/restore-sessions-segments.test.js --runInBand`

Expected: FAIL because the store and harness do not exist.

- [ ] **Step 3: Implement streaming hashes and durable segment moves**

Create `tests/util/restore-session-harness.js` with temporary roots and deterministic SHA-256 helpers. In `segment-store.js`, hash each temporary upload through `createReadStream`, compare declared length/hash, atomically rename to `segments/<item ordinal>/<segment index>.part`, and persist receipt only after rename. On a duplicate, compare journal metadata and disk hash; accept exact matches and mark the session `failed` with `SEGMENT_CONFLICT` otherwise. Assemble items by streaming segments in index order to `items/<item ordinal>.payload`, then verify final size/hash before setting state `ready`.

- [ ] **Step 4: Run segment, protocol, and store tests**

Run: `npx jest --config tests/jest.config.json tests/restore-sessions-protocol.test.js tests/restore-sessions-store.test.js tests/restore-sessions-segments.test.js --runInBand`

Expected: all three suites PASS.

- [ ] **Step 5: Commit segment ingestion**

~~~bash
git add src/restore-sessions/segment-store.js tests/restore-sessions-segments.test.js tests/util/restore-session-harness.js
git commit -m "feat: stage idempotent restore segments"
~~~

### Task 4: Logical Adapters and Exact Inventory Plan

**Files:**
- Create: `src/restore-sessions/adapters.js`
- Test: `tests/restore-sessions-adapters.test.js`

**Interfaces:**
- Consumes: verified item payload files, selected scopes, and authenticated `UserDirectoryList`.
- Produces: `buildRestorePlan({ session, directories, scopes }) -> { writes, deletions, inventory }`, where every path is core-generated and contained.

- [ ] **Step 1: Write failing all-type and deletion-plan tests**

~~~js
import { expect, test } from '@jest/globals';
import { buildAdapterFixture } from './util/restore-session-harness.js';
import { buildRestorePlan } from '../src/restore-sessions/adapters.js';

test('maps every logical type and schedules stale selected-scope data last', async () => {
    const fixture = await buildAdapterFixture({ includeAllTypes: true, staleChats: 2 });
    const plan = await buildRestorePlan(fixture);
    expect(plan.writes.map(x => x.itemId)).toEqual(expect.arrayContaining([
        'settings', 'character/Alice.png', 'chat/Alice.png/chat-1',
        'group/g1', 'groupchat/gc1', 'worldinfo/world', 'preset/openai/preset',
        'persona/avatar.png', 'theme/night', 'quickreply/default',
    ]));
    expect(plan.deletions).toHaveLength(2);
    expect(plan.deletions.every(x => x.scope === 'chat')).toBe(true);
});
~~~

- [ ] **Step 2: Run the adapter test and verify red**

Run: `npx jest --config tests/jest.config.json tests/restore-sessions-adapters.test.js --runInBand`

Expected: FAIL because `adapters.js` and fixture helper are absent.

- [ ] **Step 3: Implement fixed adapters without browser-supplied paths**

Use the existing TavernSync logical formats exactly: PNG for `character`; canonical JSONL for `chat` and `groupchat`; canonical JSON for `group`, `worldinfo`, and `preset`; stripped settings JSON for `settings`; persona JSON containing `avatarId`, `name`, `description`, and optional PNG base64; named JSON objects for `theme` and `quickreply`. Merge stripped settings onto live `settings.json` while preserving local secret/device keys and `extensionSettings.tavernsync`; rebuild persona name/description maps from selected persona items. Validate PNG signatures, JSON/JSONL syntax, API preset directories, filename grammar, duplicates, and containment before returning the plan.

The plan objects are exact:

~~~js
{
    writes: [{ itemId, scope, staged, target }],
    deletions: [{ itemId, scope, target }],
    inventory: [{ itemId, type, size, hash }],
}
~~~

- [ ] **Step 4: Run adapter tests and lint**

Run: `npx jest --config tests/jest.config.json tests/restore-sessions-adapters.test.js --runInBand && npx eslint src/restore-sessions/adapters.js tests/restore-sessions-adapters.test.js`

Expected: PASS and ESLint exits 0.

- [ ] **Step 5: Commit logical adapters**

~~~bash
git add src/restore-sessions/adapters.js tests/restore-sessions-adapters.test.js tests/util/restore-session-harness.js
git commit -m "feat: map logical restore items to user data"
~~~

### Task 5: Atomic Transaction, Deletion-Last, and Rollback

**Files:**
- Create: `src/restore-sessions/transaction.js`
- Test: `tests/restore-sessions-transaction.test.js`

**Interfaces:**
- Consumes: fully validated `{ writes, deletions, inventory }`, session workspace, `AbortSignal`, and optional fault/free-space injections.
- Produces: `createRestoreTransaction(options)` with `commit(plan)`, `rollback()`, and `recover()`.

- [ ] **Step 1: Write failing ordering, space, and injected-fault tests**

~~~js
import { expect, test } from '@jest/globals';
import { createTransactionHarness } from './util/restore-session-harness.js';

test('writes replacements before deletions and restores originals after a fault', async () => {
    const h = await createTransactionHarness({ failAfter: 2 });
    await expect(h.transaction.commit(h.plan)).rejects.toThrow(/injected/i);
    expect(await h.readLive()).toEqual(h.originalLive);
    expect(h.events.indexOf('write:first')).toBeLessThan(h.events.indexOf('delete:first'));
});

test('refuses commit before touching live data when temporary space is insufficient', async () => {
    const h = await createTransactionHarness({ availableBytes: 1 });
    await expect(h.transaction.commit(h.plan)).rejects.toMatchObject({ code: 'SPACE_INSUFFICIENT' });
    expect(await h.readLive()).toEqual(h.originalLive);
});
~~~

- [ ] **Step 2: Run the transaction test and verify red**

Run: `npx jest --config tests/jest.config.json tests/restore-sessions-transaction.test.js --runInBand`

Expected: FAIL because `transaction.js` is missing.

- [ ] **Step 3: Implement journaled rename operations and recovery**

Before applying, calculate staged bytes plus rollback bytes and use `fs.promises.statfs`; return `SPACE_UNKNOWN` if unavailable and `SPACE_INSUFFICIENT` if below required bytes. For every write, journal and move an existing target to rollback before renaming the staged replacement. Only after every write succeeds, journal and move stale selected-scope targets to rollback. After inventory verification, mark `committed`. Any error or cancellation transitions to `rolling_back`, removes moved replacements, restores backups in reverse order, and ends `rolled_back`. `recover()` performs the same reverse replay for journals found in `applying`, `deleting`, or `rolling_back`.

- [ ] **Step 4: Run transaction plus adapter tests**

Run: `npx jest --config tests/jest.config.json tests/restore-sessions-adapters.test.js tests/restore-sessions-transaction.test.js --runInBand`

Expected: PASS with live-state equality after every injected fault.

- [ ] **Step 5: Commit the transaction layer**

~~~bash
git add src/restore-sessions/transaction.js tests/restore-sessions-transaction.test.js tests/util/restore-session-harness.js
git commit -m "feat: commit restore data transactionally"
~~~

### Task 6: Authenticated Restore Router and Disk-Backed Multipart Upload

**Files:**
- Create: `src/endpoints/restore-sessions.js`
- Modify: `src/server-startup.js`
- Modify: `src/server-main.js`
- Test: `tests/restore-sessions-routes.test.js`

**Interfaces:**
- Consumes: authenticated `request.user`, CSRF-protected same-origin requests, session/segment/adapter/transaction services.
- Produces: `GET /api/users/restore/capabilities`, `POST /start`, `POST /:sessionId/batch`, `GET /:sessionId`, `POST /:sessionId/commit`, and `POST /:sessionId/cancel`.

- [ ] **Step 1: Write failing capability, ownership, and multipart route tests**

~~~js
import { expect, test } from '@jest/globals';
import { createRestoreRouteHarness } from './util/restore-session-harness.js';

test('advertises protocol limits and accepts a disk-backed batch', async () => {
    const h = await createRestoreRouteHarness();
    const capabilities = await h.get('/api/users/restore/capabilities');
    expect(capabilities.body).toMatchObject({ protocol: 1, maxBatchBytes: 8_388_608, maxInFlightBatches: 2 });
    const started = await h.postJson('/api/users/restore/start', h.startRequest);
    const uploaded = await h.postBatch(started.body.sessionId, h.batch);
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.receivedBytes).toBe(h.batch.plaintextBytes);
});

test('does not expose another user session and rejects oversized multipart bodies', async () => {
    const h = await createRestoreRouteHarness();
    const started = await h.postJson('/api/users/restore/start', h.startRequest);
    expect((await h.asUser('bob').get('/api/users/restore/' + started.body.sessionId)).status).toBe(404);
    expect((await h.postOversizedBatch(started.body.sessionId)).status).toBe(413);
});
~~~

- [ ] **Step 2: Run route tests and verify red**

Run: `npx jest --config tests/jest.config.json tests/restore-sessions-routes.test.js --runInBand`

Expected: FAIL because the router is not mounted.

- [ ] **Step 3: Implement thin routes and isolate Multer**

Mount the router under `/api/users/restore` in `setupPrivateEndpoints`. Export `isRestoreBatchRequest(request)` from the endpoint module. Wrap the existing global avatar upload middleware in `server-main.js` so it calls `next()` only for `POST /api/users/restore/:sessionId/batch`; all other uploads retain existing behavior. The restore router uses its own Multer disk storage with a destination under the authenticated user's `.restore-sessions/incoming`, field `segments`, maximum eight files, maximum 1,048,576 bytes each, and metadata in one text field named `metadata`. Always remove unclaimed temporary files in `finally`.

Return stable JSON errors:

~~~json
{ "error": { "code": "SEGMENT_HASH_MISMATCH", "message": "Restore batch rejected" } }
~~~

Do not return filesystem paths, payloads, stack traces, session owner handles, tokens, or keys.

- [ ] **Step 4: Run all restore tests and server lint**

Run: `npx jest --config tests/jest.config.json "tests/restore-sessions-*.test.js" --runInBand && npm run lint`

Expected: all restore suites PASS and repository lint exits 0 without changing unrelated files.

- [ ] **Step 5: Commit the HTTP surface**

~~~bash
git add src/endpoints/restore-sessions.js src/server-startup.js src/server-main.js tests/restore-sessions-routes.test.js tests/util/restore-session-harness.js
git commit -m "feat: expose transactional restore sessions"
~~~

### Task 7: Startup Recovery, Integration Matrix, and Core Benchmark

**Files:**
- Modify: `src/server-startup.js`
- Create: `tests/restore-sessions-integration.test.js`
- Create: `tests/restore-sessions-recovery.test.js`
- Create: `scripts/benchmark-restore-session.js`

**Interfaces:**
- Consumes: complete restore API, temporary synthetic users, fault injections, and startup user directory enumeration.
- Produces: startup recovery before accepting new commits, exact inventory evidence, and measured stage/apply/delete timings.

- [ ] **Step 1: Write failing restart/fault-matrix integration tests**

~~~js
import { expect, test } from '@jest/globals';
import { buildFullRestoreFixture } from './util/restore-session-harness.js';

test('restores every logical type and exact selected-scope inventory', async () => {
    const h = await buildFullRestoreFixture({ items: 2347, staleItems: 5 });
    const result = await h.restore();
    expect(await h.scanInventory()).toEqual(h.expectedInventory);
    expect(result.snapshotId).toBe('head-a');
    expect(result.deleted).toBe(5);
});

test.each(['segment-truncated', 'item-hash', 'space', 'write', 'delete', 'cancel-applying', 'restart-applying'])
('%s never leaves partial live state', async fault => {
    const h = await buildFullRestoreFixture({ fault });
    await expect(h.restore()).rejects.toBeDefined();
    await h.recover();
    expect(await h.readLive()).toEqual(h.originalLive);
});
~~~

- [ ] **Step 2: Run integration tests and verify at least restart recovery fails**

Run: `npx jest --config tests/jest.config.json tests/restore-sessions-integration.test.js tests/restore-sessions-recovery.test.js --runInBand`

Expected: FAIL until startup recovery is wired and the full fixture exists.

- [ ] **Step 3: Wire startup recovery and implement deterministic benchmark**

Before accepting restore commits, enumerate user roots with existing `getUserDirectoriesList()`, recover journals in `applying`, `deleting`, or `rolling_back`, and remove expired never-committed sessions. `scripts/benchmark-restore-session.js` must create a temporary user, generate deterministic all-type payloads, upload them in 8 MiB batches, commit, compare exact inventory, and print JSON containing `items`, `plaintextBytes`, `uploadMs`, `verifyMs`, `applyMs`, `deleteMs`, `totalMs`, `peakRssBytes`, `temporaryBytes`, and `inventoryEqual`.

- [ ] **Step 4: Run the complete core verification matrix**

Run:

~~~text
npx jest --config tests/jest.config.json "tests/restore-sessions-*.test.js" --runInBand
npm run lint
node scripts/benchmark-restore-session.js --items 2347 --output .restore-session-benchmark.json
git diff --check
~~~

Expected: all tests PASS, lint exits 0, benchmark reports `inventoryEqual: true`, and `git diff --check` prints nothing. Remove the local benchmark JSON after recording the result outside the repository.

- [ ] **Step 5: Review upstream-sized slices without publishing**

Inspect `git diff --stat origin/staging...HEAD` and group the commits into protocol/staging, adapters, transaction/recovery, and router integration. Confirm no Google, TavernSync, token, key, or Drive-specific identifiers entered `src/`. Do not push or open a PR.

- [ ] **Step 6: Commit integration coverage**

~~~bash
git add src/server-startup.js tests/restore-sessions-integration.test.js tests/restore-sessions-recovery.test.js tests/util/restore-session-harness.js scripts/benchmark-restore-session.js
git commit -m "test: verify transactional restore recovery"
~~~

## Final Review Gate

1. Every public route is authenticated and covered by ownership tests.
2. Browser input contains logical IDs only; all filesystem paths are core-generated and containment-tested.
3. Duplicate matching segments are idempotent; conflicting duplicates poison commit.
4. No live data changes before all items are verified.
5. Writes precede deletions; every injected apply/delete fault restores original live data.
6. Startup recovery handles interrupted apply/delete/rollback journals.
7. Full synthetic inventory matches exactly after commit.
8. `npm run lint`, focused Jest suites, benchmark, and `git diff --check` pass freshly.
9. The unrelated untracked extension directories in `E:\ST\SillyTavern\public\scripts\extensions` remain untouched.
10. No branch push, PR, maintainer message, live user restore, or user-data deletion occurs without separate authorization.

## Execution Boundary

This plan authorizes local implementation on a dedicated SillyTavern feature branch only after the execution route is selected. It does not authorize modifying the owner's primary user data, enabling a live endpoint on the running primary server, pushing to GitHub, or opening an upstream PR.
