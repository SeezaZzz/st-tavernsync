import { describe, expect, it } from 'vitest';

import type { DrivePackCrypto } from '../pack-crypto';
import { DrivePackStore } from '../pack-store';
import {
    DRIVE_V2_CHUNK_BYTES,
    DRIVE_V2_PACK_BYTES,
    type DrivePackManifestV2,
    type EncryptedPack,
} from '../pack-types';
import type { DriveClient, DriveFileMeta, ResumableRangeResult } from '../client';

function manifestFixture(id: string): DrivePackManifestV2 {
    return {
        schema: 2,
        storage: 'drive-pack-v2',
        device: 'pc',
        updatedAt: 123,
        chunkBytes: DRIVE_V2_CHUNK_BYTES,
        packBytes: DRIVE_V2_PACK_BYTES,
        items: {
            [id]: {
                id,
                type: 'character',
                hash: 'item-hash',
                size: 4,
                mtime: 456,
                chunks: [{
                    packName: 'pack-a',
                    offset: 0,
                    boxedLength: 4,
                    plainLength: 1,
                    chunkHash: 'chunk-hash',
                }],
            },
        },
    };
}

function packFixtures(): EncryptedPack[] {
    return [
        { name: 'pack-a', bytes: new Uint8Array([1, 2, 3, 4]), chunks: [] },
        { name: 'pack-b', bytes: new Uint8Array([5, 6, 7]), chunks: [] },
    ];
}

function cryptoStub(): DrivePackCrypto {
    return {
        async encryptChunk(value) { return value; },
        async decryptChunk(value) { return value; },
        async packName() { return 'unused'; },
        async encryptManifest() { return new Uint8Array([0xca, 0xfe, 0xba, 0xbe]); },
        async decryptManifest() { throw new Error('not used'); },
    };
}

function makeStore(options: {
    existing?: DriveFileMeta[];
    manifests?: DriveFileMeta[];
    uploadedMetadataOmitsSize?: boolean;
} = {}) {
    const files = new Map((options.existing ?? []).map(file => [file.name, file]));
    const sessions = new Map<string, { name: string; totalBytes: number }>();
    const events: string[] = [];
    const commitBytes: Uint8Array[] = [];
    const client = {
        beginCalls: 0,
        async listChildren(parentId: string): Promise<DriveFileMeta[]> {
            return parentId === 'packs-id' ? [...files.values()] : (options.manifests ?? []);
        },
        async beginResumableFile(
            _parentId: string,
            name: string,
            totalBytes: number,
        ): Promise<string> {
            client.beginCalls += 1;
            const session = `session:${name}`;
            sessions.set(session, { name, totalBytes });
            return session;
        },
        async putResumableRange(session: string): Promise<ResumableRangeResult> {
            const pending = sessions.get(session);
            if (!pending) throw new Error('unknown session');
            const file: DriveFileMeta = {
                id: `id:${pending.name}`,
                name: pending.name,
                ...(options.uploadedMetadataOmitsSize ? {} : { size: String(pending.totalBytes) }),
            };
            files.set(file.name, file);
            events.push(`upload:${file.name}`);
            return { kind: 'complete', file };
        },
        async queryResumableFile(): Promise<ResumableRangeResult> {
            throw new Error('not used');
        },
        async createFile(
            _parentId: string,
            name: string,
            bytes: Uint8Array,
            properties?: Record<string, string>,
        ): Promise<DriveFileMeta> {
            expect(properties).toEqual({ ts: 'commit-v2' });
            events.push('commit');
            commitBytes.push(bytes);
            return { id: `commit:${name}`, name, size: String(bytes.byteLength) };
        },
    };
    const store = new DrivePackStore(
        client as unknown as DriveClient,
        cryptoStub(),
        { rootId: 'root-id', packsId: 'packs-id', manifestsId: 'manifests-id' },
    );
    return { store, client, events, commitBytes };
}

describe('Drive pack store', () => {
    it('detects an existing committed v2 snapshot', async () => {
        const { store } = makeStore({
            manifests: [{ id: 'm1', name: 'commit.enc', appProperties: { ts: 'commit-v2' } }],
        });
        await expect(store.hasCommittedSnapshot()).resolves.toBe(true);
    });

    it('reuses a completed pack with matching name and size', async () => {
        const { store, client } = makeStore({ existing: [{ id: 'p1', name: 'pack-a', size: '32' }] });
        await store.putPack({ name: 'pack-a', bytes: new Uint8Array(32), chunks: [] });
        expect(client.beginCalls).toBe(0);
    });

    it('rejects an existing pack name with the wrong size', async () => {
        const { store } = makeStore({ existing: [{ id: 'p1', name: 'pack-a', size: '31' }] });
        await expect(store.verifyPacks([{ name: 'pack-a', byteLength: 32 }]))
            .rejects.toThrow('pack size mismatch');
    });

    it('verifies a newly uploaded pack when Drive omits size from the completion response', async () => {
        const { store } = makeStore({ uploadedMetadataOmitsSize: true });
        const pack = { name: 'pack-a', bytes: new Uint8Array(32), chunks: [] };
        await store.putPack(pack);
        await expect(store.verifyPacks([{ name: pack.name, byteLength: pack.bytes.byteLength }]))
            .resolves.toBeUndefined();
    });

    it('refuses manifest publication before pack verification', async () => {
        const { store } = makeStore();
        await expect(store.commitManifest(manifestFixture('character/private.png')))
            .rejects.toThrow('packs must be verified');
    });

    it('commits schema 2 ciphertext after expected packs verify', async () => {
        const { store, events, commitBytes } = makeStore();
        const packs = packFixtures();
        for (const pack of packs) await store.putPack(pack);
        await store.verifyPacks(packs.map(pack => ({ name: pack.name, byteLength: pack.bytes.byteLength })));
        await store.commitManifest(manifestFixture('character/private.png'));
        expect(events.at(-1)).toBe('commit');
        expect(new TextDecoder().decode(commitBytes[0])).not.toContain('private.png');
    });
});
