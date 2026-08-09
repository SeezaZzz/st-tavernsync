import { describe, expect, it } from 'vitest';

import type { ItemType, Manifest, SyncItem } from '../../../sync-core/types';
import type { DriveV2CommitMeta } from '../drive-v2-head';
import { runDriveV2Pull, type DriveV2PullOptions } from '../drive-v2-pull';
import type { DriveV2PackReader } from '../pack-reader';
import {
    DRIVE_V2_CHUNK_BYTES,
    DRIVE_V2_PACK_BYTES,
    type DrivePackItemV2,
    type DrivePackManifestV2,
} from '../pack-types';

function typeOf(id: string): ItemType {
    return id.split('/')[0] as ItemType;
}

function pullHarness(input: {
    remote?: string[];
    localOnly?: string[];
    inSync?: string[];
    failItem?: string;
}) {
    const remoteIds = [...new Set([
        ...(input.remote ?? []),
        ...(input.inSync ?? []),
        ...(input.failItem ? [input.failItem] : []),
    ])];
    const localIds = [...new Set([...(input.localOnly ?? []), ...(input.inSync ?? [])])];
    const events: string[] = [];
    let activeApplies = 0;
    let maxConcurrentApplies = 0;
    const remoteItems = Object.fromEntries(remoteIds.map(id => [id, {
        id,
        type: typeOf(id),
        hash: `hash:${id}`,
        size: 1,
        mtime: 1,
        chunks: [],
    } satisfies DrivePackItemV2]));
    const localItems = Object.fromEntries(localIds.map(id => [id, {
        id,
        type: typeOf(id),
        hash: `hash:${id}`,
        size: 1,
        mtime: 1,
    } satisfies SyncItem]));
    const commit: DriveV2CommitMeta = {
        fileId: 'manifest-id',
        commitId: 'head-b',
        parents: ['head-a'],
        createdTime: '',
    };
    const manifest: DrivePackManifestV2 = {
        schema: 2,
        storage: 'drive-pack-v2',
        device: 'pc',
        updatedAt: 2,
        chunkBytes: DRIVE_V2_CHUNK_BYTES,
        packBytes: DRIVE_V2_PACK_BYTES,
        items: remoteItems,
    };
    const local: Manifest = {
        schema: 1,
        version: 1,
        device: 'phone',
        updatedAt: 1,
        items: localItems,
    };
    const options: DriveV2PullOptions = {
        commit,
        manifest,
        local,
        localScanComplete: true,
        allowedTypes: new Set(remoteIds.concat(localIds).map(typeOf)),
        reader: {
            async readItem(item: DrivePackItemV2) {
                events.push(`read:${item.id}`);
                if (item.id === input.failItem) throw new Error(item.id);
                return new Uint8Array([1]);
            },
            getDownloadedPackCount: () => 0,
            getPeakCachedBytes: () => 0,
        } as unknown as DriveV2PackReader,
        async applyItem(id) {
            activeApplies += 1;
            maxConcurrentApplies = Math.max(maxConcurrentApplies, activeApplies);
            events.push(`apply:${id}`);
            await Promise.resolve();
            activeApplies -= 1;
        },
        async deleteItem(id) { events.push(`delete:${id}`); },
        async saveBlob() {},
        async saveBase(commitId) { events.push(`save-base:${commitId}`); },
        journal: {
            async start(commitId) { events.push(`journal-start:${commitId}`); },
            async markCompleted(itemId) { events.push(`journal-item:${itemId}`); },
            async finish(commitId) { events.push(`journal-finish:${commitId}`); },
        },
        checkpoint(item, stage) { events.push(`checkpoint:${stage}:${item.id}`); },
    };
    return {
        options,
        events,
        get maxConcurrentApplies() { return maxConcurrentApplies; },
    };
}

describe('Drive v2 Pull', () => {
    it('applies changed items serially in shared order and runs deletions last', async () => {
        const h = pullHarness({
            remote: ['settings/root', 'character/a.png'],
            localOnly: ['chat/a.png/old'],
        });
        await runDriveV2Pull(h.options);
        expect(h.maxConcurrentApplies).toBe(1);
        expect(h.events).toEqual([
            'journal-start:head-b',
            'checkpoint:downloading:character/a.png',
            'read:character/a.png',
            'checkpoint:storing:character/a.png',
            'checkpoint:applying:character/a.png',
            'apply:character/a.png', 'journal-item:character/a.png',
            'checkpoint:downloading:settings/root',
            'read:settings/root',
            'checkpoint:storing:settings/root',
            'checkpoint:applying:settings/root',
            'apply:settings/root', 'journal-item:settings/root',
            'delete:chat/a.png/old',
            'save-base:head-b',
            'journal-finish:head-b',
        ]);
    });

    it('does not delete or advance base after decrypt or apply failure', async () => {
        const h = pullHarness({ failItem: 'character/a.png', localOnly: ['chat/a.png/old'] });
        await expect(runDriveV2Pull(h.options)).rejects.toThrow('character/a.png');
        expect(h.events).not.toContain('delete:chat/a.png/old');
        expect(h.events.some(event => event.startsWith('save-base:'))).toBe(false);
        expect(h.events).not.toContain('journal-finish:head-b');
    });

    it('rejects an incomplete local scan before any mutation', async () => {
        const h = pullHarness({ remote: ['character/a.png'], localOnly: ['chat/a.png/old'] });
        h.options.localScanComplete = false;
        await expect(runDriveV2Pull(h.options)).rejects.toThrow('local scan incomplete');
        expect(h.events).toEqual([]);
    });

    it('skips items already matching the selected snapshot on retry', async () => {
        const h = pullHarness({
            inSync: ['character/a.png'],
            remote: ['character/a.png', 'chat/a.png/new'],
        });
        const result = await runDriveV2Pull(h.options);
        expect(h.events).not.toContain('read:character/a.png');
        expect(result.skippedInSync).toBe(1);
    });
});
