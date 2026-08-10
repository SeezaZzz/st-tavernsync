import { describe, expect, it } from 'vitest';

import { runDriveV2Pull } from '../drive-v2-pull';
import { createAdaptivePullHarness } from './adaptive-pull-harness';

describe('Drive v2 extension-only Pull', () => {
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

    it('resumes completed IDs and performs no delete or base advance after failure', async () => {
        const h = await createAdaptivePullHarness({
            remote: ['preset/done', 'preset/fails'],
            local: ['preset/old'],
            completed: ['preset/done'],
            fail: 'preset/fails',
        });

        await expect(runDriveV2Pull(h.options)).rejects.toThrow('preset/fails');

        expect(h.events).not.toContain('read:preset/done');
        expect(h.events.some(value => value.startsWith('delete:'))).toBe(false);
        expect(h.events.some(value => value.startsWith('save-base:'))).toBe(false);
        expect(h.events).toContain('checkpoint-flush');
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
});
