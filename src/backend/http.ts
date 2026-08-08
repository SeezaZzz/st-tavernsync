import { ConflictError, type RemoteSnapshot, type StorageAdapter, type StorageRevision } from './adapter';
import type { Manifest } from '../sync-core/types';
import { LOG_PREFIX } from '../settings';
import { mapPool } from '../util/pool';

export interface HttpAdapterOptions {
    endpoint: string;
    deviceToken: string;
}

function authHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...extra,
    };
}

async function readError(res: Response): Promise<string> {
    try {
        return await res.text();
    } catch {
        return res.statusText;
    }
}

export class HttpStorageAdapter implements StorageAdapter {
    constructor(private opts: HttpAdapterOptions) {}

    private url(path: string): string {
        const base = this.opts.endpoint.replace(/\/+$/, '');
        return `${base}${path}`;
    }

    async getSnapshot(): Promise<RemoteSnapshot> {
        const res = await fetch(this.url('/v1/manifest'), {
            headers: authHeaders(this.opts.deviceToken),
        });
        if (res.status === 404) {
            return { kind: 'single', manifest: null, revision: '0' };
        }
        if (!res.ok) {
            throw new Error(`getManifest: ${res.status} ${await readError(res)}`);
        }
        const version = Number(res.headers.get('ETag')?.replace(/"/g, '') || res.headers.get('X-Manifest-Version') || 0);
        const body = await res.json() as { manifest: Manifest | null; version?: number };
        return {
            kind: 'single',
            manifest: body.manifest,
            revision: String(body.version ?? version),
        };
    }

    async putManifest(m: Manifest, ifRevision: StorageRevision): Promise<{ revision: StorageRevision }> {
        const res = await fetch(this.url('/v1/manifest'), {
            method: 'PUT',
            headers: authHeaders(this.opts.deviceToken, { 'If-Match': String(Number(ifRevision)) }),
            body: JSON.stringify(m),
        });
        if (res.status === 412) {
            throw new ConflictError();
        }
        if (!res.ok) {
            throw new Error(`putManifest: ${res.status} ${await readError(res)}`);
        }
        const body = await res.json() as { version: number };
        return { revision: String(body.version) };
    }

    async checkBlobs(hashes: string[]): Promise<string[]> {
        const res = await fetch(this.url('/v1/blobs/check'), {
            method: 'POST',
            headers: authHeaders(this.opts.deviceToken),
            body: JSON.stringify({ hashes }),
        });
        if (!res.ok) {
            throw new Error(`checkBlobs: ${res.status} ${await readError(res)}`);
        }
        const body = await res.json() as { missing: string[] };
        return body.missing || [];
    }

    async getBlob(hash: string): Promise<Uint8Array> {
        const res = await fetch(this.url(`/v1/blobs/${encodeURIComponent(hash)}`), {
            headers: { Authorization: `Bearer ${this.opts.deviceToken}` },
        });
        if (!res.ok) {
            throw new Error(`getBlob ${hash}: ${res.status}`);
        }
        return new Uint8Array(await res.arrayBuffer());
    }

    async putBlob(hash: string, data: Uint8Array): Promise<void> {
        const res = await fetch(this.url(`/v1/blobs/${encodeURIComponent(hash)}`), {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${this.opts.deviceToken}`,
                'Content-Type': 'application/octet-stream',
            },
            body: data as unknown as BodyInit,
        });
        if (!res.ok) {
            console.error(LOG_PREFIX, 'putBlob failed', hash, res.status);
            throw new Error(`putBlob ${hash}: ${res.status}`);
        }
    }

    async quota(): Promise<{ usedBytes: number; limitBytes: number; itemCount: number }> {
        const res = await fetch(this.url('/v1/quota'), {
            headers: authHeaders(this.opts.deviceToken),
        });
        if (!res.ok) {
            return { usedBytes: 0, limitBytes: 0, itemCount: 0 };
        }
        return await res.json() as { usedBytes: number; limitBytes: number; itemCount: number };
    }

    async getAccount(): Promise<{ e2eeSalt: string | null }> {
        const res = await fetch(this.url('/v1/account'), {
            headers: authHeaders(this.opts.deviceToken),
        });
        if (!res.ok) {
            return { e2eeSalt: null };
        }
        return await res.json() as { e2eeSalt: string | null };
    }

    /** Publish account salt if empty; returns the canonical salt for this account. */
    async ensureAccountSalt(localSalt: string): Promise<string> {
        const current = await this.getAccount();
        if (current.e2eeSalt) {
            return current.e2eeSalt;
        }
        const res = await fetch(this.url('/v1/account'), {
            method: 'PUT',
            headers: authHeaders(this.opts.deviceToken),
            body: JSON.stringify({ e2eeSalt: localSalt }),
        });
        if (res.status === 409) {
            const body = await res.json() as { e2eeSalt?: string };
            if (body.e2eeSalt) return body.e2eeSalt;
        }
        if (!res.ok) {
            console.warn(LOG_PREFIX, 'ensureAccountSalt failed', res.status);
            return localSalt;
        }
        const body = await res.json() as { e2eeSalt: string };
        return body.e2eeSalt || localSalt;
    }
}

export interface UploadBlobsOptions {
    readonly hashes: readonly string[];
    readonly load: (hash: string) => Promise<Uint8Array>;
    readonly concurrency?: number;
    /** Called once per unique hash, including hashes already present remotely. */
    readonly onProcessed?: (hash: string) => void;
}

/** Upload missing blobs lazily with bounded concurrency and simple backoff. */
export async function uploadBlobsParallel(
    adapter: StorageAdapter,
    options: UploadBlobsOptions,
): Promise<void> {
    if (options.hashes.length === 0) return;

    const unique = [...new Set(options.hashes)];
    const missing = new Set(await adapter.checkBlobs(unique));
    const queue = unique.filter((hash) => missing.has(hash));

    for (const hash of unique) {
        if (!missing.has(hash)) options.onProcessed?.(hash);
    }

    await mapPool(queue, options.concurrency ?? 4, async (hash) => {
        const data = await options.load(hash);
        let attempt = 0;
        for (;;) {
            try {
                await adapter.putBlob(hash, data);
                options.onProcessed?.(hash);
                return;
            } catch (error) {
                attempt++;
                if (attempt >= 3) throw error;
                await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
            }
        }
    });
}
