// src/backend/drive/client.ts
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const MULTIPART_LIMIT = 5 * 1024 * 1024;

export class DriveAuthError extends Error {
    constructor() { super('Google authorization expired or revoked'); this.name = 'DriveAuthError'; }
}

export class DriveHttpError extends Error {
    constructor(readonly status: number, readonly body: string) {
        super(`Drive API ${status}: ${body}`);
        this.name = 'DriveHttpError';
    }
}

export type ResumableRangeResult =
    | { kind: 'incomplete'; acknowledgedBytes: number }
    | { kind: 'complete'; file: DriveFileMeta };

export interface DriveFileMeta {
    id: string; name: string; size?: number | string; createdTime?: string;
    appProperties?: Record<string, string>;
}
export interface DriveTokenProvider { getToken(): Promise<string>; }

export class DriveClient {
    constructor(private tp: DriveTokenProvider) {}

    private async authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
        const token = await this.tp.getToken();
        const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
        if (res.status === 401) throw new DriveAuthError();
        return res;
    }

    private async req(url: string, init: RequestInit = {}): Promise<Response> {
        const res = await this.authedFetch(url, init);
        if (!res.ok) throw new DriveHttpError(res.status, await res.text().catch(() => ''));
        return res;
    }

    private async resumableResult(res: Response): Promise<ResumableRangeResult> {
        if (res.status === 308) {
            const range = res.headers.get('Range');
            if (!range) return { kind: 'incomplete', acknowledgedBytes: 0 };
            const match = /^bytes=0-(\d+)$/.exec(range);
            if (!match) throw new TypeError(`Drive resumable upload returned invalid Range: ${range}`);
            return { kind: 'incomplete', acknowledgedBytes: Number(match[1]) + 1 };
        }
        if (!res.ok) throw new DriveHttpError(res.status, await res.text().catch(() => ''));
        return { kind: 'complete', file: await res.json() as DriveFileMeta };
    }

    async listChildren(parentId: string): Promise<DriveFileMeta[]> {
        const out: DriveFileMeta[] = [];
        let pageToken = '';
        do {
            const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
            const fields = encodeURIComponent('nextPageToken, files(id,name,size,createdTime,appProperties)');
            const url = `${API}/files?q=${q}&fields=${fields}&pageSize=1000&pageToken=${pageToken}`;
            const data = await (await this.req(url)).json();
            out.push(...(data.files ?? []));
            pageToken = data.nextPageToken ?? '';
        } while (pageToken);
        return out;
    }

    async findChildByName(parentId: string, name: string): Promise<DriveFileMeta | null> {
        const q = encodeURIComponent(`'${parentId}' in parents and name='${name.replace(/'/g, "\\'")}' and trashed=false`);
        const fields = encodeURIComponent('files(id,name,size,createdTime,appProperties)');
        const data = await (await this.req(`${API}/files?q=${q}&fields=${fields}&pageSize=10`)).json();
        return (data.files ?? [])[0] ?? null;
    }

    async searchRootFolders(marker: 'root-v1' | 'root-v2' = 'root-v1'): Promise<DriveFileMeta[]> {
        const q = encodeURIComponent(`appProperties has { key='ts' and value='${marker}' } and trashed=false`);
        const fields = encodeURIComponent('files(id,name,size,createdTime,appProperties)');
        const data = await (await this.req(`${API}/files?q=${q}&fields=${fields}&pageSize=100`)).json();
        return data.files ?? [];
    }

    async createFolder(name: string, appProperties: Record<string, string>, parentId?: string): Promise<DriveFileMeta> {
        const res = await this.req(`${API}/files`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                mimeType: 'application/vnd.google-apps.folder',
                appProperties,
                ...(parentId ? { parents: [parentId] } : {}),
            }),
        });
        return res.json();
    }

    async createFile(parentId: string, name: string, data: Uint8Array, appProperties?: Record<string, string>): Promise<DriveFileMeta> {
        const meta = { name, parents: [parentId], ...(appProperties ? { appProperties } : {}) };
        if (data.byteLength <= MULTIPART_LIMIT) {
            const boundary = 'tsync_' + Math.random().toString(16).slice(2);
            const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
            const tail = `\r\n--${boundary}--`;
            const headBytes = new TextEncoder().encode(head);
            const tailBytes = new TextEncoder().encode(tail);
            const body = new Uint8Array(headBytes.byteLength + data.byteLength + tailBytes.byteLength);
            body.set(headBytes, 0);
            body.set(data, headBytes.byteLength);
            body.set(tailBytes, headBytes.byteLength + data.byteLength);
            const res = await this.req(`${UPLOAD}/files?uploadType=multipart`, {
                method: 'POST',
                headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
                body: body as unknown as BodyInit,
            });
            return res.json();
        }
        // resumable: initiate → PUT session
        const init = await this.req(`${UPLOAD}/files?uploadType=resumable`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(meta),
        });
        const session = init.headers.get('Location');
        if (!session) throw new Error('resumable upload: no session URL');
        const res = await this.req(session, { method: 'PUT', body: data as unknown as BodyInit });
        return res.json();
    }

    async beginResumableFile(
        parentId: string,
        name: string,
        totalBytes: number,
        appProperties?: Record<string, string>,
    ): Promise<string> {
        const meta = { name, parents: [parentId], ...(appProperties ? { appProperties } : {}) };
        const res = await this.req(`${UPLOAD}/files?uploadType=resumable`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Upload-Content-Type': 'application/octet-stream',
                'X-Upload-Content-Length': String(totalBytes),
            },
            body: JSON.stringify(meta),
        });
        const sessionUrl = res.headers.get('Location');
        if (!sessionUrl) throw new TypeError('resumable upload: no session URL');
        return sessionUrl;
    }

    async queryResumableFile(sessionUrl: string, totalBytes: number): Promise<ResumableRangeResult> {
        const res = await this.authedFetch(sessionUrl, {
            method: 'PUT',
            headers: {
                'Content-Length': '0',
                'Content-Range': `bytes */${totalBytes}`,
            },
        });
        return this.resumableResult(res);
    }

    async putResumableRange(
        sessionUrl: string,
        data: Uint8Array,
        start: number,
        totalBytes: number,
    ): Promise<ResumableRangeResult> {
        if (data.byteLength === 0) throw new RangeError('resumable range must not be empty');
        const end = start + data.byteLength - 1;
        const res = await this.authedFetch(sessionUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(data.byteLength),
                'Content-Range': `bytes ${start}-${end}/${totalBytes}`,
            },
            body: data as unknown as BodyInit,
        });
        return this.resumableResult(res);
    }

    async getFileData(id: string): Promise<Uint8Array> {
        const res = await this.req(`${API}/files/${id}?alt=media`);
        return new Uint8Array(await res.arrayBuffer());
    }

    async trashFile(id: string): Promise<void> {
        await this.req(`${API}/files/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
    }

    async getQuota(): Promise<{ usedBytes: number; limitBytes: number }> {
        const data = await (await this.req(`${API}/about?fields=storageQuota`)).json();
        return { usedBytes: Number(data.storageQuota?.usage ?? 0), limitBytes: Number(data.storageQuota?.limit ?? 0) };
    }
}
