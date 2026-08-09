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

export type DriveV2PullStage = 'downloading' | 'storing' | 'applying';

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
    checkpoint?(item: DrivePackItemV2, stage: DriveV2PullStage): void;
    onProgress?(message: string): void;
    applyConcurrency?: number;
    maxPreparedBytes?: number;
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

function pullBatches(
    items: readonly DrivePackItemV2[],
    concurrency: number,
    maxPreparedBytes: number,
): DrivePackItemV2[][] {
    const batches: DrivePackItemV2[][] = [];
    let batch: DrivePackItemV2[] = [];
    let batchBytes = 0;

    const flush = (): void => {
        if (batch.length) batches.push(batch);
        batch = [];
        batchBytes = 0;
    };

    for (const item of items) {
        const itemBytes = Math.max(1, item.size);
        if (batch.length && (
            batch[0].type !== item.type
            || batch.length >= concurrency
            || batchBytes + itemBytes > maxPreparedBytes
        )) flush();
        batch.push(item);
        batchBytes += itemBytes;
        if (itemBytes > maxPreparedBytes) flush();
    }
    flush();
    return batches;
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

    const applyConcurrency = Math.max(1, Math.floor(options.applyConcurrency ?? 4));
    const maxPreparedBytes = Math.max(1, Math.floor(options.maxPreparedBytes ?? 16 * 1024 * 1024));
    const batches = pullBatches(changed as DrivePackItemV2[], applyConcurrency, maxPreparedBytes);
    const batchBytes = (batch: readonly DrivePackItemV2[]): number =>
        batch.reduce((total, item) => total + Math.max(1, item.size), 0);
    const prepareBatch = async (
        batch: readonly DrivePackItemV2[],
        startIndex: number,
    ): Promise<Array<{ item: DrivePackItemV2; bytes: Uint8Array }>> => {
        const prepared: Array<{ item: DrivePackItemV2; bytes: Uint8Array }> = [];
        for (const item of batch) {
            assertNotAborted(options.signal);
            options.onProgress?.(`Preparing ${startIndex + prepared.length + 1}/${changed.length} · ${item.type}`);
            options.checkpoint?.(item, 'downloading');
            prepared.push({ item, bytes: await options.reader.readItem(item) });
        }
        return prepared;
    };
    type PreparedResult =
        | { ok: true; value: Array<{ item: DrivePackItemV2; bytes: Uint8Array }> }
        | { ok: false; error: unknown };
    const prepareSafely = (
        batch: readonly DrivePackItemV2[],
        startIndex: number,
    ): Promise<PreparedResult> => prepareBatch(batch, startIndex).then(
        value => ({ ok: true, value }),
        error => ({ ok: false, error }),
    );

    await options.journal.start(options.commit.commitId);
    let applied = 0;
    let preparedThrough = batches[0]?.length ?? 0;
    let preparedResult = batches.length
        ? prepareSafely(batches[0], 0)
        : null;
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const currentResult = await preparedResult!;
        if (!currentResult.ok) throw currentResult.error;
        const prepared = currentResult.value;
        const nextBatch = batches[batchIndex + 1];
        const canPrefetch = nextBatch
            && batchBytes(batches[batchIndex]) <= maxPreparedBytes
            && batchBytes(nextBatch) <= maxPreparedBytes;
        const nextStartIndex = preparedThrough;
        let nextResult = canPrefetch
            ? prepareSafely(nextBatch, nextStartIndex)
            : null;
        if (nextBatch) preparedThrough += nextBatch.length;

        const outcomes = await Promise.allSettled(prepared.map(async ({ item, bytes }) => {
            options.checkpoint?.(item, 'storing');
            await options.saveBlob(item.hash, bytes);
            options.checkpoint?.(item, 'applying');
            await options.applyItem(item.id, item.type, bytes);
            return item;
        }));
        let failure: unknown;
        for (const outcome of outcomes) {
            if (outcome.status === 'rejected') {
                failure ??= outcome.reason;
                continue;
            }
            await options.journal.markCompleted(outcome.value.id);
            applied += 1;
            options.onProgress?.(`Applying ${applied}/${changed.length} · ${outcome.value.type}`);
        }
        if (failure !== undefined) throw failure;
        if (nextBatch && !nextResult) {
            nextResult = prepareSafely(nextBatch, nextStartIndex);
        }
        preparedResult = nextResult;
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
