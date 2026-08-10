import { describe, expect, it } from 'vitest';

import type { ItemType } from '../../../sync-core/types';
import { sha256Hex } from '../../../st-adapter/normalize';
import { ByteBudget } from '../byte-budget';
import type { DrivePackItemV2 } from '../pack-types';
import { readVerifiedItem } from '../verified-item-reader';

async function packedItem(id: string, parts: Uint8Array[]): Promise<DrivePackItemV2> {
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    const chunks = [];
    for (const part of parts) {
        bytes.set(part, offset);
        chunks.push({
            packName: 'pack-a',
            offset,
            boxedLength: part.byteLength,
            plainLength: part.byteLength,
            chunkHash: await sha256Hex(part),
        });
        offset += part.byteLength;
    }
    return {
        id,
        type: id.split('/')[0] as ItemType,
        size: bytes.byteLength,
        hash: await sha256Hex(bytes),
        mtime: 1,
        chunks,
    };
}

describe('readVerifiedItem', () => {
    it('range-reads, decrypts, and verifies one item without retaining encrypted chunks', async () => {
        const parts = [new TextEncoder().encode('hello '), new TextEncoder().encode('world')];
        const item = await packedItem('chat/a/one', parts);
        const encrypted = new ByteBudget(64);
        const plaintext = new ByteBudget(64);
        let read = 0;

        const prepared = await readVerifiedItem({
            item,
            source: { readChunk: async () => parts[read++].slice() },
            crypto: { decryptChunk: async bytes => bytes },
            encryptedBudget: encrypted,
            plaintextBudget: plaintext,
        });

        expect(new TextDecoder().decode(prepared.bytes)).toBe('hello world');
        expect(encrypted.usedBytes).toBe(0);
        expect(plaintext.usedBytes).toBe(11);
        prepared.release();
        expect(plaintext.usedBytes).toBe(0);
        expect(prepared.bytes).toEqual(new Uint8Array(11));
    });

    it('zeros and releases plaintext after item hash failure', async () => {
        const item = await packedItem('chat/a/bad', [new Uint8Array([1, 2])]);
        item.hash = '0'.repeat(64);
        const plaintext = new ByteBudget(64);

        await expect(readVerifiedItem({
            item,
            source: { readChunk: async () => new Uint8Array([1, 2]) },
            crypto: { decryptChunk: async bytes => bytes },
            encryptedBudget: new ByteBudget(64),
            plaintextBudget: plaintext,
        })).rejects.toThrow(/item hash/i);

        expect(plaintext.usedBytes).toBe(0);
    });

    it('releases both budgets after a chunk hash failure', async () => {
        const item = await packedItem('chat/a/bad-chunk', [new Uint8Array([1, 2])]);
        item.chunks[0].chunkHash = 'f'.repeat(64);
        const encrypted = new ByteBudget(64);
        const plaintext = new ByteBudget(64);

        await expect(readVerifiedItem({
            item,
            source: { readChunk: async () => new Uint8Array([1, 2]) },
            crypto: { decryptChunk: async bytes => bytes },
            encryptedBudget: encrypted,
            plaintextBudget: plaintext,
        })).rejects.toThrow(/chunk hash/i);

        expect(encrypted.usedBytes).toBe(0);
        expect(plaintext.usedBytes).toBe(0);
    });
});
