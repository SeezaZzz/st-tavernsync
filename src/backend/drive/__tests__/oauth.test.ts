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

    /** env สำหรับ popup flow ใหม่: รับผลผ่าน localStorage (callback page เขียน hash) ไม่พึ่ง popup handle */
    function popupEnv() {
        const store = new Map<string, string>();
        vi.stubGlobal('localStorage', {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        });
        const fakePopup = { close: vi.fn() };
        const open = vi.fn((_url?: unknown, _target?: unknown, _features?: unknown) => fakePopup as never);
        vi.stubGlobal('window', {
            location: { origin: 'http://127.0.0.1:8000' },
            open,
            addEventListener: () => {},
            removeEventListener: () => {},
        });
        const callbackWrites = (hash: string) => store.set('tavernsync_oauth_hash', hash);
        return { store, open, fakePopup, callbackWrites };
    }

    it('prompt ว่างเจอ interaction_required → fallback ไป popup implicit flow ของตัวเอง', async () => {
        installGisGlobals(inst => inst.callback({ error: 'interaction_required' }));
        const google = (window as unknown as { google: unknown }).google;
        const env = popupEnv();
        vi.stubGlobal('window', { ...(window as unknown as object), google, open: env.open });

        const p = new GisTokenProvider('cid');
        const pending = p.getToken();
        await new Promise(r => setTimeout(r, 50)); // รอ popup เปิด + ล้าง key เก่าก่อน (ของจริง callback มาหลังผู้ใช้กดเสมอ)
        env.callbackWrites('#access_token=tok_popup&expires_in=3600');
        await expect(pending).resolves.toBe('tok_popup');
        expect(env.open).toHaveBeenCalledTimes(1);
        const url = String(env.open.mock.calls[0]?.[0]);
        expect(url).toContain('client_id=cid');
        expect(url).toContain('redirect_uri=' + encodeURIComponent('http://127.0.0.1:8000'));
        expect(url).toContain('response_type=token');
        expect(url).toContain('prompt=consent');
    });

    it('getTokenInteractive ข้าม GIS ไป popup implicit flow ตรง ๆ และ cache token ต่อได้', async () => {
        const env = popupEnv();
        const p = new GisTokenProvider('cid');
        const pending = p.getTokenInteractive();
        await new Promise(r => setTimeout(r, 50));
        env.callbackWrites('#access_token=tok_direct&expires_in=3600');
        await expect(pending).resolves.toBe('tok_direct');
        expect(env.open).toHaveBeenCalledTimes(1);
        expect(String(env.open.mock.calls[0]?.[0])).toContain('prompt=consent');
        await expect(p.getTokenInteractive()).resolves.toBe('tok_direct');
        expect(env.open).toHaveBeenCalledTimes(1); // cache — ไม่เปิด popup ซ้ำ
    });

    it('popup handle ตายจาก COOP (close ก็โยน) — flow ยังสำเร็จเพราะรับผลผ่าน localStorage', async () => {
        const env = popupEnv();
        env.fakePopup.close.mockImplementation(() => { throw new Error('severed by COOP'); });
        const p = new GisTokenProvider('cid');
        const pending = p.getTokenInteractive();
        await new Promise(r => setTimeout(r, 50));
        env.callbackWrites('#access_token=tok_coop&expires_in=3600');
        await expect(pending).resolves.toBe('tok_coop');
    });

    it('callback ส่ง error กลับมา → reject "Google sign-in failed: <code>"', async () => {
        const env = popupEnv();
        const p = new GisTokenProvider('cid');
        const pending = p.getTokenInteractive();
        await new Promise(r => setTimeout(r, 50));
        env.callbackWrites('#error=access_denied');
        await expect(pending).rejects.toThrow('Google sign-in failed: access_denied');
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
