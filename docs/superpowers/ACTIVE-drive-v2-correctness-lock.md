# ACTIVE Drive v2 Implementation Playbook

Open this file before every implementation block and continue from **Current next action**. Update the checkboxes only after the named test or live proof exists.

## Result We Are Building

```text
Install/update TavernSync
-> Connect Google
-> Enter the same TavernSync Encryption passphrase
-> Push the selected categories as one complete encrypted snapshot
-> Pull the newest snapshot by downloading each pack once
-> Restore every selected item with exact names
-> Verify the restored inventory
-> Report success
```

The implementation stays inside the TavernSync browser extension. The passphrase remains the only encryption secret created by the user. Device-local API keys and OAuth tokens remain local.

## Current Next Action

Publish the verified extension-only build on the feature branch, then complete **Stage 4: iPhone proof** with the same snapshot and bundle.

Current iPhone evidence to capture:

- final restored item count and Favorite count;
- Pull elapsed time and pack download requests;
- exact selected-scope inventory after reload;
- Bat family group image, dotted/Unicode character names, and character assets;
- WebContent/Jetsam or network errors from native syslog.

Desktop proof recorded on 2026-08-10: the newest encrypted Drive snapshot contains 2,873 logical items. The disposable `8123` restore completed in 107 seconds, restored 370 characters and five Favorites, and passed final inventory verification. The Bat family group image was restored at 9,703 bytes with SHA-256 `44FB181150F6D299E0170EFC4E22868B7A85092024F64797AF8AB707985AC7C6`, matching the source. The interleaved-pack regression test proves one download per required pack with the two-pack RAM cache. The full suite reports 56 files / 305 tests; TypeScript, lint, production build, and `git diff --check` exit zero. The served sandbox bundle SHA-256 is `35C8FA5B0596FE2A298EB47C39768127ECE5B62C9C4CF338933ACA06E1143707`.

Stage 1 proof recorded on 2026-08-10: the character-card, expression/BGM, exact dotted-name, delete, inventory, and false-success contracts pass; the full suite reports 54 files / 269 tests, TypeScript and lint exit zero, and the production build completes.

Stage 2 proof recorded on 2026-08-10: concurrent readers share one in-flight pack download; retries preserve chunk/item authentication; the cache holds at most two packs; ten shared items use one request; a 2,347-item / 30-pack fixture uses exactly 30 requests; the full suite reports 54 files / 273 tests before the final 30-pack contract was added.

## Proven OG Mechanics To Reuse

`OG` means the HTTP/Cloudflare Worker backend. These are the concrete working mechanics and their source anchors.

| OG source | Working mechanic | Drive implementation consequence |
| --- | --- | --- |
| `src/backend/runtime.ts` → `requireRuntime()` | HTTP assigns four complete Pull pipelines | Start Drive writers at four; measure before changing the number |
| `src/backend/http.ts` → `checkBlobs()` | One remote existence check covers all unique content hashes | Push builds one unique-hash/pack plan before uploading |
| `src/backend/http.ts` → `uploadBlobsParallel()` | A worker loads data only when ready, retries up to three attempts, and keeps four transfers busy | Pack upload/download queues remain continuously occupied without fixed batch barriers |
| `src/sync/push-batch.ts` → `uploadPushBatch()` | Duplicate hashes share one upload; missing local bytes fail the Push | Deduplicate chunks/packs and make a missing required payload fatal before manifest commit |
| `src/sync-core/apply.ts` → `applyOp()` | One worker slot owns the full fetch → decrypt → apply operation; type order preserves dependencies | Drive writers receive complete verified items and keep the slot until ST finishes writing |
| `src/backend/http.ts` → `getBlob()` / `putBlob()` | Each request transfers one complete authenticated payload | The Drive equivalent transfers one complete pack per request, then reuses it for every contained item |
| `worker/src/index.ts` → `/v1/blobs/*` | R2 objects are content-addressed and returned without server-side transformation | Drive packs remain immutable encrypted objects; reconstruction happens locally |
| `src/backend/http.ts` → `putManifest()` and Worker `If-Match` | Manifest publication uses compare-and-swap after payload upload | Drive commits the encrypted manifest only after every referenced pack verifies |
| `src/sync/engine.ts` → `pullAndApply()` | Download, decrypt, local store, and ST apply form one observable pipeline | Drive preserves the same stages and checkpoints them per logical item |
| `src/sync/engine.ts` → partial-base handling | Skipped/broken payloads do not make the device fully synced | Drive advances `baseCommitId` only after inventory verification succeeds |

