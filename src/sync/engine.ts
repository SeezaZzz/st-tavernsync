/**
 * Orchestrates scan → diff → plan → push/pull with optional E2EE.
 */

import { ConflictError, manifestVersionForPush, type StorageRevision } from '../backend/adapter';
import { requireRuntime, type BackendRuntime } from '../backend/runtime';
import { decodeSalt, deriveKey, encodeSalt, exportKeyRaw, importAesKey } from '../crypto';
import { driveSaltFromFolderIdAsync } from '../crypto/subkeys';
import { LOG_PREFIX, getSettings, saveSettings, type SyncScopeSettings } from '../settings';
import { loadBlob, loadLocalManifest, scanLocal, storeBlob } from '../st-adapter/scan';
import { applyLocalItem, decodeUtf8Jsonl, parseItemId, writeChat } from '../st-adapter/write';
import { stFetchJson } from '../st-adapter/http';
import { conflictSiblingId, tryChatFastForward } from '../sync-core/conflict';
import { diffManifests, summarizeDiff } from '../sync-core/diff';
import { mergeManifestItems } from '../sync-core/merge';
import { applyOp, type PreparedPull } from '../sync-core/apply';
import { buildPlan } from '../sync-core/plan';
import { mergeSettingsThreeWay, sha256Hex } from '../st-adapter/normalize';
import type { DiffEntry, Manifest, SyncItem } from '../sync-core/types';
import { emptyManifest } from '../sync-core/types';
import { LEGACY_BASE_KEY, baseStorageKey, e2eeKeyStorageKey, getSyncStore } from '../state/store';
import { createPushHandlers } from './push-batch';

export interface BaseState {
    manifest: Manifest;
    syncedAt: number;
    remoteVersion: StorageRevision;
}

export type ConflictChoice = 'local' | 'remote' | 'both' | 'skip';

let sessionKey: CryptoKey | null = null;
let sessionPassphrase: string | null = null;
/** เวลาที่เริ่ม generate (ms epoch) — 0 = ว่าง
 *  เก็บเป็น timestamp แทน boolean เพื่อให้ล็อกปลดตัวเองได้ถ้าอีเวนต์ "จบ" หายไป */
let generatingSince = 0;
/** storageNamespace ของ runtime ล่าสุด — ใช้ต่อ remembered key storage */
let currentNamespace = '';

export function getSessionKey(): CryptoKey | null {
    return sessionKey;
}

/** HTTP namespace จาก settings โดยตรง — ใช้ตอนยังไม่มี runtime (เช่น tryRestoreE2eeKey ตอน load) */
function httpNamespaceFromSettings(): string {
    const endpoint = getSettings().endpoint.trim();
    if (!endpoint) return 'http:';
    try {
        return `http:${new URL(endpoint).host}`;
    } catch {
        return 'http:';
    }
}

/** namespace จาก settings ตาม backendMode — drive ผูกกับ root folderId (ตรงกับ runtime.storageNamespace) */
function namespaceFromSettings(): string {
    const s = getSettings();
    if (s.backendMode === 'drive') {
        const folderId = s.driveFolderId.trim();
        return folderId ? `drive:${folderId}` : 'drive:';
    }
    return httpNamespaceFromSettings();
}

function rememberedKeyStorageKey(): string {
    return e2eeKeyStorageKey(currentNamespace || namespaceFromSettings());
}

/** เพดานเวลาล็อก — generation เดียวไม่ควรนานเกินนี้ ถ้าเกินแปลว่าอีเวนต์ "จบ" หายไป */
const GENERATION_LOCK_MAX_MS = 5 * 60_000;

export function setGenerationBusy(busy: boolean): void {
    generatingSince = busy ? Date.now() : 0;
}

export function isGenerationBusy(): boolean {
    if (!generatingSince) return false;
    if (Date.now() - generatingSince >= GENERATION_LOCK_MAX_MS) {
        // ST ไม่ยิงอีเวนต์จบมา (path ใหม่/บั๊ก) — ปลดล็อกเองแทนที่จะค้างถาวร
        generatingSince = 0;
        return false;
    }
    return true;
}

/** คีย์ base ของ backend ปัจจุบัน — pattern เดียวกับ rememberedKeyStorageKey() */
function baseKeyForCurrentBackend(): string {
    return baseStorageKey(currentNamespace || namespaceFromSettings());
}

