import { describe, expect, it, vi } from 'vitest';

import { prepareDriveRootKeyTransition } from '../root-key-transition';

describe('Drive root key transition', () => {
    it('invalidates the remembered E2EE key before adopting a different root', async () => {
        const invalidateE2ee = vi.fn(async () => undefined);

        await expect(prepareDriveRootKeyTransition(
            'legacy-root',
            'pack-root-v2',
            invalidateE2ee,
        )).resolves.toBe(true);

        expect(invalidateE2ee).toHaveBeenCalledOnce();
    });

    it('keeps the current E2EE key when reconnecting to the same root', async () => {
        const invalidateE2ee = vi.fn(async () => undefined);

        await expect(prepareDriveRootKeyTransition(
            'pack-root-v2',
            'pack-root-v2',
            invalidateE2ee,
        )).resolves.toBe(false);

        expect(invalidateE2ee).not.toHaveBeenCalled();
    });
});
