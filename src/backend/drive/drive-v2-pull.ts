import type { ItemType } from '../../sync-core/types';
import {
    classifyPullJob,
    runAdaptivePullQueue,
} from './adaptive-pull-queue';
import { ByteBudget } from './byte-budget';
import type { DriveV2CommitMeta } from './drive-v2-head';
import type { DrivePackCrypto } from './pack-crypto';
import { DriveV2PackReader, type DriveV2PackSource } from './pack-reader';
import type { DrivePackManifestV2 } from './pack-types';
import type { DriveV2PullCheckpoint } from './pull-checkpoint';

const DEFAULT_ENCRYPTED_BUDGET = 64 * 1024 * 1024;
const DEFAULT_PLAINTEXT_BUDGET = 48 * 1024 * 1024;
const SELF_EXTENSION_ID = 'extension/st-tavernsync';

function isSelfExtension(id: string): boolean {
    return id.toLowerCase() === SELF_EXTENSION_ID;
}

export interface DriveV2PullProgressEvent {
    readonly stage: 'apply';
    readonly completedItems: number;
    readonly totalItems: number;
    readonly itemType: string;
    readonly itemsPerSecond: number;
    readonly activeWriters: number;
    readonly downloadedPacks: number;
    readonly uniquePacksRequired: number;
    readonly packDownloadRequests: number;
    readonly etaSeconds: number;
}

export interface DriveV2PullOptions {
    readonly commit: DriveV2CommitMeta;
    readonly manifest: DrivePackManifestV2;
    readonly localInventory: ReadonlyMap<string, ItemType>;
    readonly localHashes?: ReadonlyMap<string, string>;
    readonly allowedTypes: ReadonlySet<ItemType>;
    readonly source: Pick<DriveV2PackSource, 'readPack'>;
    readonly crypto: Pick<DrivePackCrypto, 'decryptChunk'>;
    readonly checkpoint: DriveV2PullCheckpoint;
    readonly applyItem: (id: string, type: ItemType, bytes: Uint8Array) => Promise<void>;
    readonly finalizeApply?: () => Promise<void>;
    readonly deleteItem: (id: string, type: ItemType) => Promise<void>;
    readonly verifyInventory?: () => Promise<ReadonlyMap<string, ItemType>>;
    readonly saveBase: (commitId: string) => Promise<void>;
    readonly onProgress?: (event: DriveV2PullProgressEvent) => void;
    readonly signal?: AbortSignal;
    readonly encryptedBudget?: ByteBudget;
    readonly plaintextBudget?: ByteBudget;
}

export interface DriveV2PullResult {
    readonly commitId: string;
    readonly applied: number;
    readonly deleted: number;
    readonly skippedInSync: number;
    readonly downloadedPacks: number;
    readonly packDownloadRequests: number;
    readonly peakCachedBytes: number;
    readonly peakEncryptedBytes: number;
    readonly peakPlaintextBytes: number;
    readonly maxActiveWriters: number;
    readonly elapsedMs: number;
}

