import { sha256Hex } from '../../st-adapter/normalize';
import type { DrivePackCrypto } from './pack-crypto';
import type { DrivePackItemV2 } from './pack-types';
import { withPullStage } from './pull-stage-error';

export interface DriveV2PackSource {
    readPack(name: string): Promise<Uint8Array>;
}

interface CachedPack {
    readonly bytes: Uint8Array;
    users: number;
}

export class DriveV2PackReader {
    private readonly cache = new Map<string, CachedPack>();
    private readonly inFlight = new Map<string, Promise<CachedPack>>();
    private readonly pendingUsers = new Map<string, number>();
    private readonly slotWaiters = new Set<() => void>();
    private downloadedPackCount = 0;
    private packDownloadRequestCount = 0;
    private peakCachedPacks = 0;
    private peakCachedBytes = 0;

    constructor(
        private readonly source: DriveV2PackSource,
        private readonly crypto: Pick<DrivePackCrypto, 'decryptChunk'>,
        private readonly maxCachedPacks = 2,
    ) {
        if (!Number.isSafeInteger(maxCachedPacks) || maxCachedPacks < 1) {
            throw new RangeError('maxCachedPacks must be at least one');
        }
    }

    async readItem(item: DrivePackItemV2): Promise<Uint8Array> {
        const output = new Uint8Array(item.size);
        let written = 0;

        try {
            for (const ref of item.chunks) {
                const pack = await this.acquirePack(ref.packName);
                let plain: Uint8Array | null = null;
                try {
                const end = ref.offset + ref.boxedLength;
                if (
                    !Number.isSafeInteger(ref.offset)
                    || !Number.isSafeInteger(ref.boxedLength)
                    || ref.offset < 0
                    || ref.boxedLength < 0
                    || end > pack.bytes.byteLength
                ) {
                    throw new RangeError('chunk range outside pack');
                }

                plain = await withPullStage(
                    'decrypt', 'LOCAL', `pack://${ref.packName}`,
                    () => this.crypto.decryptChunk(pack.bytes.subarray(ref.offset, end)),
                );
                if (
                    plain.byteLength !== ref.plainLength
                    || await sha256Hex(plain) !== ref.chunkHash
                ) {
                    throw new Error('chunk hash mismatch');
                }
                if (written + plain.byteLength > output.byteLength) {
                    throw new Error('item hash mismatch');
                }
                output.set(plain, written);
                written += plain.byteLength;
                } finally {
                    if (plain && plain.buffer !== pack.bytes.buffer) plain.fill(0);
                    this.releasePack(pack);
                }
            }

            if (written !== item.size || await sha256Hex(output) !== item.hash) {
                throw new Error('item hash mismatch');
            }
            return output;
        } catch (error) {
            output.fill(0);
            throw error;
        }
    }

    getDownloadedPackCount(): number {
        return this.downloadedPackCount;
    }

    getPackDownloadRequestCount(): number {
        return this.packDownloadRequestCount;
    }

    getPeakCachedPacks(): number {
        return this.peakCachedPacks;
    }

    getPeakCachedBytes(): number {
        return this.peakCachedBytes;
    }

    private async acquirePack(name: string): Promise<CachedPack> {
        for (;;) {
            const cached = this.cache.get(name);
            if (cached) {
                cached.users += 1;
                this.cache.delete(name);
                this.cache.set(name, cached);
                return cached;
            }

            const running = this.inFlight.get(name);
            if (running) {
                this.pendingUsers.set(name, (this.pendingUsers.get(name) ?? 0) + 1);
                return running;
            }

            if (this.cache.size + this.inFlight.size >= this.maxCachedPacks) {
                if (this.evictOneIdlePack()) continue;
                await this.waitForSlot();
                continue;
            }

            this.pendingUsers.set(name, 1);
            const download = this.downloadPack(name).then(bytes => {
                const pack: CachedPack = {
                    bytes,
                    users: this.pendingUsers.get(name) ?? 1,
                };
                this.pendingUsers.delete(name);
                this.downloadedPackCount += 1;
                this.cache.set(name, pack);
                this.peakCachedPacks = Math.max(this.peakCachedPacks, this.cache.size);
                const cachedBytes = [...this.cache.values()]
                    .reduce((total, value) => total + value.bytes.byteLength, 0);
                this.peakCachedBytes = Math.max(this.peakCachedBytes, cachedBytes);
                return pack;
            }).finally(() => {
                this.pendingUsers.delete(name);
                this.inFlight.delete(name);
                this.notifySlotWaiters();
            });
            this.inFlight.set(name, download);
            return download;
        }
    }

    private releasePack(pack: CachedPack): void {
        pack.users = Math.max(0, pack.users - 1);
        this.notifySlotWaiters();
    }

    private evictOneIdlePack(): boolean {
        for (const [name, pack] of this.cache) {
            if (pack.users > 0) continue;
            this.cache.delete(name);
            pack.bytes.fill(0);
            return true;
        }
        return false;
    }

    private waitForSlot(): Promise<void> {
        return new Promise(resolve => {
            this.slotWaiters.add(resolve);
        });
    }

    private notifySlotWaiters(): void {
        const waiters = [...this.slotWaiters];
        this.slotWaiters.clear();
        for (const resolve of waiters) resolve();
    }

    private async downloadPack(name: string): Promise<Uint8Array> {
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            this.packDownloadRequestCount += 1;
            try {
                return await withPullStage(
                    'pack-download', 'GET', `drive-pack://${name}`,
                    () => this.source.readPack(name),
                );
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError;
    }
}
