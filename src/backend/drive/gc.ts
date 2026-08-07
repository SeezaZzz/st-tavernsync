// src/backend/drive/gc.ts
// Manual GC สำหรับ Drive backend — รันเฉพาะตอนผู้ใช้กดปุ่ม (ห้าม auto)
// กฎ: ห้ามรันระหว่างมี fork, live set = union blob จากทุก retained commit,
// orphan ต้องเก่ากว่า 7 วัน, prune commits เมื่อเหลือ head เดียว (เก็บ 10 ล่าสุด)
import type { DriveClient } from './client';
import type { DriveAdapter, DriveLayout } from './adapter';
import type { BackendCrypto } from '../runtime';
import { parseCommitMeta, computeHeads } from './commits';

const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_COMMITS = 10;

export async function collectGarbage(
    client: DriveClient,
    adapter: DriveAdapter,
    layout: DriveLayout,
    crypto: BackendCrypto,
): Promise<{ trashedBlobs: number; trashedCommits: number }> {
    const commitFiles = (await client.listChildren(layout.manifestsId))
        .filter(f => f.appProperties?.ts === 'commit-v1')
        .map(parseCommitMeta);
    const heads = computeHeads(commitFiles);
    if (heads.length > 1) throw new Error('มี fork ค้างอยู่ — ซิงก์ให้เสร็จก่อน GC');
    if (heads.length === 0) return { trashedBlobs: 0, trashedCommits: 0 };

    // รวบรวม commits ที่ retain: walk จาก head เก็บ 10 ตัวล่าสุด
    const byId = new Map(commitFiles.map(c => [c.commitId, c]));
    const retained: typeof commitFiles = [];
    const queue = [heads[0]];
    const seen = new Set<string>();
    while (queue.length && retained.length < KEEP_COMMITS) {
        const c = queue.shift()!;
        if (seen.has(c.commitId)) continue;
        seen.add(c.commitId);
        retained.push(c);
        for (const p of c.parents) { const pc = byId.get(p); if (pc) queue.push(pc); }
    }

    // live set = union ของ blob names ที่ทุก retained commit อ้าง
    const live = new Set<string>();
    for (const c of retained) {
        const m = await crypto.decodeManifest(await client.getFileData(c.id));
        for (const item of Object.values(m.items)) {
            if (!item.deleted) live.add(await crypto.blobNameFor(item.hash));
        }
    }

    // trash blob orphan ที่เก่ากว่า grace
    let trashedBlobs = 0;
    const now = Date.now();
    for (const f of await client.listChildren(layout.blobsId)) {
        const age = now - Date.parse(f.createdTime ?? '');
        if (!live.has(f.name) && Number.isFinite(age) && age > ORPHAN_GRACE_MS) {
            await client.trashFile(f.id);
            trashedBlobs++;
        }
    }
    if (trashedBlobs > 0) adapter.invalidateBlobsCache();

    // trash commits เกิน retain
    let trashedCommits = 0;
    for (const c of commitFiles) {
        if (!seen.has(c.commitId)) { await client.trashFile(c.id); trashedCommits++; }
    }
    return { trashedBlobs, trashedCommits };
}
