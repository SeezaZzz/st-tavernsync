// src/backend/drive/oauth.ts
import type { DriveTokenProvider } from './client';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** key ที่หน้าต่าง popup (หลัง redirect กลับมาที่ origin เรา) เขียน URL hash ที่มี access_token ลง localStorage ให้หน้าหลักอ่าน */
const OAUTH_RESULT_KEY = 'tavernsync_oauth_hash';

/** ส่วนของ GIS token client ที่เราใช้ — thin wrapper ให้ mock ได้ในเทส
 *  callback รีแอสไซน์ได้บน instance เดิม (GIS รองรับ) — ห้ามสร้าง client ใหม่ตอนขอ token */
export interface GisTokenClient {
    callback: (resp: GisTokenResponse) => void;
    requestAccessToken(overrides?: { prompt?: string }): void;
}

type GisTokenResponse = { access_token?: string; error?: string; expires_in?: number };

interface GisGlobal {
    accounts: { oauth2: {
        initTokenClient(cfg: { client_id: string; scope: string; callback: (r: GisTokenResponse) => void }): GisTokenClient;
    } };
}

/** error จาก GIS ที่แปลว่า prompt ว่างใช้ไม่ได้ (ต้องมี user interaction) → escalate เป็น consent */
const INTERACTION_REQUIRED = 'interaction_required';

class GisError extends Error {
    constructor(public code: string) {
        super(`Google sign-in failed: ${code}`);
        this.name = 'GisError';
    }
}

export class GisTokenProvider implements DriveTokenProvider {
    private token: string | null = null;
    private expiresAt = 0;
    private client: GisTokenClient | null = null;
    /** memoize request ที่ค้างอยู่ — getToken พร้อมกันหลาย call แชร์ request เดียว */
    private inflight: Promise<string> | null = null;

    constructor(
        private clientId: string,
        private loadClient?: () => Promise<GisTokenClient>,
        private setCallback?: (fn: (resp: GisTokenResponse) => void) => void,
    ) {}

    /** ต้องถูกเรียกจาก user gesture (ปุ่ม Connect / Push / Pull / Test) */
    async getToken(): Promise<string> {
        if (this.token && Date.now() < this.expiresAt - 30_000) return this.token;
        if (this.inflight) return this.inflight;
        this.inflight = this.requestToken();
        try {
            return await this.inflight;
        } finally {
            this.inflight = null;
        }
    }

    /** เรียกจาก user gesture เท่านั้น — ข้าม prompt:'' ไป consent ตรง ๆ
     *  (บางเบราว์เซอร์ที่บล็อก third-party cookies ทำ prompt:'' ค้างเงียบ ๆ ไม่ยิง callback) */
    async getTokenInteractive(): Promise<string> {
        if (this.token && Date.now() < this.expiresAt - 30_000) return this.token;
        if (this.inflight) return this.inflight;
        // ใช้ popup implicit flow ของเราเอง ไม่ผ่าน GIS iframe — GIS callback หายเงียบ ๆ
        // ในบางเบราว์เซอร์ (3p storage ถูกบล็อก) ทำให้ Connect ค้างทั้งที่ผู้ใช้ consent สำเร็จแล้ว
        this.inflight = this.requestViaPopup('consent');
        try {
            return await this.inflight;
        } finally {
            this.inflight = null;
        }
    }

