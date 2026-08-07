import { describe, expect, it, vi } from 'vitest';
import { collectGarbage } from '../gc';
import type { DriveClient, DriveFileMeta } from '../client';
import type { DriveAdapter, DriveLayout } from '../adapter';
import type { BackendCrypto } from '../../runtime';
import type { Manifest } from '../../../sync-core/types';

const cryptoStub: BackendCrypto = {
    encryptBlob: async d => d,
    decryptBlob: async d => d,
    encodeManifest: async m => new TextEncoder().encode(JSON.stringify(m)),
    decodeManifest: async d => JSON.parse(new TextDecoder().decode(d)),
    blobNameFor: async h => 'hmac_' + h,
};

const layout: DriveLayout = { rootId: 'r', manifestsId: 'm', blobsId: 'b' };
const adapterStub = {} as DriveAdapter; // GC ใช้ client/layout/crypto โดยตรง — adapter ไม่ถูกแตะ

const DAY = 24 * 60 * 60 * 1000;
const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

function commitFile(commitId: string, parents: string[], createdTime = ''): DriveFileMeta {
    const appProperties: Record<string, string> = { ts: 'commit-v1' };
    parents.forEach((p, i) => { appProperties[`p${i}`] = p; });
    return { id: 'file_' + commitId, name: commitId + '.enc', createdTime, appProperties };
}

function manifestWith(hashes: string[], deleted: string[] = []): Manifest {
    const items: Manifest['items'] = {};
    for (const h of hashes) items[`chat/${h}`] = { id: `chat/${h}`, type: 'chat', hash: h, size: 1, mtime: 1 };
    for (const h of deleted) items[`chat/${h}`] = { id: `chat/${h}`, type: 'chat', hash: h, size: 1, mtime: 1, deleted: 1 };
    return { version: 1, schema: 1, device: 'test', updatedAt: 1, items };
}

/** client stub แยกไฟล์ตาม folder; manifests ผูก manifest จริงผ่าน encodeManifest ของ cryptoStub */
async function makeClient(opts: {
    commits: { meta: DriveFileMeta; manifest: Manifest }[];
    blobs: DriveFileMeta[];
}): Promise<{ client: DriveClient; trashed: string[] }> {
    const trashed: string[] = [];
    const manifestData = new Map<string, Uint8Array>();
    for (const c of opts.commits) {
        manifestData.set(c.meta.id, await cryptoStub.encodeManifest(c.manifest));
    }
    const client = {
        listChildren: vi.fn(async (parentId: string) => {
            if (parentId === layout.manifestsId) return opts.commits.map(c => c.meta);
            if (parentId === layout.blobsId) return opts.blobs;
            return [];
        }),
        getFileData: vi.fn(async (id: string) => manifestData.get(id) ?? new Uint8Array()),
        trashFile: vi.fn(async (id: string) => { trashed.push(id); }),
    } as unknown as DriveClient;
    return { client, trashed };
}

describe('collectGarbage', () => {
    it('มี fork (2 heads) → ปฏิเสธ GC ไม่ trash อะไรทั้งนั้น', async () => {
        const { client, trashed } = await makeClient({
            commits: [
                { meta: commitFile('aaa', []), manifest: manifestWith(['x']) },
                { meta: commitFile('bbb', []), manifest: manifestWith(['y']) },
            ],
            blobs: [{ id: 'blob_orphan', name: 'hmac_old', createdTime: isoDaysAgo(30) }],
        });
        await expect(collectGarbage(client, adapterStub, layout, cryptoStub)).rejects.toThrow(/fork/);
        expect(trashed).toEqual([]);
    });

    it('blob orphan เก่ากว่า 7 วัน → ถูก trash', async () => {
        const { client, trashed } = await makeClient({
            commits: [{ meta: commitFile('aaa', []), manifest: manifestWith(['live']) }],
            blobs: [
                { id: 'blob_live', name: 'hmac_live', createdTime: isoDaysAgo(1) },
                { id: 'blob_orphan', name: 'hmac_gone', createdTime: isoDaysAgo(30) },
            ],
        });
        const res = await collectGarbage(client, adapterStub, layout, cryptoStub);
        expect(trashed).toEqual(['blob_orphan']);
        expect(res.trashedBlobs).toBe(1);
        expect(res.trashedCommits).toBe(0);
    });

    it('blob orphan แต่อายุ < 7 วัน → รอด (grace period)', async () => {
        const { client, trashed } = await makeClient({
            commits: [{ meta: commitFile('aaa', []), manifest: manifestWith(['live']) }],
            blobs: [
                { id: 'blob_live', name: 'hmac_live', createdTime: isoDaysAgo(30) },
                { id: 'blob_young', name: 'hmac_gone', createdTime: isoDaysAgo(3) },
            ],
        });
        const res = await collectGarbage(client, adapterStub, layout, cryptoStub);
        expect(trashed).toEqual([]);
        expect(res.trashedBlobs).toBe(0);
    });

    it('blob ที่ retained commit อ้างถึง → รอดเสมอ (แม้เก่ามาก)', async () => {
        // head อ้าง 'new'; commit ตัวที่ 10 ใน chain (ยัง retained) อ้าง 'old' → ทั้งคู่รอด
        const commits = [{ meta: commitFile('c00', ['c01']), manifest: manifestWith(['new']) }];
        for (let i = 1; i <= 9; i++) {
            const id = `c${String(i).padStart(2, '0')}`;
            commits.push({ meta: commitFile(id, [`c${String(i + 1).padStart(2, '0')}`]), manifest: manifestWith([i === 9 ? 'old' : 'mid']) });
        }
        commits.push({ meta: commitFile('c10', []), manifest: manifestWith(['mid']) }); // ตัวที่ 11 → โดน prune
        const { client, trashed } = await makeClient({
            commits,
            blobs: [
                { id: 'blob_new', name: 'hmac_new', createdTime: isoDaysAgo(60) },
                { id: 'blob_old', name: 'hmac_old', createdTime: isoDaysAgo(60) },
            ],
        });
        const res = await collectGarbage(client, adapterStub, layout, cryptoStub);
        expect(trashed).toEqual(['file_c10']); // prune commit เกิน 10 เท่านั้น ไม่แตะ blob
        expect(res.trashedBlobs).toBe(0);
        expect(res.trashedCommits).toBe(1);
    });

    it('เหลือ head เดียวและ chain ยาวเกิน 10 → trash commits เก่าสุด เหลือ 10', async () => {
        const commits = [];
        for (let i = 0; i < 15; i++) {
            const id = `k${String(i).padStart(2, '0')}`;
            commits.push({ meta: commitFile(id, i === 14 ? [] : [`k${String(i + 1).padStart(2, '0')}`]), manifest: manifestWith(['v']) });
        }
        const { client, trashed } = await makeClient({ commits, blobs: [{ id: 'blob_v', name: 'hmac_v', createdTime: isoDaysAgo(1) }] });
        const res = await collectGarbage(client, adapterStub, layout, cryptoStub);
        expect(res.trashedCommits).toBe(5);
        expect(trashed.sort()).toEqual(['file_k10', 'file_k11', 'file_k12', 'file_k13', 'file_k14']);
    });
});
