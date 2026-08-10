import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    directions: [] as string[],
    scanLocal: vi.fn(async () => ({
        manifest: { schema: 1 as const, version: 1, device: 'phone', updatedAt: 1, items: {} },
        itemCount: 0,
        refreshedBlobIds: [],
    })),
    listLocalInventory: vi.fn(async () => new Map()),
    adaptivePull: vi.fn(async () => ({
        commitId: 'head-a',
        applied: 0,
        deleted: 0,
        skippedInSync: 0,
        downloadedPacks: 0,
        peakCachedBytes: 0,
        peakEncryptedBytes: 0,
        peakPlaintextBytes: 0,
        maxActiveWriters: 0,
        elapsedMs: 40,
    })),
    wipeDriveV2RemoteSnapshot: vi.fn(async () => ({ commitId: 'empty-head' })),
    saveSettingsDebounced: vi.fn(),
    savedSettings: null as Record<string, unknown> | null,
    serverSettings: {
        world_info_settings: { world_info: { globalSelect: ['Lore A'] } },
        extension_settings: {
            tavernsync: { deviceName: 'phone', driveFolderId: 'root' },
            anotherExtension: { enabled: true },
        },
    } as Record<string, unknown>,
    runDriveV2Sync: vi.fn(async (options: {
        direction: string;
        runPull: (commit: unknown, manifest: unknown) => Promise<unknown>;
    }) => {
        harness.directions.push(options.direction);
        if (options.direction === 'pull') {
            const commit = {
                fileId: 'file-a',
                commitId: 'head-a',
                parents: [],
                createdTime: '2026-01-01',
            };
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
    return { ...original, scanLocal: harness.scanLocal };
});

vi.mock('../../st-adapter/inventory', () => ({
    listLocalInventory: harness.listLocalInventory,
}));

vi.mock('../../st-adapter/http', () => ({
    stFetchJson: vi.fn(async (path: string, body: unknown) => {
        if (path === '/api/settings/get') {
            return { settings: JSON.stringify(harness.serverSettings) };
        }
        if (path === '/api/settings/save') {
            harness.savedSettings = body as Record<string, unknown>;
            return { ok: true };
        }
        throw new Error(`unexpected ST endpoint: ${path}`);
    }),
}));

vi.mock('../drive/drive-v2-pull', async importOriginal => {
    const original = await importOriginal<typeof import('../drive/drive-v2-pull')>();
    return { ...original, runDriveV2Pull: harness.adaptivePull };
});

vi.mock('../drive/drive-v2-wipe', () => ({
    wipeDriveV2RemoteSnapshot: harness.wipeDriveV2RemoteSnapshot,
}));

vi.mock('../drive/oauth', () => ({
    getSharedGisTokenProvider: () => ({ getToken: async () => 'token' }),
}));

import { runSync, unlockE2ee, wipeRemoteSyncData } from '../../sync/engine';

beforeEach(async () => {
    harness.directions.length = 0;
    harness.runDriveV2Sync.mockClear();
    harness.scanLocal.mockClear();
    harness.listLocalInventory.mockClear();
    harness.adaptivePull.mockClear();
    harness.wipeDriveV2RemoteSnapshot.mockClear();
    harness.saveSettingsDebounced.mockClear();
    harness.savedSettings = null;
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
            saveSettingsDebounced: harness.saveSettingsDebounced,
        }),
    };
    await unlockE2ee('passphrase');
    harness.saveSettingsDebounced.mockClear();
});

describe('Drive v2 engine routing', () => {
    it.each(['push', 'pull'] as const)('routes %s through the v2 coordinator', async direction => {
        await runSync({
            direction,
            chooseDriveV2Source: async () => ({ kind: 'cancel' }),
        });
        expect(harness.directions).toContain(direction);
    });

    it('scans local hashes before Drive v2 Pull so unchanged items can be skipped', async () => {
        await runSync({ direction: 'pull' });

        expect(harness.scanLocal).toHaveBeenCalledOnce();
        expect(harness.adaptivePull).toHaveBeenCalledWith(expect.objectContaining({
            commit: expect.objectContaining({ commitId: 'head-a' }),
            localHashes: expect.any(Map),
        }));
    });

    it('includes semantic companion items for every selected scope', async () => {
        await runSync({ direction: 'pull' });

        const calls = harness.adaptivePull.mock.calls as unknown as Array<[
            { allowedTypes: Set<string> },
        ]>;
        const options = calls[0][0];
        expect([...options.allowedTypes]).toEqual(expect.arrayContaining([
            'settings',
            'extension',
            'character',
            'characterstate',
            'characterasset',
            'group',
            'groupchat',
            'userimage',
        ]));
    });

    it('persists Pull status onto the latest restored settings instead of saving stale page state', async () => {
        await runSync({ direction: 'pull' });

        expect(harness.saveSettingsDebounced).not.toHaveBeenCalled();
        expect(harness.savedSettings).toMatchObject({
            world_info_settings: { world_info: { globalSelect: ['Lore A'] } },
            extension_settings: {
                anotherExtension: { enabled: true },
                tavernsync: expect.objectContaining({
                    deviceName: 'phone',
                    driveFolderId: 'root',
                    lastItemCount: 0,
                    lastStatusMessage: 'Fast Pull complete · 0s',
                }),
            },
        });
    });

    it('contains no Core restore or restore-session imports', () => {
        const source = readFileSync(new URL('../../sync/engine.ts', import.meta.url), 'utf8');

        expect(source).not.toMatch(/core-restore|restore-session|RestoreSessionClient|runDriveV2CoreRestore/);
    });

    it('routes remote wipe through the Drive v2 empty-snapshot path', async () => {
        await wipeRemoteSyncData();

        expect(harness.wipeDriveV2RemoteSnapshot).toHaveBeenCalledOnce();
        expect(harness.wipeDriveV2RemoteSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({ commitManifest: expect.any(Function) }),
            'phone',
        );
    });
});
