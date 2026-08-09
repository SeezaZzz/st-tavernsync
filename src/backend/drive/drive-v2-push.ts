import type { SyncItem } from '../../sync-core/types';
import { buildDrivePacks } from './pack-builder';
import type { DrivePackCrypto } from './pack-crypto';
import type { DrivePackLayout } from './pack-layout';
import type { PackUploadControl } from './pack-uploader';
import { DriveUploadPausedError } from './pack-uploader';
import { formatDriveV2PushProgress } from './drive-v2-ui-state';
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
    resumeSessions?: ReadonlyMap<string, { sessionUrl: string; acknowledgedBytes: number }>;
    onPausedPack?(pack: EncryptedPack, error: DriveUploadPausedError): void;
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
    private completedPacks = 0;
    private completedBytes = 0;
    private totalKnown = false;

    constructor(
        private readonly store: DriveV2PushStore,
        private readonly concurrency: number,
        private readonly signal: AbortSignal | undefined,
        private readonly now: () => number,
        private readonly onProgress: ((message: string) => void) | undefined,
        private readonly resumeSessions: ReadonlyMap<string, { sessionUrl: string; acknowledgedBytes: number }> | undefined,
        private readonly onPausedPack: ((pack: EncryptedPack, error: DriveUploadPausedError) => void) | undefined,
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
        let succeeded = false;

        let task!: Promise<void>;
        task = this.store.putPack(pack, {
            signal: this.signal,
            resume: this.resumeSessions?.get(pack.name),
            onRetry: () => { this.retryCount += 1; },
        }).then(() => {
            succeeded = true;
        }).catch(error => {
            if (error instanceof DriveUploadPausedError) this.onPausedPack?.(pack, error);
            this.firstError ??= error;
        }).finally(() => {
            if (succeeded) {
                this.completedPacks += 1;
                this.completedBytes += pack.bytes.byteLength;
            }
            this.inFlightBytes -= pack.bytes.byteLength;
            this.lastUploadAt = this.now();
            this.inFlight.delete(task);
            this.reportProgress();
        });
        this.inFlight.add(task);
    }

    markTotalKnown(): void {
        this.totalKnown = true;
        this.reportProgress();
    }

    private reportProgress(): void {
        if (!this.totalKnown || !this.onProgress) return;
        const elapsedSeconds = this.firstUploadAt === null
            ? 0
            : Math.max((this.now() - this.firstUploadAt) / 1000, 0.001);
        const bytesPerSecond = this.completedBytes / elapsedSeconds;
        const totalBytes = this.expected.reduce((sum, pack) => sum + pack.byteLength, 0);
        const remainingBytes = Math.max(0, totalBytes - this.completedBytes);
        const etaSeconds = bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : 0;
        this.onProgress(formatDriveV2PushProgress({
            stage: 'upload',
            completedPacks: this.completedPacks,
            totalPacks: this.expected.length,
            bytesPerSecond,
            etaSeconds,
        }));
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
        options.resumeSessions,
        options.onPausedPack,
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
    queue.markTotalKnown();
    await queue.drain();

    options.onProgress?.(`Verifying ${queue.getExpected().length} pack(s)…`);
    const verifyStartedAt = now();
    await options.runtime.store.verifyPacks(queue.getExpected());
    const verifyFinishedAt = now();
    options.signal?.throwIfAborted();

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

class DriveV2PushControllerImpl implements DriveV2PushController {
    private abortController = new AbortController();
    private readonly paused = new Map<string, { pack: EncryptedPack; error: DriveUploadPausedError }>();
    private running: Promise<DriveV2PushResult> | null = null;
    private cancelled = false;
    private lastResult: DriveV2PushResult | null = null;

    constructor(private readonly options: DriveV2PushOptions) {
        options.signal?.addEventListener('abort', () => this.cancel(), { once: true });
    }

    run(): Promise<DriveV2PushResult> {
        if (this.cancelled) return Promise.reject(new DOMException('Push cancelled', 'AbortError'));
        if (this.running) return this.running;
        this.running = this.execute().finally(() => { this.running = null; });
        return this.running;
    }

    private execute(): Promise<DriveV2PushResult> {
        return runDriveV2FullPush({
            ...this.options,
            signal: this.abortController.signal,
            onPausedPack: (pack, error) => {
                this.paused.set(pack.name, { pack, error });
                this.options.onPausedPack?.(pack, error);
            },
        }).then(result => {
            this.lastResult = result;
            return result;
        });
    }

    pause(): void {
        if (!this.abortController.signal.aborted) {
            this.abortController.abort(new DOMException('Push paused', 'AbortError'));
        }
    }

    async resume(): Promise<void> {
        if (this.cancelled) throw new DOMException('Push cancelled', 'AbortError');
        if (this.running) throw new Error('Drive v2 Push is already running');
        this.abortController = new AbortController();

        for (const [name, state] of [...this.paused]) {
            try {
                await this.options.runtime.store.putPack(state.pack, {
                    signal: this.abortController.signal,
                    resume: {
                        sessionUrl: state.error.sessionUrl,
                        acknowledgedBytes: state.error.acknowledgedBytes,
                    },
                });
                this.paused.delete(name);
            } catch (error) {
                if (error instanceof DriveUploadPausedError) {
                    this.paused.set(name, { pack: state.pack, error });
                }
                throw error;
            }
        }

        await this.run();
    }

    cancel(): void {
        this.cancelled = true;
        if (!this.abortController.signal.aborted) {
            this.abortController.abort(new DOMException('Push cancelled', 'AbortError'));
        }
        this.paused.clear();
    }

    getLastResult(): DriveV2PushResult | null {
        return this.lastResult;
    }
}

export function createDriveV2PushController(options: DriveV2PushOptions): DriveV2PushController {
    return new DriveV2PushControllerImpl(options);
}

export function driveV2ControllerResult(controller: DriveV2PushController): DriveV2PushResult | null {
    return controller instanceof DriveV2PushControllerImpl ? controller.getLastResult() : null;
}
