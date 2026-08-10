import { describe, expect, it, vi } from 'vitest';

import { DriveAuthError, DriveHttpError } from '../client';
import { DriveRangeSource } from '../range-source';

describe('DriveRangeSource', () => {
    it('lists packs once and reads only a validated chunk range', async () => {
        const listPacks = vi.fn().mockResolvedValue(new Map([
            ['pack-a', { id: 'file-a', name: 'pack-a', size: '100' }],
        ]));
        const getFileRange = vi.fn().mockResolvedValue(new Uint8Array(20));
        const source = new DriveRangeSource({ listPacks }, { getFileRange });
        const ref = { packName: 'pack-a', offset: 10, boxedLength: 20 };

        await source.readChunk(ref);
        await source.readChunk(ref);

        expect(listPacks).toHaveBeenCalledOnce();
        expect(getFileRange).toHaveBeenCalledWith('file-a', 10, 20, undefined);
    });

    it('rejects a chunk outside its listed pack before downloading', async () => {
        const getFileRange = vi.fn();
        const source = new DriveRangeSource({
            listPacks: async () => new Map([['pack-a', { id: 'file-a', name: 'pack-a', size: '25' }]]),
        }, { getFileRange });

        await expect(source.readChunk({ packName: 'pack-a', offset: 10, boxedLength: 20 }))
            .rejects.toThrow(/range/i);
        expect(getFileRange).not.toHaveBeenCalled();
    });

    it.each([408, 429, 500])('retries Drive HTTP %s before succeeding', async status => {
        const getFileRange = vi.fn()
            .mockRejectedValueOnce(new DriveHttpError(status, 'temporary'))
            .mockResolvedValue(new Uint8Array([1]));
        const source = new DriveRangeSource({
            listPacks: async () => new Map([['pack', { id: 'file', name: 'pack', size: '1' }]]),
        }, { getFileRange }, { delays: [0], sleep: async () => undefined });

        await expect(source.readChunk({ packName: 'pack', offset: 0, boxedLength: 1 }))
            .resolves.toEqual(new Uint8Array([1]));
        expect(getFileRange).toHaveBeenCalledTimes(2);
    });

    it('does not retry expired Google authorization', async () => {
        const getFileRange = vi.fn().mockRejectedValue(new DriveAuthError());
        const source = new DriveRangeSource({
            listPacks: async () => new Map([['pack', { id: 'file', name: 'pack', size: '1' }]]),
        }, { getFileRange }, { delays: [0], sleep: async () => undefined });

        await expect(source.readChunk({ packName: 'pack', offset: 0, boxedLength: 1 }))
            .rejects.toBeInstanceOf(DriveAuthError);
        expect(getFileRange).toHaveBeenCalledOnce();
    });
});
