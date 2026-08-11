import { describe, expect, it } from 'vitest';

import { runDriveV2Pull } from '../drive-v2-pull';
import { createAdaptivePullHarness } from './adaptive-pull-harness';

describe('Drive v2 extension-only Pull', () => {
    it('downloads one shared pack once for ten restored items', async () => {
        const h = await createAdaptivePullHarness({
            remote: Array.from({ length: 10 }, (_, index) => `preset/${index}`),
        });

        const result = await runDriveV2Pull(h.options);

        expect(h.packReads).toBe(1);
        expect(h.chunkReads).toBe(0);
        expect(result.packDownloadRequests).toBe(1);
    });

    it('reads only encrypted chunk ranges in the mobile profile', async () => {
        const h = await createAdaptivePullHarness({
            remote: Array.from({ length: 10 }, (_, index) => `preset/${index}`),
        });

        await runDriveV2Pull({ ...h.options, profile: 'mobile' });

        expect(h.packReads).toBe(0);
        expect(h.chunkReads).toBe(10);
    });

    it('does not download or write items whose local content hash already matches Drive', async () => {
        const h = await createAdaptivePullHarness({
            remote: ['preset/same', 'preset/changed'],
            local: ['preset/same', 'preset/changed'],
            inSync: ['preset/same'],
        });

        const result = await runDriveV2Pull(h.options);

        expect(h.events).not.toContain('apply:preset/same');
        expect(h.events).toContain('apply:preset/changed');
        expect(result.applied).toBe(1);
        expect(result.skippedInSync).toBe(1);
    });

    it('restores every remote item without local hashes and deletes inventory-only IDs last', async () => {
        const h = await createAdaptivePullHarness({
            remote: ['character/A.png', 'chat/A.png/new', 'preset/x'],
            local: ['character/A.png', 'chat/A.png/old'],
        });

        await runDriveV2Pull(h.options);

        expect(h.events).toContain('apply:character/A.png');
        expect(h.events).toContain('apply:chat/A.png/new');
        expect(h.events.indexOf('apply:character/A.png'))
            .toBeLessThan(h.events.indexOf('apply:chat/A.png/new'));
        expect(h.events.at(-3)).toBe('delete:chat/A.png/old');
        expect(h.events.at(-2)).toBe('save-base:head-b');
        expect(h.events.at(-1)).toBe('checkpoint-finish');
        expect(h.inventory()).toEqual(h.remoteInventory());
    });

    it('resumes completed IDs that still match locally and performs no delete or base advance after failure', async () => {
        const h = await createAdaptivePullHarness({
            remote: ['preset/done', 'preset/fails'],
            local: ['preset/done', 'preset/old'],
            inSync: ['preset/done'],
            completed: ['preset/done'],
            fail: 'preset/fails',
        });

        await expect(runDriveV2Pull(h.options)).rejects.toThrow('preset/fails');

        expect(h.events).not.toContain('read:preset/done');
        expect(h.events.some(value => value.startsWith('delete:'))).toBe(false);
        expect(h.events.some(value => value.startsWith('save-base:'))).toBe(false);
        expect(h.events).toContain('checkpoint-flush');
    });

    it('reapplies a stale checkpoint item when its local file is gone', async () => {
        const h = await createAdaptivePullHarness({
            remote: ['characterstate/Alan.png', 'character/Alan.png'],
            completed: ['character/Alan.png'],
        });

        await runDriveV2Pull(h.options);

        expect(h.events).toContain('apply:character/Alan.png');
        expect(h.events.indexOf('apply:character/Alan.png'))
            .toBeLessThan(h.events.indexOf('apply:characterstate/Alan.png'));
    });

    it('reapplies matching favorite state when its character card will be reimported', async () => {
        const h = await createAdaptivePullHarness({
            remote: ['characterstate/Alan.png', 'character/Alan.png'],
            local: ['characterstate/Alan.png', 'character/Alan.png'],
            inSync: ['characterstate/Alan.png'],
        });

        await runDriveV2Pull(h.options);

        expect(h.events).toContain('apply:character/Alan.png');
        expect(h.events).toContain('apply:characterstate/Alan.png');
        expect(h.events.indexOf('apply:character/Alan.png'))
            .toBeLessThan(h.events.indexOf('apply:characterstate/Alan.png'));
    });

    it('ignores TavernSync itself in legacy snapshots and local inventory', async () => {
        const h = await createAdaptivePullHarness({
            remote: ['extension/st-tavernsync', 'preset/x'],
            local: ['extension/st-tavernsync'],
        });
        const options = {
            ...h.options,
            verifyInventory: async () => new Map([
                ['extension/st-tavernsync', 'extension' as const],
                ['preset/x', 'preset' as const],
            ]),
        } as Parameters<typeof runDriveV2Pull>[0];

        const result = await runDriveV2Pull(options);

        expect(h.events).not.toContain('apply:extension/st-tavernsync');
        expect(h.events).not.toContain('delete:extension/st-tavernsync');
        expect(result.applied).toBe(1);
    });

    it('keeps plaintext and encrypted bytes within their configured budgets', async () => {
        const h = await createAdaptivePullHarness({
            remote: Array.from({ length: 32 }, (_, index) => `preset/${index}`),
        });

        const result = await runDriveV2Pull(h.options);

        expect(result.peakEncryptedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
        expect(result.peakPlaintextBytes).toBeLessThanOrEqual(48 * 1024 * 1024);
        expect(result.maxActiveWriters).toBeGreaterThan(4);
    });

    it('refuses to publish success when the post-restore inventory is incomplete', async () => {
        const h = await createAdaptivePullHarness({
            remote: ['character/A.png', 'chat/A.png/day-1'],
        });
        const options = {
            ...h.options,
            verifyInventory: async () => new Map([['character/A.png', 'character' as const]]),
        } as Parameters<typeof runDriveV2Pull>[0];

        await expect(runDriveV2Pull(options)).rejects.toThrow(/incomplete.*chat\/A\.png\/day-1/i);
        expect(h.events.some(value => value.startsWith('save-base:'))).toBe(false);
        expect(h.events).not.toContain('checkpoint-finish');
    });

    it('finalizes batched writers after item apply and before verification/base advance', async () => {
        const h = await createAdaptivePullHarness({ remote: ['persona/a.png', 'persona/b.png'] });
        const options = {
            ...h.options,
            finalizeApply: async () => { h.events.push('finalize'); },
        };

        await runDriveV2Pull(options);

        expect(h.events.indexOf('finalize')).toBeGreaterThan(h.events.indexOf('apply:persona/b.png'));
        expect(h.events.indexOf('finalize')).toBeLessThan(h.events.indexOf('save-base:head-b'));
    });

    it('applies the mobile profile writer and memory bounds', async () => {
        const h = await createAdaptivePullHarness({
            remote: Array.from({ length: 40 }, (_, index) => `preset/${index}`),
        });
        const result = await runDriveV2Pull({ ...h.options, profile: 'mobile' });
        expect(result.maxActiveWriters).toBeLessThanOrEqual(4);
        expect(result.peakEncryptedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
        expect(result.peakPlaintextBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
    });
});
