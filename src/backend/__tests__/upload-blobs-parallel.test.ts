import { describe, expect, it } from 'vitest';
import type { Manifest } from '../../sync-core/types';
import type { RemoteSnapshot, StorageAdapter, StorageRevision } from '../adapter';
import { uploadBlobsParallel } from '../http';

class MemoryAdapter implements StorageAdapter {
    readonly stored = new Set<string>();
    readonly putCalls: string[] = [];
    activePuts = 0;
    peakPuts = 0;

    constructor(existing: readonly string[] = []) {
        for (const hash of existing) this.stored.add(hash);
    }

    async getSnapshot(): Promise<RemoteSnapshot> {
        return { kind: 'single', manifest: null, revision: '0' };
    }

    async putManifest(_manifest: Manifest, _revision: StorageRevision): Promise<{ revision: StorageRevision }> {
        return { revision: '1' };
    }

    async checkBlobs(hashes: string[]): Promise<string[]> {
        return hashes.filter((hash) => !this.stored.has(hash));
    }

    async getBlob(_hash: string): Promise<Uint8Array> {
        return new Uint8Array();
    }

    async putBlob(hash: string, _data: Uint8Array): Promise<void> {
        this.activePuts++;
        this.peakPuts = Math.max(this.peakPuts, this.activePuts);
        await new Promise((resolve) => setTimeout(resolve, 10));
        this.activePuts--;
        this.putCalls.push(hash);
        this.stored.add(hash);
    }
}

describe('uploadBlobsParallel', () => {
    it('dedup hash และโหลดเฉพาะ blob ที่ยังไม่มี', async () => {
        const adapter = new MemoryAdapter(['cached']);
        const loaded: string[] = [];
        const processed: string[] = [];

        await uploadBlobsParallel(adapter, {
            hashes: ['cached', 'new-a', 'new-a', 'new-b'],
            load: async (hash) => {
                loaded.push(hash);
                return new TextEncoder().encode(hash);
            },
            onProcessed: (hash) => processed.push(hash),
        });

        expect(loaded.sort()).toEqual(['new-a', 'new-b']);
        expect(adapter.putCalls.sort()).toEqual(['new-a', 'new-b']);
        expect(processed.sort()).toEqual(['cached', 'new-a', 'new-b']);
    });

    it('จำกัดการอัปโหลดพร้อมกันตาม concurrency', async () => {
        const adapter = new MemoryAdapter();
        const hashes = ['a', 'b', 'c', 'd', 'e', 'f'];

        await uploadBlobsParallel(adapter, {
            hashes,
            load: async (hash) => new TextEncoder().encode(hash),
            concurrency: 4,
        });

        expect(adapter.putCalls).toHaveLength(hashes.length);
        expect(adapter.peakPuts).toBe(4);
    });
});
