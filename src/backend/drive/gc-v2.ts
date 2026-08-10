import type { DriveFileMeta } from './client';
import {
    computeDriveV2Heads,
    selectNewestDriveV2Head,
    type DriveV2CommitMeta,
} from './drive-v2-head';
import type { DrivePackManifestV2 } from './pack-types';

const KEEP_COMMITS = 10;
const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

interface V2GarbageStore {
    listCommits(): Promise<DriveV2CommitMeta[]>;
    readManifest(commit: DriveV2CommitMeta): Promise<DrivePackManifestV2>;
    listPacks(): Promise<Map<string, DriveFileMeta>>;
}

interface V2GarbageClient {
    trashFile(id: string): Promise<void>;
}

export async function collectDriveV2Garbage(
    store: V2GarbageStore,
    client: V2GarbageClient,
    options: { now?: () => number } = {},
): Promise<{ trashedPacks: number; trashedCommits: number }> {
    const commits = await store.listCommits();
    const heads = computeDriveV2Heads(commits);
    if (heads.length > 1) {
        throw new Error('Drive v2 has concurrent heads; resolve them before cleanup');
    }
    if (heads.length === 0) return { trashedPacks: 0, trashedCommits: 0 };

    const commitsById = new Map(commits.map(commit => [commit.commitId, commit]));
    const retained: DriveV2CommitMeta[] = [];
    const retainedIds = new Set<string>();
    const queue = [selectNewestDriveV2Head(heads)];
    while (queue.length > 0 && retained.length < KEEP_COMMITS) {
        const commit = queue.shift()!;
        if (retainedIds.has(commit.commitId)) continue;
        retainedIds.add(commit.commitId);
        retained.push(commit);
        for (const parentId of commit.parents) {
            const parent = commitsById.get(parentId);
            if (parent) queue.push(parent);
        }
    }

    const livePacks = new Set<string>();
    for (const commit of retained) {
        const manifest = await store.readManifest(commit);
        for (const item of Object.values(manifest.items)) {
            for (const chunk of item.chunks) livePacks.add(chunk.packName);
        }
    }

    const now = (options.now ?? (() => Date.now()))();
    let trashedPacks = 0;
    for (const [name, file] of await store.listPacks()) {
        const age = now - Date.parse(file.createdTime ?? '');
        if (!livePacks.has(name) && Number.isFinite(age) && age > ORPHAN_GRACE_MS) {
            await client.trashFile(file.id);
            trashedPacks += 1;
        }
    }

    let trashedCommits = 0;
    for (const commit of commits) {
        if (retainedIds.has(commit.commitId)) continue;
        await client.trashFile(commit.fileId);
        trashedCommits += 1;
    }

    return { trashedPacks, trashedCommits };
}