export async function runDriveV2Pull(options: DriveV2PullOptions): Promise<DriveV2PullResult> {
    const encryptedBudget = options.encryptedBudget ?? new ByteBudget(DEFAULT_ENCRYPTED_BUDGET);
    const plaintextBudget = options.plaintextBudget ?? new ByteBudget(DEFAULT_PLAINTEXT_BUDGET);
    const packCacheSlots = Math.max(1, Math.min(
        2,
        Math.floor(encryptedBudget.capacityBytes / Math.max(1, options.manifest.packBytes)),
    ));
    const packReader = new DriveV2PackReader(
        options.source,
        options.crypto,
        packCacheSlots,
    );
    const remote = Object.values(options.manifest.items)
        .filter(item => options.allowedTypes.has(item.type) && !isSelfExtension(item.id));
    const remoteIds = new Set(remote.map(item => item.id));
    const resumedIds = new Set(remote
        .filter(item => options.checkpoint.completedIds.has(item.id)
            && options.localHashes?.get(item.id) === item.hash)
        .map(item => item.id));
    const exactHashIds = new Set(remote
        .filter(item => options.localHashes?.get(item.id) === item.hash)
        .map(item => item.id));
    const skippedIds = new Set([...resumedIds, ...exactHashIds]);
    for (const item of remote) {
        if (item.type !== 'characterstate' || !skippedIds.has(item.id)) continue;
        const avatar = item.id.split('/').slice(1).join('/');
        const characterId = `character/${avatar}`;
        if (remoteIds.has(characterId) && !skippedIds.has(characterId)) {
            skippedIds.delete(item.id);
        }
    }
    const jobs = remote
        .filter(item => !skippedIds.has(item.id))
        .map(item => {
            const job = classifyPullJob(item, remoteIds);
            return {
                ...job,
                dependencies: job.dependencies.filter(id => !skippedIds.has(id)),
            };
        });
    jobs.sort((left, right) => {
        const leftPack = left.item.chunks[0]?.packName ?? '';
        const rightPack = right.item.chunks[0]?.packName ?? '';
        return leftPack.localeCompare(rightPack);
    });
    const uniquePacksRequired = new Set(jobs.flatMap(job =>
        job.item.chunks.map(chunk => chunk.packName))).size;
    const deletions = [...options.localInventory]
        .filter(([id, type]) => options.allowedTypes.has(type)
            && !isSelfExtension(id)
            && !remoteIds.has(id))
        .sort(([left], [right]) => left.localeCompare(right));
    try {
        const metrics = await runAdaptivePullQueue({
            jobs,
            signal: options.signal,
            async run(job) {
                const plainPermit = await plaintextBudget.acquire(
                    Math.max(1, job.item.size),
                    options.signal,
                );
                let bytes: Uint8Array | null = null;
                try {
                    options.signal?.throwIfAborted();
                    bytes = await packReader.readItem(job.item);
                    await options.applyItem(job.item.id, job.item.type, bytes);
                    options.checkpoint.markCompleted(job.item.id);
                } finally {
                    bytes?.fill(0);
                    plainPermit.release();
                }
            },
            onSnapshot: snapshot => options.onProgress?.({
                stage: 'apply',
                completedItems: skippedIds.size + snapshot.completed,
                totalItems: remote.length,
                itemType: snapshot.lastItemType,
                itemsPerSecond: snapshot.itemsPerSecond,
                activeWriters: snapshot.activeWriters,
                downloadedPacks: packReader.getDownloadedPackCount(),
                uniquePacksRequired,
                packDownloadRequests: packReader.getPackDownloadRequestCount(),
                etaSeconds: snapshot.etaSeconds,
            }),
        });

        await options.finalizeApply?.();

        for (const [id, type] of deletions) {
            options.signal?.throwIfAborted();
            await options.deleteItem(id, type);
        }

        if (options.verifyInventory) {
            const actual = await options.verifyInventory();
            const expected = new Map(remote.map(item => [item.id, item.type] as const));
            const missing = [...expected]
                .filter(([id, type]) => actual.get(id) !== type)
                .map(([id]) => id)
                .sort();
            const unexpected = [...actual]
                .filter(([id, type]) => options.allowedTypes.has(type)
                    && !isSelfExtension(id)
                    && !expected.has(id))
                .map(([id]) => id)
                .sort();
            if (missing.length || unexpected.length) {
                const details = [
                    missing.length ? `missing ${missing.join(', ')}` : '',
                    unexpected.length ? `unexpected ${unexpected.join(', ')}` : '',
                ].filter(Boolean).join('; ');
                throw new Error(`Restore inventory incomplete: ${details}`);
            }
        }

        await options.saveBase(options.commit.commitId);
        options.checkpoint.finish();

        return {
            commitId: options.commit.commitId,
            applied: metrics.completed,
            deleted: deletions.length,
            skippedInSync: skippedIds.size,
            downloadedPacks: packReader.getDownloadedPackCount(),
            packDownloadRequests: packReader.getPackDownloadRequestCount(),
            peakCachedBytes: packReader.getPeakCachedBytes(),
            peakEncryptedBytes: packReader.getPeakCachedBytes(),
            peakPlaintextBytes: plaintextBudget.peakBytes,
            maxActiveWriters: metrics.maxActiveWriters,
            elapsedMs: metrics.elapsedMs,
        };
    } catch (error) {
        options.checkpoint.flushIfDue(true);
        throw error;
    }
}
