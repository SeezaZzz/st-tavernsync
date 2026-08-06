// src/backend/drive/adapter.ts
import type { StorageAdapter, RemoteSnapshot, StorageRevision } from '../adapter';
import type { Manifest } from '../../sync-core/types';
import type { BackendCrypto } from '../runtime';
import { DriveClient, DriveFileMeta } from './client';

export interface DriveLayout { rootId: string; manifestsId: string; blobsId: string; }

export class MultipleRootsError extends Error {
    constructor(public roots: DriveFileMeta[]) {
        super('Multiple TavernSync root folders found');
        this.name = 'MultipleRootsError';
    }
}

export async function discoverDriveLayout(client: DriveClient): Promise<DriveLayout> {
    const roots = await client.searchRootFolders();
    if (roots.length > 1) throw new MultipleRootsError(roots);
    if (roots.length === 1) {
        const children = await client.listChildren(roots[0].id);
        const manifests = children.find(c => c.name === 'manifests');
        const blobs = children.find(c => c.name === 'blobs');
        if (!manifests || !blobs) throw new Error('TavernSync root is incomplete (missing manifests/ or blobs/)');
        return { rootId: roots[0].id, manifestsId: manifests.id, blobsId: blobs.id };
    }
    const root = await client.createFolder('TavernSync', { ts: 'root-v1' });
    const manifests = await client.createFolder('manifests', {}, root.id);
    const blobs = await client.createFolder('blobs', {}, root.id);
    return { rootId: root.id, manifestsId: manifests.id, blobsId: blobs.id };
}

export class DriveAdapter implements StorageAdapter {
    constructor(
        private client: DriveClient,
        private crypto: BackendCrypto,
        private layout: DriveLayout,
    ) {}

    async checkBlobs(hashes: string[]): Promise<string[]> {
        const files = await this.client.listChildren(this.layout.blobsId);
        const have = new Set(files.map(f => f.name));
        const missing: string[] = [];
        for (const h of hashes) {
            if (!have.has(await this.crypto.blobNameFor(h))) missing.push(h);
        }
        return missing;
    }

    async getBlob(hash: string): Promise<Uint8Array> {
        const name = await this.crypto.blobNameFor(hash);
        const f = await this.client.findChildByName(this.layout.blobsId, name);
        if (!f) throw new Error(`blob not found: ${hash}`);
        return this.client.getFileData(f.id);
    }

    async putBlob(hash: string, data: Uint8Array): Promise<void> {
        const name = await this.crypto.blobNameFor(hash);
        if (await this.client.findChildByName(this.layout.blobsId, name)) return; // content-addressed: มีแล้วข้าม
        await this.client.createFile(this.layout.blobsId, name, data);
    }

    async quota(): Promise<{ usedBytes: number; limitBytes: number; itemCount: number }> {
        const q = await this.client.getQuota();
        const blobs = await this.client.listChildren(this.layout.blobsId);
        return { ...q, itemCount: blobs.length };
    }

    // Task 6 จะ implement จริง
    async getSnapshot(): Promise<RemoteSnapshot> { throw new Error('not implemented (Task 6)'); }
    async putManifest(_m: Manifest, _r: StorageRevision): Promise<{ revision: StorageRevision }> { throw new Error('not implemented (Task 6)'); }
}