export async function loadBase(): Promise<BaseState | null> {
    const store = getSyncStore();
    const key = baseKeyForCurrentBackend();
    const scoped = await store.getItem<BaseState>(key);
    if (scoped) return scoped;

    // ย้ายสมุดเล่มเก่า (สมัยยังไม่แยกตาม backend) เข้าคีย์ใหม่ครั้งเดียว — เนื้อในเหมือนเดิมทุกอย่าง
    // ทำให้พฤติกรรมของเครื่องที่อัปเกรดมาไม่เปลี่ยน แล้วค่อยแยกกันจริงตอนสลับ backend ครั้งถัดไป
    const legacy = await store.getItem<BaseState>(LEGACY_BASE_KEY);
    if (!legacy) return null;
    await store.setItem(key, legacy);
    await store.removeItem(LEGACY_BASE_KEY);
    console.log(LOG_PREFIX, `Migrated legacy base → ${key}`);
    return legacy;
}

export async function saveBase(state: BaseState): Promise<void> {
    await getSyncStore().setItem(baseKeyForCurrentBackend(), state);
}

export async function clearBase(): Promise<void> {
    const store = getSyncStore();
    await store.removeItem(baseKeyForCurrentBackend());
    await store.removeItem(LEGACY_BASE_KEY); // กวาดของเก่าทิ้งด้วย ไม่งั้นถูก migrate กลับมาอีก
}

export async function wipeRemoteSyncData(): Promise<void> {
    const s = getSettings();
    const rt = await requireRuntime();
    currentNamespace = rt.storageNamespace;
    const adapter = rt.storage;
    const snap = await adapter.getSnapshot();
    if (snap.kind !== 'single') throw new Error('fork unsupported on this backend');
    const remoteVersion = snap.revision;
    const empty = emptyManifest(s.deviceName || 'device', snap.manifest?.version ?? 0);
    empty.items = {};
    const { revision: next } = await adapter.putManifest(empty, remoteVersion);
    await saveBase({ manifest: empty, syncedAt: Date.now(), remoteVersion: next });
    s.lastStatusMessage = 'Remote wiped';
    s.lastItemCount = 0;
    saveSettings();
    console.log(LOG_PREFIX, 'Remote manifest wiped', { next });
}

