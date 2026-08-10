/**
 * Orchestrates scan → diff → plan → push/pull with optional E2EE.
 */

import { ConflictError, manifestVersionForPush, type StorageRevision } from '../backend/adapter';
import { requireDriveV2Runtime, requireRuntime, type BackendRuntime } from '../backend/runtime';
import {
    createDriveV2PushController,
    driveV2ControllerResult,
    type DriveV2Runtime,
    type DriveV2PushController,
    type DriveV2PushResult,
} from '../backend/drive/drive-v2-push';
import { wipeDriveV2RemoteSnapshot } from '../backend/drive/drive-v2-wipe';
import { runDriveV2Pull, type DriveV2PullResult } from '../backend/drive/drive-v2-pull';
import {
    runDriveV2Sync,
    type DriveV2SourceChoice,
} from '../backend/drive/drive-v2-sync';
import { computeDriveV2Heads, type DriveV2CommitMeta } from '../backend/drive/drive-v2-head';
import type { DrivePackManifestV2 } from '../backend/drive/pack-types';
import { DriveV2PullCheckpoint } from '../backend/drive/pull-checkpoint';
import { formatDriveV2PullProgress } from '../backend/drive/drive-v2-ui-state';
import { decodeSalt, deriveKey, encodeSalt, exportKeyRaw, importAesKey } from '../crypto';
import { driveSaltFromFolderIdAsync } from '../crypto/subkeys';
import { LOG_PREFIX, getSettings, saveSettings, type SyncScopeSettings } from '../settings';
import { loadBlob, loadLocalManifest, scanLocal, storeBlob } from '../st-adapter/scan';
import { listLocalInventory } from '../st-adapter/inventory';
import {
    applyLocalItem,
    applyPreparedPersonas,
    decodeUtf8Jsonl,
    parseItemId,
    preparePersona,
    writeChat,
    type PreparedPersona,
} from '../st-adapter/write';
import type { PersonaPayload } from '../st-adapter/read';
import { deleteLocalItem } from '../st-adapter/delete';
import { stFetchJson } from '../st-adapter/http';
import { conflictSiblingId, tryChatFastForward } from '../sync-core/conflict';
import { diffManifests, summarizeDiff } from '../sync-core/diff';
import { mergeManifestItems } from '../sync-core/merge';
import { applyOp } from '../sync-core/apply';
import { buildPlan } from '../sync-core/plan';
import { mergeSettingsThreeWay, sha256Hex } from '../st-adapter/normalize';
import type { DiffEntry, Manifest, SyncItem } from '../sync-core/types';
import { emptyManifest } from '../sync-core/types';
import {
    LEGACY_BASE_KEY,
    baseStorageKey,
    e2eeKeyStorageKey,
    getSyncStore,
    loadDriveV2Base,
    saveDriveV2Base,
} from '../state/store';
import { createPushHandlers } from './push-batch';
import { PullCrashJournal, type PullCrashUpdate, type PullStage } from './pull-crash-journal';

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
let activeDriveV2Controller: DriveV2PushController | null = null;
let activeDriveV2PushNamespace = '';

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
    if (s.backendMode === 'drive' && s.driveRootVersion === 2) {
        const runtime = await requireDriveV2Runtime();
        currentNamespace = `drive:${runtime.layout.rootId}`;
        const { commitId } = await wipeDriveV2RemoteSnapshot(
            runtime.store,
            s.deviceName || 'device',
        );
        await saveDriveV2Base(currentNamespace, {
            commitId,
            syncedAt: Date.now(),
        });
        s.lastStatusMessage = 'Remote wiped';
        s.lastItemCount = 0;
        saveSettings();
        console.log(LOG_PREFIX, 'Google Drive backup wiped', { commitId });
        return;
    }
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

