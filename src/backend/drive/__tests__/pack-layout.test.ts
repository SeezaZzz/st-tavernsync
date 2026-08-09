import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getSettings } from '../../../settings';
import type { DriveClient, DriveFileMeta } from '../client';
import {
    discoverDrivePackLayout,
    recoverExistingDrivePackLayout,
    resetDriveRootToV2,
    type ResetDriveRootToV2Options,
} from '../pack-layout';

function loadSettingsFixture(value: Record<string, unknown>) {
    (globalThis as unknown as { SillyTavern: unknown }).SillyTavern = {
        getContext: () => ({
            extensionSettings: { tavernsync: value },
            saveSettingsDebounced: vi.fn(),
        }),
    };
    return getSettings();
}

interface LayoutClientFake {
    createdRootProperties: Record<string, string> | null;
    trashed: string[];
    createFolder(name: string, properties: Record<string, string>, parentId?: string): Promise<DriveFileMeta>;
    listChildren(parentId: string): Promise<DriveFileMeta[]>;
    searchRootFolders(marker?: string): Promise<DriveFileMeta[]>;
    trashFile(id: string): Promise<void>;
}

function layoutClient(options: { failCreate?: boolean; roots?: DriveFileMeta[] } = {}): LayoutClientFake {
    const client: LayoutClientFake = {
        createdRootProperties: null,
        trashed: [],
        async createFolder(name, properties, parentId) {
            if (options.failCreate) throw new Error('create failed');
            if (!parentId) {
                client.createdRootProperties = properties;
                return { id: 'root-v2-id', name };
            }
            if (name === 'packs') return { id: 'packs-id', name };
            if (name === 'manifests') return { id: 'manifests-id', name };
            throw new Error(`unexpected folder ${name}`);
        },
        async listChildren() {
            return [
                { id: 'packs-id', name: 'packs' },
                { id: 'manifests-id', name: 'manifests' },
            ];
        },
        async searchRootFolders() {
            return options.roots ?? [];
        },
        async trashFile(id) {
            client.trashed.push(id);
        },
    };
    return client;
}

function baseResetOptions(client: LayoutClientFake): ResetDriveRootToV2Options {
    return {
        client: client as unknown as DriveClient,
        oldRootId: 'root-v1-id',
        oldNamespace: 'drive:root-v1-id',
        clearBackendState: vi.fn(async () => undefined),
    };
}

describe('Drive v2 pack layout', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('backfills existing users to Drive Root v1', () => {
        const settings = loadSettingsFixture({ backendMode: 'drive', driveFolderId: 'old-root' });
        expect(settings.driveRootVersion).toBe(1);
    });

    it('trashes only the selected v1 root and creates root-v2 children', async () => {
        const client = layoutClient();
        const clearBackendState = vi.fn(async () => undefined);
        const layout = await resetDriveRootToV2({
            client: client as unknown as DriveClient,
            oldRootId: 'root-v1-id',
            oldNamespace: 'drive:root-v1-id',
            clearBackendState,
        });
        expect(client.trashed).toEqual(['root-v1-id']);
        expect(client.createdRootProperties).toEqual({ ts: 'root-v2' });
        expect(clearBackendState).toHaveBeenCalledWith('drive:root-v1-id');
        expect(layout).toEqual({ rootId: 'root-v2-id', packsId: 'packs-id', manifestsId: 'manifests-id' });
    });

    it('does not trash anything when v2 folder creation fails', async () => {
        const client = layoutClient({ failCreate: true });
        await expect(resetDriveRootToV2(baseResetOptions(client))).rejects.toThrow('create failed');
        expect(client.trashed).toEqual([]);
    });

    it('replaces an existing v2 root for a second empty-root benchmark', async () => {
        const client = layoutClient();
        await resetDriveRootToV2({
            client: client as unknown as DriveClient,
            oldRootId: 'previous-root-v2',
            oldNamespace: 'drive:previous-root-v2',
            clearBackendState: vi.fn(async () => undefined),
        });
        expect(client.trashed).toEqual(['previous-root-v2']);
        expect(client.createdRootProperties).toEqual({ ts: 'root-v2' });
    });

    it('discovers packs and manifests under a remembered v2 root', async () => {
        const client = layoutClient();
        await expect(discoverDrivePackLayout(client as unknown as DriveClient, 'known-v2'))
            .resolves.toEqual({ rootId: 'known-v2', packsId: 'packs-id', manifestsId: 'manifests-id' });
    });

    it('recovers a stale device from its broken v1 root by finding the existing v2 root', async () => {
        const client = layoutClient({ roots: [{ id: 'shared-v2', name: 'TavernSync' }] });
        const legacyError = new Error('TavernSync root is incomplete (missing manifests/ or blobs/)');

        await expect(recoverExistingDrivePackLayout(
            client as unknown as DriveClient,
            legacyError,
        )).resolves.toEqual({ rootId: 'shared-v2', packsId: 'packs-id', manifestsId: 'manifests-id' });
        expect(client.createdRootProperties).toBeNull();
        expect(client.trashed).toEqual([]);
    });

    it('preserves the legacy error when no existing v2 root can be found', async () => {
        const client = layoutClient();
        const legacyError = new Error('legacy root unavailable');

        await expect(recoverExistingDrivePackLayout(
            client as unknown as DriveClient,
            legacyError,
        )).rejects.toBe(legacyError);
        expect(client.createdRootProperties).toBeNull();
        expect(client.trashed).toEqual([]);
    });
});