The OG scanner in `src/st-adapter/scan.ts` and `read.ts` is a shared starting point, not the completeness reference: it currently reads character cards but not character sub-assets. Stage 1 completes that shared scanner.

## Selected Category Data Contract

The manifest must contain these logical items when the corresponding checkbox is enabled:

| Checkbox | Required snapshot contents |
| --- | --- |
| Settings | Syncable settings after the existing secret/device-local exclusions |
| Characters | Character card PNG, expression/sprite images, character BGM, and supported character assets |
| Chats | Every listed chat for every selected character |
| Lorebooks | Every listed world-info/lorebook payload |
| Presets | Kobold, Novel, OpenAI, TextGen, instruct, context, sysprompt, and reasoning presets |
| Personas | Persona metadata, description, and avatar image |
| Groups | Group metadata and all group chats |
| Quick replies | Every quick-reply set |
| Themes | Every theme |

`Characters` is the user-facing scope for its assets; the UI does not need separate Sprite or BGM switches.

## Stage 1 — Complete Scanner, Writer, And Inventory

### 1.1 Add the logical asset type

Change `src/sync-core/types.ts`:

- add `characterasset` to `ItemType`;
- use IDs produced by `characterAssetId(characterName, relativePath)`;
- percent-encode each path component so spaces, Unicode, dots, and slashes round-trip safely.

Expected test: `character-assets.test.ts` round-trips Unicode, spaces, and dots.

### 1.2 Discover and read character assets

Create `src/st-adapter/character-assets.ts` with:

- `characterAssetId(characterName, relativePath)`;
- `decodeCharacterAssetId(id)`;
- `listCharacterAssetRefs(characterName, api)` for inventory-only listing;
- `listCharacterAssets(characterName, api)` for Push bytes and hashes.

Use existing SillyTavern endpoints:

```text
GET  /api/sprites/get?name=<character>
POST /api/assets/character?name=<character>&category=bgm
GET  the returned same-origin /characters/... asset URL
```

Represent direct expressions as `<filename>` and BGM as `bgm/<filename>`. Add further ST-supported character asset categories through the same reference-list pattern when their list endpoint returns the complete files required for reconstruction.

Expected test: the fixture returns one expression and one BGM file; both IDs and byte lengths match.

### 1.3 Feed assets into Push

Change `src/st-adapter/read.ts`:

- return both `avatar` and the character display/folder `name` from `listCharacters()`.

Change `src/st-adapter/scan.ts`:

- keep the existing character-card scan;
- when `scope.characters` is enabled, enumerate assets for each character name;
- hash and store each asset exactly like every other logical blob;
- include the resulting `characterasset` items in the manifest.

Change `src/sync/engine.ts` → `scopeTypeSet()`:

- map the Characters checkbox to both `character` and `characterasset`.

Expected test: a Characters-only scan produces the card plus both asset fixture IDs.

### 1.4 Restore and delete assets

Change `src/st-adapter/write.ts`:

- add `writeCharacterAsset()`;
- decode the asset ID into character name and relative path;
- upload through `POST /api/sprites/upload` using the character or `character/subfolder` name;
- pass the exact filename extension in the multipart file;
- pass `spriteName` as the filename without its final extension.

Also change `importCharacterPng()` so multipart `preserved_name` contains the complete `.png` filename. This makes ST's `path.parse()` preserve dots inside the basename.

Change `src/st-adapter/delete.ts`:

- map a removed `characterasset` to `POST /api/sprites/delete` using the decoded character/subfolder and exact sprite name.

Expected tests: dotted character filenames remain exact; expression and BGM uploads target the decoded folders; asset deletion targets the matching name.

### 1.5 Inventory and completion proof

Change `src/st-adapter/inventory.ts`:

- list character cards and character-asset references without downloading their bodies;
- emit IDs using the same `characterAssetId()` function used by Push.

Change `src/backend/drive/drive-v2-pull.ts`:

- accept a `verifyInventory()` callback;
- after all writes and deletion-last complete, obtain a fresh enabled-scope inventory;
- compare its ID/type set with the selected remote manifest;
- call `saveBase()` and `checkpoint.finish()` only after the sets match.

Change `src/sync/engine.ts`:

- provide `verifyInventory()` using `listLocalInventory(allowedTypes)`.

