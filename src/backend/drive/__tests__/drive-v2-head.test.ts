import { describe, expect, it } from 'vitest';

import type { DriveFileMeta } from '../client';
import {
    computeDriveV2Heads,
    parentProperties,
    parseDriveV2Commit,
    selectNewestDriveV2Head,
    type DriveV2CommitMeta,
} from '../drive-v2-head';

function file(name: string, appProperties: Record<string, string>): DriveFileMeta {
    return { id: `id:${name}`, name, createdTime: '2026-08-09T00:00:00Z', appProperties };
}

function commit(commitId: string, parents: string[]): DriveV2CommitMeta {
    return parseDriveV2Commit(file(`${commitId}.enc`, { ts: 'commit-v2', ...parentProperties(parents) }));
}

describe('Drive v2 commit heads', () => {
    it('selects by Drive createdTime then Drive fileId, never commit name', () => {
        const heads = [
            { fileId: 'file-z', commitId: 'commit-a', parents: [], createdTime: '2026-08-10T01:00:00Z' },
            { fileId: 'file-a', commitId: 'commit-z', parents: [], createdTime: '2026-08-10T02:00:00Z' },
            { fileId: 'file-z', commitId: 'commit-b', parents: [], createdTime: '2026-08-10T02:00:00Z' },
        ];

        expect(selectNewestDriveV2Head(heads).commitId).toBe('commit-b');
    });

    it('treats a Phase-1 commit without parents as the genesis head', () => {
        const genesis = file('g.enc', { ts: 'commit-v2' });
        expect(parseDriveV2Commit(genesis)).toMatchObject({ commitId: 'g', parents: [] });
        expect(computeDriveV2Heads([parseDriveV2Commit(genesis)]).map(x => x.commitId)).toEqual(['g']);
    });

    it('returns both children when two devices fork from one parent', () => {
        const commits = [
            commit('g', []),
            commit('phone', ['g']),
            commit('pc', ['g']),
        ];
        expect(computeDriveV2Heads(commits).map(x => x.commitId).sort()).toEqual(['pc', 'phone']);
    });

    it('encodes every current head as a parent of a force commit', () => {
        expect(parentProperties(['pc', 'phone'])).toEqual({ parents: 'pc,phone' });
    });
});
