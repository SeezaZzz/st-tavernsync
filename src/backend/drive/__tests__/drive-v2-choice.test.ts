import { describe, expect, it } from 'vitest';

import type { ItemType, Manifest, SyncItem } from '../../../sync-core/types';
import { buildDriveV2SnapshotPreview } from '../drive-v2-choice';
import {
    DRIVE_V2_CHUNK_BYTES,
    DRIVE_V2_PACK_BYTES,
    type DrivePackItemV2,
    type DrivePackManifestV2,
} from '../pack-types';

const allTypes = new Set<ItemType>([
    'settings', 'preset', 'worldinfo', 'persona', 'character',
    'chat', 'group', 'groupchat', 'quickreply', 'theme',
]);

function item(id: string, hash: string, type: ItemType = 'character'): SyncItem {
    return { id, hash, type, size: 1, mtime: 1 };
}

function manifest(items: Record<string, SyncItem>): Manifest {
    return { schema: 1, version: 1, device: 'phone', updatedAt: 1, items };
}

function packItem(id: string, hash: string, type: ItemType = 'character'): DrivePackItemV2 {
    return { id, hash, type, size: 1, mtime: 1, chunks: [] };
}

function packManifest(items: Record<string, DrivePackItemV2>): DrivePackManifestV2 {
    return {
        schema: 2,
        storage: 'drive-pack-v2',
        device: 'pc',
        updatedAt: 2,
        chunkBytes: DRIVE_V2_CHUNK_BYTES,
        packBytes: DRIVE_V2_PACK_BYTES,
        items,
    };
}

describe('Drive v2 source-choice preview', () => {
    it('previews add replace delete and in-sync for Drive-authoritative Pull', () => {
        const local = manifest({
            same: item('same', 'h1'),
            old: item('old', 'h0'),
            localOnly: item('localOnly', 'x'),
        });
        const remote = packManifest({
            same: packItem('same', 'h1'),
            old: packItem('old', 'h2'),
            remoteOnly: packItem('remoteOnly', 'r'),
        });
        expect(buildDriveV2SnapshotPreview(local, remote, allTypes)).toEqual({
            add: 1,
            replace: 1,
            delete: 1,
            inSync: 1,
        });
    });

    it('never deletes items from a disabled scope', () => {
        const preview = buildDriveV2SnapshotPreview(
            manifest({ chat: item('chat', 'h', 'chat') }),
            packManifest({}),
            new Set(['character']),
        );
        expect(preview.delete).toBe(0);
    });
});
