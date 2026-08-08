import { describe, expect, it } from 'vitest';
import type { Manifest } from '../../sync-core/types';
import type { RemoteSnapshot, StorageAdapter, StorageRevision } from '../../backend/adapter';
import { createPushHandlers, MissingLocalBlobError, uploadPushBatch } from '../push-batch';

class BatchAdapter implements StorageAdapter {
    readonly existing = new Set<string>(['cached']);
    readonly uploaded: string[] = [];

    async getSnapshot(): Promise<RemoteSnapshot> {
        return { kind: 'single', manifest: null, revision: '0' };
    }

    async putManifest(_manifest: Manifest, _revision: StorageRevision): Promise<{ revision: StorageRevision }> {
        return { revision: '1' };
    }

    async checkBlobs(hashes: string[]): Promise<string[]> {
        return hashes.filter((hash) => !this.existing.has(hash));
    }

    async getBlob(_hash: string): Promise<Uint8Array> {
        return new Uint8Array();
    }

    async putBlob(hash: string, _data: Uint8Array): Promise<void> {
        this.uploaded.push(hash);
        this.existing.add(hash);
    }
}

describe('uploadPushBatch', () => {
    it('สร้าง single fallback และ batch handler จาก dependency ชุดเดียว', async () => {
        const adapter = new BatchAdapter();
        const processed: string[] = [];
        const handlers = createPushHandlers({
            adapter,
            load: async (hash) => new TextEncoder().encode(hash),
            encrypt: async (data) => data,
        });

        await handlers.pushBlob('single-item', 'single-hash');
        await handlers.pushBlobs(
            [{ id: 'batch-item', hash: 'batch-hash' }],
            (item) => processed.push(item.id),
        );

        expect(adapter.uploaded.sort()).toEqual(['batch-hash', 'single-hash']);
        expect(processed).toEqual(['batch-item']);
    });

    it('โหลดและเข้ารหัสต่อ unique hash แต่รายงานครบทุก item รวม cached', async () => {
        const adapter = new BatchAdapter();
        const loaded: string[] = [];
        const encrypted: string[] = [];
        const processed: string[] = [];

        await uploadPushBatch({
            adapter,
            items: [
                { id: 'one', hash: 'shared' },
                { id: 'two', hash: 'shared' },
                { id: 'three', hash: 'cached' },
            ],
            load: async (hash) => {
                loaded.push(hash);
                return new TextEncoder().encode(hash);
            },
            encrypt: async (data) => {
                const hash = new TextDecoder().decode(data);
                encrypted.push(hash);
                return data;
            },
            onProcessed: (item) => processed.push(item.id),
        });

        expect(loaded).toEqual(['shared']);
        expect(encrypted).toEqual(['shared']);
        expect(adapter.uploaded).toEqual(['shared']);
        expect(processed.sort()).toEqual(['one', 'three', 'two']);
    });

    it('หยุดด้วย typed error เมื่อ local blob หาย', async () => {
        const adapter = new BatchAdapter();

        await expect(uploadPushBatch({
            adapter,
            items: [{ id: 'missing-item', hash: 'missing-hash' }],
            load: async () => null,
            encrypt: async (data) => data,
            onProcessed: () => undefined,
        })).rejects.toEqual(new MissingLocalBlobError('missing-item', 'missing-hash'));
    });
});
