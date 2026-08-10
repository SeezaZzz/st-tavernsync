import { describe, expect, it, vi } from 'vitest';

import { deriveKey, exportKeyRaw } from '../../../crypto';
import { deriveDrivePackSubkeys, driveSaltFromFolderIdAsync } from '../../../crypto/subkeys';
import type { DriveClient, DriveFileMeta } from '../client';
import { makeDrivePackCrypto } from '../pack-crypto';
import { emptyDrivePackManifest } from '../pack-types';
import { resolveDriveStorageByPassphrase } from '../root-resolver';

interface CandidateFixture {
    root: DriveFileMeta;
    children: DriveFileMeta[];
    manifestBytes: Uint8Array;
}

async function encryptedCandidate(options: {
    rootId: string;
    passphrase: string;
    createdTime: string;
    itemCount?: number;
}): Promise<CandidateFixture> {
    const { key } = await deriveKey(
        options.passphrase,
        await driveSaltFromFolderIdAsync(options.rootId),
        { extractable: true },
    );
    const crypto = makeDrivePackCrypto(
        await deriveDrivePackSubkeys(await exportKeyRaw(key), options.rootId),
    );
    const manifest = emptyDrivePackManifest(`device:${options.rootId}`);
    for (let index = 0; index < (options.itemCount ?? 1); index += 1) {
        manifest.items[`preset/${index}`] = {
            id: `preset/${index}`,
            type: 'preset',
            hash: `hash-${index}`,
            size: 1,
            mtime: index,
            chunks: [],
        };
    }
    return {
        root: {
            id: options.rootId,
            name: 'TavernSync',
            appProperties: { ts: 'root-v2' },
        },
        children: [
            { id: `packs:${options.rootId}`, name: 'packs' },
            { id: `manifests:${options.rootId}`, name: 'manifests' },
        ],
        manifestBytes: await crypto.encryptManifest(manifest),
    };
}

function clientFor(candidates: readonly CandidateFixture[]): DriveClient & { createFolder: ReturnType<typeof vi.fn> } {
    const createFolder = vi.fn();
    return {
        searchRootFolders: vi.fn(async () => candidates.map(candidate => candidate.root)),
        listChildren: vi.fn(async (parentId: string) => {
            const candidate = candidates.find(value =>
                value.root.id === parentId || `manifests:${value.root.id}` === parentId);
            if (!candidate) return [];
            if (candidate.root.id === parentId) return candidate.children;
            return [{
                id: `commit-file:${candidate.root.id}`,
                name: `commit:${candidate.root.id}.enc`,
                createdTime: candidate.root.id === 'newer'
                    ? '2026-08-10T10:00:00Z'
                    : '2026-08-09T10:00:00Z',
                appProperties: { ts: 'commit-v2' },
            }];
        }),
        getFileData: vi.fn(async (fileId: string) => {
            const rootId = fileId.replace('commit-file:', '');
            const candidate = candidates.find(value => value.root.id === rootId);
            if (!candidate) throw new Error(`missing fixture: ${fileId}`);
            return candidate.manifestBytes;
        }),
        createFolder,
    } as unknown as DriveClient & { createFolder: ReturnType<typeof vi.fn> };
}

describe('Drive encrypted storage resolver', () => {
    it('selects the newest candidate whose manifest authenticates with the passphrase', async () => {
        const candidates = await Promise.all([
            encryptedCandidate({ rootId: 'wrong-key', passphrase: 'another key', createdTime: '2026-08-11T10:00:00Z' }),
            encryptedCandidate({ rootId: 'older', passphrase: 'shared key', createdTime: '2026-08-09T10:00:00Z' }),
            encryptedCandidate({ rootId: 'newer', passphrase: 'shared key', createdTime: '2026-08-10T10:00:00Z', itemCount: 2 }),
        ]);
        const client = clientFor(candidates);

        await expect(resolveDriveStorageByPassphrase({
            client,
            passphrase: 'shared key',
        })).resolves.toMatchObject({
            kind: 'ready',
            layout: { rootId: 'newer' },
            itemCount: 2,
        });
        expect(client.createFolder).not.toHaveBeenCalled();
    });
});
