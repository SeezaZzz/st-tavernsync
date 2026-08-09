import { open, seal } from '../../crypto';
import { hmacNameFor, type DrivePackSubkeys } from '../../crypto/subkeys';
import type { DrivePackManifestV2 } from './pack-types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface DrivePackCrypto {
    encryptChunk(plain: Uint8Array): Promise<Uint8Array>;
    decryptChunk(boxed: Uint8Array): Promise<Uint8Array>;
    packName(entries: readonly { chunkHash: string; plainLength: number }[]): Promise<string>;
    encryptManifest(manifest: DrivePackManifestV2): Promise<Uint8Array>;
    decryptManifest(boxed: Uint8Array): Promise<DrivePackManifestV2>;
}

function assertManifest(value: unknown): asserts value is DrivePackManifestV2 {
    if (!value || typeof value !== 'object') throw new TypeError('Drive v2 manifest is not an object');
    const candidate = value as Partial<DrivePackManifestV2>;
    if (candidate.schema !== 2 || candidate.storage !== 'drive-pack-v2' || !candidate.items) {
        throw new TypeError('Drive v2 manifest has an unsupported schema');
    }
}

export function makeDrivePackCrypto(subkeys: DrivePackSubkeys): DrivePackCrypto {
    return {
        encryptChunk: plain => seal(subkeys.chunkEnc, plain),
        decryptChunk: boxed => open(subkeys.chunkEnc, boxed),
        packName: entries => hmacNameFor(subkeys.packName, JSON.stringify(entries)),
        encryptManifest: manifest => seal(subkeys.manifestEnc, encoder.encode(JSON.stringify(manifest))),
        async decryptManifest(boxed) {
            const plain = await open(subkeys.manifestEnc, boxed);
            const parsed: unknown = JSON.parse(decoder.decode(plain));
            assertManifest(parsed);
            return parsed;
        },
    };
}
