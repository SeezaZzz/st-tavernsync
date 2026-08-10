import type { ItemType } from '../../sync-core/types';
import {
    classifyPullJob,
    runAdaptivePullQueue,
} from './adaptive-pull-queue';
import { ByteBudget } from './byte-budget';
import type { DriveV2CommitMeta } from './drive-v2-head';
import type { DrivePackCrypto } from './pack-crypto';
import type { DrivePackManifestV2 } from './pack-types';
import type { DriveV2PullCheckpoint } from './pull-checkpoint';
import type { DriveChunkRange, DriveRangeSource } from './range-source';
import { readVerifiedItem } from './verified-item-reader';

const DEFAULT_ENCRYPTED_BUDGET = 64 * 1024 * 1024;
const DEFAULT_PLAINTEXT_BUDGET = 48 * 1024 * 1024;

export interface DriveV2PullProgressEvent {
    readonly stage: 'apply';
    readonly completedItems: number;
    readonly totalItems: number;
    readonly itemType: string;
    readonly itemsPerSecond: number;
    readonly activeWriters: number;
    readonly etaSeconds: number;
}

export interface DriveV2PullOptions {
    readonly commit: DriveV2CommitMeta;
    readonly manifest: DrivePackManifestV2;
    readonly localInventory: ReadonlyMap<string, ItemType>;
    readonly allowedTypes: ReadonlySet<ItemType>;
    readonly source: Pick<DriveRangeSource, 'readChunk'>;
    readonly crypto: Pick<DrivePackCrypto, 'decryptChunk'>;
    readonly checkpoint: DriveV2PullCheckpoint;
    readonly applyItem: (id: string, type: ItemType, bytes: Uint8Array) => Promise<void>;
    readonly deleteItem: (id: string, type: ItemType) => Promise<void>;
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
    readonly peakCachedBytes: number;
    readonly peakEncryptedBytes: number;
    readonly peakPlaintextBytes: number;
    readonly maxActiveWriters: number;
    readonly elapsedMs: number;
}

export async function runDriveV2Pull(options: DriveV2PullOptions): Promise<DriveV2PullResult> {
    const encryptedBudget = options.encryptedBudget ?? new ByteBudget(DEFAULT_ENCRYPTED_BUDGET);
    const plaintextBudget = options.plaintextBudget ?? new ByteBudget(DEFAULT_PLAINTEXT_BUDGET);
    const remote = Object.values(options.manifest.items)
        .filter(item => options.allowedTypes.has(item.type));
    const remoteIds = new Set(remote.map(item => item.id));
    const resumedIds = new Set(remote
        .filter(item => options.checkpoint.completedIds.has(item.id))
        .map(item => item.id));
    const jobs = remote
        .filter(item => !resumedIds.has(item.id))
        .map(item => {
            const job = classifyPullJob(item, remoteIds);
            return {
                ...job,
                dependencies: job.dependencies.filter(id => !resumedIds.has(id)),
            };
        });
    const deletions = [...options.localInventory]
        .filter(([id, type]) => options.allowedTypes.has(type) && !remoteIds.has(id))
        .sort(([left], [right]) => left.localeCompare(right));
    const downloadedPackNames = new Set<string>();
    const source = {
        readChunk: async (ref: DriveChunkRange, signal?: AbortSignal): Promise<Uint8Array> => {
            const bytes = await options.source.readChunk(ref, signal);
            downloadedPackNames.add(ref.packName);
            return bytes;
        },
    };

    try {
        const metrics = await runAdaptivePullQueue({
            jobs,
            signal: options.signal,
            async run(job) {
                const prepared = await readVerifiedItem({
                    item: job.item,
                    source,
                    crypto: options.crypto,
                    encryptedBudget,
                    plaintextBudget,
                    signal: options.signal,
                });
                try {
                    await options.applyItem(job.item.id, job.item.type, prepared.bytes);
                    options.checkpoint.markCompleted(job.item.id);
                } finally {
                    prepared.release();
                }
            },
            onSnapshot: snapshot => options.onProgress?.({
                stage: 'apply',
                completedItems: resumedIds.size + snapshot.completed,
                totalItems: remote.length,
                itemType: snapshot.lastItemType,
                itemsPerSecond: snapshot.itemsPerSecond,
                activeWriters: snapshot.activeWriters,
                etaSeconds: snapshot.etaSeconds,
            }),
        });

        for (const [id, type] of deletions) {
            options.signal?.throwIfAborted();
            await options.deleteItem(id, type);
        }

        await options.saveBase(options.commit.commitId);
        options.checkpoint.finish();

        return {
            commitId: options.commit.commitId,
            applied: metrics.completed,
            deleted: deletions.length,
            skippedInSync: resumedIds.size,
            downloadedPacks: downloadedPackNames.size,
            peakCachedBytes: encryptedBudget.peakBytes,
            peakEncryptedBytes: encryptedBudget.peakBytes,
            peakPlaintextBytes: plaintextBudget.peakBytes,
            maxActiveWriters: metrics.maxActiveWriters,
            elapsedMs: metrics.elapsedMs,
        };
    } catch (error) {
        options.checkpoint.flushIfDue(true);
        throw error;
    }
}