function b64encode(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

function b64decode(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function persistRememberedKey(key: CryptoKey): Promise<void> {
    const s = getSettings();
    if (s.e2eeRequireSessionUnlock) {
        await getSyncStore().removeItem(rememberedKeyStorageKey());
        return;
    }
    const raw = await exportKeyRaw(key);
    await getSyncStore().setItem(rememberedKeyStorageKey(), b64encode(raw));
}

async function clearRememberedKey(): Promise<void> {
    await getSyncStore().removeItem(rememberedKeyStorageKey());
}

/**
 * Load remembered device key from localforage into memory.
 * Returns true if a key is now available.
 */
export async function tryRestoreE2eeKey(): Promise<boolean> {
    const s = getSettings();
    if (!s.e2eeEnabled) return true;
    if (sessionKey) return true;
    if (s.e2eeRequireSessionUnlock) return false;

    try {
        const b64 = await getSyncStore().getItem<string>(rememberedKeyStorageKey());
        if (!b64) return false;
        // Drive runtime ต้อง exportKeyRaw(sessionKey) เพื่อ derive HKDF subkeys → restore แบบ extractable
        sessionKey = await importAesKey(b64decode(b64), s.backendMode === 'drive');
        console.log(LOG_PREFIX, 'Restored remembered E2EE key for this device');
        return true;
    } catch (e) {
        console.warn(LOG_PREFIX, 'Failed to restore remembered E2EE key', e);
        await clearRememberedKey();
        return false;
    }
}

/**
 * E2EE salt must be per-account (shared), not per-device.
 * Otherwise HMAC blob keys differ and pulls 404.
 */
export async function syncAccountSalt(passphrase?: string): Promise<void> {
    const s = getSettings();
    if (!s.e2eeEnabled) return;
    // Drive: salt derive จาก folderId แบบ deterministic — Connect/unlock เขียนลง settings ให้แล้ว ไม่ต้อง sync ผ่าน network
    if (s.backendMode === 'drive') return;
    if (!s.endpoint.trim() || !s.deviceToken.trim()) return;

    const rt = await requireRuntime();
    currentNamespace = rt.storageNamespace;
    let localSalt = s.e2eeSalt;
    if (!localSalt) {
        // Need a salt to publish — create one if unlocking
        if (!passphrase && !sessionPassphrase) return;
        const { salt } = await deriveKey(passphrase || sessionPassphrase || '', undefined, { extractable: true });
        localSalt = encodeSalt(salt);
        s.e2eeSalt = localSalt;
        saveSettings();
    }

    const canonical = encodeSalt(await rt.saltProvider.ensureSalt(decodeSalt(localSalt)));
    if (canonical !== s.e2eeSalt) {
        console.warn(LOG_PREFIX, 'Adopting account E2EE salt from server (was device-local)');
        s.e2eeSalt = canonical;
        saveSettings();
        const pw = passphrase || sessionPassphrase;
        if (pw) {
            const { key } = await deriveKey(pw, decodeSalt(canonical), { extractable: true });
            sessionKey = key;
            await persistRememberedKey(key);
        } else {
            // Salt changed — remembered key is for old salt; force re-unlock
            sessionKey = null;
            sessionPassphrase = null;
            await clearRememberedKey();
            console.warn(LOG_PREFIX, 'Re-enter E2EE passphrase after adopting server salt');
        }
    }
}

export async function unlockE2ee(passphrase: string): Promise<void> {
    const s = getSettings();
    sessionPassphrase = passphrase;
    const remember = !s.e2eeRequireSessionUnlock;
    // Drive runtime ต้อง exportKeyRaw(sessionKey) เพื่อ derive HKDF subkeys → บังคับ extractable เสมอ
    const extractable = remember || s.backendMode === 'drive';

    // Prefer account salt from server when available
    if (s.backendMode === 'drive') {
        // Drive: salt = SHA-256(folderId) แบบ deterministic — ต้อง Connect Google ก่อนเพื่อรู้ folderId
        const folderId = s.driveFolderId.trim();
        if (!folderId) {
            sessionPassphrase = null;
            throw new Error('Connect Google ก่อน แล้วค่อยปลดล็อก passphrase');
        }
        currentNamespace = `drive:${folderId}`;
        s.e2eeSalt = encodeSalt(await driveSaltFromFolderIdAsync(folderId));
        saveSettings();
    } else if (s.endpoint.trim() && s.deviceToken.trim()) {
        try {
            const rt = await requireRuntime();
            currentNamespace = rt.storageNamespace;
            const salt = await rt.saltProvider.getSalt();
            if (salt) {
                s.e2eeSalt = encodeSalt(salt);
                saveSettings();
            }
        } catch (e) {
            console.warn(LOG_PREFIX, 'Could not fetch account salt', e);
        }
    }

    let key: CryptoKey;
    if (s.e2eeSalt) {
        const derived = await deriveKey(passphrase, decodeSalt(s.e2eeSalt), { extractable });
        key = derived.key;
    } else {
        const derived = await deriveKey(passphrase, undefined, { extractable });
        key = derived.key;
        s.e2eeSalt = encodeSalt(derived.salt);
        saveSettings();
    }
    sessionKey = key;
    await persistRememberedKey(key);

    // Drop passphrase from memory when we remember the device key
    if (remember) sessionPassphrase = null;

    try {
        await syncAccountSalt(passphrase);
    } catch (e) {
        console.warn(LOG_PREFIX, 'syncAccountSalt after unlock failed', e);
    }
}

/** Clear in-memory key. Optionally forget the remembered device key too. */
export async function lockE2ee(opts?: { forgetDevice?: boolean }): Promise<void> {
    sessionKey = null;
    sessionPassphrase = null;
    if (opts?.forgetDevice !== false) {
        // Default lock forgets remembered key so next sync needs passphrase
        await clearRememberedKey();
    }
}

/** Try to persist the in-memory key (needs extractable CryptoKey). */
export async function rememberCurrentE2eeKey(): Promise<boolean> {
    if (!sessionKey) return false;
    try {
        await persistRememberedKey(sessionKey);
        return !getSettings().e2eeRequireSessionUnlock;
    } catch {
        return false;
    }
}

/** Forget remembered key without requiring lock semantics from callers that only toggle the setting. */
export async function forgetRememberedE2eeKey(): Promise<void> {
    await clearRememberedKey();
}

export function hasE2eeKey(): boolean {
    return !!sessionKey;
}

function scopeTypeSet(scope: SyncScopeSettings): Set<string> {
    const map: Record<string, string> = {
        settings: 'settings',
        characters: 'character',
        chats: 'chat',
        lorebooks: 'worldinfo',
        presets: 'preset',
        personas: 'persona',
        groups: 'group',
        quickreplies: 'quickreply',
        themes: 'theme',
    };
    const set = new Set<string>();
    for (const [k, on] of Object.entries(scope)) {
        if (on && map[k]) {
            set.add(map[k]);
            if (k === 'groups') set.add('groupchat');
        }
    }
    return set;
}

async function getRemoteBlob(rt: BackendRuntime, plaintextHash: string): Promise<Uint8Array> {
    // engine ส่ง logical content hash เสมอ — adapter แปลงเป็น blob name เอง
    return rt.storage.getBlob(plaintextHash);
}

function isBlobMissingError(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e);
    return /\b404\b/.test(msg) || /not.?found/i.test(msg);
}

export async function runScan(onProgress?: (m: string) => void) {
    const s = getSettings();
    return scanLocal({
        deviceName: s.deviceName || 'device',
        scope: s.scope,
        onProgress,
    });
}

export async function getStatusDiff(): Promise<{
    local: Manifest;
    remote: Manifest | null;
    base: Manifest | null;
    remoteVersion: StorageRevision;
    entries: DiffEntry[];
    summary: ReturnType<typeof summarizeDiff>;
    itemCount: number;
}> {
    let local = await loadLocalManifest();
    if (!local) {
        const scanned = await runScan();
        local = scanned.manifest;
    }

    let remote: Manifest | null = null;
    let remoteVersion: StorageRevision = '0';
    try {
        const rt = await requireRuntime();
        currentNamespace = rt.storageNamespace;
        const adapter = rt.storage;
        const snap = await adapter.getSnapshot();
        if (snap.kind !== 'single') throw new Error('fork unsupported on this backend');
        remote = snap.manifest;
        remoteVersion = snap.revision;
    } catch (e) {
        console.warn(LOG_PREFIX, 'Remote unavailable for status', e);
    }

    const baseState = await loadBase();
    const entries = diffManifests(local, baseState?.manifest ?? null, remote);
    return {
        local,
        remote,
        base: baseState?.manifest ?? null,
        remoteVersion,
        entries,
        summary: summarizeDiff(entries),
        itemCount: Object.keys(local.items).length,
    };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge stripped remote settings onto live settings.json.
 * Personas are synced as persona/* items and applied before settings — a shallow
 * `{...full, ...pulled}` would replace power_user and wipe names/descriptions
 * while leaving avatar PNGs on disk (exactly "image but no persona data").
 */
export function mergePulledSettings(
    live: Record<string, unknown>,
    pulled: Record<string, unknown>,
): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...live, ...pulled };

    if (isPlainObject(live.power_user) || isPlainObject(pulled.power_user)) {
        const livePu = isPlainObject(live.power_user) ? live.power_user : {};
        const pulledPu = isPlainObject(pulled.power_user) ? pulled.power_user : {};
        merged.power_user = {
            ...livePu,
            ...pulledPu,
            // Always keep whatever is live after persona/* apply (or pre-existing)
            personas: livePu.personas ?? pulledPu.personas,
            persona_descriptions: livePu.persona_descriptions ?? pulledPu.persona_descriptions,
            default_persona: livePu.default_persona ?? pulledPu.default_persona,
        };
    }

    if (!merged.extensionSettings || typeof merged.extensionSettings !== 'object') {
        merged.extensionSettings = {};
    }
    const liveExt = isPlainObject(live.extensionSettings) ? live.extensionSettings : {};
    const pulledExt = isPlainObject(pulled.extensionSettings) ? pulled.extensionSettings : {};
    const mergedExt = {
        ...liveExt,
        ...pulledExt,
        tavernsync: liveExt.tavernsync ?? getSettings(),
    };
    merged.extensionSettings = mergedExt;

    return merged;
}

