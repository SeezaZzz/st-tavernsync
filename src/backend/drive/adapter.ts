// src/backend/drive/adapter.ts
import { ConflictError, type StorageAdapter, type RemoteSnapshot, type StorageRevision } from '../adapter';
import type { Manifest } from '../../sync-core/types';
import type { BackendCrypto } from '../runtime';
import { DriveClient, DriveFileMeta } from './client';
import {
    COMMIT_ID_LEN,
    MAX_PARENTS,
    computeHeads,
    findCommonAncestor,
    parseCommitMeta,
    revisionOfHeads,
    type CommitMeta,
} from './commits';

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

    private async listCommits(): Promise<CommitMeta[]> {
        const files = await this.client.listChildren(this.layout.manifestsId);
        return files
            .filter(f => f.appProperties?.ts === 'commit-v1' && f.name.endsWith('.enc'))
            .map(parseCommitMeta);
    }

    private async loadCommitManifest(c: CommitMeta): Promise<Manifest> {
        const data = await this.client.getFileData(c.id);
        return this.crypto.decodeManifest(data);
    }

    async getSnapshot(): Promise<RemoteSnapshot> {
        const commits = await this.listCommits();
        const heads = computeHeads(commits);
        if (heads.length === 0) return { kind: 'single', manifest: null, revision: '0' };
        const revision = await revisionOfHeads(heads);
        if (heads.length === 1) {
            return { kind: 'single', manifest: await this.loadCommitManifest(heads[0]), revision };
        }
        // fork: โหลด manifest ทุก head + หา common ancestor ของ head คู่แรก (N>2 ให้ engine merge ทีละก้อน)
        const headManifests = await Promise.all(heads.map(async h => ({ commitId: h.commitId, manifest: await this.loadCommitManifest(h) })));
        const anc = findCommonAncestor(heads[0], heads[1], commits);
        const commonAncestor = anc ? await this.loadCommitManifest(anc) : null;
        return { kind: 'fork', heads: headManifests, commonAncestor, revision };
    }

    async putManifest(m: Manifest, ifRevision: StorageRevision): Promise<{ revision: StorageRevision }> {
        const commits = await this.listCommits();
        let heads = computeHeads(commits);
        const current = heads.length ? await revisionOfHeads(heads) : '0';
        if (current !== ifRevision) throw new ConflictError();

        // ถ้า heads > MAX_PARENTS: สร้าง merge commit กลางเป็นลำดับ (manifest เดียวกัน) จนเหลือ ≤4 parents
        while (heads.length > MAX_PARENTS) {
            const group = heads.slice(0, MAX_PARENTS);
            const parents = group.map(h => h.commitId);
            const { fileId, commitId } = await this.writeCommit(m, parents);
            heads = [{ id: fileId, commitId, parents, createdTime: '' }, ...heads.slice(MAX_PARENTS)];
        }
        const { commitId } = await this.writeCommit(m, heads.map(h => h.commitId));
        return { revision: await revisionOfHeads([{ id: '', commitId, parents: [], createdTime: '' }]) };
    }

    /** สร้าง commit ไฟล์ใหม่; คืนทั้ง Drive file id และ commitId (32 hex จาก SHA-256 ของ ciphertext).
     *  encode manifest ใหม่ทุกครั้ง — AES-GCM มี IV สุ่ม → ciphertext ต่างกัน → commitId ไม่ชนกัน
     *  (ป้องกัน self-edge ตอน rollup และ re-push manifest เดิม) */
    private async writeCommit(m: Manifest, parents: string[]): Promise<{ fileId: string; commitId: string }> {
        const data = await this.crypto.encodeManifest(m);
        const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
        const commitId = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, COMMIT_ID_LEN);
        const appProperties: Record<string, string> = { ts: 'commit-v1' };
        parents.slice(0, MAX_PARENTS).forEach((p, i) => { appProperties[`p${i}`] = p; });
        const created = await this.client.createFile(this.layout.manifestsId, `${commitId}.enc`, data, appProperties);
        return { fileId: created.id, commitId };
    }
}
