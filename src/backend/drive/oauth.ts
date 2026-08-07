// src/backend/drive/oauth.ts
import type { DriveTokenProvider } from './client';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

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

    private async requestToken(): Promise<string> {
        const client = this.loadClient ? await this.loadClient() : await this.loadGisClient();
        try {
            // default prompt ว่าง — ใช้ session เดิมเงียบ ๆ (auto-sync ไม่มี gesture ก็ผ่านถ้าเคย consent)
            return await this.requestOnce(client, '');
        } catch (e) {
            // escalate เฉพาะ error ที่บอกว่าต้องมี interaction — อื่น ๆ (access_denied ฯลฯ) โยนต่อ
            if (e instanceof GisError && e.code === INTERACTION_REQUIRED) {
                return this.requestOnce(client, 'consent');
            }
            throw e;
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
