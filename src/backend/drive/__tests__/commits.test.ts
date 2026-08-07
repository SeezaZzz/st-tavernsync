import { describe, expect, it, vi } from 'vitest';
import { parseCommitMeta, computeHeads, revisionOfHeads, findCommonAncestor, type CommitMeta } from '../commits';
import { DriveAdapter } from '../adapter';
import { ConflictError } from '../../adapter';
import type { DriveClient, DriveFileMeta } from '../client';
import type { BackendCrypto } from '../../runtime';
import { emptyManifest, type Manifest } from '../../../sync-core/types';

function commit(commitId: string, parents: string[] = []): CommitMeta {
    return { id: 'file_' + commitId, commitId, parents, createdTime: '2026-08-06T00:00:00Z' };
}

describe('commit graph', () => {
    it('parseCommitMeta อ่าน p0..p3 และเช็ก marker ts=commit-v1', () => {
        const m = parseCommitMeta({
            id: 'f1', name: 'a'.repeat(32) + '.enc',
            appProperties: { ts: 'commit-v1', p0: 'b'.repeat(32), p1: 'c'.repeat(32) },
        });
        expect(m.commitId).toBe('a'.repeat(32));
        expect(m.parents).toEqual(['b'.repeat(32), 'c'.repeat(32)]);
    });

    it('computeHeads คืน commit ที่ไม่มีใครชี้เป็น parent', () => {
        const c1 = commit('1'.repeat(32));
        const c2 = commit('2'.repeat(32), ['1'.repeat(32)]);
        const c3 = commit('3'.repeat(32), ['1'.repeat(32)]);
        const heads = computeHeads([c1, c2, c3]);
        expect(heads.map(h => h.commitId).sort()).toEqual(['2'.repeat(32), '3'.repeat(32)]);
    });

    it('revisionOfHeads deterministic และเปลี่ยนตามชุด heads', async () => {
        const c2 = commit('2'.repeat(32));
        const c3 = commit('3'.repeat(32));
        expect(await revisionOfHeads([c2, c3])).toBe(await revisionOfHeads([c3, c2])); // เรียงก่อน hash
        expect(await revisionOfHeads([c2])).not.toBe(await revisionOfHeads([c2, c3]));
    });

    it('findCommonAncestor หาจุดแยกของ fork', () => {
        const base = commit('0'.repeat(32));
        const a = commit('a'.repeat(32), ['0'.repeat(32)]);
        const b = commit('b'.repeat(32), ['0'.repeat(32)]);
        const found = findCommonAncestor(a, b, [base, a, b]);
        expect(found?.commitId).toBe('0'.repeat(32));
    });

    it('findCommonAncestor กรณีไม่มีจุดร่วม คืน null', () => {
        const a = commit('a'.repeat(32));
        const b = commit('b'.repeat(32));
        expect(findCommonAncestor(a, b, [a, b])).toBeNull();
    });
});

const cryptoStub: BackendCrypto = {
    encryptBlob: async d => d,
    decryptBlob: async d => d,
    encodeManifest: async m => new TextEncoder().encode(JSON.stringify(m)),
    decodeManifest: async d => JSON.parse(new TextDecoder().decode(d)),
    blobNameFor: async h => 'hmac_' + h,
};

function commitFile(commitId: string, parents: string[] = []): DriveFileMeta {
    const appProperties: Record<string, string> = { ts: 'commit-v1' };
    parents.forEach((p, i) => { appProperties[`p${i}`] = p; });
    return { id: 'file_' + commitId, name: commitId + '.enc', appProperties, createdTime: '2026-08-06T00:00:00Z' };
}

/** clientStub pattern เดียวกับ adapter-blobs.test.ts แต่ getFileData แยกตาม file id */
function manifestClientStub(files: DriveFileMeta[], manifestByFileId: Record<string, Manifest> = {}): DriveClient {
    return {
        listChildren: vi.fn(async () => files),
        findChildByName: vi.fn(async (_p: string, name: string) => files.find(f => f.name === name) ?? null),
        createFolder: vi.fn(async (name: string) => ({ id: 'new_' + name, name })),
        createFile: vi.fn(async (_p: string, name: string) => ({ id: 'up_' + name, name })),
        getFileData: vi.fn(async (id: string) => new TextEncoder().encode(JSON.stringify(manifestByFileId[id]))),
        trashFile: vi.fn(async () => {}),
        getQuota: vi.fn(async () => ({ usedBytes: 0, limitBytes: 15 })),
        searchRootFolders: vi.fn(async () => []),
    } as unknown as DriveClient;
}

