import { describe, expect, it } from 'vitest';

import { runDriveV2Pull } from '../drive-v2-pull';
import { createAdaptivePullHarness } from './adaptive-pull-harness';

describe('extension-only adaptive Pull integration', () => {
    it.each([
        'network-loss',
        'http-408',
        'http-429',
        'http-500',
        'wrong-passphrase',
        'chunk-hash',
        'item-hash',
        'apply-failure',
        'cancel',
    ] as const)('preserves checkpoint, skips deletion, and does not advance base after %s', async fault => {
        const ids = Array.from({ length: 2_347 }, (_, index) => `preset/${index}`);
        const h = await createAdaptivePullHarness({
            remote: ids,
            local: ['preset/old'],
            fault,
        });

        await expect(runDriveV2Pull(h.options)).rejects.toBeDefined();

        expect(h.deletedIds).toEqual([]);
        expect(h.savedBase).toBeNull();
        expect(h.checkpointState).not.toBeNull();
    });

    it('restores 2347 items with exact inventory and bounded peak bytes', async () => {
        const ids = Array.from({ length: 2_347 }, (_, index) => `preset/${index}`);
        const h = await createAdaptivePullHarness({ remote: ids, local: ['preset/old'] });

        const result = await runDriveV2Pull(h.options);

        expect(h.inventory()).toEqual(h.remoteInventory());
        expect(result.peakEncryptedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
        expect(result.peakPlaintextBytes).toBeLessThanOrEqual(48 * 1024 * 1024);
        expect(result.maxActiveWriters).toBeGreaterThan(4);
        expect(h.checkpointState).toBeNull();
    });

    it('downloads a 30-pack snapshot with exactly 30 successful media requests', async () => {
        const ids = Array.from({ length: 2_347 }, (_, index) => `preset/${index}`);
        const h = await createAdaptivePullHarness({
            remote: ids,
            packCount: 30,
        });

        const result = await runDriveV2Pull(h.options);

        expect(h.inventory()).toEqual(h.remoteInventory());
        expect(h.packReads).toBe(30);
        expect(result.downloadedPacks).toBe(30);
        expect(result.packDownloadRequests).toBe(30);
    });

    it('downloads interleaved items once per pack with a two-pack RAM cache', async () => {
        const ids = Array.from({ length: 90 }, (_, index) => `preset/${index}`);
        const packNames = ids.map((_, index) => `pack-${index % 3}`);
        const h = await createAdaptivePullHarness({ remote: ids, packNames });

        const result = await runDriveV2Pull(h.options);

        expect(h.inventory()).toEqual(h.remoteInventory());
        expect(h.packReads).toBe(3);
        expect(result.packDownloadRequests).toBe(3);
        expect(result.peakEncryptedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    });

    it('uses one verified range read per mobile item when dependencies span hashed packs', async () => {
        // Given: character/chat pairs are distributed differently across hashed pack names.
        const packCount = 8;
        const chats = Array.from({ length: 40 }, (_, index) => `chat/char-${index}.png/day`);
        const assets = Array.from({ length: 40 }, (_, index) => `characterasset/char-${index}/sprite.png`);
        const states = Array.from({ length: 40 }, (_, index) => `characterstate/char-${index}.png`);
        const characters = Array.from({ length: 40 }, (_, index) => `character/char-${index}.png`);
        const h = await createAdaptivePullHarness({
            remote: [...chats, ...assets, ...states, ...characters],
            packNames: [
                ...chats.map((_, index) => `pack-${(index * 3 + 1) % packCount}`),
                ...assets.map((_, index) => `pack-${(index * 7 + 2) % packCount}`),
                ...states.map((_, index) => `pack-${(index * 5 + 3) % packCount}`),
                ...characters.map((_, index) => `pack-${(index * 5 + 4) % packCount}`),
            ],
            packReadDelayMs: 1,
        });

        // When: the snapshot is restored through the Mobile range path.
        const result = await runDriveV2Pull({ ...h.options, profile: 'mobile' });

        // Then: Mobile never downloads a full pack and touches every required range once.
        expect(h.inventory()).toEqual(h.remoteInventory());
        expect(h.packReads).toBe(0);
        expect(h.chunkReads).toBe(160);
        expect(result.downloadedPacks).toBe(packCount);
        expect(result.packDownloadRequests).toBe(160);
    });

    it('reports five-run adaptive Pull benchmark evidence', async () => {
        const runs: Array<{
            elapsedMs: number;
            itemsPerSecond: number;
            maxWriters: number;
            peakEncryptedBytes: number;
            peakPlaintextBytes: number;
        }> = [];

        for (let run = 0; run < 5; run++) {
            const ids = Array.from({ length: 2_347 }, (_, index) => `preset/${index}`);
            const h = await createAdaptivePullHarness({ remote: ids });
            const result = await runDriveV2Pull(h.options);
            runs.push({
                elapsedMs: result.elapsedMs,
                itemsPerSecond: result.applied / Math.max(0.001, result.elapsedMs / 1_000),
                maxWriters: result.maxActiveWriters,
                peakEncryptedBytes: result.peakEncryptedBytes,
                peakPlaintextBytes: result.peakPlaintextBytes,
            });
        }

        const sorted = runs.map(value => value.elapsedMs).sort((left, right) => left - right);
        console.info('[TavernSync benchmark]', JSON.stringify({
            medianElapsedMs: sorted[2],
            runs,
        }));
        expect(runs.every(value => value.maxWriters > 4)).toBe(true);
    }, 30_000);
});
