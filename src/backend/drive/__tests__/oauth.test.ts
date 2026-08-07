import { describe, expect, it, vi } from 'vitest';
import { GisTokenProvider } from '../oauth';

function gisStub() {
    const calls: { prompt?: string }[] = [];
    const listeners: ((resp: { access_token?: string; error?: string; expires_in?: number }) => void)[] = [];
    return {
        calls,
        client: {
            requestAccessToken(opts?: { prompt?: string }) {
                calls.push(opts ?? {});
                listeners.forEach(fn => fn({ access_token: 'token_' + calls.length, expires_in: 3600 }));
            },
        } as never,
        setCallback(fn: (resp: { access_token?: string; error?: string; expires_in?: number }) => void) { listeners.push(fn); },
    };
}

describe('GisTokenProvider', () => {
    it('getToken ครั้งแรกขอ token ผ่าน GIS และ cache ไว้', async () => {
        const g = gisStub();
        const p = new GisTokenProvider('cid', async () => g.client, g.setCallback);
        expect(await p.getToken()).toBe('token_1');
        expect(await p.getToken()).toBe('token_1'); // cache
        expect(g.calls).toHaveLength(1);
    });

    it('token หมดอายุ → ขอใหม่แบบ prompt ว่าง (ตอน gesture ถัดไป)', async () => {
        const g = gisStub();
        const p = new GisTokenProvider('cid', async () => g.client, g.setCallback);
        await p.getToken();
        p.markExpiredForTest();
        expect(await p.getToken()).toBe('token_2');
        expect(g.calls[1]?.prompt).toBe('');
    });

    it('revoke ล้าง token ใน memory', async () => {
        const g = gisStub();
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
        const p = new GisTokenProvider('cid', async () => g.client, g.setCallback);
        await p.getToken();
        await p.revoke();
        expect(await p.getToken()).toBe('token_2');
    });
});
