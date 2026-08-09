import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    directions: [] as string[],
    scanLocal: vi.fn(async () => ({
        manifest: { schema: 1 as const, version: 1, device: 'phone', updatedAt: 1, items: {} },
        itemCount: 0,
        refreshedBlobIds: [],
    })),
    coreRestore: vi.fn(async () => ({
        commitId: 'head-a',
        uploadedBatches: 1,
        uploadedBytes: 1,
        elapsedMs: 40,
    })),
    runDriveV2Sync: vi.fn(async (options: {
        direction: string;
        runPull: (commit: unknown, manifest: unknown) => Promise<unknown>;
    }) => {
        harness.directions.push(options.direction);
        if (options.direction === 'pull') {
            const commit = { fileId: 'file-a', commitId: 'head-a', parents: [], createdTime: '2026-01-01' };
            const manifest = {
                schema: 2 as const,
                storage: 'drive-pack-v2' as const,
                device: 'pc',
                updatedAt: 1,
                chunkBytes: 1,
                packBytes: 32,
                items: {},
            };
            return { kind: 'pulled' as const, result: await options.runPull(commit, manifest) };
        }
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
                listPacks: async () => new Map(),
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
        scanLocal: harness.scanLocal,
    };
});

vi.mock('../drive/core-restore', () => ({ runDriveV2CoreRestore: harness.coreRestore }));

vi.mock('../drive/oauth', () => ({
    getSharedGisTokenProvider: () => ({ getToken: async () => 'token' }),
}));

import { runSync, unlockE2ee } from '../../sync/engine';

beforeEach(async () => {
    harness.directions.length = 0;
    harness.runDriveV2Sync.mockClear();
    harness.scanLocal.mockClear();
    harness.coreRestore.mockClear();
    (globalThis as unknown as { SillyTavern: unknown }).SillyTavern = {
        libs: {
            localforage: {
                createInstance: () => ({
                    getItem: async () => null,
                    setItem: async () => undefined,
                    removeItem: async () => undefined,
                }),
            },
        },
        getContext: () => ({
            extensionSettings: {
                tavernsync: {
                    backendMode: 'drive',
                    driveRootVersion: 2,
                    driveFolderId: 'root',
                    e2eeEnabled: true,
                    e2eeRequireSessionUnlock: true,
                    deviceName: 'phone',
                    scope: { settings: true },
                },
            },
            saveSettingsDebounced: () => undefined,
        }),
    };
    await unlockE2ee('passphrase');
});

describe('Drive v2 engine routing', () => {
    it.each(['push', 'pull'] as const)('routes %s through the v2 coordinator', async direction => {
        await runSync({
            direction,
            chooseDriveV2Source: async () => ({ kind: 'cancel' }),
        });
        expect(harness.directions).toContain(direction);
    });

    it('routes Drive v2 Pull to the core restore client before browser scan', async () => {
        await runSync({ direction: 'pull' });
        expect(harness.scanLocal).not.toHaveBeenCalled();
        expect(harness.coreRestore).toHaveBeenCalledWith(expect.objectContaining({
            selectedCommitId: 'head-a',
        }));
    });

    it('has no Drive v2 Legacy Pull branch', async () => {
        await runSync({ direction: 'pull' });
        expect(harness.scanLocal).not.toHaveBeenCalled();
        expect(harness.coreRestore).toHaveBeenCalledOnce();
    });
});
