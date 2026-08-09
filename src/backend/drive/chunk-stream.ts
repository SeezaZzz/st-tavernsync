import { Sha256Stream } from '../../crypto/sha256-stream';
import { sha256Hex } from '../../st-adapter/normalize';
import type { RestoreItemType } from '../restore-session/types';
import type { DrivePackCrypto } from './pack-crypto';
import type { DrivePackManifestV2 } from './pack-types';
import type { DriveChunkRange } from './range-source';

export interface RestoreSegment {
    readonly itemId: string;
    readonly itemType: RestoreItemType;
    readonly index: number;
    readonly hash: string;
    readonly bytes: Uint8Array;
}
interface ChunkSource {
    readChunk(ref: DriveChunkRange, signal?: AbortSignal): Promise<Uint8Array>;
}

interface StreamRestoreSegmentsOptions {
    readonly manifest: DrivePackManifestV2;
    readonly source: ChunkSource;
    readonly crypto: Pick<DrivePackCrypto, 'decryptChunk'>;
    readonly allowedTypes?: ReadonlySet<RestoreItemType>;
    readonly signal?: AbortSignal;
}

export async function* streamRestoreSegments(
    options: StreamRestoreSegmentsOptions,
): AsyncGenerator<RestoreSegment> {
    for (const item of Object.values(options.manifest.items)) {
        if (options.allowedTypes && !options.allowedTypes.has(item.type)) continue;
        const itemHash = new Sha256Stream();
        let itemBytes = 0;
        for (let index = 0; index < item.chunks.length; index++) {
            options.signal?.throwIfAborted();
            const ref = item.chunks[index];
            const boxed = await options.source.readChunk(ref, options.signal);
            const plain = await options.crypto.decryptChunk(boxed);
            if (plain.byteLength !== ref.plainLength || await sha256Hex(plain) !== ref.chunkHash) {
                plain.fill(0);
                throw new Error(`chunk hash mismatch for ${item.id}`);
            }
            itemHash.update(plain);
            itemBytes += plain.byteLength;
            yield {
                itemId: item.id,
                itemType: item.type,
                index,
                hash: ref.chunkHash,
                bytes: plain,
            };
        }
        if (itemBytes !== item.size || itemHash.hex() !== item.hash) {
            throw new Error(`item hash mismatch for ${item.id}`);
        }
    }
}
