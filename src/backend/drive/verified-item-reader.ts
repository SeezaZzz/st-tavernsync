import { sha256Hex } from '../../st-adapter/normalize';
import { ByteBudget } from './byte-budget';
import type { DrivePackCrypto } from './pack-crypto';
import type { DrivePackItemV2 } from './pack-types';
import type { DriveRangeSource } from './range-source';

export interface PreparedDriveItem {
    readonly item: DrivePackItemV2;
    readonly bytes: Uint8Array;
    release(): void;
}

export async function readVerifiedItem(options: {
    item: DrivePackItemV2;
    source: Pick<DriveRangeSource, 'readChunk'>;
    crypto: Pick<DrivePackCrypto, 'decryptChunk'>;
    encryptedBudget: ByteBudget;
    plaintextBudget: ByteBudget;
    signal?: AbortSignal;
}): Promise<PreparedDriveItem> {
    const plainPermit = await options.plaintextBudget.acquire(
        Math.max(1, options.item.size),
        options.signal,
    );
    const output = new Uint8Array(options.item.size);
    let outputOffset = 0;

    try {
        for (const ref of options.item.chunks) {
            options.signal?.throwIfAborted();
            const encryptedPermit = await options.encryptedBudget.acquire(ref.boxedLength, options.signal);
            let boxed: Uint8Array | null = null;
            try {
                boxed = await options.source.readChunk(ref, options.signal);
                if (boxed.byteLength !== ref.boxedLength) {
                    throw new Error(`encrypted chunk size mismatch for ${options.item.id}`);
                }
                const plain = await options.crypto.decryptChunk(boxed);
                try {
                    if (plain.byteLength !== ref.plainLength
                        || await sha256Hex(plain) !== ref.chunkHash) {
                        throw new Error(`chunk hash mismatch for ${options.item.id}`);
                    }
                    output.set(plain, outputOffset);
                    outputOffset += plain.byteLength;
                } finally {
                    plain.fill(0);
                }
            } finally {
                boxed?.fill(0);
                encryptedPermit.release();
            }
        }

        if (outputOffset !== options.item.size
            || await sha256Hex(output) !== options.item.hash) {
            throw new Error(`item hash mismatch for ${options.item.id}`);
        }

        let released = false;
        return {
            item: options.item,
            bytes: output,
            release: () => {
                if (released) return;
                released = true;
                output.fill(0);
                plainPermit.release();
            },
        };
    } catch (error) {
        output.fill(0);
        plainPermit.release();
        throw error;
    }
}
