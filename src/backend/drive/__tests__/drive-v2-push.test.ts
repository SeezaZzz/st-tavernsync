import { beforeEach, describe, expect, it } from 'vitest';

import type { SyncItem } from '../../../sync-core/types';
import { runSync } from '../../../sync/engine';
import {
    createDriveV2PushController,
    runDriveV2FullPush,
    type DriveV2PushOptions,
    type DriveV2Runtime,
} from '../drive-v2-push';
import { DriveAuthError } from '../client';
import { DriveUploadPausedError } from '../pack-uploader';
import type { DrivePackCrypto } from '../pack-crypto';
import type { DrivePackManifestV2, EncryptedPack } from '../pack-types';

function cryptoStub(): DrivePackCrypto {
    return {
        async encryptChunk(value) { return value.slice(); },
        async decryptChunk(value) { return value.slice(); },
        async packName(entries) { return `pack-${entries[0]?.chunkHash ?? 'empty'}`; },
        async encryptManifest() { return new Uint8Array([1]); },
        async decryptManifest() { throw new Error('not used'); },
    };
}

function pushHarness(config: { packCount: number; concurrency: number; failPack?: number }) {
    const events: string[] = [];
    let active = 0;
    let maxConcurrentUploads = 0;
    let uploads = 0;
    let commits = 0;
    let committedParents: string[] = [];
    let committedManifest: DrivePackManifestV2 | null = null;
    const fixtures = new Map<string, Uint8Array>();
    const items: SyncItem[] = [];
    for (let index = 0; index < config.packCount; index++) {
        const hash = `hash-${index}`;
        fixtures.set(hash, new Uint8Array([index + 1]));
        items.push({ id: `item-${index}`, type: 'character', hash, size: 1, mtime: index });
    }

    const store = {
        async hasCommittedSnapshot() { return false; },
        async listCommits() { return []; },
        async readManifest() { throw new Error('not used'); },
        async readPack() { throw new Error('not used'); },
        async listPacks() { return new Map(); },
        async putPack(pack: EncryptedPack) {
            const uploadNumber = uploads++;
            active += 1;
            maxConcurrentUploads = Math.max(maxConcurrentUploads, active);
            events.push(`upload:${pack.name}`);
            await new Promise(resolve => setTimeout(resolve, 5));
            active -= 1;
            if (uploadNumber === config.failPack) throw new Error(`pack ${uploadNumber}`);
        },
        async verifyPacks() { events.push('verify'); },
        async commitManifest(manifest: DrivePackManifestV2, parents: readonly string[] = []) {
            commits += 1;
            committedManifest = manifest;
            committedParents = [...parents];
            events.push('commit');
            return { commitId: 'commit-id' };
        },
    };
    const runtime: DriveV2Runtime = {
        layout: { rootId: 'root', packsId: 'packs', manifestsId: 'manifests' },
        crypto: cryptoStub(),
        store,
    };
    const options: DriveV2PushOptions = {
        runtime,
        device: 'pc',
        items,
        chunkBytes: 1,
        packBytes: 1,
        concurrency: config.concurrency,
        load: async hash => fixtures.get(hash) ?? null,
    };
    return {
        options,
        events,
        get maxConcurrentUploads() { return maxConcurrentUploads; },
        get commits() { return commits; },
        get committedParents() { return committedParents; },
        get committedManifest() { return committedManifest; },
    };
}

