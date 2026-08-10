import { computeDriveV2Heads, type DriveV2CommitMeta } from './drive-v2-head';
import { emptyDrivePackManifest, type DrivePackManifestV2 } from './pack-types';

interface DriveV2WipeStore {
    listCommits(): Promise<DriveV2CommitMeta[]>;
    verifyPacks(expected: readonly { name: string; byteLength: number }[]): Promise<void>;
    commitManifest(
        manifest: DrivePackManifestV2,
        parents?: readonly string[],
    ): Promise<{ commitId: string }>;
}

export async function wipeDriveV2RemoteSnapshot(
    store: DriveV2WipeStore,
    device: string,
): Promise<{ commitId: string }> {
    const parents = computeDriveV2Heads(await store.listCommits())
        .map(commit => commit.commitId)
        .sort((left, right) => left.localeCompare(right));
    await store.verifyPacks([]);
    return store.commitManifest(emptyDrivePackManifest(device), parents);
}
