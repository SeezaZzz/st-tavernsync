import { expect, it } from 'vitest';

import { buildRestoreBatches, type RestorePlainSegment } from '../batch-builder';

async function* segments(count: number, bytes: number, owned: Uint8Array[]): AsyncGenerator<RestorePlainSegment> {
    for (let index = 0; index < count; index++) {
        const value = new Uint8Array(bytes).fill(index + 1);
        owned.push(value);
        yield {
            itemId: `groupchat/${index}`,
            itemType: 'groupchat',
            index: 0,
            hash: index.toString(16).padStart(64, '0'),
            bytes: value,
        };
    }
}

it('packs at most eight segments and releases owned plaintext buffers', async () => {
    const batches = [];
    const owned: Uint8Array[] = [];
    for await (const batch of buildRestoreBatches(segments(17, 4, owned), {
        maxBatchBytes: 32,
        maxBatchSegments: 8,
    })) {
        batches.push(batch);
        expect(batch.plaintextBytes).toBeLessThanOrEqual(32);
        expect(batch.metadata.segments.length).toBeLessThanOrEqual(8);
        batch.release();
    }
    expect(batches).toHaveLength(3);
    expect(owned.every(bytes => bytes.every(value => value === 0))).toBe(true);
});