async function resolveChatConflict(
    id: string,
    localHash: string,
    remoteHash: string,
    rt: BackendRuntime,
): Promise<'local' | 'remote' | 'both' | 'fast_forward_local' | 'fast_forward_remote'> {
    let localBytes = await loadBlob(localHash);
    if (!localBytes || localBytes.byteLength === 0) {
        // re-scan needed; treat as both
        return 'both';
    }
    const remoteBoxed = await getRemoteBlob(rt, remoteHash);
    const remoteBytes = await rt.crypto.decryptBlob(remoteBoxed, remoteHash);
    const localMsgs = decodeUtf8Jsonl(localBytes);
    const remoteMsgs = decodeUtf8Jsonl(remoteBytes);
    const ff = tryChatFastForward(localMsgs, remoteMsgs);
    if (ff.kind === 'same') return 'local';
    if (ff.kind === 'fast_forward') {
        return ff.winner === 'local' ? 'fast_forward_local' : 'fast_forward_remote';
    }
    return 'both';
}

export interface SyncRunOptions {
    direction: 'push' | 'pull' | 'both';
    dryRun?: boolean;
    /** Restrict to these types (M4 lorebooks+presets dogfood) */
    typeFilter?: Set<string>;
    onProgress?: (m: string) => void;
    /**
     * Resolve all remaining conflicts at once.
     * Prefer this over per-item resolveConflict.
     */
    resolveConflicts?: (
        entries: DiffEntry[],
        direction: 'push' | 'pull' | 'both',
    ) => Promise<Map<string, ConflictChoice>>;
    /** @deprecated prefer resolveConflicts */
    resolveConflict?: (entry: DiffEntry) => Promise<ConflictChoice>;
}

