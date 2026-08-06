import { describe, expect, it, vi, beforeEach } from 'vitest';
import { HttpStorageAdapter } from '../http';

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('HttpStorageAdapter revision boundary', () => {
    beforeEach(() => { vi.restoreAllMocks(); });

    it('getSnapshot คืน kind single และ revision เป็น string จาก header X-Manifest-Version', async () => {
        const manifest = { version: 7, schema: 1, device: 'pc', updatedAt: 1, items: {} };
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ manifest }, { 'X-Manifest-Version': '7' })));
        const a = new HttpStorageAdapter({ endpoint: 'https://x.workers.dev', deviceToken: 'tok12345' });
        const snap = await a.getSnapshot();
        expect(snap.kind).toBe('single');
        if (snap.kind === 'single') {
            expect(snap.revision).toBe('7');
            expect(snap.manifest).toEqual(manifest);
        }
    });

    it('putManifest ส่ง If-Match เป็นตัวเลขเดิมบน wire (parse จาก StorageRevision)', async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return jsonResponse({ version: 8 }); }));
        const a = new HttpStorageAdapter({ endpoint: 'https://x.workers.dev', deviceToken: 'tok12345' });
        const m = { version: 8, schema: 1 as const, device: 'pc', updatedAt: 2, items: {} };
        const r = await a.putManifest(m, '7');
        expect(r.revision).toBe('8');
        expect((calls[0].init.headers as Record<string, string>)['If-Match']).toBe('7');
        expect(String(calls[0].url)).toBe('https://x.workers.dev/v1/manifest');
    });

    it('putManifest เจอ 412 → ConflictError', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'conflict', version: 9 }, {}, 412)));
        const a = new HttpStorageAdapter({ endpoint: 'https://x.workers.dev', deviceToken: 'tok12345' });
        await expect(a.putManifest({ version: 9, schema: 1, device: 'pc', updatedAt: 3, items: {} }, '7'))
            .rejects.toMatchObject({ name: 'ConflictError' });
    });
});