function scopeTypeSet(scope: SyncScopeSettings): Set<SyncItem['type']> {
    const mappings: readonly [keyof SyncScopeSettings, SyncItem['type']][] = [
        ['settings', 'settings'],
        ['characters', 'character'],
        ['chats', 'chat'],
        ['lorebooks', 'worldinfo'],
        ['presets', 'preset'],
        ['personas', 'persona'],
        ['groups', 'group'],
        ['quickreplies', 'quickreply'],
        ['themes', 'theme'],
    ];
    const set = new Set<SyncItem['type']>();
    for (const [setting, type] of mappings) {
        if (scope[setting]) {
            set.add(type);
            if (setting === 'settings') set.add('extension');
            if (setting === 'characters') {
                set.add('characterstate');
                set.add('characterasset');
            }
            if (setting === 'groups') {
                set.add('groupchat');
                set.add('userimage');
            }
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

    const liveExt = isPlainObject(live.extension_settings) ? live.extension_settings : {};
    const pulledExt = isPlainObject(pulled.extension_settings) ? pulled.extension_settings : {};
    const mergedExt = {
        ...liveExt,
        ...pulledExt,
        tavernsync: liveExt.tavernsync ?? getSettings(),
    };
    merged.extension_settings = mergedExt;
    delete merged.extensionSettings;

    return merged;
}

async function persistFastPullStatus(lastStatusMessage: string, lastItemCount: number): Promise<void> {
    const raw = await stFetchJson<{ settings: string }>('/api/settings/get', {});
    const latestValue: unknown = JSON.parse(raw.settings || '{}');
    const latest = isPlainObject(latestValue) ? latestValue : {};
    const extensionSettings = isPlainObject(latest.extension_settings)
        ? latest.extension_settings
        : {};
    const latestTavernSync = isPlainObject(extensionSettings.tavernsync)
        ? extensionSettings.tavernsync
        : structuredClone(getSettings()) as unknown as Record<string, unknown>;

    latest.extension_settings = {
        ...extensionSettings,
        tavernsync: {
            ...latestTavernSync,
            lastStatusMessage,
            lastItemCount,
        },
    };
    await stFetchJson('/api/settings/save', latest);
}

async function resolveChatConflict(
    id: string,
    localHash: string,
    remoteHash: string,
    rt: BackendRuntime,
): Promise<'local' | 'remote' | 'both' | 'fast_forward_local' | 'fast_forward_remote'> {
    const localBytes = await loadBlob(localHash);
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
    chooseDriveV2Source?: (input: import('../backend/drive/drive-v2-choice').DriveV2ChoiceInput) => Promise<DriveV2SourceChoice>;
}

export class DriveV2SourceChoiceRequiredError extends Error {
    constructor() {
        super('Google Drive backup source selection is required');
        this.name = 'DriveV2SourceChoiceRequiredError';
    }
}

async function runDriveV2ExtensionPull(options: {
    runtime: DriveV2Runtime;
    settings: ReturnType<typeof getSettings>;
    namespace: string;
    allowedTypes: ReadonlySet<SyncItem['type']>;
    commit: DriveV2CommitMeta;
    manifest: DrivePackManifestV2;
    onProgress?: (message: string) => void;
}): Promise<DriveV2PullResult> {
    options.onProgress?.('Checking local data…');
    const scanned = await scanLocal({
        deviceName: options.settings.deviceName || 'device',
        scope: options.settings.scope,
        onProgress: options.onProgress,
    });
    const localItems = Object.values(scanned.manifest.items)
        .filter(item => options.allowedTypes.has(item.type));
    const localInventory = new Map(localItems.map(item => [item.id, item.type] as const));
    const localHashes = new Map(localItems.map(item => [item.id, item.hash] as const));
    const checkpoint = new DriveV2PullCheckpoint(options.commit.commitId);
    const preparedPersonas: PreparedPersona[] = [];

    return runDriveV2Pull({
        commit: options.commit,
        manifest: options.manifest,
        localInventory,
        localHashes,
        allowedTypes: options.allowedTypes,
        source: options.runtime.store,
        crypto: options.runtime.crypto,
        checkpoint,
        applyItem: async (id, type, bytes) => {
            if (type === 'persona') {
                const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
                const avatarId = parseItemId(id).parts.join('/');
                const payload: PersonaPayload = typeof raw === 'string'
                    ? { avatarId, name: raw, description: null, imageBase64: '' }
                    : { ...(raw as PersonaPayload), avatarId: (raw as PersonaPayload).avatarId || avatarId };
                preparedPersonas.push(await preparePersona(payload));
                return;
            }
            if (type !== 'settings') {
                await applyLocalItem(id, type, bytes, false);
                return;
            }
            const pulledValue: unknown = JSON.parse(new TextDecoder().decode(bytes));
            const pulled = isPlainObject(pulledValue) ? pulledValue : {};
            const raw = await stFetchJson<{ settings: string }>('/api/settings/get', {});
            const liveValue: unknown = JSON.parse(raw.settings || '{}');
            const live = isPlainObject(liveValue) ? liveValue : {};
            const merged = mergePulledSettings(live, pulled);
            await applyLocalItem(
                id,
                type,
                new TextEncoder().encode(JSON.stringify(merged)),
                false,
            );
        },
        finalizeApply: () => applyPreparedPersonas(preparedPersonas),
        deleteItem: deleteLocalItem,
        verifyInventory: () => listLocalInventory(options.allowedTypes),
        saveBase: commitId => saveDriveV2Base(options.namespace, {
            commitId,
            syncedAt: Date.now(),
        }),
        onProgress: event => options.onProgress?.(formatDriveV2PullProgress(event)),
    });
}

async function runDriveV2FromEngine(options: {
    direction: 'push' | 'pull';
    typeFilter?: ReadonlySet<string>;
    chooseSource?: SyncRunOptions['chooseDriveV2Source'];
    onProgress?: (message: string) => void;
}): Promise<{ message: string }> {
    if (options.direction === 'pull') return runDriveV2FastPullFromEngine(options);
    const settings = getSettings();
    const scanStartedAt = performance.now();
    options.onProgress?.('Scanning local…');
    const scanned = await runScan(options.onProgress);
    const scanMs = performance.now() - scanStartedAt;
    const runtime = await requireDriveV2Runtime();
    currentNamespace = `drive:${runtime.layout.rootId}`;
    const allowedTypes = scopeTypeSet(settings.scope);
    if (options.typeFilter) {
        for (const type of [...allowedTypes]) {
            if (!options.typeFilter.has(type)) allowedTypes.delete(type);
        }
    }
    let pulledItemCount = scanned.itemCount;

    const result = await runDriveV2Sync({
        direction: options.direction,
        runtime,
        namespace: currentNamespace,
        local: scanned.manifest,
        allowedTypes,
        loadBase: () => loadDriveV2Base(currentNamespace),
        saveBase: base => saveDriveV2Base(currentNamespace, base),
        chooseSource: options.chooseSource ?? (() => Promise.reject(new DriveV2SourceChoiceRequiredError())),
        runPush: async input => {
            const items = Object.values(scanned.manifest.items)
                .filter(item => allowedTypes.has(item.type) && !item.deleted);
            const controller = createDriveV2PushController({
                runtime,
                device: settings.deviceName || 'device',
                items,
                load: loadBlob,
                parents: input.parents,
                baseCommitId: input.baseCommitId,
                forced: input.forced,
                scanMs,
                onProgress: options.onProgress,
            });
            activeDriveV2Controller = controller;
            activeDriveV2PushNamespace = currentNamespace;
            return controller.run();
        },
        runPull: async (commit, manifest) => {
            pulledItemCount = Object.values(manifest.items)
                .filter(item => allowedTypes.has(item.type)).length;
            return runDriveV2ExtensionPull({
                runtime,
                settings,
                namespace: currentNamespace,
                allowedTypes,
                commit,
                manifest,
                onProgress: options.onProgress,
            });
        },
    });

    switch (result.kind) {
        case 'cancelled':
            return { message: 'Cancelled · no changes' };
        case 'pushed':
            return finishDriveV2Push(result.result);
        case 'pulled': {
            const seconds = Math.round(result.result.elapsedMs / 1000);
            settings.lastItemCount = pulledItemCount;
            settings.lastStatusMessage = `Pull complete · ${seconds}s`;
            saveSettings();
            return { message: settings.lastStatusMessage };
        }
    }
}

async function runDriveV2FastPullFromEngine(options: {
    direction: 'push' | 'pull';
    typeFilter?: ReadonlySet<string>;
    chooseSource?: SyncRunOptions['chooseDriveV2Source'];
    onProgress?: (message: string) => void;
}): Promise<{ message: string }> {
    const settings = getSettings();
    const runtime = await requireDriveV2Runtime();
    currentNamespace = `drive:${runtime.layout.rootId}`;
    const allowedTypes = scopeTypeSet(settings.scope);
    if (options.typeFilter) {
        for (const type of [...allowedTypes]) {
            if (!options.typeFilter.has(type)) allowedTypes.delete(type);
        }
    }
    let pulledItemCount = 0;

    const result = await runDriveV2Sync({
        direction: 'pull',
        runtime,
        namespace: currentNamespace,
        local: emptyManifest(settings.deviceName || 'device'),
        allowedTypes,
        loadBase: () => loadDriveV2Base(currentNamespace),
        saveBase: base => saveDriveV2Base(currentNamespace, base),
        chooseSource: options.chooseSource ?? (() => Promise.reject(new DriveV2SourceChoiceRequiredError())),
        runPush: async () => { throw new Error('Fast Pull cannot push'); },
        runPull: async (commit, manifest) => {
            pulledItemCount = Object.values(manifest.items)
                .filter(item => allowedTypes.has(item.type)).length;
            return runDriveV2ExtensionPull({
                runtime,
                settings,
                namespace: currentNamespace,
                allowedTypes,
                commit,
                manifest,
                onProgress: options.onProgress,
            });
        },
    });

    if (result.kind !== 'pulled') return { message: 'Cancelled · no changes' };
    const seconds = Math.round(result.result.elapsedMs / 1000);
    settings.lastItemCount = pulledItemCount;
    settings.lastStatusMessage = `Fast Pull complete · ${seconds}s`;
    await persistFastPullStatus(settings.lastStatusMessage, settings.lastItemCount);
    return { message: settings.lastStatusMessage };
}

function finishDriveV2Push(result: DriveV2PushResult): { message: string } {
    const settings = getSettings();
    settings.lastItemCount = result.metrics.itemCount;
    settings.lastStatusMessage = `Full Push complete · ${Math.round(result.metrics.elapsedMs / 1000)}s`;
    saveSettings();
    return { message: settings.lastStatusMessage };
}

export async function resumeDriveV2FullPushFromEngine(): Promise<{ message: string }> {
    if (!activeDriveV2Controller) throw new Error('No paused Google Drive upload to resume');
    await activeDriveV2Controller.resume();
    const result = driveV2ControllerResult(activeDriveV2Controller);
    if (!result) throw new Error('Google Drive upload resumed without a result');
    if (activeDriveV2PushNamespace) {
        await saveDriveV2Base(activeDriveV2PushNamespace, {
            commitId: result.commitId,
            syncedAt: Date.now(),
        });
    }
    return finishDriveV2Push(result);
}

export async function getDriveV2Status(onProgress?: (message: string) => void): Promise<{
    itemCount: number;
    headCount: number;
    baseCommitId: string | null;
    state: 'empty' | 'current' | 'stale';
    heads: readonly { commitId: string; device: string; createdTime: string; itemCount: number }[];
}> {
    const scanned = await runScan(onProgress);
    const runtime = await requireDriveV2Runtime();
    currentNamespace = `drive:${runtime.layout.rootId}`;
    const commits = await runtime.store.listCommits();
    const heads = computeDriveV2Heads(commits);
    const base = await loadDriveV2Base(currentNamespace);
    const summaries = await Promise.all(heads.map(async commit => {
        const manifest = await runtime.store.readManifest(commit);
        return {
            commitId: commit.commitId,
            device: manifest.device,
            createdTime: commit.createdTime,
            itemCount: Object.keys(manifest.items).length,
        };
    }));
    const state = heads.length === 0
        ? 'empty' as const
        : heads.length === 1 && base?.commitId === heads[0].commitId
            ? 'current' as const
            : 'stale' as const;
    return {
        itemCount: scanned.itemCount,
        headCount: heads.length,
        baseCommitId: base?.commitId ?? null,
        state,
        heads: summaries,
    };
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
    if (s.backendMode === 'drive' && s.driveRootVersion === 2) {
        if (opts.dryRun) throw new Error('Google Drive backup does not support dry-run sync');
        if (opts.direction === 'both') {
            throw new Error('Google Drive backup requires an explicit Push or Pull direction');
        }
        return runDriveV2FromEngine({
            direction: opts.direction,
            typeFilter: opts.typeFilter,
            chooseSource: opts.chooseDriveV2Source,
            onProgress: opts.onProgress,
        });
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
    const pullJournal = typeof localStorage === 'undefined' ? null : new PullCrashJournal(localStorage);
    if (opts.direction === 'pull' || opts.direction === 'both') pullJournal?.startRun();
    const remoteItems = new Map(entries.flatMap((entry) => entry.remote ? [[entry.id, entry.remote] as const] : []));
    const checkpoint = (id: string, type: SyncItem['type'], hash: string, stage: PullStage): void => {
        const item: PullCrashUpdate = {
            id,
            type,
            hash,
            size: remoteItems.get(id)?.size ?? 0,
            stage,
        };
        pullJournal?.update(item);
    };

    const pullAndApply = async (id: string, type: SyncItem['type'], hash: string): Promise<void> => {
        checkpoint(id, type, hash, 'downloading');
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
                pullJournal?.finish(id);
                return;
            }
            throw e;
        }

        checkpoint(id, type, hash, 'decrypting');
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
            pullJournal?.finish(id);
            return;
        }

        checkpoint(id, type, hash, 'storing');
        await storeBlob(hash, plain);
        checkpoint(id, type, hash, 'applying');
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
        pullJournal?.finish(id);
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
        pullAndApply,
        concurrency: rt.pullConcurrency,
        keepBoth: async (id, type) => {
            const entry = entries.find((x) => x.id === id);
            if (!entry?.remote) return;
            const sibling = conflictSiblingId(id, s.deviceName || 'remote');
            checkpoint(id, type, entry.remote.hash, 'downloading');
            let plain: Uint8Array;
            try {
                const boxed = await getRemoteBlob(rt, entry.remote.hash);
                checkpoint(id, type, entry.remote.hash, 'decrypting');
                plain = await rt.crypto.decryptBlob(boxed, entry.remote.hash);
            } catch (e) {
                console.error(LOG_PREFIX, 'keep_both: could not fetch remote', id, e);
                toastr.warning(
                    `Could not save a second copy of ${id} (missing/broken on server). Your local file is unchanged.`,
                    'TavernSync',
                );
                pullJournal?.finish(id);
                return;
            }
            checkpoint(id, type, entry.remote.hash, 'storing');
            await storeBlob(entry.remote.hash, plain);
            checkpoint(id, type, entry.remote.hash, 'applying');

            if (type === 'chat') {
                const { parts } = parseItemId(sibling);
                const avatar = parts[0];
                const fileName = parts.slice(1).join('/');
                const chat = decodeUtf8Jsonl(plain);
                if (!opts.dryRun) await writeChat(avatar, fileName, chat, true);
            } else {
                await applyLocalItem(sibling, type, plain, !!opts.dryRun);
            }
            pullJournal?.finish(id);
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
