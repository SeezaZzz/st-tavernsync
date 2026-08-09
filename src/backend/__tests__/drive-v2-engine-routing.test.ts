import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    directions: [] as string[],
    runDriveV2Sync: vi.fn(async (options: { direction: string }) => {
        harness.directions.push(options.direction);
        return { kind: 'cancelled' as const };
    }),
}));

vi.mock('../runtime', async importOriginal => {
    const original = await importOriginal<typeof import('../runtime')>();
    return {
        ...original,
        requireDriveV2Runtime: async () => ({
            layout: { rootId: 'root', packsId: 'packs', manifestsId: 'manifests' },
            crypto: {
                encryptChunk: async (value: Uint8Array) => value,
                decryptChunk: async (value: Uint8Array) => value,
                packName: async () => 'pack',
                encryptManifest: async () => new Uint8Array([1]),
                decryptManifest: async () => { throw new Error('not used'); },
            },
            store: {
                hasCommittedSnapshot: async () => false,
                listCommits: async () => [],
                readManifest: async () => { throw new Error('not used'); },
                readPack: async () => { throw new Error('not used'); },
                putPack: async () => undefined,
                verifyPacks: async () => undefined,
                commitManifest: async () => ({ commitId: 'old-direct-push' }),
            },
        }),
    };
});

vi.mock('../drive/drive-v2-sync', async importOriginal => {
    const original = await importOriginal<typeof import('../drive/drive-v2-sync')>();
    return { ...original, runDriveV2Sync: harness.runDriveV2Sync };
});

vi.mock('../../st-adapter/scan', async importOriginal => {
    const original = await importOriginal<typeof import('../../st-adapter/scan')>();
    return {
        ...original,
        scanLocal: async () => ({
            manifest: { schema: 1, version: 1, device: 'phone', updatedAt: 1, items: {} },
            itemCount: 0,
            refreshedBlobIds: [],
        }),
    };
});

import { runSync } from '../../sync/engine';

beforeEach(() => {
    harness.directions.length = 0;
    harness.runDriveV2Sync.mockClear();
    (globalThis as unknown as { SillyTavern: unknown }).SillyTavern = {
        libs: { localforage: { createInstance: () => ({ getItem: async () => null, setItem: async () => undefined }) } },
        getContext: () => ({
            extensionSettings: {
                tavernsync: {
                    backendMode: 'drive',
                    driveRootVersion: 2,
                    driveFolderId: 'root',
                    e2eeEnabled: false,
                    deviceName: 'phone',
                    scope: {},
                },
            },
            saveSettingsDebounced: () => undefined,
        }),
    };
});

describe('Drive v2 engine routing', () => {
    it.each(['push', 'pull'] as const)('routes %s through the v2 coordinator', async direction => {
        await runSync({
            direction,
            chooseDriveV2Source: async () => ({ kind: 'cancel' }),
        });
        expect(harness.directions).toContain(direction);
    });
});
