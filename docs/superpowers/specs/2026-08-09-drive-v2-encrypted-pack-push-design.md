# Google Drive v2 Encrypted Pack Push Design

**Date:** 2026-08-09
**Status:** Owner approved
**Scope:** Phase 1 — fresh-root Full Push only

## 1. Problem

The current Google Drive backend encrypts each logical TavernSync blob as one
Drive file. This protects the contents, but it preserves approximate source
sizes, performs thousands of Drive file-creation requests, holds large blobs in
memory, and restarts too much work after a network or authentication failure.
The first full upload of roughly 2,345 items took about 90 minutes.

The OG HTTP backend has demonstrated approximately two minutes for a 500 MB
upload after its concurrency optimization. Google Drive must approach that
experience closely enough to remain a practical alternative to a hosted
Cloudflare server.

## 2. Goals

1. Upload no plaintext content, plaintext item name, plaintext content hash, or
   plaintext manifest data to Google Drive.
2. Split logical items into independently encrypted chunks before data reaches
   Google Drive.
3. Mix encrypted chunks from multiple items into immutable packfiles so Drive
   cannot map one stored file to one character, chat, image, or setting.
4. Reduce Drive file-creation operations from thousands of logical blobs to
   tens of packfiles for a typical full backup.
5. Bound the Full Push working set and avoid `Array.from(Uint8Array)` storage
   expansion in the v2 push path.
6. Resume transiently interrupted uploads without restarting the full Push.
7. Publish a new snapshot only after every referenced pack is complete.
8. Instrument the pipeline so scan, packing/encryption, upload, and commit time
   can be tuned independently.

## 3. Performance Gates

Performance is measured from a genuinely empty v2 Root with the same PC,
dataset, network, and Google account.

- **Gate 1:** Full Push completes in 15 minutes or less.
- **Competitive target:** no more than 2x the OG HTTP elapsed time for the same
  bytes and item set.
- **Stretch target:** approximately 2–3 minutes for a 500 MB dataset.

All benchmark reports must include total plaintext bytes, pack bytes, item
count, pack count, wall-clock time, average upload throughput, retry count, and
peak in-flight bytes. A faster result does not pass if the manifest is not
committed atomically or any input item is omitted.

## 4. Explicit Non-Goals

This phase does not implement:

- Pull or restoration from v2 packs;
- incremental Push into an existing v2 snapshot;
- v1/v2 mixed storage or in-place migration;
- automatic deletion of a Drive Root during extension update;
- padding every small item or hiding total account usage;
- changes to the OG HTTP backend;
- a public stable release before the Full Push benchmark passes.

The v2 structures must leave room for later Pull and incremental Push, but
those behaviors receive separate designs and tests.

## 5. Fresh Root Lifecycle

The PC remains the source of truth. The existing v1 Drive Root is not migrated.
After the v2 build is ready to test, an explicit user action performs this
sequence:

1. require an active Google connection and a destructive confirmation;
2. create a new Root marked `ts=root-v2` with `packs/` and `manifests/`
   children; if creation fails, leave v1 untouched;
3. move the entire current `TavernSync` v1 Root to Drive trash, including its
   `blobs/` and `manifests/` children;
4. clear the saved v1 `driveFolderId`, remembered Drive E2EE key, Drive base
   state, and status derived from the old Root;
5. save the new v2 Root ID and derive new v2 subkeys from that ID and the user's
   passphrase;
6. run a Full Push from the PC.

The old Root remains recoverable in Drive trash until the owner chooses to
empty trash. No SillyTavern data on the PC or phone is deleted by this action.
The same explicit reset may replace a previous v2 Root when repeating an
empty-Root tuning benchmark. It always creates the replacement Root first and
trashes the selected current Root only after creation succeeds.

## 6. Cryptographic Boundaries

Drive v2 derives protocol-separated HKDF subkeys from the unlocked root key:

- `chunk-enc-v2` — AES-256-GCM encryption for each chunk;
- `pack-name-v2` — HMAC-SHA-256 for pack names;
- `manifest-enc-v2` — AES-256-GCM encryption for the v2 manifest.

Every chunk uses a fresh random AES-GCM IV. Deterministic AES-GCM nonces are
forbidden. Pack names are deterministic HMACs of the ordered chunk plan, not
plaintext item names or raw hashes. The encrypted manifest is the only place
that maps logical items to packs and byte ranges.

Google may observe the TavernSync folder structure, pack count, pack sizes,
timestamps, and opaque app properties. It must not receive item IDs, item
types, source filenames, raw content hashes, plaintext sizes per item, or
decryptable content.

## 7. Pack Format

- Maximum plaintext chunk size: **1 MiB**.
- Target encrypted pack size: **32 MiB**.
- Items are sorted deterministically by logical item ID, then chunk index.
- Each chunk is encrypted independently before entering a pack.
- A pack is the raw concatenation of sealed chunk frames. The pack contains no
  plaintext index or filename.
- The encrypted v2 manifest identifies itself with `schema: 2` and
  `storage: "drive-pack-v2"`. For every logical item it records the overall
  plaintext SHA-256 and ordered chunk references: pack name, byte offset, boxed
  length, plaintext length, and plaintext chunk SHA-256. These hashes never
  appear outside the encrypted manifest.
- The pack name is an HMAC over the ordered chunk identifiers and lengths.
- Packfiles are immutable. A completed pack with the expected name is reusable
  after an interrupted retry.

Small items are not padded to 1 MiB. Padding thousands of small items would
multiply storage and encryption work without improving the owner's primary
goal, which is content confidentiality and practical speed.

