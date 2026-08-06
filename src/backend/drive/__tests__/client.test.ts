import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DriveClient } from '../client';

const tp = { getToken: async () => 'tok' };

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn(handler));
}

describe('DriveClient', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('listChildren รวมทุกหน้า (paging) และใส่ parent + trashed=false ใน query', async () => {
        const seen: string[] = [];
        stubFetch(async (url) => {
            seen.push(String(url));
            if (seen.length === 1) {
                return new Response(JSON.stringify({ files: [{ id: 'a', name: 'x' }], nextPageToken: 'p2' }), { status: 200 });
            }
            return new Response(JSON.stringify({ files: [{ id: 'b', name: 'y' }] }), { status: 200 });
        });
        const c = new DriveClient(tp);
        const files = await c.listChildren('parent1');
        expect(files.map(f => f.id)).toEqual(['a', 'b']);
        expect(seen[0]).toContain('pageToken');
        expect(decodeURIComponent(seen[0])).toContain("'parent1' in parents");
        expect(decodeURIComponent(seen[0])).toContain('trashed=false');
        expect(seen[1]).toContain('pageToken=p2');
    });

    it('createFile เล็กใช้ multipart; ใหญ่กว่า 5MB ใช้ resumable (initiate แล้ว PUT)', async () => {
        const urls: string[] = [];
        stubFetch(async (url, init) => {
            urls.push(`${init?.method ?? 'GET'} ${url}`);
            if (String(url).includes('uploadType=resumable') && init?.method === 'POST') {
                return new Response('', { status: 200, headers: { Location: 'https://upload/session1' } });
            }
            return new Response(JSON.stringify({ id: 'f1', name: 'n' }), { status: 200 });
        });
        const c = new DriveClient(tp);
        await c.createFile('p', 'small', new Uint8Array(100));
        await c.createFile('p', 'big', new Uint8Array(6 * 1024 * 1024));
        expect(urls[0]).toContain('uploadType=multipart');
        expect(urls.some(u => u.includes('uploadType=resumable') && u.startsWith('POST'))).toBe(true);
        expect(urls.some(u => u === 'PUT https://upload/session1')).toBe(true);
    });

    it('getQuota อ่าน storageQuota; ถ้าไม่มี limit คืน 0', async () => {
        stubFetch(async () => new Response(JSON.stringify({ storageQuota: { usage: '10', limit: '20' } }), { status: 200 }));
        const c = new DriveClient(tp);
        expect(await c.getQuota()).toEqual({ usedBytes: 10, limitBytes: 20 });
        stubFetch(async () => new Response(JSON.stringify({ storageQuota: { usage: '10' } }), { status: 200 }));
        expect(await c.getQuota()).toEqual({ usedBytes: 10, limitBytes: 0 });
    });

    it('401 จาก Drive โยน DriveAuthError (ให้ UI เด้ง reconnect)', async () => {
        stubFetch(async () => new Response('{}', { status: 401 }));
        const c = new DriveClient(tp);
        await expect(c.getQuota()).rejects.toMatchObject({ name: 'DriveAuthError' });
    });

    it('createFolder ส่ง mimeType folder + appProperties และแนบ parentId ถ้ามี', async () => {
        const bodies: string[] = [];
        stubFetch(async (_url, init) => {
            bodies.push(String(init?.body));
            return new Response(JSON.stringify({ id: 'd1', name: 'folder' }), { status: 200 });
        });
        const c = new DriveClient(tp);
        const meta = await c.createFolder('folder', { ts: 'root-v1' }, 'parent9');
        expect(meta.id).toBe('d1');
        const body = JSON.parse(bodies[0]);
        expect(body.mimeType).toBe('application/vnd.google-apps.folder');
        expect(body.appProperties).toEqual({ ts: 'root-v1' });
        expect(body.parents).toEqual(['parent9']);
    });

    it('searchRootFolders ค้นหา appProperties ts=root-v1, trashed=false, pageSize=100', async () => {
        const seen: string[] = [];
        stubFetch(async (url) => {
            seen.push(String(url));
            return new Response(JSON.stringify({ files: [{ id: 'r1', name: 'TavernSync' }] }), { status: 200 });
        });
        const c = new DriveClient(tp);
        const roots = await c.searchRootFolders();
        expect(roots.map(f => f.id)).toEqual(['r1']);
        const q = decodeURIComponent(seen[0]);
        expect(q).toContain("appProperties has { key='ts' and value='root-v1' }");
        expect(q).toContain('trashed=false');
        expect(seen[0]).toContain('pageSize=100');
    });
});
