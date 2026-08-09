import { beforeEach, describe, expect, it, vi } from 'vitest';

const setItem = vi.fn();
const getItem = vi.fn();

vi.mock('../../state/store', () => ({
    getSyncStore: () => ({ setItem, getItem }),
}));

import { loadBlob, storeBlob } from '../scan';

describe('scan blob storage', () => {
    beforeEach(() => {
        setItem.mockReset();
        getItem.mockReset();
    });

    it('stores Uint8Array directly instead of expanding it to number[]', async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        await storeBlob('abc', bytes);
        expect(setItem).toHaveBeenCalledWith('blob:abc', bytes);
        expect(Array.isArray(setItem.mock.calls[0][1])).toBe(false);
    });

    it.each([
        new Uint8Array([1, 2, 3]),
        new Uint8Array([1, 2, 3]).buffer,
        [1, 2, 3],
    ])('loads binary and legacy values', async (stored) => {
        getItem.mockResolvedValue(stored);
        await expect(loadBlob('abc')).resolves.toEqual(new Uint8Array([1, 2, 3]));
    });
});
