import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../../../st-adapter/normalize';
import type { DrivePackCrypto } from '../pack-crypto';
import { DriveV2PackReader } from '../pack-reader';
import type { DrivePackItemV2 } from '../pack-types';

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
    const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
}

function sourceFixture(packs: Record<string, Uint8Array>) {
    const reads = new Map<string, number>();
    return {
        reads,
        async readPack(name: string): Promise<Uint8Array> {
            reads.set(name, (reads.get(name) ?? 0) + 1);
            const pack = packs[name];
            if (!pack) throw new Error(`missing pack: ${name}`);
            return pack;
        },
    };
}

function cryptoStub(): DrivePackCrypto {
    return {
        async encryptChunk(value) { return value; },
        async decryptChunk(value) { return value; },
        async packName() { return 'unused'; },
        async encryptManifest() { return new Uint8Array(); },
        async decryptManifest() { throw new Error('not used'); },
    };
}

async function itemFixture(
    id: string,
    chunks: Array<{ packName: string; offset: number; bytes: Uint8Array }>,
): Promise<DrivePackItemV2> {
    const plain = concatBytes(chunks.map(chunk => chunk.bytes));
    return {
        id,
        type: 'chat',
        size: plain.byteLength,
        mtime: 1,
        hash: await sha256Hex(plain),
        chunks: await Promise.all(chunks.map(async chunk => ({
            packName: chunk.packName,
            offset: chunk.offset,
            boxedLength: chunk.bytes.byteLength,
            plainLength: chunk.bytes.byteLength,
            chunkHash: await sha256Hex(chunk.bytes),
        }))),
    };
}

describe('Drive v2 pack reader', () => {
    it('never retains more than two packs and reuses a shared pack', async () => {
        const source = sourceFixture({
            'pack-a': new Uint8Array([1]),
            'pack-b': new Uint8Array([2]),
            'pack-c': new Uint8Array([3]),
        });
        const reader = new DriveV2PackReader(source, cryptoStub(), 2);
        await reader.readItem(await itemFixture('one', [
            { packName: 'pack-a', offset: 0, bytes: new Uint8Array([1]) },
            { packName: 'pack-b', offset: 0, bytes: new Uint8Array([2]) },
        ]));
        await reader.readItem(await itemFixture('two', [
            { packName: 'pack-b', offset: 0, bytes: new Uint8Array([2]) },
            { packName: 'pack-c', offset: 0, bytes: new Uint8Array([3]) },
        ]));
        expect(reader.getPeakCachedPacks()).toBe(2);
        expect(reader.getDownloadedPackCount()).toBe(3);
        expect(source.reads.get('pack-b')).toBe(1);
    });

    it('rejects an out-of-bounds chunk before decrypting', async () => {
        const reader = new DriveV2PackReader(sourceFixture({ p: new Uint8Array(8) }), cryptoStub(), 2);
        const item = await itemFixture('bad-range', [
            { packName: 'p', offset: 7, bytes: new Uint8Array(4) },
        ]);
        await expect(reader.readItem(item)).rejects.toThrow('chunk range outside pack');
    });

    it('rejects bad chunk and complete-item hashes', async () => {
        const source = sourceFixture({ p: new Uint8Array([1]) });
        const good = await itemFixture('bad-hash', [
            { packName: 'p', offset: 0, bytes: new Uint8Array([1]) },
        ]);
        const reader = new DriveV2PackReader(source, cryptoStub(), 2);
        await expect(reader.readItem({
            ...good,
            chunks: [{ ...good.chunks[0], chunkHash: 'wrong' }],
        })).rejects.toThrow('chunk hash mismatch');
        await expect(reader.readItem({ ...good, hash: 'wrong' })).rejects.toThrow('item hash mismatch');
    });
});
