import type { SyncItem } from '../../sync-core/types';
import { buildDrivePacks } from './pack-builder';
import type { DrivePackCrypto } from './pack-crypto';
import type { DrivePackLayout } from './pack-layout';
import type { PackUploadControl } from './pack-uploader';
import {
    DRIVE_V2_CHUNK_BYTES,
    DRIVE_V2_CONCURRENCY,
    DRIVE_V2_PACK_BYTES,
    type DrivePackManifestV2,
    type EncryptedPack,
} from './pack-types';

export interface DriveV2PushStore {
    hasCommittedSnapshot(): Promise<boolean>;
    putPack(pack: EncryptedPack, options?: PackUploadControl): Promise<void>;
    verifyPacks(expected: readonly { name: string; byteLength: number }[]): Promise<void>;
    commitManifest(manifest: DrivePackManifestV2): Promise<{ commitId: string }>;
}

export interface DriveV2Runtime {
    layout: DrivePackLayout;
    crypto: DrivePackCrypto;
    store: DriveV2PushStore;
}

export interface DriveV2PushMetrics {
    itemCount: number;
    plainBytes: number;
    packBytes: number;
    packCount: number;
    retries: number;
    peakInFlightBytes: number;
    scanMs: number;
    packingMs: number;
    uploadMs: number;
    verifyMs: number;
    commitMs: number;
    elapsedMs: number;
}

export interface DriveV2PushResult {
    commitId: string;
    manifest: DrivePackManifestV2;
    metrics: DriveV2PushMetrics;
}

export interface DriveV2PushOptions {
    runtime: DriveV2Runtime;
    device: string;
    items: readonly SyncItem[];
    load(hash: string): Promise<Uint8Array | null>;
    chunkBytes?: number;
    packBytes?: number;
    concurrency?: number;
    scanMs?: number;
    signal?: AbortSignal;
    onProgress?(message: string): void;
    now?(): number;
}

export interface DriveV2PushController {
    run(): Promise<DriveV2PushResult>;
    pause(): void;
    resume(): Promise<void>;
    cancel(): void;
}

class BoundedPackUploadQueue {
    private readonly inFlight = new Set<Promise<void>>();
    private readonly expected: { name: string; byteLength: number }[] = [];
    private firstError: unknown = null;
    private inFlightBytes = 0;
    private peakBytes = 0;
    private waitMs = 0;
    private firstUploadAt: number | null = null;
    private lastUploadAt: number | null = null;
    private retryCount = 0;

    constructor(
        private readonly store: DriveV2PushStore,
        private readonly concurrency: number,
        private readonly signal: AbortSignal | undefined,
        private readonly now: () => number,
        private readonly onProgress: ((message: string) => void) | undefined,
    ) {
        if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
            throw new RangeError('concurrency must be a positive safe integer');
        }
    }

    async accept(pack: EncryptedPack): Promise<void> {
        this.signal?.throwIfAborted();
        const waitStarted = this.now();
        while (this.inFlight.size >= this.concurrency) {
            await Promise.race(this.inFlight);
            if (this.firstError) throw this.firstError;
            this.signal?.throwIfAborted();
        }
        this.waitMs += this.now() - waitStarted;
        if (this.firstError) throw this.firstError;

        this.expected.push({ name: pack.name, byteLength: pack.bytes.byteLength });
        this.inFlightBytes += pack.bytes.byteLength;
        this.peakBytes = Math.max(this.peakBytes, this.inFlightBytes);
        this.firstUploadAt ??= this.now();
        this.onProgress?.(`Uploading ${this.expected.length} pack(s)…`);

        let task!: Promise<void>;
        task = this.store.putPack(pack, {
            signal: this.signal,
            onRetry: () => { this.retryCount += 1; },
        }).catch(error => {
            this.firstError ??= error;
        }).finally(() => {
            this.inFlightBytes -= pack.bytes.byteLength;
            this.lastUploadAt = this.now();
            this.inFlight.delete(task);
        });
        this.inFlight.add(task);
    }

    async drain(): Promise<void> {
        await Promise.all([...this.inFlight]);
        if (this.firstError) throw this.firstError;
        this.signal?.throwIfAborted();
    }

    getExpected(): readonly { name: string; byteLength: number }[] {
        return this.expected;
    }

    getPeakBytes(): number {
        return this.peakBytes;
    }

    getRetryCount(): number {
        return this.retryCount;
    }

    getWaitMs(): number {
        return this.waitMs;
    }

    getUploadMs(): number {
        if (this.firstUploadAt === null || this.lastUploadAt === null) return 0;
        return this.lastUploadAt - this.firstUploadAt;
    }
}

export async function runDriveV2FullPush(options: DriveV2PushOptions): Promise<DriveV2PushResult> {
    if (await options.runtime.store.hasCommittedSnapshot()) {
        throw new Error('Drive v2 incremental Push is not implemented');
    }

    const now = options.now ?? (() => performance.now());
    const startedAt = now();
    const queue = new BoundedPackUploadQueue(
        options.runtime.store,
        options.concurrency ?? DRIVE_V2_CONCURRENCY,
        options.signal,
        now,
        options.onProgress,
    );

    const packingStartedAt = now();
    const manifest = await buildDrivePacks({
        device: options.device,
        items: options.items,
        chunkBytes: options.chunkBytes ?? DRIVE_V2_CHUNK_BYTES,
        packBytes: options.packBytes ?? DRIVE_V2_PACK_BYTES,
        load: options.load,
        crypto: options.runtime.crypto,
        emit: pack => queue.accept(pack),
        onProgress: (done, total) => options.onProgress?.(`Packing ${done}/${total}`),
    });
    const packingFinishedAt = now();
    await queue.drain();

    options.onProgress?.(`Verifying ${queue.getExpected().length} pack(s)…`);
    const verifyStartedAt = now();
    await options.runtime.store.verifyPacks(queue.getExpected());
    const verifyFinishedAt = now();

    options.onProgress?.('Committing encrypted manifest…');
    const commitStartedAt = now();
    const { commitId } = await options.runtime.store.commitManifest(manifest);
    const finishedAt = now();

    return {
        commitId,
        manifest,
        metrics: {
            itemCount: options.items.length,
            plainBytes: options.items.reduce((sum, item) => sum + item.size, 0),
            packBytes: queue.getExpected().reduce((sum, pack) => sum + pack.byteLength, 0),
            packCount: queue.getExpected().length,
            retries: queue.getRetryCount(),
            peakInFlightBytes: queue.getPeakBytes(),
            scanMs: options.scanMs ?? 0,
            packingMs: Math.max(0, packingFinishedAt - packingStartedAt - queue.getWaitMs()),
            uploadMs: queue.getUploadMs(),
            verifyMs: verifyFinishedAt - verifyStartedAt,
            commitMs: finishedAt - commitStartedAt,
            elapsedMs: (options.scanMs ?? 0) + (finishedAt - startedAt),
        },
    };
}
