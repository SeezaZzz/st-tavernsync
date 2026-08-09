import type { SyncItem } from '../../sync-core/types';

export const DRIVE_V2_CHUNK_BYTES = 1 * 1024 * 1024;
export const DRIVE_V2_PACK_BYTES = 32 * 1024 * 1024;
export const DRIVE_V2_RANGE_BYTES = 8 * 1024 * 1024;
export const DRIVE_V2_CONCURRENCY = 4;

export interface DrivePackChunkRef {
    packName: string;
    offset: number;
    boxedLength: number;
    plainLength: number;
    chunkHash: string;
}

export interface DrivePackItemV2 {
    id: string;
    type: SyncItem['type'];
    hash: string;
    size: number;
    mtime: number;
    chunks: DrivePackChunkRef[];
}

export interface DrivePackManifestV2 {
    schema: 2;
    storage: 'drive-pack-v2';
    device: string;
    updatedAt: number;
    chunkBytes: number;
    packBytes: number;
    items: Record<string, DrivePackItemV2>;
}

export interface EncryptedPack {
    name: string;
    bytes: Uint8Array;
    chunks: readonly {
        chunkHash: string;
        plainLength: number;
        boxedLength: number;
    }[];
}

export function emptyDrivePackManifest(
    device: string,
    chunkBytes = DRIVE_V2_CHUNK_BYTES,
    packBytes = DRIVE_V2_PACK_BYTES,
): DrivePackManifestV2 {
    return {
        schema: 2,
        storage: 'drive-pack-v2',
        device,
        updatedAt: Date.now(),
        chunkBytes,
        packBytes,
        items: {},
    };
}
