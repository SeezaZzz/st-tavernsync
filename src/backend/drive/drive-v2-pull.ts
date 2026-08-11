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
import type { DriveRangeSource } from './range-source';
import {
    getPullPerformanceConfig,
    type PullPerformanceProfile,
} from './pull-performance-profile';
import { isTransientPullError, withPullStage } from './pull-stage-error';
import { readVerifiedItem } from './verified-item-reader';

const DEFAULT_ENCRYPTED_BUDGET = 64 * 1024 * 1024;
const DEFAULT_PLAINTEXT_BUDGET = 48 * 1024 * 1024;
const SELF_EXTENSION_ID = 'extension/st-tavernsync';

function isSelfExtension(id: string): boolean {
    return id.toLowerCase() === SELF_EXTENSION_ID;
}

export interface DriveV2PullProgressEvent {
    readonly stage: 'apply';
    readonly profile: PullPerformanceProfile;
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
    readonly profile?: PullPerformanceProfile;
    readonly commit: DriveV2CommitMeta;
    readonly manifest: DrivePackManifestV2;
    readonly localInventory: ReadonlyMap<string, ItemType>;
    readonly localHashes?: ReadonlyMap<string, string>;
    readonly allowedTypes: ReadonlySet<ItemType>;
    readonly source: Pick<DriveV2PackSource, 'readPack'> & Partial<Pick<DriveRangeSource, 'readChunk'>>;
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
    const profile = options.profile ?? 'pc';
    const config = getPullPerformanceConfig(profile);
    const encryptedBudget = options.encryptedBudget ?? new ByteBudget(
        profile === 'pc' ? DEFAULT_ENCRYPTED_BUDGET : config.encryptedBudgetBytes,
    );
    const plaintextBudget = options.plaintextBudget ?? new ByteBudget(
        profile === 'pc' ? DEFAULT_PLAINTEXT_BUDGET : config.plaintextBudgetBytes,
    );
    const packCacheSlots = Math.max(1, Math.min(
        2,
        Math.floor(encryptedBudget.capacityBytes / Math.max(1, options.manifest.packBytes)),
    ));
    const packReader = profile === 'pc'
        ? new DriveV2PackReader(options.source, options.crypto, packCacheSlots)
        : null;
    const rangedPackNames = new Set<string>();
    let rangeReadRequests = 0;
    const readChunk = options.source.readChunk?.bind(options.source);
    const rangeSource = {
        readChunk: async (...args: Parameters<DriveRangeSource['readChunk']>) => {
            if (!readChunk) throw new Error('Mobile pull requires Drive byte-range support');
            rangeReadRequests += 1;
            const bytes = await readChunk(...args);
            rangedPackNames.add(args[0].packName);
            return bytes;
        },
    };
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
            const dependencies = job.dependencies.filter(id => !skippedIds.has(id));
            return {
                ...job,
                dependencies,
                phase: dependencies.length ? 1 as const : 0 as const,
            };
    });
    jobs.sort((left, right) => {
        if (left.phase !== right.phase) return left.phase - right.phase;
        return left.affinity.localeCompare(right.affinity);
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
            limits: config.limits,
            aggregateLimit: config.aggregateCap,
            minimumAggregateLimit: config.minimumAggregateCap,
            transientRetries: config.transientRetries,
            isTransientError: isTransientPullError,
            retryDelay: attempt => new Promise(resolve => setTimeout(resolve, 250 * (2 ** (attempt - 1)))),
            async run(job) {
                if (profile === 'mobile') {
                    const prepared = await readVerifiedItem({
                        item: job.item,
                        source: rangeSource,
                        crypto: options.crypto,
                        encryptedBudget,
                        plaintextBudget,
                        signal: options.signal,
                    });
                    try {
                        await withPullStage(
                            'local-write', 'POST', `st-item://${job.item.id}`,
                            () => options.applyItem(job.item.id, job.item.type, prepared.bytes),
                        );
                        options.checkpoint.markCompleted(job.item.id);
                    } finally {
                        prepared.release();
                    }
                    return;
                }

                if (!packReader) throw new Error('PC pull requires a pack reader');
                const plainPermit = await plaintextBudget.acquire(
                    Math.max(1, job.item.size),
                    options.signal,
                );
                let bytes: Uint8Array | null = null;
                try {
                    options.signal?.throwIfAborted();
                    bytes = await packReader.readItem(job.item);
                    await withPullStage(
                        'local-write', 'POST', `st-item://${job.item.id}`,
                        () => options.applyItem(job.item.id, job.item.type, bytes!),
                    );
                    options.checkpoint.markCompleted(job.item.id);
                } finally {
                    bytes?.fill(0);
                    plainPermit.release();
                }
            },
            onSnapshot: snapshot => options.onProgress?.({
                stage: 'apply',
                profile,
                completedItems: skippedIds.size + snapshot.completed,
                totalItems: remote.length,
                itemType: snapshot.lastItemType,
                itemsPerSecond: snapshot.itemsPerSecond,
                activeWriters: snapshot.activeWriters,
                downloadedPacks: packReader?.getDownloadedPackCount() ?? rangedPackNames.size,
                uniquePacksRequired,
                packDownloadRequests: packReader?.getPackDownloadRequestCount() ?? rangeReadRequests,
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
            downloadedPacks: packReader?.getDownloadedPackCount() ?? rangedPackNames.size,
            packDownloadRequests: packReader?.getPackDownloadRequestCount() ?? rangeReadRequests,
            peakCachedBytes: packReader?.getPeakCachedBytes() ?? encryptedBudget.peakBytes,
            peakEncryptedBytes: packReader?.getPeakCachedBytes() ?? encryptedBudget.peakBytes,
            peakPlaintextBytes: plaintextBudget.peakBytes,
            maxActiveWriters: metrics.maxActiveWriters,
            elapsedMs: metrics.elapsedMs,
        };
    } catch (error) {
        options.checkpoint.flushIfDue(true);
        throw error;
    }
}
