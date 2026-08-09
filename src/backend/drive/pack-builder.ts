import type { SyncItem } from '../../sync-core/types';
import { MissingLocalBlobError } from '../../sync/push-batch';
import { sha256Hex } from '../../st-adapter/normalize';
import type { DrivePackCrypto } from './pack-crypto';
import {
    DRIVE_V2_CHUNK_BYTES,
    DRIVE_V2_PACK_BYTES,
    emptyDrivePackManifest,
    type DrivePackChunkRef,
    type DrivePackItemV2,
    type DrivePackManifestV2,
    type EncryptedPack,
} from './pack-types';

export interface BuildDrivePacksOptions {
    device: string;
    items: readonly SyncItem[];
    chunkBytes?: number;
    packBytes?: number;
    load(hash: string): Promise<Uint8Array | null>;
    crypto: DrivePackCrypto;
    emit(pack: EncryptedPack): Promise<void>;
    onProgress?(packedItems: number, totalItems: number): void;
}

interface PendingChunk {
    chunkHash: string;
    plainLength: number;
    boxedLength: number;
    ref: DrivePackChunkRef;
}

class PackWriter {
    private parts: Uint8Array[] = [];
    private chunks: PendingChunk[] = [];
    private byteLength = 0;

    constructor(
        private readonly packBytes: number,
        private readonly crypto: DrivePackCrypto,
        private readonly emit: (pack: EncryptedPack) => Promise<void>,
    ) {
        if (!Number.isSafeInteger(packBytes) || packBytes <= 0) {
            throw new RangeError('packBytes must be a positive safe integer');
        }
    }

    async appendItem(item: SyncItem, plain: Uint8Array, chunkBytes: number): Promise<DrivePackItemV2> {
        if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
            throw new RangeError('chunkBytes must be a positive safe integer');
        }

        const refs: DrivePackChunkRef[] = [];
        for (let offset = 0; offset < plain.byteLength; offset += chunkBytes) {
            const chunk = plain.subarray(offset, Math.min(offset + chunkBytes, plain.byteLength));
            const chunkHash = await sha256Hex(chunk);
            const boxed = await this.crypto.encryptChunk(chunk);
            if (boxed.byteLength > this.packBytes) {
                throw new RangeError(`encrypted chunk exceeds pack size: ${boxed.byteLength} > ${this.packBytes}`);
            }
            if (this.byteLength > 0 && this.byteLength + boxed.byteLength > this.packBytes) {
                await this.flush();
            }

            const ref: DrivePackChunkRef = {
                packName: '',
                offset: this.byteLength,
                boxedLength: boxed.byteLength,
                plainLength: chunk.byteLength,
                chunkHash,
            };
            this.parts.push(boxed);
            this.chunks.push({
                chunkHash,
                plainLength: chunk.byteLength,
                boxedLength: boxed.byteLength,
                ref,
            });
            this.byteLength += boxed.byteLength;
            refs.push(ref);
        }

        return {
            id: item.id,
            type: item.type,
            hash: item.hash,
            size: item.size,
            mtime: item.mtime,
            chunks: refs,
        };
    }

    async flush(): Promise<void> {
        if (this.byteLength === 0) return;

        const parts = this.parts;
        const chunks = this.chunks;
        const totalBytes = this.byteLength;
        this.parts = [];
        this.chunks = [];
        this.byteLength = 0;

        const name = await this.crypto.packName(chunks.map(chunk => ({
            chunkHash: chunk.chunkHash,
            plainLength: chunk.plainLength,
        })));
        const bytes = new Uint8Array(totalBytes);
        let offset = 0;
        for (const part of parts) {
            bytes.set(part, offset);
            offset += part.byteLength;
        }
        for (const chunk of chunks) chunk.ref.packName = name;

        await this.emit({
            name,
            bytes,
            chunks: chunks.map(chunk => ({
                chunkHash: chunk.chunkHash,
                plainLength: chunk.plainLength,
                boxedLength: chunk.boxedLength,
            })),
        });
    }
}

export async function buildDrivePacks(options: BuildDrivePacksOptions): Promise<DrivePackManifestV2> {
    const chunkBytes = options.chunkBytes ?? DRIVE_V2_CHUNK_BYTES;
    const packBytes = options.packBytes ?? DRIVE_V2_PACK_BYTES;
    const items = [...options.items].sort((a, b) => a.id.localeCompare(b.id));
    const manifest = emptyDrivePackManifest(options.device, chunkBytes, packBytes);
    const writer = new PackWriter(packBytes, options.crypto, options.emit);

    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const plain = await options.load(item.hash);
        if (!plain) throw new MissingLocalBlobError(item.id, item.hash);
        manifest.items[item.id] = await writer.appendItem(item, plain, chunkBytes);
        options.onProgress?.(index + 1, items.length);
    }

    await writer.flush();
    return manifest;
}
