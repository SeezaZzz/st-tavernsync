// src/backend/drive/commits.ts
// Immutable manifest-commit graph บน Drive: commitId = 32 hex chars จาก SHA-256 ของ ciphertext,
// parents เก็บใน appProperties p0..p3 (สูงสุด 4)
import type { StorageRevision } from '../adapter';
import type { DriveFileMeta } from './client';

export const MAX_PARENTS = 4;
export const COMMIT_ID_LEN = 32; // hex chars

export interface CommitMeta { id: string; commitId: string; parents: string[]; createdTime: string; }

export function parseCommitMeta(f: DriveFileMeta): CommitMeta {
    if (f.appProperties?.ts !== 'commit-v1') throw new Error(`not a commit file: ${f.name}`);
    const parents: string[] = [];
    for (let i = 0; i < MAX_PARENTS; i++) {
        const p = f.appProperties[`p${i}`];
        if (p) parents.push(p);
    }
    return { id: f.id, commitId: f.name.replace(/\.enc$/, ''), parents, createdTime: f.createdTime ?? '' };
}

export function computeHeads(commits: CommitMeta[]): CommitMeta[] {
    const referenced = new Set(commits.flatMap(c => c.parents));
    return commits.filter(c => !referenced.has(c.commitId));
}

export async function revisionOfHeads(heads: CommitMeta[]): Promise<StorageRevision> {
    const joined = heads.map(h => h.commitId).sort().join('');
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(joined) as BufferSource);
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function findCommonAncestor(a: CommitMeta, b: CommitMeta, all: CommitMeta[]): CommitMeta | null {
    const byId = new Map(all.map(c => [c.commitId, c]));
    const seenFromA = new Set<string>();
    const queue: string[] = [a.commitId];
    while (queue.length) {
        const id = queue.shift()!;
        if (seenFromA.has(id)) continue;
        seenFromA.add(id);
        for (const p of byId.get(id)?.parents ?? []) queue.push(p);
    }
    // BFS จาก b หาตัวแรกที่ a เคยไปถึง
    const queueB: string[] = [b.commitId];
    const seenB = new Set<string>();
    while (queueB.length) {
        const id = queueB.shift()!;
        if (seenB.has(id)) continue;
        seenB.add(id);
        if (seenFromA.has(id)) return byId.get(id) ?? null;
        for (const p of byId.get(id)?.parents ?? []) queueB.push(p);
    }
    return null;
}
