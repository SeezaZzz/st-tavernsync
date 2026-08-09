import { describe, expect, it } from 'vitest';

import { deriveDrivePackSubkeys } from '../../../crypto/subkeys';
import { makeDrivePackCrypto } from '../pack-crypto';
import {
    DRIVE_V2_CHUNK_BYTES,
    DRIVE_V2_PACK_BYTES,
    type DrivePackManifestV2,
} from '../pack-types';

async function digestHex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function makeKeys() {
    return deriveDrivePackSubkeys(new Uint8Array(32).fill(7), 'root-v2');
}

function manifestFixture(id: string): DrivePackManifestV2 {
    return {
        schema: 2,
        storage: 'drive-pack-v2',
        device: 'pc',
        updatedAt: 123,
        chunkBytes: DRIVE_V2_CHUNK_BYTES,
        packBytes: DRIVE_V2_PACK_BYTES,
        items: {
            [id]: {
                id,
                type: 'character',
                hash: 'item-hash',
                size: 21,
                mtime: 456,
                chunks: [{
                    packName: 'pack-a',
                    offset: 0,
                    boxedLength: 49,
                    plainLength: 21,
                    chunkHash: 'chunk-hash',
                }],
            },
        },
    };
}

describe('Drive pack crypto', () => {
    it('derives isolated v2 keys and seals chunks with random IVs', async () => {
        const crypto = makeDrivePackCrypto(await makeKeys());
        const plain = new TextEncoder().encode('secret-character-data');
        const first = await crypto.encryptChunk(plain);
        const second = await crypto.encryptChunk(plain);
        expect(first).not.toEqual(second);
        await expect(crypto.decryptChunk(first)).resolves.toEqual(plain);
        expect(await crypto.packName([{ chunkHash: await digestHex(plain), plainLength: plain.length }]))
            .toMatch(/^[0-9a-f]{64}$/);
    });

    it('encrypts schema 2 manifest without plaintext identifiers', async () => {
        const crypto = makeDrivePackCrypto(await makeKeys());
        const manifest = manifestFixture('character/private.png');
        const boxed = await crypto.encryptManifest(manifest);
        expect(new TextDecoder().decode(boxed)).not.toContain('private.png');
        await expect(crypto.decryptManifest(boxed)).resolves.toEqual(manifest);
    });
});
