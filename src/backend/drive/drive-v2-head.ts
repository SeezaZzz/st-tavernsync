import type { DriveFileMeta } from './client';

export interface DriveV2CommitMeta {
    fileId: string;
    commitId: string;
    parents: string[];
    createdTime: string;
}

export function parseDriveV2Commit(file: DriveFileMeta): DriveV2CommitMeta {
    if (file.appProperties?.ts !== 'commit-v2') {
        throw new TypeError('not a Drive v2 commit');
    }
    return {
        fileId: file.id,
        commitId: file.name.replace(/\.enc$/, ''),
        parents: (file.appProperties.parents ?? '').split(',').filter(Boolean),
        createdTime: file.createdTime ?? '',
    };
}

export function computeDriveV2Heads(commits: readonly DriveV2CommitMeta[]): DriveV2CommitMeta[] {
    const referenced = new Set(commits.flatMap(commit => commit.parents));
    return commits.filter(commit => !referenced.has(commit.commitId));
}

export function selectNewestDriveV2Head(
    heads: readonly DriveV2CommitMeta[],
): DriveV2CommitMeta {
    if (heads.length === 0) throw new Error('Drive v2 has no committed snapshot');
    return [...heads].sort((a, b) =>
        b.createdTime.localeCompare(a.createdTime)
        || b.fileId.localeCompare(a.fileId))[0];
}

export function parentProperties(parents: readonly string[]): Record<string, string> {
    return parents.length ? { parents: parents.join(',') } : {};
}
