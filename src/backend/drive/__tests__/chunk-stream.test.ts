import { expect, it } from 'vitest';

import { sha256Hex } from '../../../st-adapter/normalize';
import { streamRestoreSegments } from '../chunk-stream';
import type { DrivePackManifestV2 } from '../pack-types';

it('yields verified segments in manifest item and chunk order without whole-pack reads', async () => {
    const chunks = [
        new TextEncoder().encode('one-'),
        new TextEncoder().encode('first'),
        new TextEncoder().encode('second'),
    ];
    const first = new Uint8Array([...chunks[0], ...chunks[1]]);
    const manifest: DrivePackManifestV2 = {
        schema: 2,
        storage: 'drive-pack-v2',
        device: 'pc',
        updatedAt: 1,
        chunkBytes: 1_048_576,
        packBytes: 33_554_432,
        items: {
            first: {
                id: 'groupchat/first', type: 'groupchat', size: first.length,
                hash: await sha256Hex(first), mtime: 1,
                chunks: [
                    { packName: 'p', offset: 0, boxedLength: 4, plainLength: 4, chunkHash: await sha256Hex(chunks[0]) },
                    { packName: 'p', offset: 4, boxedLength: 5, plainLength: 5, chunkHash: await sha256Hex(chunks[1]) },
                ],
            },
            second: {
                id: 'groupchat/second', type: 'groupchat', size: chunks[2].length,
                hash: await sha256Hex(chunks[2]), mtime: 1,
                chunks: [{ packName: 'p', offset: 9, boxedLength: 6, plainLength: 6, chunkHash: await sha256Hex(chunks[2]) }],
            },
        },
    };
    let read = 0;
    const values = [];
    for await (const segment of streamRestoreSegments({
        manifest,
        source: { readChunk: async () => chunks[read++].slice() },
        crypto: { decryptChunk: async value => value },
    })) {
        values.push([segment.itemId, segment.index, segment.bytes.byteLength]);
    }

    expect(values).toEqual([
        ['groupchat/first', 0, 4],
        ['groupchat/first', 1, 5],
        ['groupchat/second', 0, 6],
    ]);
});

it('rejects a correct chunk with the wrong final item hash', async () => {
    const bytes = new Uint8Array([1, 2]);
    const manifest: DrivePackManifestV2 = {
        schema: 2, storage: 'drive-pack-v2', device: 'pc', updatedAt: 1,
        chunkBytes: 1_048_576, packBytes: 33_554_432,
        items: { a: {
            id: 'groupchat/a', type: 'groupchat', size: 2, hash: '0'.repeat(64), mtime: 1,
            chunks: [{ packName: 'p', offset: 0, boxedLength: 2, plainLength: 2, chunkHash: await sha256Hex(bytes) }],
        } },
    };

    const consume = async () => {
        for await (const _segment of streamRestoreSegments({
            manifest,
            source: { readChunk: async () => bytes },
            crypto: { decryptChunk: async value => value },
        })) { /* consume */ }
    };
    await expect(consume()).rejects.toThrow(/item hash/i);
});
