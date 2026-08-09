import { sha256Hex } from '../../st-adapter/normalize';
import type { DrivePackCrypto } from './pack-crypto';
import type { DrivePackItemV2 } from './pack-types';

export interface DriveV2PackSource {
    readPack(name: string): Promise<Uint8Array>;
}

export class DriveV2PackReader {
    private readonly cache = new Map<string, Uint8Array>();
    private downloadedPackCount = 0;
    private peakCachedPacks = 0;
    private peakCachedBytes = 0;

    constructor(
        private readonly source: DriveV2PackSource,
        private readonly crypto: DrivePackCrypto,
        private readonly maxCachedPacks = 2,
    ) {
        if (!Number.isSafeInteger(maxCachedPacks) || maxCachedPacks < 1) {
            throw new RangeError('maxCachedPacks must be at least one');
        }
    }

    async readItem(item: DrivePackItemV2): Promise<Uint8Array> {
        const output = new Uint8Array(item.size);
        let written = 0;

        for (const ref of item.chunks) {
            const pack = await this.getPack(ref.packName);
            const end = ref.offset + ref.boxedLength;
            if (
                !Number.isSafeInteger(ref.offset)
                || !Number.isSafeInteger(ref.boxedLength)
                || ref.offset < 0
                || ref.boxedLength < 0
                || end > pack.byteLength
            ) {
                throw new RangeError('chunk range outside pack');
            }

            const plain = await this.crypto.decryptChunk(pack.subarray(ref.offset, end));
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
        }

        if (written !== item.size || await sha256Hex(output) !== item.hash) {
            throw new Error('item hash mismatch');
        }
        return output;
    }

    getDownloadedPackCount(): number {
        return this.downloadedPackCount;
    }

    getPeakCachedPacks(): number {
        return this.peakCachedPacks;
    }

    getPeakCachedBytes(): number {
        return this.peakCachedBytes;
    }

    private async getPack(name: string): Promise<Uint8Array> {
        const cached = this.cache.get(name);
        if (cached) {
            this.cache.delete(name);
            this.cache.set(name, cached);
            return cached;
        }

        while (this.cache.size >= this.maxCachedPacks) {
            const oldest = this.cache.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.cache.delete(oldest);
        }

        const pack = await this.source.readPack(name);
        this.downloadedPackCount += 1;
        this.cache.set(name, pack);
        this.peakCachedPacks = Math.max(this.peakCachedPacks, this.cache.size);
        const cachedBytes = [...this.cache.values()]
            .reduce((total, value) => total + value.byteLength, 0);
        this.peakCachedBytes = Math.max(this.peakCachedBytes, cachedBytes);
        return pack;
    }
}