describe('Drive v2 Full Push', () => {
    beforeEach(() => {
        (globalThis as unknown as { SillyTavern: unknown }).SillyTavern = {
            getContext: () => ({
                extensionSettings: {
                    tavernsync: {
                        backendMode: 'drive',
                        driveRootVersion: 2,
                        driveFolderId: 'root-v2',
                        e2eeEnabled: false,
                    },
                },
                saveSettingsDebounced: () => undefined,
            }),
        };
    });

    it('overlaps packing with four bounded pack uploads and commits last', async () => {
        const harness = pushHarness({ packCount: 9, concurrency: 4 });
        const result = await runDriveV2FullPush(harness.options);
        expect(harness.maxConcurrentUploads).toBe(4);
        expect(harness.events.at(-1)).toBe('commit');
        expect(result.metrics.packCount).toBe(9);
    });

    it('does not commit after a failed pack', async () => {
        const harness = pushHarness({ packCount: 9, concurrency: 4, failPack: 3 });
        await expect(runDriveV2FullPush(harness.options)).rejects.toThrow('pack 3');
        expect(harness.commits).toBe(0);
    });

    it('publishes parent and prior-base metadata only in the encrypted manifest', async () => {
        const harness = pushHarness({ packCount: 1, concurrency: 1 });
        harness.options.parents = ['head-a', 'head-b'];
        harness.options.baseCommitId = 'old-base';
        harness.options.forced = true;

        await runDriveV2FullPush(harness.options);

        expect(harness.committedParents).toEqual(['head-a', 'head-b']);
        expect(harness.committedManifest).toMatchObject({ baseCommitId: 'old-base', forced: true });
    });

    it('does not commit when cancelled after pack verification', async () => {
        const abort = new AbortController();
        let commits = 0;
        const runtime: DriveV2Runtime = {
            layout: { rootId: 'root', packsId: 'packs', manifestsId: 'manifests' },
            crypto: cryptoStub(),
            store: {
                async hasCommittedSnapshot() { return false; },
                async listCommits() { return []; },
                async readManifest() { throw new Error('not used'); },
                async readPack() { throw new Error('not used'); },
                async listPacks() { return new Map(); },
                async putPack() { return undefined; },
                async verifyPacks() { abort.abort(); },
                async commitManifest() { commits += 1; return { commitId: 'bad-commit' }; },
            },
        };
        await expect(runDriveV2FullPush({
            runtime,
            device: 'pc',
            items: [{ id: 'one', type: 'character', hash: 'one', size: 1, mtime: 1 }],
            chunkBytes: 1,
            packBytes: 1,
            concurrency: 1,
            load: async () => new Uint8Array([1]),
            signal: abort.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(commits).toBe(0);
    });

    it('blocks the ambiguous v2 both direction', async () => {
        await expect(runSync({ direction: 'both' }))
            .rejects.toThrow('Google Drive backup requires an explicit Push or Pull direction');
    });

    it('resumes an auth-paused pack with the same ciphertext and session', async () => {
        const source = new Uint8Array([7]);
        let pausedPack: EncryptedPack | null = null;
        let resumedPack: EncryptedPack | null = null;
        let pausedBytes: Uint8Array | null = null;
        let resumedBytes: Uint8Array | null = null;
        let resumeState: unknown = null;
        let completed = false;
        const store = {
            async hasCommittedSnapshot() { return false; },
            async listCommits() { return []; },
            async readManifest() { throw new Error('not used'); },
            async readPack() { throw new Error('not used'); },
            async listPacks() { return new Map(); },
            async putPack(pack: EncryptedPack, control?: { resume?: unknown }) {
                if (!pausedPack) {
                    pausedPack = pack;
                    pausedBytes = pack.bytes;
                    throw new DriveUploadPausedError('session-1', 1, new DriveAuthError());
                }
                if (!completed) {
                    resumedPack = pack;
                    resumedBytes = pack.bytes;
                    resumeState = control?.resume;
                    completed = true;
                }
            },
            async verifyPacks() { return undefined; },
            async commitManifest() { return { commitId: 'commit-id' }; },
        };
        const controller = createDriveV2PushController({
            runtime: {
                layout: { rootId: 'root', packsId: 'packs', manifestsId: 'manifests' },
                crypto: cryptoStub(),
                store,
            },
            device: 'pc',
            items: [{ id: 'one', type: 'character', hash: 'hash-one', size: 1, mtime: 1 }],
            chunkBytes: 1,
            packBytes: 1,
            concurrency: 1,
            load: async () => source,
        });

        await expect(controller.run()).rejects.toMatchObject({ name: 'DriveUploadPausedError' });
        await controller.resume();

        expect(resumedPack).not.toBeNull();
        expect(pausedPack).not.toBeNull();
        expect(resumedBytes).toBe(pausedBytes);
        expect(resumeState).toEqual({ sessionUrl: 'session-1', acknowledgedBytes: 1 });
    });
});