    /** OAuth implicit flow แบบเขียนเอง: เปิด popup ไป accounts.google.com → redirect กลับมาที่ origin root
     *  (ST โหลดในหน้าต่างนั้นแวบเดียว ตัว extension จับ hash เขียนลง localStorage แล้วปิดตัวเอง) —
     *  รับผลผ่าน localStorage/storage event ไม่พึ่ง popup handle เพราะ Google ส่ง COOP มากับ
     *  หน้า sign-in ทำ opener reference ตาย (อ่าน closed=true ทั้งที่หน้าต่างยังเปิดอยู่)
     *  redirect URI ที่ต้อง whitelist คือ origin เฉย ๆ เหมือน JavaScript origins — ไม่มี path ยาว ๆ */
    private requestViaPopup(prompt: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const redirectUri = window.location.origin;
            const url =
                'https://accounts.google.com/o/oauth2/v2/auth' +
                `?client_id=${encodeURIComponent(this.clientId)}` +
                `&redirect_uri=${encodeURIComponent(redirectUri)}` +
                '&response_type=token' +
                `&scope=${encodeURIComponent(SCOPE)}` +
                `&prompt=${encodeURIComponent(prompt)}` +
                '&include_granted_scopes=true';
            console.debug('[TavernSync]', `opening OAuth popup (redirect back to ${redirectUri})…`);
            const popup = window.open(url, 'tavernsync-oauth', 'width=520,height=640');
            if (!popup) {
                reject(new Error('เปิดหน้าต่าง Google sign-in ไม่ได้ — popup ถูกบล็อก กดอนุญาต popup ของเว็บนี้ก่อน'));
                return;
            }

            try { localStorage.removeItem(OAUTH_RESULT_KEY); } catch { /* ถ้าใช้ไม่ได้จะ timeout เอง */ }
            let settled = false;
            const cleanup = () => {
                clearInterval(poller);
                clearTimeout(timer);
                window.removeEventListener('storage', onStorage);
            };
            const handleHash = (hash: string) => {
                if (settled) return;
                settled = true;
                cleanup();
                try { popup.close(); } catch { /* handle อาจตายจาก COOP — callback page ปิดตัวเองอยู่แล้ว */ }
                const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
                const token = params.get('access_token');
                const err = params.get('error');
                if (token) {
                    this.token = token;
                    this.expiresAt = Date.now() + Number(params.get('expires_in') ?? 3600) * 1000;
                    console.debug('[TavernSync]', 'OAuth token acquired via popup callback');
                    resolve(this.token);
                } else {
                    reject(new GisError(err ?? 'unknown'));
                }
            };
            const readStore = () => {
                let hash: string | null = null;
                try { hash = localStorage.getItem(OAUTH_RESULT_KEY); } catch { return; }
                if (hash) {
                    try { localStorage.removeItem(OAUTH_RESULT_KEY); } catch { /* ignore */ }
                    handleHash(hash);
                }
            };
            const onStorage = (e: StorageEvent) => {
                if (e.key === OAUTH_RESULT_KEY && e.newValue) handleHash(e.newValue);
            };
            window.addEventListener('storage', onStorage);
            const poller = setInterval(readStore, 300);
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error('Google sign-in ไม่ตอบกลับใน 2 นาที — ถ้าปิด popup ไปเองถือว่ายกเลิก; ถ้า popup ฟ้อง redirect_uri_mismatch ให้เพิ่ม URL callback ใน Authorized redirect URIs ของ Client ID'));
            }, 120_000);
        });
    }

    private async requestToken(): Promise<string> {
        const client = this.loadClient ? await this.loadClient() : await this.loadGisClient();
        try {
            // default prompt ว่าง — ใช้ session เดิมเงียบ ๆ (auto-sync ไม่มี gesture ก็ผ่านถ้าเคย consent)
            return await this.requestOnce(client, '');
        } catch (e) {
            // error ที่ต้องให้ผู้ใช้เลือกเอง (access_denied ฯลฯ) โยนต่อ ไม่ fallback
            if (e instanceof GisError && e.code !== INTERACTION_REQUIRED) throw e;
            // interaction_required หรือ GIS ค้าง/timeout → fallback popup implicit flow ของเราเอง
            // (ถ้าไม่ได้อยู่ใน gesture window popup จะโดนบล็อกและฟ้อง error ชัดเจนแทนที่จะค้าง)
            console.debug('[TavernSync]', 'silent GIS path failed, falling back to popup flow:', e);
            return this.requestViaPopup('consent');
        }
    }

    private requestOnce(client: GisTokenClient, prompt: string): Promise<string> {
        return new Promise((resolve, reject) => {
            // กันค้างนิรันดร์ — GIS ไม่มี timeout ของตัวเอง ถ้า popup โดนบล็อกเงียบ ๆ หรือ callback ไม่ยิง promise จะแขวนตลอด
            const timer = setTimeout(() => {
                reject(new Error(`Google sign-in ไม่ตอบกลับใน 2 นาที (prompt:'${prompt}') — เช็กว่า popup ถูกบล็อก หรือ accounts.google.com โดน adblock/tracking prevention`));
            }, 120_000);
            const cb = (resp: GisTokenResponse) => {
                clearTimeout(timer);
                if (resp.access_token) {
                    this.token = resp.access_token;
                    this.expiresAt = Date.now() + (resp.expires_in ?? 3600) * 1000;
                    console.debug('[TavernSync]', `GIS token acquired (expires_in=${resp.expires_in ?? '?'}s)`);
                    resolve(this.token);
                } else {
                    console.debug('[TavernSync]', `GIS error response (prompt:'${prompt}'):`, resp.error);
                    reject(new GisError(resp.error ?? 'unknown'));
                }
            };
            // ติด callback บน instance เดียวกับที่จะ requestAccessToken — ห้าม init client ใหม่
            if (this.setCallback) this.setCallback(cb);
            else client.callback = cb;
            console.debug('[TavernSync]', `requestAccessToken prompt:'${prompt}'`);
            client.requestAccessToken({ prompt });
        });
    }

    async revoke(): Promise<void> {
        if (this.token) {
            await fetch(`https://oauth2.googleapis.com/revoke?token=${this.token}`, { method: 'POST' }).catch(() => {});
        }
        this.token = null;
        this.expiresAt = 0;
    }

    markExpiredForTest(): void { this.expiresAt = 0; }

    private async loadGisClient(): Promise<GisTokenClient> {
        if (this.client) return this.client;
        console.debug('[TavernSync]', 'loading GIS script (accounts.google.com/gsi/client)…');
        await new Promise<void>((resolve, reject) => {
            // กันค้าง — ถ้าสคริปต์โดนบล็อกเงียบ ๆ (adblock/tracking prevention) onload/onerror อาจไม่ยิงเลย
            const timer = setTimeout(() => {
                reject(new Error('โหลดสคริปต์ Google (accounts.google.com/gsi/client) ไม่สำเร็จใน 20 วินาที — อาจโดน adblock หรือ Edge tracking prevention บล็อก'));
            }, 20_000);
            const s = document.createElement('script');
            s.src = GIS_SRC;
            s.onload = () => { clearTimeout(timer); resolve(); };
            s.onerror = () => { clearTimeout(timer); reject(new Error('โหลด Google Identity Services ไม่สำเร็จ — เช็ก adblock/tracking prevention')); };
            document.head.appendChild(s);
        });
        console.debug('[TavernSync]', 'GIS script loaded, init token client');
        const g = (window as unknown as { google: GisGlobal }).google;
        this.client = g.accounts.oauth2.initTokenClient({
            client_id: this.clientId,
            scope: SCOPE,
            callback: () => {},
        });
        return this.client;
    }
}

/** provider กลางต่อ clientId — Connect / requireRuntime / GC แชร์ token cache ก้อนเดียว
 *  (กันทุก sync เด้ง consent popup และให้ Disconnect revoke ถูก instance) */
let shared: { clientId: string; provider: GisTokenProvider } | null = null;

export function getSharedGisTokenProvider(clientId: string): GisTokenProvider {
    if (!shared || shared.clientId !== clientId) {
        shared = { clientId, provider: new GisTokenProvider(clientId) };
    }
    return shared.provider;
}