describe('DriveAdapter manifest commits', () => {
    const layout = { rootId: 'r', manifestsId: 'm', blobsId: 'b' };

    it('putManifest เมื่อ revision ไม่ตรง → ConflictError และไม่สร้างไฟล์', async () => {
        const existing = commitFile('1'.repeat(32));
        const client = manifestClientStub([existing]);
        const a = new DriveAdapter(client, cryptoStub, layout);
        const m = emptyManifest('dev', 2);
        // heads = [c1] → revision ปัจจุบัน ≠ '0'
        await expect(a.putManifest(m, '0')).rejects.toBeInstanceOf(ConflictError);
        expect(client.createFile).not.toHaveBeenCalled();
    });

    it('push ครั้งแรก (ไม่มี commit) ใช้ ifRevision "0" สร้าง commit แรกสำเร็จ', async () => {
        const client = manifestClientStub([]);
        const a = new DriveAdapter(client, cryptoStub, layout);
        const m = emptyManifest('dev', 1);
        const { revision } = await a.putManifest(m, '0');
        expect(revision).toMatch(/^[0-9a-f]{64}$/);
        expect(client.createFile).toHaveBeenCalledTimes(1);
        const [parentId, name, data, appProperties] = (client.createFile as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, Uint8Array, Record<string, string>];
        expect(parentId).toBe('m');
        expect(name).toMatch(/^[0-9a-f]{32}\.enc$/);
        expect(appProperties.ts).toBe('commit-v1');
        expect(appProperties).not.toHaveProperty('p0');
        expect(await cryptoStub.decodeManifest(data)).toEqual(m);
    });

    it('getSnapshot เจอ 2 heads → kind fork พร้อม heads + commonAncestor', async () => {
        const base = '0'.repeat(32), headA = 'a'.repeat(32), headB = 'b'.repeat(32);
        const baseManifest = emptyManifest('dev', 1);
        const manifestA = { ...emptyManifest('devA', 2), items: { x: { hash: 'hx', size: 1, updatedAt: 1, type: 'settings' } as never } };
        const manifestB = { ...emptyManifest('devB', 2), items: { y: { hash: 'hy', size: 1, updatedAt: 1, type: 'settings' } as never } };
        const client = manifestClientStub(
            [commitFile(base), commitFile(headA, [base]), commitFile(headB, [base])],
            { ['file_' + base]: baseManifest, ['file_' + headA]: manifestA, ['file_' + headB]: manifestB },
        );
        const a = new DriveAdapter(client, cryptoStub, layout);
        const snap = await a.getSnapshot();
        expect(snap.kind).toBe('fork');
        if (snap.kind !== 'fork') return;
        expect(snap.heads.map(h => h.commitId).sort()).toEqual([headA, headB].sort());
        expect(snap.commonAncestor).toEqual(baseManifest);
        expect(snap.revision).toMatch(/^[0-9a-f]{64}$/);
    });

    it('putManifest เมื่อ heads > 4 → สร้าง merge commit กลาง (≤4 parents) ก่อน commit สุดท้าย', async () => {
        const headIds = ['1', '2', '3', '4', '5'].map(c => c.repeat(32));
        const files = headIds.map(id => commitFile(id));
        const client = manifestClientStub(files);
        const a = new DriveAdapter(client, cryptoStub, layout);
        const m = emptyManifest('dev', 9);
        const revision = await revisionOfHeads(files.map(parseCommitMeta));
        const result = await a.putManifest(m, revision);
        expect(result.revision).toMatch(/^[0-9a-f]{64}$/);
        // commit กลาง 1 ตัว (parents = 4 heads แรก) + commit สุดท้าย (parents = กลาง + head ที่เหลือ)
        expect(client.createFile).toHaveBeenCalledTimes(2);
        const calls = (client.createFile as ReturnType<typeof vi.fn>).mock.calls as [string, string, Uint8Array, Record<string, string>][];
        const [, midName, , midProps] = calls[0];
        expect(midProps).toEqual({ ts: 'commit-v1', p0: headIds[0], p1: headIds[1], p2: headIds[2], p3: headIds[3] });
        const [, finalName, , finalProps] = calls[1];
        expect(finalProps.ts).toBe('commit-v1');
        expect(finalProps.p0).toBe(midName.replace(/\.enc$/, '')); // parent แรก = commit กลาง
        expect(finalProps.p1).toBe(headIds[4]);
        expect(finalProps).not.toHaveProperty('p2');
        expect(finalName).toMatch(/^[0-9a-f]{32}\.enc$/);
    });
});