## 8. Full Push Data Flow

1. Scan local SillyTavern data and build the logical manifest.
2. Process items in deterministic order and build the chunk/pack plan during
   the same packing pass; do not reread the full dataset merely to plan packs.
3. Read each logical item lazily, split it into 1 MiB chunks, and encrypt each
   chunk independently.
4. Finalize each 32 MiB pack when its contents are known, enqueue it immediately,
   and release source buffers as soon as they are no longer needed. Upload may
   overlap with construction of later packs.
5. Upload at most four packs concurrently.
6. Verify that every pack referenced by the completed plan exists on Drive and
   has the expected ciphertext size.
7. Encrypt and commit the v2 manifest as the final operation.

The baseline in-flight pack ceiling is four packs, approximately 128 MiB of
pack payload plus bounded encryption and source buffers. Instrumentation must
report actual peak in-flight bytes; tuning may lower concurrency if the measured
working set exceeds the implementation budget.

## 9. Resumable Upload and Retry

Each 32 MiB pack uses a real Drive resumable upload, divided into transport
ranges that are multiples of 256 KiB. The initial baseline transport range is
8 MiB. Four pack uploads may run concurrently.

Error handling:

- connection loss, HTTP 408, 429, and 5xx: query the resumable session status
  and retry from the acknowledged byte with jittered exponential backoff;
- HTTP 401: pause scheduling, retain completed work, and expose a user-driven
  `Connect & Resume` action;
- other 4xx responses: stop with the pack name, response status, and safe next
  action;
- user cancellation: stop scheduling new packs and abort or settle in-flight
  requests without committing a manifest.

Resumable session URLs are not persisted across a complete ST/WebView restart.
Random-IV encryption means the exact ciphertext must be retained to resume an
old byte offset. Persisting the entire temporary ciphertext dataset is not
worth the complexity in Phase 1. Across a restart, completed packs are reused
and only incomplete in-flight packs are regenerated, limiting repeated work to
at most four 32 MiB packs with the baseline four-worker configuration.

## 10. Atomicity and Orphans

Pack upload success does not make a snapshot visible. The encrypted manifest
commit is the publication gate.

- If any pack fails, no manifest commit occurs.
- A failed attempt may leave completed unreferenced packs.
- A retry reuses completed packs whose deterministic names match the plan.
- Orphan cleanup is manual and must never run while a Push is active.
- Integrity is enforced later by AES-GCM authentication and the logical item
  hash stored inside the encrypted manifest.

This ordering prevents another device from observing or pulling a half-built
snapshot.

## 11. Progress and Benchmark Telemetry

The UI reports actionable stages rather than one generic loader:

```text
Scanning local data…
Packing 8/31
Uploading 18/31 · 6.2 MB/s · ETA 01:04
Retrying pack 19/31 · attempt 2
Verifying 31/31 packs
Committing encrypted manifest
Full Push complete · 07:42
```

The final benchmark record separates:

- scan time;
- chunking/encryption time;
- upload time;
- verification/listing time;
- manifest commit time;
- retry/backoff time.

## 12. Tuning Ladder

Tuning changes one variable at a time against the same empty-Root benchmark:

1. baseline: 1 MiB chunks, 32 MiB packs, 8 MiB transport ranges, concurrency 4;
2. if network is underutilized and there are no 429/5xx responses, test pack
   concurrency 6, then 8;
3. if file-creation/session overhead dominates, test 64 MiB packs;
4. if memory or retry cost dominates, test 16 MiB packs;
5. retain the smallest-memory configuration that reaches the competitive
   target; do not select maximum concurrency merely because it is faster once.

Every candidate must run at least twice. A result with errors, an uncommitted
manifest, missing items, or unexplained byte-count mismatch is rejected.

## 13. Test Strategy

Unit and integration tests must cover:

- chunk boundaries at 0, 1 byte, exactly 1 MiB, and multiple chunks;
- pack boundaries and items spanning packs;
- deterministic pack planning and names with random ciphertext;
- pack/unpack round trips and AES-GCM tamper rejection;
- absence of plaintext item names, raw hashes, and recognizable content in
  pack bytes, Drive names, metadata, and encrypted manifest bytes;
- bounded in-flight bytes and release of completed pack buffers;
- resumable status handling, HTTP 308 ranges, and continuation offsets;
- retries for network loss, 408, 429, and 5xx with bounded backoff;
- 401 pause and user-driven resume;
- cancellation without manifest commit;
- failed pack upload preventing manifest publication;
- completed-pack reuse after restart;
- fresh Root reset touching only the selected app-created v1 Root and clearing
  the correct local namespace;
- pagination for pack listings;
- no behavioral or byte-level changes to the HTTP/OG backend.

Verification before the first Drive benchmark includes TypeScript, the full
Vitest suite, production webpack build, `git diff --check`, and a review that
`package-lock.json` and unrelated user changes remain untouched.

## 14. Rollout and Stop Conditions

Implementation occurs on a dedicated branch. It is not merged as a stable
Google Drive release until Gate 1 passes on a real empty Root.

Stop and investigate rather than tuning further when:

- the encrypted manifest can be committed before all packs exist;
- any plaintext identifier or content reaches Drive;
- the same benchmark reports missing or extra logical bytes;
- retries create conflicting completed packs for one deterministic name;
- Drive rate limiting worsens as concurrency increases;
- peak memory grows with total dataset size rather than the bounded in-flight
  window.

After Full Push is correct and benchmarked, Pull and incremental Push receive
separate design and implementation phases using the same v2 storage contract.
