import { describe, expect, it, vi } from 'vitest';
import { DriveAdapter, discoverDriveLayout, MultipleRootsError } from '../adapter';
import type { DriveClient, DriveFileMeta } from '../client';
import type { BackendCrypto } from '../../runtime';

const cryptoStub: BackendCrypto = {
    encryptBlob: async d => d,
    decryptBlob: async d => d,
    encodeManifest: async m => new TextEncoder().encode(JSON.stringify(m)),
    decodeManifest: async d => JSON.parse(new TextDecoder().decode(d)),
    blobNameFor: async h => 'hmac_' + h,
};

function clientStub(files: DriveFileMeta[]): DriveClient {
    return {
        listChildren: vi.fn(async () => files),
        findChildByName: vi.fn(async (_p: string, name: string) => files.find(f => f.name === name) ?? null),
        createFolder: vi.fn(async (name: string, _appProperties: Record<string, string>, parentId?: string) => ({ id: 'new_' + name, name, parents: parentId ? [parentId] : [] })),
        createFile: vi.fn(async (_p: string, name: string) => ({ id: 'up_' + name, name })),
        getFileData: vi.fn(async () => new Uint8Array([1, 2, 3])),
        trashFile: vi.fn(async () => {}),
        getQuota: vi.fn(async () => ({ usedBytes: 5, limitBytes: 15 })),
        searchRootFolders: vi.fn(async () => files.filter(f => f.appProperties?.ts === 'root-v1')),
    } as unknown as DriveClient;
}

describe('DriveAdapter blobs', () => {
    const layout = { rootId: 'r', manifestsId: 'm', blobsId: 'b' };

    it('checkBlobs แปลง logical hash เป็น HMAC แล้วเทียบกับไฟล์ใน blobs/', async () => {
        const client = clientStub([{ id: 'f1', name: 'hmac_aaa' }]);
        const a = new DriveAdapter(client, cryptoStub, layout);
        expect(await a.checkBlobs(['aaa', 'bbb'])).toEqual(['bbb']);
        expect(client.listChildren).toHaveBeenCalledWith('b');
    });

    it('putBlob ข้ามถ้ามีไฟล์ชื่อเดียวกันอยู่แล้ว', async () => {
        const client = clientStub([{ id: 'f1', name: 'hmac_aaa' }]);
        const a = new DriveAdapter(client, cryptoStub, layout);
        await a.putBlob('aaa', new Uint8Array([9]));
        expect(client.createFile).not.toHaveBeenCalled();
    });

    it('getBlob หาไฟล์จากชื่อ HMAC แล้วอ่านข้อมูล', async () => {
        const client = clientStub([{ id: 'f1', name: 'hmac_aaa' }]);
        const a = new DriveAdapter(client, cryptoStub, layout);
        expect([...(await a.getBlob('aaa'))]).toEqual([1, 2, 3]);
        await expect(a.getBlob('zzz')).rejects.toThrow();
    });

    it('quota รวม storageQuota กับจำนวนไฟล์ใน blobs/', async () => {
        const client = clientStub([{ id: 'f1', name: 'hmac_aaa' }, { id: 'f2', name: 'hmac_bbb' }]);
        const a = new DriveAdapter(client, cryptoStub, layout);
        expect(await a.quota()).toEqual({ usedBytes: 5, limitBytes: 15, itemCount: 2 });
    });
});

describe('discoverDriveLayout', () => {
    it('ไม่เจอ root → สร้าง root + manifests + blobs (subfolder อยู่ใต้ root)', async () => {
        const client = clientStub([]);
        const layout = await discoverDriveLayout(client);
        expect(layout).toEqual({ rootId: 'new_TavernSync', manifestsId: 'new_manifests', blobsId: 'new_blobs' });
        expect(client.createFolder).toHaveBeenCalledWith('manifests', {}, 'new_TavernSync');
        expect(client.createFolder).toHaveBeenCalledWith('blobs', {}, 'new_TavernSync');
    });

    it('เจอ root เดียว → ใช้ manifests/blobs ที่มีอยู่', async () => {
        const root = { id: 'r1', name: 'TavernSync', appProperties: { ts: 'root-v1' } };
        const children = [
            { id: 'm1', name: 'manifests' },
            { id: 'b1', name: 'blobs' },
        ];
        const client = {
            ...clientStub(children),
            searchRootFolders: vi.fn(async () => [root]),
        } as unknown as DriveClient;
        const layout = await discoverDriveLayout(client);
        expect(layout).toEqual({ rootId: 'r1', manifestsId: 'm1', blobsId: 'b1' });
    });

    it('เจอหลาย root → MultipleRootsError พร้อมรายการ', async () => {
        const roots = [
            { id: 'r1', name: 'TavernSync', appProperties: { ts: 'root-v1' } },
            { id: 'r2', name: 'TavernSync', appProperties: { ts: 'root-v1' } },
        ];
        const client = {
            ...clientStub(roots),
            // root discovery ค้นทั้ง Drive (q: appProperties) ไม่ใช่ listChildren
            searchRootFolders: vi.fn(async () => roots),
        } as unknown as DriveClient;
        await expect(discoverDriveLayout(client)).rejects.toBeInstanceOf(MultipleRootsError);
    });
});
