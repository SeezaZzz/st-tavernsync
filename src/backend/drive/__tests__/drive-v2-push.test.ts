import { beforeEach, describe, expect, it } from 'vitest';

import type { SyncItem } from '../../../sync-core/types';
import { runSync } from '../../../sync/engine';
import {
    runDriveV2FullPush,
    type DriveV2PushOptions,
    type DriveV2Runtime,
} from '../drive-v2-push';
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
    const fixtures = new Map<string, Uint8Array>();
    const items: SyncItem[] = [];
    for (let index = 0; index < config.packCount; index++) {
        const hash = `hash-${index}`;
        fixtures.set(hash, new Uint8Array([index + 1]));
        items.push({ id: `item-${index}`, type: 'character', hash, size: 1, mtime: index });
    }

    const store = {
        async hasCommittedSnapshot() { return false; },
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
        async commitManifest(_manifest: DrivePackManifestV2) {
            commits += 1;
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

    it.each(['pull', 'both'] as const)('blocks unsupported v2 direction %s', async direction => {
        await expect(runSync({ direction })).rejects.toThrow('Drive v2 Phase 1 supports Full Push only');
    });
});
