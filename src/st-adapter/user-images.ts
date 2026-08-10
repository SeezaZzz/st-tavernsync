import type { SyncItem } from '../sync-core/types';
import { stFetchBytes, stFetchJson } from './http';
import { sha256Hex } from './normalize';

const USER_IMAGE_PREFIX = '/user/images/';

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    }
    return btoa(binary);
}

export async function makeGroupImageItem(groupBytes: Uint8Array): Promise<{
    readonly item: SyncItem;
    readonly bytes: Uint8Array;
} | null> {
    const group = JSON.parse(new TextDecoder().decode(groupBytes)) as { readonly avatar_url?: string };
    if (!group.avatar_url?.startsWith(USER_IMAGE_PREFIX)) return null;
    const relativePath = decodeURIComponent(group.avatar_url.slice(USER_IMAGE_PREFIX.length));
    let bytes: Uint8Array;
    try {
        bytes = await stFetchBytes(group.avatar_url);
    } catch (error) {
        if (error instanceof Error && /\b404\b/.test(error.message)) return null;
        throw error;
    }
    return {
        item: {
            id: `userimage/${relativePath}`,
            type: 'userimage',
            hash: await sha256Hex(bytes),
            size: bytes.byteLength,
            mtime: Date.now(),
        },
        bytes,
    };
}

export async function writeUserImage(relativePath: string, bytes: Uint8Array): Promise<void> {
    const segments = relativePath.split('/').filter(Boolean);
    const filename = segments.pop();
    if (!filename) throw new Error('User image is missing a filename');
    const extension = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined;
    if (!extension) throw new Error(`User image is missing a file extension: ${relativePath}`);
    const body: Record<string, string> = {
        image: bytesToBase64(bytes),
        format: extension,
        filename,
    };
    if (segments.length) body.ch_name = segments.join('_');
    const response = await stFetchJson<{ path?: string }>('/api/images/upload', body);
    const savedPath = response.path?.replace(/\\/g, '/').replace(/^\/+/, '');
    const expectedPath = `user/images/${relativePath}`;
    if (savedPath !== expectedPath) {
        throw new Error(`User image upload returned an unexpected path: ${savedPath ?? 'missing'}`);
    }

    const written = await stFetchBytes(`/${savedPath}`);
    if (written.byteLength !== bytes.byteLength) {
        throw new Error(`User image verification failed for ${relativePath}: size mismatch`);
    }
    const [expectedHash, writtenHash] = await Promise.all([
        sha256Hex(bytes),
        sha256Hex(written),
    ]);
    if (writtenHash !== expectedHash) {
        throw new Error(`User image verification failed for ${relativePath}: hash mismatch`);
    }
}
