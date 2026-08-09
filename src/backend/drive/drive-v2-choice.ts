import type { ItemType, Manifest } from '../../sync-core/types';
import type { DrivePackManifestV2 } from './pack-types';

export interface DriveV2SnapshotPreview {
    add: number;
    replace: number;
    delete: number;
    inSync: number;
}

export interface DriveV2SnapshotSummary extends DriveV2SnapshotPreview {
    commitId?: string;
    device: string;
    createdTime?: string;
    itemCount: number;
}

export interface DriveV2ChoiceInput {
    local: DriveV2SnapshotSummary;
    heads: DriveV2SnapshotSummary[];
}

export function buildDriveV2SnapshotPreview(
    local: Manifest,
    remote: DrivePackManifestV2,
    allowedTypes: ReadonlySet<ItemType>,
): DriveV2SnapshotPreview {
    const preview: DriveV2SnapshotPreview = { add: 0, replace: 0, delete: 0, inSync: 0 };

    for (const remoteItem of Object.values(remote.items)) {
        if (!allowedTypes.has(remoteItem.type)) continue;
        const localItem = local.items[remoteItem.id];
        if (!localItem) preview.add += 1;
        else if (localItem.hash === remoteItem.hash) preview.inSync += 1;
        else preview.replace += 1;
    }

    for (const localItem of Object.values(local.items)) {
        if (allowedTypes.has(localItem.type) && !remote.items[localItem.id]) {
            preview.delete += 1;
        }
    }

    return preview;
}
