import { describe, expect, it, vi } from 'vitest';

import type { DriveClient } from '../client';
import { resolveDriveLayoutForConnect } from '../connect-layout';

describe('Drive layout selection during Connect', () => {
    it('reports missing current storage without creating a legacy or current Root', async () => {
        const createFolder = vi.fn(async () => {
            throw new Error('Connect must not create storage');
        });
        const client = {
            searchRootFolders: vi.fn(async () => []),
            listChildren: vi.fn(async () => []),
            createFolder,
        } as unknown as DriveClient;

        await expect(resolveDriveLayoutForConnect({
            client,
            currentVersion: 1,
            knownRootId: '',
            pickLegacyRoot: async () => null,
        })).resolves.toEqual({ version: 2, layout: null });
        expect(createFolder).not.toHaveBeenCalled();
    });

    it('defers multiple current roots to passphrase resolution instead of asking the user', async () => {
        const pickLegacyRoot = vi.fn(async () => {
            throw new Error('must not show a root picker');
        });
        const client = {
            searchRootFolders: vi.fn(async () => [
                { id: 'root-a', name: 'TavernSync', appProperties: { ts: 'root-v2' } },
                { id: 'root-b', name: 'TavernSync', appProperties: { ts: 'root-v2' } },
            ]),
            listChildren: vi.fn(async (parentId: string) => [
                { id: `packs:${parentId}`, name: 'packs' },
                { id: `manifests:${parentId}`, name: 'manifests' },
            ]),
        } as unknown as DriveClient;

        await expect(resolveDriveLayoutForConnect({
            client,
            currentVersion: 1,
            knownRootId: '',
            pickLegacyRoot,
        })).resolves.toEqual({ version: 2, layout: null });
        expect(pickLegacyRoot).not.toHaveBeenCalled();
    });

    it('defers an unremembered current root until the passphrase authenticates it', async () => {
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
        })).resolves.toEqual({ version: 2, layout: null });
        expect(createFolder).not.toHaveBeenCalled();
    });

    it('ignores a remembered legacy Root until the passphrase authenticates current storage', async () => {
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

        expect(resolved).toEqual({ version: 2, layout: null });
    });
});