Expected test: a manifest containing a missing chat or asset rejects with the missing ID and leaves base/checkpoint unfinished.

### Stage 1 Gate

```powershell
npx vitest run src/st-adapter/__tests__/character-assets.test.ts `
  src/st-adapter/__tests__/write.test.ts `
  src/st-adapter/__tests__/delete.test.ts `
  src/st-adapter/__tests__/inventory.test.ts `
  src/backend/drive/__tests__/drive-v2-pull.test.ts
npx tsc --noEmit
```

Stage 1 is complete when the focused tests and TypeScript exit zero and a manifest fixture contains every enabled character asset.

## Stage 2 — One Download Per Pack

### 2.1 Lock the request-count behavior with tests

Add tests under `src/backend/drive/__tests__/` proving:

- ten items sharing one pack call `readPack(packName)` exactly once;
- items spanning two packs call `readPack` exactly twice;
- the cache never retains more than two completed pack byte arrays;
- a failed pack download retries the pack and does not mark contained items complete;
- item hashes and chunk authentication still fail closed.

The test must fail against the current `verified-item-reader.ts`, which loops over `item.chunks` and calls `readChunk()` for each chunk.

### 2.2 Build the bounded pack reader

Use the existing whole-pack source:

```text
src/backend/drive/pack-store.ts -> readPack(name)
src/backend/drive/client.ts     -> getFileData(id)
```

Create a pack reader that:

1. groups selected manifest items by `packName`;
2. keeps a map of in-flight pack promises so concurrent consumers share one download;
3. holds at most two completed packs;
4. slices each encrypted chunk from the downloaded pack using manifest offsets;
5. runs existing `decryptChunk` and complete-item hash verification;
6. releases a pack after every dependent item has been prepared/applied.

Expose metrics:

```text
uniquePacksRequired
packDownloadRequests
peakCachedPackBytes
completedItems
activeWriters
```

The required invariant is `packDownloadRequests <= uniquePacksRequired + retryAttempts`.

### 2.3 Feed continuous item writers

Change `drive-v2-pull.ts` and `adaptive-pull-queue.ts`:

- start with four writer slots, matching the OG baseline;
- give each slot a complete verified logical item;
- keep the slot occupied through the ST API write;
- release the slot immediately to the next ready item;
- preserve dependency order: character card, then its chats/assets; settings/shared mutations remain serial;
- use the existing plaintext budget when holding prepared items.

The live progress line must expose pack downloads, items/second, and active writers so a collapse to one writer is visible immediately.

### Stage 2 Gate

Run focused pack-reader/queue tests, then the full suite, TypeScript, lint, build, and `git diff --check`. A 30-pack fixture should make roughly 30 successful Drive media downloads rather than thousands of chunk requests.

## Stage 3 — New Snapshot And Sandbox Proof

1. Build and copy the verified extension only to the disposable ST instance on port `8123`.
2. Push a new snapshot from the complete PC source. Record selected-scope item counts, logical bytes, pack count, upload requests, elapsed time, and committed manifest ID.
3. Pull that new snapshot into the disposable Data Root.
4. Compare source and restored enabled-scope inventories by exact logical ID/type.
5. Confirm dotted/Unicode character filenames and character-asset paths explicitly.
6. Record Pull elapsed time, pack download requests, items/second, maximum active writers, and peak cached bytes.
7. Treat desktop correctness as proven only when the inventory comparison is exact.

Desktop target: at most five minutes and no more than 2x OG for the same selected data and network.

## Stage 4 — iPhone Proof

Use the same extension build and newest snapshot on SillyiOS. Capture native syslog from Pull start through final reload. Record inventory result, elapsed time, pack requests, throughput, active writers, peak cache, and any WebContent/Jetsam event.

The iPhone result is accepted when inventory is exact, the app remains alive, and the Pull completes inside the measured performance gate.

## Three Operational Invariants

1. Live tests use the disposable Data Root and port `8123` until desktop proof passes.
2. Encryption keys, Google tokens, and ST API secrets stay out of logs and remote plaintext metadata.
3. Git merge/push happens only after the owner reviews the live evidence.

## Work-Block Check-In

At the start of every block:

1. read **Current next action**;
2. inspect the named source and tests;
3. execute only that stage;
4. paste the fresh test/live evidence into the status update;
5. update this file's checkbox or Current next action only when the proof exists.
