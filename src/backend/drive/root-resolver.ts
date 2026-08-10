import { deriveKey, exportKeyRaw } from '../../crypto';
import { deriveDrivePackSubkeys, driveSaltFromFolderIdAsync } from '../../crypto/subkeys';
import type { DriveClient } from './client';
import {
    computeDriveV2Heads,
    selectNewestDriveV2Head,
    type DriveV2CommitMeta,
} from './drive-v2-head';
import { makeDrivePackCrypto } from './pack-crypto';
import {
    listExistingDrivePackLayouts,
    type DrivePackLayout,
} from './pack-layout';
import { DrivePackStore } from './pack-store';

export type DriveStorageResolution =
    | { kind: 'ready'; layout: DrivePackLayout; head: DriveV2CommitMeta; itemCount: number }
    | { kind: 'empty'; layout: DrivePackLayout }
    | { kind: 'missing' };

export interface ResolveDriveStorageOptions {
    client: DriveClient;
    passphrase: string;
    rememberedRootId?: string;
}

function isAuthenticationFailure(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'OperationError';
}

export async function resolveDriveStorageByPassphrase(
    options: ResolveDriveStorageOptions,
): Promise<DriveStorageResolution> {
    const layouts = await listExistingDrivePackLayouts(options.client);
    if (layouts.length === 0) return { kind: 'missing' };

    const valid: Array<{
        layout: DrivePackLayout;
        head: DriveV2CommitMeta;
        itemCount: number;
    }> = [];
    const empty: DrivePackLayout[] = [];

    for (const layout of layouts) {
        const { key } = await deriveKey(
            options.passphrase,
            await driveSaltFromFolderIdAsync(layout.rootId),
            { extractable: true },
        );
        const subkeys = await deriveDrivePackSubkeys(await exportKeyRaw(key), layout.rootId);
        const store = new DrivePackStore(
            options.client,
            makeDrivePackCrypto(subkeys),
            layout,
        );
        const commits = await store.listCommits();
        if (commits.length === 0) {
            empty.push(layout);
            continue;
        }
        const head = selectNewestDriveV2Head(computeDriveV2Heads(commits));
        try {
            const manifest = await store.readManifest(head);
            valid.push({ layout, head, itemCount: Object.keys(manifest.items).length });
        } catch (error) {
            if (!isAuthenticationFailure(error)) throw error;
        }
    }

    if (valid.length > 0) {
        const selected = [...valid].sort((left, right) =>
            right.head.createdTime.localeCompare(left.head.createdTime)
            || right.head.fileId.localeCompare(left.head.fileId))[0];
        return { kind: 'ready', ...selected };
    }

    const remembered = empty.find(layout => layout.rootId === options.rememberedRootId);
    if (remembered) return { kind: 'empty', layout: remembered };
    if (empty.length === 1 && empty.length === layouts.length) {
        return { kind: 'empty', layout: empty[0] };
    }
    throw new Error('Encryption passphrase is incorrect');
}
