# Drive v2 Pull Performance Profiles Design

**Status:** Owner-approved design; pending written-spec review

**Extends:** `2026-08-10-drive-v2-extension-only-adaptive-restore-design.md`

**Does not change:** encrypted pack format, manifest format, Encryption
passphrase behavior, snapshot selection, Push behavior, enabled scopes, or
HTTP/OG sync

## 1. Goal

Drive v2 Pull must retain the verified desktop throughput while completing
reliably inside mobile WebViews. One encrypted snapshot must remain portable
between PC, Android, and SillyiOS; only the local Pull scheduler changes.

The owner-visible contract is:

1. The first interactive Pull on a device asks for **Mobile / Stable** or
   **PC / Fast**.
2. The user may remember that choice for this device.
3. The remembered choice can always be changed under **Advanced**.
4. A failed PC / Fast Pull can switch to Mobile / Stable and resume its
   checkpoint rather than restarting the complete snapshot.

Push remains one shared path. It currently uploads at most four packs at once
and produces the same portable encrypted snapshot regardless of which device
performed the Push.

## 2. Device-Local Profile State

The Pull profile has three states:

```text
unset | mobile | pc
```

The remembered value is device-local runtime configuration. It is stored in a
TavernSync-namespaced browser-local record and is excluded from snapshot
inventory, settings payloads, Push, Pull, reset-base operations, and deletion
propagation. A PC Push must never change the profile selected on a phone.

If the local record is absent, Pull opens the first-run chooser. Platform
detection may preselect a recommendation—Mobile / Stable on iOS, Android, and
other mobile WebViews; PC / Fast on desktop—but detection never removes the
choice or silently locks a profile.

If the user does not select **Remember for this device**, the selected profile
applies to that Pull only and the chooser appears again next time.

## 3. User Interface

### 3.1 First-Pull Chooser

The chooser uses plain device language and does not expose queue internals:

```text
Choose Pull performance

(•) Mobile / Stable
    Best for phones and tablets. Uses fewer simultaneous requests.

( ) PC / Fast
    Best for desktop. Faster, but may overload some mobile WebViews.

[✓] Remember for this device

[Start Pull] [Cancel]
```

The recommended option is preselected. Cancel performs no Drive or local-data
mutation.

### 3.2 Advanced Setting

The existing collapsed **Advanced** section gains a **Pull performance**
selector with the same two choices and short descriptions. It also shows the
active value beside the label.

Changing the selector while no Pull is active affects the next Pull. Changing
it while a Pull is active updates the saved preference but does not mutate the
running scheduler. The current Pull continues with the profile captured when
it started.

Progress includes the active profile and aggregate writer count:

```text
Pulling · Mobile / Stable · 4 writers · 822/2872 · ETA 08:14
Pulling · PC / Fast · 17 writers · 822/2872 · ETA 01:42
```

## 4. Scheduler Profiles

Both profiles use the same dependency graph, hash comparison, checkpoint,
deletion-last phase, and final inventory verifier.

| Profile | Initial class limits (small / medium / heavy / serial) | Per-class maximum | Aggregate writer cap | Encrypted cache | Plaintext budget |
| --- | --- | --- | ---: | ---: | ---: |
| Mobile / Stable | 2 / 1 / 1 / 1 | 3 / 2 / 1 / 1 | 4 | one 32 MiB pack | 24 MiB normal in-flight data |
| PC / Fast | 12 / 8 / 2 / 1 | 16 / 12 / 4 / 1 | 23 | two 32 MiB packs | 48 MiB normal in-flight data |

The aggregate cap applies after the per-class limits. Serial work still has a
class limit of one and dependency ordering still takes priority. An item larger
than the normal plaintext budget may run only as the sole plaintext-heavy item;
it must not deadlock waiting for capacity it can never obtain.

Mobile adaptation may reduce the aggregate cap from 4 to 3 and then 2 after
transient request failures or sustained latency collapse. It must not increase
above 4 during that Pull. PC adaptation retains its current per-class growth
inside the aggregate cap.

## 5. Failure, Fallback, and Resume

