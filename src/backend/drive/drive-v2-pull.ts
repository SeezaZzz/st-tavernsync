import { PULL_TYPE_ORDER } from '../../sync-core/plan';
import type { ItemType, Manifest } from '../../sync-core/types';
import type { DriveV2CommitMeta } from './drive-v2-head';
import type { DriveV2PackReader } from './pack-reader';
import type { DrivePackItemV2, DrivePackManifestV2 } from './pack-types';

export interface DriveV2PullJournal {
    start(commitId: string): Promise<void>;
    markCompleted(itemId: string): Promise<void>;
    finish(commitId: string): Promise<void>;
}

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
    journal: DriveV2PullJournal;
    onProgress?(message: string): void;
    signal?: AbortSignal;
    now?(): number;
}

export interface DriveV2PullResult {
    commitId: string;
    applied: number;
    deleted: number;
    skippedInSync: number;
    downloadedPacks: number;
    peakCachedBytes: number;
    elapsedMs: number;
}

const typeRank = new Map<ItemType, number>(
    PULL_TYPE_ORDER.map((type, index) => [type, index]),
);

function sortItems<T extends { id: string; type: ItemType }>(items: readonly T[]): T[] {
    return [...items].sort((a, b) =>
        (typeRank.get(a.type) ?? 50) - (typeRank.get(b.type) ?? 50)
        || a.id.localeCompare(b.id));
}

function assertNotAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    throw signal.reason ?? new DOMException('Pull cancelled', 'AbortError');
}

export async function runDriveV2Pull(options: DriveV2PullOptions): Promise<DriveV2PullResult> {
    if (!options.localScanComplete) throw new Error('local scan incomplete');

    const now = options.now ?? (() => performance.now());
    const startedAt = now();
    const remoteItems = Object.values(options.manifest.items)
        .filter(item => options.allowedTypes.has(item.type));
    const changed = sortItems(remoteItems.filter(item =>
        options.local.items[item.id]?.hash !== item.hash));
    const skippedInSync = remoteItems.length - changed.length;
    const deletions = sortItems(Object.values(options.local.items).filter(item =>
        options.allowedTypes.has(item.type) && !options.manifest.items[item.id]));

    await options.journal.start(options.commit.commitId);
    let applied = 0;
    for (const item of changed) {
        assertNotAborted(options.signal);
        options.onProgress?.(`Applying ${applied + 1}/${changed.length} · ${item.type}`);
        const bytes = await options.reader.readItem(item as DrivePackItemV2);
        await options.saveBlob(item.hash, bytes);
        await options.applyItem(item.id, item.type, bytes);
        await options.journal.markCompleted(item.id);
        applied += 1;
    }

    let deleted = 0;
    for (const item of deletions) {
        assertNotAborted(options.signal);
        options.onProgress?.(`Deleting ${deleted + 1}/${deletions.length}`);
        await options.deleteItem(item.id, item.type);
        deleted += 1;
    }

    await options.saveBase(options.commit.commitId);
    await options.journal.finish(options.commit.commitId);

    return {
        commitId: options.commit.commitId,
        applied,
        deleted,
        skippedInSync,
        downloadedPacks: options.reader.getDownloadedPackCount(),
        peakCachedBytes: options.reader.getPeakCachedBytes(),
        elapsedMs: Math.max(0, now() - startedAt),
    };
}
