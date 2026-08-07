// src/backend/drive/oauth.ts
import type { DriveTokenProvider } from './client';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** ส่วนของ GIS token client ที่เราใช้ — thin wrapper ให้ mock ได้ในเทส */
export interface GisTokenClient { requestAccessToken(overrides?: { prompt?: string }): void; }

type GisTokenResponse = { access_token?: string; error?: string; expires_in?: number };

interface GisGlobal {
    accounts: { oauth2: {
        initTokenClient(cfg: { client_id: string; scope: string; callback: (r: GisTokenResponse) => void }): GisTokenClient;
    } };
}

export class GisTokenProvider implements DriveTokenProvider {
    private token: string | null = null;
    private expiresAt = 0;
    private client: GisTokenClient | null = null;

    constructor(
        private clientId: string,
        private loadClient?: () => Promise<GisTokenClient>,
        private setCallback?: (fn: (resp: GisTokenResponse) => void) => void,
    ) {}

    /** ต้องถูกเรียกจาก user gesture (ปุ่ม Connect / Push / Pull / Test) */
    async getToken(): Promise<string> {
        if (this.token && Date.now() < this.expiresAt - 30_000) return this.token;
        const client = this.loadClient ? await this.loadClient() : await this.loadGisClient();
        return new Promise((resolve, reject) => {
            const cb = (resp: GisTokenResponse) => {
                if (resp.access_token) {
                    this.token = resp.access_token;
                    this.expiresAt = Date.now() + (resp.expires_in ?? 3600) * 1000;
                    resolve(this.token);
                } else {
                    reject(new Error(`Google sign-in failed: ${resp.error ?? 'unknown'}`));
                }
            };
            this.setCallback ? this.setCallback(cb) : this.registerCallback(cb);
            client.requestAccessToken({ prompt: this.token ? '' : 'consent' });
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
        await new Promise<void>((resolve, reject) => {
            const s = document.createElement('script');
            s.src = GIS_SRC;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('โหลด Google Identity Services ไม่สำเร็จ'));
            document.head.appendChild(s);
        });
        const g = (window as unknown as { google: GisGlobal }).google;
        this.client = g.accounts.oauth2.initTokenClient({
            client_id: this.clientId,
            scope: SCOPE,
            callback: () => {},
        });
        return this.client;
    }

    private registerCallback(cb: (resp: GisTokenResponse) => void) {
        // GIS รับ callback ตอน initTokenClient — re-init ด้วย callback ใหม่ทุกครั้งที่ขอ token
        const g = (window as unknown as { google: GisGlobal }).google;
        this.client = g.accounts.oauth2.initTokenClient({ client_id: this.clientId, scope: SCOPE, callback: cb });
    }
}
