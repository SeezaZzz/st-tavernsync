import type { ItemType, Manifest } from '../../sync-core/types';
import type { DriveV2BaseState } from '../../state/store';
import {
    buildDriveV2DevicePreview,
    buildDriveV2SnapshotPreview,
    type DriveV2ChoiceInput,
} from './drive-v2-choice';
import { computeDriveV2Heads, type DriveV2CommitMeta } from './drive-v2-head';
import type { DriveV2PullResult } from './drive-v2-pull';
import type { DriveV2PushResult, DriveV2Runtime } from './drive-v2-push';
import type { DrivePackManifestV2 } from './pack-types';

export type DriveV2SourceChoice =
    | { kind: 'drive'; commitId: string }
    | { kind: 'local' }
    | { kind: 'cancel' };

export interface DriveV2SyncOptions {
    direction: 'push' | 'pull';
    runtime: DriveV2Runtime;
    namespace: string;
    local: Manifest;
    allowedTypes: ReadonlySet<ItemType>;
    loadBase(): Promise<DriveV2BaseState | null>;
    saveBase(base: DriveV2BaseState): Promise<void>;
    chooseSource(input: DriveV2ChoiceInput): Promise<DriveV2SourceChoice>;
    runPull(commit: DriveV2CommitMeta, manifest: DrivePackManifestV2): Promise<DriveV2PullResult>;
    runPush(input: {
        parents: string[];
        baseCommitId?: string;
        forced: boolean;
    }): Promise<DriveV2PushResult>;
}

export type DriveV2SyncResult =
    | { kind: 'pushed'; result: DriveV2PushResult }
    | { kind: 'pulled'; result: DriveV2PullResult }
    | { kind: 'cancelled' };

interface DriveV2ReadableStore {
    listCommits(): Promise<DriveV2CommitMeta[]>;
    readManifest(commit: DriveV2CommitMeta): Promise<DrivePackManifestV2>;
}

function readableStore(runtime: DriveV2Runtime): DriveV2ReadableStore {
    const store = runtime.store as Partial<DriveV2ReadableStore>;
    if (typeof store.listCommits !== 'function' || typeof store.readManifest !== 'function') {
        throw new Error('Drive v2 runtime does not support snapshot reads');
    }
    return store as DriveV2ReadableStore;
}

export async function runDriveV2Sync(options: DriveV2SyncOptions): Promise<DriveV2SyncResult> {
    const store = readableStore(options.runtime);
    const commits = await store.listCommits();
    const heads = computeDriveV2Heads(commits);
    const base = await options.loadBase();

    if (heads.length === 0) {
        if (options.direction === 'pull') throw new Error('Drive v2 has no committed snapshot');
        return pushAndSave(options, [], base?.commitId, false);
    }

    if (options.direction === 'pull') {
        const newestHead = [...heads].sort((a, b) =>
            b.createdTime.localeCompare(a.createdTime)
            || b.commitId.localeCompare(a.commitId))[0];
        const manifest = await store.readManifest(newestHead);
        return { kind: 'pulled', result: await options.runPull(newestHead, manifest) };
    }

    const currentHead = heads.length === 1 && base?.commitId === heads[0].commitId
        ? heads[0]
        : null;
    if (currentHead) {
        if (options.direction === 'push') {
            return pushAndSave(options, [currentHead.commitId], base?.commitId, false);
        }
        const manifest = await store.readManifest(currentHead);
        return { kind: 'pulled', result: await options.runPull(currentHead, manifest) };
    }

    const headManifests = await Promise.all(heads.map(async commit => ({
        commit,
        manifest: await store.readManifest(commit),
    })));
    const input: DriveV2ChoiceInput = {
        local: {
            device: options.local.device,
            itemCount: countAllowedLocalItems(options.local, options.allowedTypes),
        },
        heads: headManifests.map(({ commit, manifest }) => ({
            commitId: commit.commitId,
            device: manifest.device,
            createdTime: commit.createdTime,
            itemCount: countAllowedRemoteItems(manifest, options.allowedTypes),
            useDrive: buildDriveV2SnapshotPreview(options.local, manifest, options.allowedTypes),
            useLocal: buildDriveV2DevicePreview(options.local, manifest, options.allowedTypes),
        })),
    };

    const choice = await options.chooseSource(input);
    if (choice.kind === 'cancel') return { kind: 'cancelled' };
    if (choice.kind === 'local') {
        return pushAndSave(
            options,
            heads.map(head => head.commitId),
            base?.commitId,
            true,
        );
    }

    const selected = headManifests.find(entry => entry.commit.commitId === choice.commitId);
    if (!selected) throw new Error(`selected Drive v2 head is no longer current: ${choice.commitId}`);
    return {
        kind: 'pulled',
        result: await options.runPull(selected.commit, selected.manifest),
    };
}

async function pushAndSave(
    options: DriveV2SyncOptions,
    parents: string[],
    baseCommitId: string | undefined,
    forced: boolean,
): Promise<DriveV2SyncResult> {
    const result = await options.runPush({ parents, baseCommitId, forced });
    await options.saveBase({ commitId: result.commitId, syncedAt: Date.now() });
    return { kind: 'pushed', result };
}

function countAllowedLocalItems(local: Manifest, allowedTypes: ReadonlySet<ItemType>): number {
    return Object.values(local.items).filter(item => allowedTypes.has(item.type)).length;
}

function countAllowedRemoteItems(
    remote: DrivePackManifestV2,
    allowedTypes: ReadonlySet<ItemType>,
): number {
    return Object.values(remote.items).filter(item => allowedTypes.has(item.type)).length;
}