Every Google Drive and local SillyTavern fetch used by Pull is wrapped with a
stage-aware error. Diagnostics record:

- stage (`manifest`, `pack-download`, `decrypt`, `local-read`, `local-write`,
  `verify`, or `delete`);
- HTTP method;
- sanitized host and path;
- response status when one exists;
- active profile, aggregate writers, item ID, item type, and queue class.

Query strings, Google tokens, passphrases, derived keys, decrypted contents,
and secret values are never logged.

For transient network failures in Mobile / Stable, the scheduler stops
launching new work, reduces the aggregate cap by one step, and retries the
failed request with bounded exponential backoff. After the retry budget is
exhausted, it flushes the checkpoint and reports a resumable failure. It never
runs deletion-last or advances the base after a failed Pull.

When PC / Fast ends with a WebView-style fetch failure such as `TypeError: Load
failed`, TavernSync flushes the checkpoint and offers:

```text
PC / Fast could not finish on this device.

[Switch to Mobile / Stable and resume]
[Keep PC / Fast]
[Cancel]
```

**Switch and resume** persists Mobile / Stable for this device and begins a
new Pull against the same current Drive head. Existing checkpoint IDs are only
skipped when their present local hashes still match the manifest. If the Drive
head changed, normal checkpoint rules discard the stale checkpoint and restore
the newest committed snapshot.

## 6. Push Boundary

Push does not gain separate Mobile and PC formats or user choices in this
change. Its pack size, chunk size, four-upload cap, manifest, verification, and
commit behavior remain unchanged.

If later live evidence shows Push instability on a particular mobile runtime,
the same device-local performance profile may lower only Push upload
concurrency. Such a change would still produce byte-compatible packs and is
outside this design's implementation scope.

## 7. Compatibility and Migration

- Existing installations start with profile `unset` and see the chooser on
  their first Drive v2 Pull after updating.
- Existing Drive snapshots and checkpoints remain valid.
- Slash-command and automatic startup Pull use the remembered device profile.
  If no profile is remembered, they use the platform-recommended profile
  without opening an interactive dialog and log that recommendation.
- Resetting TavernSync sync state does not erase the device performance
  preference. The user changes or replaces it through the Advanced selector.
- HTTP/OG sync never reads this profile.

## 8. Verification Gates

Automated coverage must prove:

- first interactive Pull prompts when the profile is unset;
- remembered profile is device-local and absent from Push/settings payloads;
- Advanced changes are reflected on the next Pull, not a running Pull;
- Mobile never exceeds four aggregate writers and can step down to three and
  two;
- PC preserves its current class behavior while never exceeding 23 aggregate
  writers;
- oversized plaintext work runs exclusively without deadlock;
- error logs identify stage and sanitized path without credentials;
- PC WebView failure offers switch-and-resume;
- resume skips only items whose local hash still matches;
- no failure runs deletion-last or advances the base;
- Push output and HTTP/OG behavior are unchanged.

Live gates use the same newest Drive snapshot and Encryption passphrase:

1. **Desktop PC / Fast:** full or repeat Pull completes with inventory matching
   the snapshot and no desktop performance regression beyond 10% of the
   current verified baseline under comparable local/network conditions.
2. **SillyiOS Mobile / Stable:** Pull completes without `TypeError: Load
   failed`, WebContent termination, Node termination, or Jetsam; inventory and
   hashes pass after reload.
3. **Fallback:** start PC / Fast on SillyiOS, reproduce or simulate a transient
   WebView fetch failure, select Mobile / Stable, and complete from the saved
   checkpoint without restarting already verified items.
4. **Cross-device portability:** Push once from either device, then Pull that
   exact snapshot with both profiles; both final inventories must match.

## 9. Non-Goals

- separate mobile and PC snapshots, manifests, roots, or passphrases;
- a second Push format;
- SillyTavern Core patches, Companion plugins, or special IPA builds;
- automatic synchronization of the selected profile to other devices;
- claiming a failed request was caused by overload when stage-aware evidence
  identifies a different network or server failure.
