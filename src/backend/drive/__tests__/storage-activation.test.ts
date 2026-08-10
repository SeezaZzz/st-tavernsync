import { describe, expect, it, vi } from 'vitest';

import type { DriveClient } from '../client';
import { activateDriveStorage } from '../storage-activation';

function emptyClient() {
    const createFolder = vi.fn(async (name: string, _properties: Record<string, string>, parentId?: string) => ({
        id: parentId ? `${parentId}:${name}` : 'new-storage',
        name,
    }));
    return {
        client: {
            searchRootFolders: vi.fn(async () => []),
            listChildren: vi.fn(async () => []),
            createFolder,
        } as unknown as DriveClient,
        createFolder,
    };
}

describe('Drive storage activation', () => {
    it.each(['unlock', 'pull', 'status'] as const)('does not create storage for %s', async action => {
        const h = emptyClient();
        const adopt = vi.fn();
        const unlock = vi.fn();

        await expect(activateDriveStorage({
            action,
            client: h.client,
            passphrase: 'secret',
            adopt,
            unlock,
        })).resolves.toEqual({ kind: 'missing' });
        expect(h.createFolder).not.toHaveBeenCalled();
        expect(adopt).not.toHaveBeenCalled();
        expect(unlock).not.toHaveBeenCalled();
    });

    it('creates exactly one current storage area after an explicit Push', async () => {
        const h = emptyClient();
        const adopt = vi.fn(async () => undefined);
        const unlock = vi.fn(async () => undefined);

        await expect(activateDriveStorage({
            action: 'push',
            client: h.client,
            passphrase: 'secret',
            adopt,
            unlock,
        })).resolves.toMatchObject({ kind: 'empty', layout: { rootId: 'new-storage' } });
        expect(h.createFolder).toHaveBeenCalledTimes(3);
        expect(adopt).toHaveBeenCalledOnce();
        expect(unlock).toHaveBeenCalledWith('secret');
    });
});
