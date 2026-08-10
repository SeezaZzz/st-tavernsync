import { describe, expect, it, vi } from 'vitest';

import type { DriveClient } from '../client';
import { resolveDriveLayoutForConnect } from '../connect-layout';

describe('Drive layout selection during Connect', () => {
    it('adopts an existing v2 Root before creating an empty v1 Root on a fresh device', async () => {
        const createFolder = vi.fn(async () => {
            throw new Error('must not create a legacy Root');
        });
        const client = {
            searchRootFolders: vi.fn(async (marker?: string) => marker === 'root-v2'
                ? [{ id: 'root-v2', name: 'TavernSync', appProperties: { ts: 'root-v2' } }]
                : []),
            listChildren: vi.fn(async (parentId: string) => parentId === 'root-v2'
                ? [
                    { id: 'packs-v2', name: 'packs' },
                    { id: 'manifests-v2', name: 'manifests' },
                ]
                : []),
            createFolder,
        } as unknown as DriveClient;

        await expect(resolveDriveLayoutForConnect({
            client,
            currentVersion: 1,
            knownRootId: '',
            pickLegacyRoot: async () => null,
        })).resolves.toEqual({
            version: 2,
            layout: {
                rootId: 'root-v2',
                packsId: 'packs-v2',
                manifestsId: 'manifests-v2',
            },
        });
        expect(createFolder).not.toHaveBeenCalled();
    });

    it('adopts an existing v2 Root even when this device remembers a valid empty v1 Root', async () => {
        const client = {
            searchRootFolders: vi.fn(async (marker?: string) => marker === 'root-v2'
                ? [{ id: 'root-v2', name: 'TavernSync', appProperties: { ts: 'root-v2' } }]
                : [{ id: 'root-v1', name: 'TavernSync', appProperties: { ts: 'root-v1' } }]),
            listChildren: vi.fn(async (parentId: string) => parentId === 'root-v2'
                ? [
                    { id: 'packs-v2', name: 'packs' },
                    { id: 'manifests-v2', name: 'manifests' },
                ]
                : [
                    { id: 'blobs-v1', name: 'blobs' },
                    { id: 'manifests-v1', name: 'manifests' },
                ]),
        } as unknown as DriveClient;

        const resolved = await resolveDriveLayoutForConnect({
            client,
            currentVersion: 1,
            knownRootId: 'root-v1',
            pickLegacyRoot: async () => null,
        });

        expect(resolved).toMatchObject({ version: 2, layout: { rootId: 'root-v2' } });
    });
});
