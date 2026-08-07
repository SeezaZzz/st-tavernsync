import { afterEach, describe, expect, it, vi } from 'vitest';
import { GisTokenProvider, getSharedGisTokenProvider } from '../oauth';

type GisResp = { access_token?: string; error?: string; expires_in?: number };

function gisStub() {
    const calls: { prompt?: string }[] = [];
    const listeners: ((resp: GisResp) => void)[] = [];
    return {
        calls,
        client: {
            callback: () => {},
            requestAccessToken(opts?: { prompt?: string }) {
                calls.push(opts ?? {});
                listeners.forEach(fn => fn({ access_token: 'token_' + calls.length, expires_in: 3600 }));
            },
        } as never,
        setCallback(fn: (resp: GisResp) => void) { listeners.push(fn); },
    };
}

/** stub document.createElement('script') + window.google.accounts.oauth2 สำหรับ default path (ไม่ inject stubs) */
function installGisGlobals(respond?: (inst: GisInstance, overrides: { prompt?: string }) => void) {
    vi.stubGlobal('document', {
        createElement: () => {
            const s: { src: string; onload: (() => void) | null; onerror: (() => void) | null } = {
                src: '', onload: null, onerror: null,
            };
            queueMicrotask(() => s.onload?.());
            return s;
        },
        head: { appendChild: () => {} },
    });
    const instances: GisInstance[] = [];
    vi.stubGlobal('window', {
        google: { accounts: { oauth2: {
            initTokenClient(cfg: { client_id: string; scope: string; callback: (r: GisResp) => void }) {
                const inst: GisInstance = {
                    initCallback: cfg.callback,
                    callback: cfg.callback,
                    calls: [],
                    requestAccessToken(overrides?: { prompt?: string }) {
                        inst.calls.push(overrides ?? {});
                        const fire = respond ?? ((i: GisInstance) => i.callback({ access_token: 'tok_' + i.calls.length, expires_in: 3600 }));
                        queueMicrotask(() => fire(inst, overrides ?? {}));
                    },
                };
                instances.push(inst);
                return inst;
            },
        } } },
    });
    return instances;
}

interface GisInstance {
    initCallback: (r: GisResp) => void;
    callback: (r: GisResp) => void;
    calls: { prompt?: string }[];
    requestAccessToken(overrides?: { prompt?: string }): void;
}

afterEach(() => { vi.unstubAllGlobals(); });

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

    it('default path (ไม่ inject stubs): resolve บน client instance เดียวกับที่รับ callback จริง', async () => {
        const instances = installGisGlobals();
        const p = new GisTokenProvider('cid');
        await expect(p.getToken()).resolves.toBe('tok_1');
        // ห้าม init client ตัวที่สองตอนขอ token — requestAccessToken ต้องยิงบน instance ที่ callback ถูกแนบ
        expect(instances).toHaveLength(1);
        expect(instances[0].calls).toEqual([{ prompt: '' }]);
        expect(instances[0].callback).not.toBe(instances[0].initCallback);
    });

    it('OAuth error → reject "Google sign-in failed: <code>" (ไม่ escalate ถ้าไม่ใช่ interaction_required)', async () => {
        const instances = installGisGlobals(inst => inst.callback({ error: 'access_denied' }));
        const p = new GisTokenProvider('cid');
        await expect(p.getToken()).rejects.toThrow('Google sign-in failed: access_denied');
        expect(instances[0].calls).toHaveLength(1);
    });

    it('prompt ว่างเจอ interaction_required → escalate เป็น consent บน instance เดิม', async () => {
        const instances = installGisGlobals((inst, o) => {
            if (o.prompt === '') inst.callback({ error: 'interaction_required' });
            else inst.callback({ access_token: 'tok_consent', expires_in: 3600 });
        });
        const p = new GisTokenProvider('cid');
        await expect(p.getToken()).resolves.toBe('tok_consent');
        expect(instances).toHaveLength(1);
        expect(instances[0].calls).toEqual([{ prompt: '' }, { prompt: 'consent' }]);
    });

    it('getToken พร้อมกันก่อน resolve → requestAccessToken ครั้งเดียว แชร์ token เดียวกัน', async () => {
        let listener: ((resp: GisResp) => void) | null = null;
        const calls: { prompt?: string }[] = [];
        const client = {
            callback: () => {},
            requestAccessToken(o?: { prompt?: string }) { calls.push(o ?? {}); },
        };
        const p = new GisTokenProvider('cid', async () => client as never, fn => { listener = fn; });
        const t1 = p.getToken();
        const t2 = p.getToken();
        await new Promise(r => setTimeout(r, 0));
        expect(calls).toHaveLength(1);
        listener!({ access_token: 'tok_shared', expires_in: 3600 });
        await expect(t1).resolves.toBe('tok_shared');
        await expect(t2).resolves.toBe('tok_shared');
    });

    it('getSharedGisTokenProvider คืน instance เดิมต่อ clientId เดิม', () => {
        expect(getSharedGisTokenProvider('cid_a')).toBe(getSharedGisTokenProvider('cid_a'));
        expect(getSharedGisTokenProvider('cid_b')).not.toBe(getSharedGisTokenProvider('cid_a'));
    });
});