export async function runSync(opts: SyncRunOptions): Promise<{ message: string }> {
    if (isGenerationBusy()) {
        throw new Error('Cannot sync while generation is in progress');
    }

    const s = getSettings();
    if (s.e2eeEnabled) {
        await syncAccountSalt();
        if (!sessionKey) {
            throw new Error('E2EE enabled but no key on this device — enter passphrase once');
        }
    }
    const rt = await requireRuntime();
    currentNamespace = rt.storageNamespace;
    const adapter = rt.storage;
    const progress = (m: string) => {
        opts.onProgress?.(m);
        console.log(LOG_PREFIX, m);
    };
    /** อัปเดตเฉพาะ UI ไม่แตะ console — ใช้กับตัวนับรายชิ้นที่ยิงหลักพันครั้ง */
    const progressUi = (m: string) => opts.onProgress?.(m);
    const opVerb =
        opts.direction === 'push' ? 'Pushing' : opts.direction === 'pull' ? 'Pulling' : 'Syncing';

    progress('Scanning local…');
    const scanned = await runScan(progress);
    const local = scanned.manifest;

    progress('Fetching remote manifest…');
    const snap = await adapter.getSnapshot();
    let remote: Manifest | null;
    let remoteVersion: StorageRevision = snap.revision;
    if (snap.kind === 'single') {
        remote = snap.manifest;
    } else if (snap.heads.length === 0) {
        remote = snap.commonAncestor;
    } else {
        // fork: 3-way merge heads เทียบ commonAncestor — conflict เข้า resolveConflicts เดิม
        // (ห้ามตัดสินด้วย mtime/อายุ; merge ทีละ head โดย base คือ commonAncestor คงที่)
        progress(`Fork detected (${snap.heads.length} heads) — merging…`);
        const baseItems: Record<string, SyncItem> = snap.commonAncestor?.items ?? {};
        let mergedItems: Record<string, SyncItem> = { ...baseItems };
        for (const head of snap.heads) {
            const r = mergeManifestItems(baseItems, mergedItems, head.manifest.items);
            if (r.conflicts.length) {
                let choices = new Map<string, ConflictChoice>();
                if (opts.resolveConflicts) {
                    choices = await opts.resolveConflicts(r.conflicts, opts.direction);
                } else if (opts.resolveConflict) {
                    for (const c of r.conflicts) {
                        choices.set(c.id, await opts.resolveConflict(c));
                    }
                }
                for (const c of r.conflicts) {
                    // Safe default เหมือน conflict path เดิม: pull → remote, อื่น ๆ → skip
                    const fallback: ConflictChoice =
                        opts.direction === 'pull' ? 'remote' : 'skip';
                    const choice = choices.get(c.id) || fallback;
                    if (choice === 'local') {
                        if (c.local) r.merged[c.id] = c.local;
                    } else if (choice === 'remote' || choice === 'both') {
                        // 'both': ฝั่ง remote ชนะใน manifest — local copy ของ device นี้ยังอยู่
                        // และ diff ปกติข้างล่างจะเด้ง conflict UI อีกครั้ง (keep_both ทำที่ apply)
                        if (c.remote) r.merged[c.id] = c.remote;
                    }
                    // 'skip' → เว้นไว้ (ไม่ใส่ merged)
                }
            }
            mergedItems = r.merged;
        }
        remote = { ...snap.heads[0].manifest, items: mergedItems };
    }
    const baseState = await loadBase();

    let entries = diffManifests(local, baseState?.manifest ?? null, remote);
    const allowed = opts.typeFilter || scopeTypeSet(s.scope);

    // Pre-resolve chat conflicts via fast-forward
    for (const e of entries) {
        if (e.action !== 'conflict' || e.type !== 'chat') continue;
        if (!e.local || !e.remote) continue;
        try {
            const decision = await resolveChatConflict(e.id, e.local.hash, e.remote.hash, rt);
            if (decision === 'fast_forward_remote') {
                e.action = 'pull';
            } else if (decision === 'fast_forward_local') {
                e.action = 'push';
            }
        } catch (err) {
            // Common: remote chat encrypted with another key, or corrupt/missing blob.
            // Fall through to normal conflict UI — sync itself is not aborted.
            console.warn(LOG_PREFIX, 'fast-forward skipped (will ask on conflict)', e.id, err);
        }
    }

    // User conflict resolution for remaining conflicts (batch once)
    const conflictEntries = entries.filter((e) => e.action === 'conflict');
    for (const e of conflictEntries) {
        if (e.type === 'settings' && e.local && e.remote) {
            // Field-level merge attempt
            try {
                const localBytes = await loadBlob(e.local.hash);
                const remoteBoxed = await getRemoteBlob(rt, e.remote.hash);
                const remoteBytes = await rt.crypto.decryptBlob(remoteBoxed, e.remote.hash);
                const localObj = JSON.parse(new TextDecoder().decode(localBytes!)) as Record<string, unknown>;
                const remoteObj = JSON.parse(new TextDecoder().decode(remoteBytes)) as Record<string, unknown>;
                let baseObj: Record<string, unknown> | null = null;
                if (e.base) {
                    const bb = await loadBlob(e.base.hash);
                    if (bb) baseObj = JSON.parse(new TextDecoder().decode(bb)) as Record<string, unknown>;
                }
                const { merged, conflicts } = mergeSettingsThreeWay(localObj, baseObj, remoteObj);
                if (conflicts.length === 0) {
                    const json = JSON.stringify(merged); // already from merge of stripped trees
                    const bytes = new TextEncoder().encode(json);
                    const hash = await sha256Hex(bytes);
                    await storeBlob(hash, bytes);
                    local.items[e.id] = { ...e.local, hash, size: bytes.byteLength };
                    e.action = 'push';
                    e.local = local.items[e.id];
                }
            } catch (err) {
                console.error(LOG_PREFIX, 'settings merge failed', err);
            }
        }
    }

    const stillConflicted = entries.filter((e) => e.action === 'conflict');
    if (stillConflicted.length) {
        let choices = new Map<string, ConflictChoice>();
        if (opts.resolveConflicts) {
            choices = await opts.resolveConflicts(stillConflicted, opts.direction);
        } else if (opts.resolveConflict) {
            for (const e of stillConflicted) {
                choices.set(e.id, await opts.resolveConflict(e));
            }
        } else {
            // Safe default: never mass-overwrite from a possibly incomplete device
            const fallback: ConflictChoice =
                opts.direction === 'pull' ? 'remote' : 'skip';
            for (const e of stillConflicted) choices.set(e.id, fallback);
        }

        for (const e of stillConflicted) {
            const fallback: ConflictChoice =
                opts.direction === 'pull' ? 'remote' : 'skip';
            const choice = choices.get(e.id) || fallback;
            if (choice === 'local') e.action = 'push';
            else if (choice === 'remote') e.action = 'pull';
            else if (choice === 'skip') e.action = 'in_sync'; // leave server + local as-is this run
            // both stays conflict → keep_both in plan
        }
    }

    if (opts.direction === 'push') {
        entries = entries.filter((e) =>
            e.action === 'push' || e.action === 'push_new' || e.action === 'local_delete' || e.action === 'conflict');
    } else if (opts.direction === 'pull') {
        entries = entries.filter((e) =>
            e.action === 'pull' || e.action === 'pull_new' || e.action === 'remote_delete' || e.action === 'conflict');
    }

    const plan = buildPlan(entries, {
        propagateDeletes: s.propagateDeletes,
        allowedTypes: allowed,
    });

    progress(`Plan: ${plan.length} ops`);

    let settingsChanged = false;
    let personasChanged = false;
    const pullAppliedIds = new Set<string>();
    let pullSkipped = 0;

    const preparePull = async (id: string, type: SyncItem['type'], hash: string): Promise<PreparedPull> => {
        let boxed: Uint8Array;
        try {
            boxed = await getRemoteBlob(rt, hash);
        } catch (e) {
            if (isBlobMissingError(e)) {
                pullSkipped++;
                console.error(LOG_PREFIX, `Skipping pull ${id}: blob ${hash} not on server`, e);
                toastr.warning(
                    `Skipped ${id} — missing on the server. Push from the device that still has it.`,
                    'TavernSync',
                );
                return async () => undefined;
            }
            throw e;
        }

        let plain: Uint8Array;
        try {
            plain = await rt.crypto.decryptBlob(boxed, hash);
        } catch (e) {
            pullSkipped++;
            console.error(LOG_PREFIX, `Skipping pull ${id}: decrypt/hash failed`, e);
            toastr.warning(
                `Skipped ${id} — could not read server copy (wrong key or corrupt).`,
                'TavernSync',
            );
            return async () => undefined;
        }

        return async () => {
            await storeBlob(hash, plain);
            if (type === 'settings') {
                settingsChanged = true;
                const pulled = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
                const raw = await stFetchJson<{ settings: string }>('/api/settings/get', {});
                const full = JSON.parse(raw.settings || '{}') as Record<string, unknown>;
                const merged = mergePulledSettings(full, pulled);
                await applyLocalItem(id, type, new TextEncoder().encode(JSON.stringify(merged)), !!opts.dryRun);
            } else {
                if (type === 'persona') personasChanged = true;
                await applyLocalItem(id, type, plain, !!opts.dryRun);
            }
            pullAppliedIds.add(id);
        };
    };

    await applyOp(plan, {
        dryRun: !!opts.dryRun,
        log: (msg, meta) => console.log(LOG_PREFIX, msg, meta ?? ''),
        onProgress: (processed, total) => progressUi(`${opVerb} ${processed}/${total}…`),
        ...createPushHandlers({
            adapter,
            load: loadBlob,
            encrypt: (data) => rt.crypto.encryptBlob(data),
        }),
        preparePull,
        pullAndApply: async (id, type, hash) => (await preparePull(id, type, hash))(),
        keepBoth: async (id, type) => {
            const entry = entries.find((x) => x.id === id);
            if (!entry?.remote) return;
            const sibling = conflictSiblingId(id, s.deviceName || 'remote');
            let plain: Uint8Array;
            try {
                const boxed = await getRemoteBlob(rt, entry.remote.hash);
                plain = await rt.crypto.decryptBlob(boxed, entry.remote.hash);
            } catch (e) {
                console.error(LOG_PREFIX, 'keep_both: could not fetch remote', id, e);
                toastr.warning(
                    `Could not save a second copy of ${id} (missing/broken on server). Your local file is unchanged.`,
                    'TavernSync',
                );
                return;
            }
            await storeBlob(entry.remote.hash, plain);

            if (type === 'chat') {
                const { parts } = parseItemId(sibling);
                const avatar = parts[0];
                const fileName = parts.slice(1).join('/');
                const chat = decodeUtf8Jsonl(plain);
                if (!opts.dryRun) await writeChat(avatar, fileName, chat, true);
            } else {
                await applyLocalItem(sibling, type, plain, !!opts.dryRun);
            }
            toastr.warning(`Kept both copies for ${id}`, 'TavernSync');
        },
        tombstone: async (id) => {
            // Mark deleted on remote by pushing manifest without item — handled by rebuild below
            console.log(LOG_PREFIX, 'tombstone', id);
        },
    });

    // Rebuild remote manifest from intended end state
    if (!opts.dryRun && (opts.direction === 'push' || opts.direction === 'both')) {
        progress('Committing remote manifest…');
        const newItems: Record<string, SyncItem> = { ...(remote?.items || {}) };
        for (const e of entries) {
            if (!allowed.has(e.type || '')) continue;
            if (e.action === 'push' || e.action === 'push_new') {
                if (e.local) newItems[e.id] = e.local;
            }
            if (e.action === 'pull' || e.action === 'pull_new') {
                if (e.remote) newItems[e.id] = e.remote;
            }
            if (e.action === 'local_delete' && s.propagateDeletes) {
                delete newItems[e.id];
            }
        }

        // Drop entries whose blobs are missing under the backend's blob name
        // (batch เช็กครั้งเดียว — HTTP endpoint รับ array อยู่แล้ว, Drive จะได้ list โฟลเดอร์รอบเดียว)
        const dropped: string[] = [];
        const missingSet = new Set(await adapter.checkBlobs(Object.values(newItems).map(i => i.hash)));
        for (const [id, item] of Object.entries(newItems)) {
            if (missingSet.has(item.hash)) {
                delete newItems[id];
                dropped.push(id);
            }
        }
        if (dropped.length) {
            console.error(LOG_PREFIX, 'Dropping manifest entries with missing blobs', dropped);
            toastr.warning(
                `${dropped.length} item(s) weren't uploaded. Unlock this device if needed, then Push again.`,
                'TavernSync',
            );
        }

        const newManifest: Manifest = {
            ...emptyManifest(s.deviceName || 'device', manifestVersionForPush(remoteVersion, remote)),
            items: newItems,
            updatedAt: Date.now(),
        };

        try {
            const { revision } = await adapter.putManifest(newManifest, remoteVersion);
            await saveBase({ manifest: newManifest, syncedAt: Date.now(), remoteVersion: revision });
        } catch (err) {
            if (err instanceof ConflictError) {
                progress('412 conflict — re-diff once…');
                const again = await adapter.getSnapshot();
                if (again.kind === 'single') {
                    remote = again.manifest;
                    remoteVersion = again.revision;
                }
                // fork หรือ single ก็ abort เหมือนกัน — user retry แล้ว fork จะผ่าน merge path ข้างบน
                throw new Error('Remote changed during push; please retry');
            }
            throw err;
        }
    } else if (!opts.dryRun && opts.direction === 'pull') {
        if (remote) {
            if (pullSkipped > 0) {
                // Do NOT adopt full remote as base — that makes an incomplete device look "synced"
                // and a later Push can overwrite the server with partial data.
                const prev = await loadBase();
                const mergedItems: Record<string, SyncItem> = { ...(prev?.manifest.items || {}) };
                for (const id of pullAppliedIds) {
                    const item = remote.items[id];
                    if (item) mergedItems[id] = item;
                }
                await saveBase({
                    manifest: {
                        ...(prev?.manifest || emptyManifest(s.deviceName || 'device', remote.version)),
                        items: mergedItems,
                        updatedAt: Date.now(),
                    },
                    syncedAt: Date.now(),
                    remoteVersion,
                });
                toastr.warning(
                    `Pull incomplete (${pullSkipped} skipped). Baseline only updated for items that landed. ` +
                    `Do not Push from this device as the source of truth until a clean Pull succeeds.`,
                    'TavernSync',
                    { timeOut: 12000 },
                );
            } else {
                await saveBase({ manifest: remote, syncedAt: Date.now(), remoteVersion });
            }
        }
    }

    const summary = summarizeDiff(entries);
    const message = `${summary.push} push · ${summary.pull} pull · ${summary.conflict} conflict`;
    s.lastStatusMessage = message;
    saveSettings();

    if (settingsChanged || personasChanged) {
        const what = settingsChanged && personasChanged
            ? 'Settings and personas'
            : settingsChanged
                ? 'Settings'
                : 'Personas';
        toastr.info(`${what} updated. A page reload is recommended.`, 'TavernSync');
        // Soft prompt — don't force
        if (confirm(`TavernSync updated ${what.toLowerCase()}. Reload now so everything shows up?`)) {
            location.reload();
        }
    }

    return { message };
}
