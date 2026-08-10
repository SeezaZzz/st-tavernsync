import { describe, expect, it } from 'vitest';

import type { ItemType, Manifest } from '../../../sync-core/types';
import type { DriveV2BaseState } from '../../../state/store';
import type { DriveV2ChoiceInput } from '../drive-v2-choice';
import type { DriveV2CommitMeta } from '../drive-v2-head';
import type { DriveV2PullResult } from '../drive-v2-pull';
import type { DriveV2PushResult, DriveV2Runtime } from '../drive-v2-push';
import {
    runDriveV2Sync,
    type DriveV2SourceChoice,
    type DriveV2SyncOptions,
} from '../drive-v2-sync';
import {
    DRIVE_V2_CHUNK_BYTES,
    DRIVE_V2_PACK_BYTES,
    type DrivePackManifestV2,
} from '../pack-types';

function remoteManifest(device: string): DrivePackManifestV2 {
    return {
        schema: 2,
        storage: 'drive-pack-v2',
        device,
        updatedAt: 2,
        chunkBytes: DRIVE_V2_CHUNK_BYTES,
        packBytes: DRIVE_V2_PACK_BYTES,
        items: {},
    };
}

function syncHarness(input: {
    base: string | null;
    heads: string[];
    direction?: 'push' | 'pull';
    choice?: DriveV2SourceChoice;
    commits?: DriveV2CommitMeta[];
}) {
    const events: string[] = [];
    let choiceCalls = 0;
    let choiceInput: DriveV2ChoiceInput | null = null;
    let committedParents: string[] = [];
    let committedManifest: Partial<DrivePackManifestV2> = {};
    const savedBases: DriveV2BaseState[] = [];
    const commits: DriveV2CommitMeta[] = input.commits ?? input.heads.map(commitId => ({
        fileId: `file:${commitId}`,
        commitId,
        parents: [],
        createdTime: `time:${commitId}`,
    }));
    const runtime = {
        store: {
            async listCommits() { return commits; },
            async readManifest(commit: DriveV2CommitMeta) { return remoteManifest(`device:${commit.commitId}`); },
        },
    } as unknown as DriveV2Runtime;
    const local: Manifest = {
        schema: 1,
        version: 1,
        device: 'local',
        updatedAt: 1,
        items: {},
    };
    const options: DriveV2SyncOptions = {
        direction: input.direction ?? 'push',
        runtime,
        namespace: 'drive:root',
        local,
        allowedTypes: new Set<ItemType>(),
        loadBase: async () => input.base ? { commitId: input.base, syncedAt: 1 } : null,
        saveBase: async base => { savedBases.push(base); },
        async chooseSource(value) {
            choiceCalls += 1;
            choiceInput = value;
            return input.choice ?? { kind: 'cancel' };
        },
        async runPull(commit) {
            events.push(`pull:${commit.commitId}`);
            return { commitId: commit.commitId } as DriveV2PullResult;
        },
        async runPush(push) {
            committedParents = [...push.parents];
            committedManifest = { baseCommitId: push.baseCommitId, forced: push.forced };
            events.push(`push:${push.parents.join(',')}`);
            return {
                commitId: 'new-head',
                manifest: committedManifest,
            } as DriveV2PushResult;
        },
    };
    return {
        options,
        events,
        savedBases,
        get choiceCalls() { return choiceCalls; },
        get choiceInput() { return choiceInput; },
        get committedParents() { return committedParents; },
        get committedManifest() { return committedManifest; },
    };
}

describe('Drive v2 guarded sync', () => {
    it('pushes directly when device base equals the single Drive head', async () => {
        const h = syncHarness({ base: 'head-a', heads: ['head-a'], direction: 'push' });
        await runDriveV2Sync(h.options);
        expect(h.choiceCalls).toBe(0);
        expect(h.committedParents).toEqual(['head-a']);
        expect(h.savedBases.at(-1)?.commitId).toBe('new-head');
    });

    it('pulls the only Drive head without offering the local device as a source', async () => {
        const h = syncHarness({
            base: 'head-a',
            heads: ['head-b'],
            direction: 'pull',
            choice: { kind: 'local' },
        });
        await runDriveV2Sync(h.options);
        expect(h.choiceCalls).toBe(0);
        expect(h.events).toContain('pull:head-b');
        expect(h.events.some(event => event.startsWith('push:'))).toBe(false);
    });

    it('pulls the newest Drive head when Drive contains concurrent heads', async () => {
        const h = syncHarness({
            base: 'head-a',
            heads: [],
            direction: 'pull',
            choice: { kind: 'local' },
            commits: [
                { fileId: 'file-z', commitId: 'head-b', parents: [], createdTime: '2026-08-10T02:00:00Z' },
                { fileId: 'file-a', commitId: 'head-c', parents: [], createdTime: '2026-08-10T02:00:00Z' },
            ],
        });

        await runDriveV2Sync(h.options);

        expect(h.choiceCalls).toBe(0);
        expect(h.events).toEqual(['pull:head-b']);
    });

    it('force-pushes this device and closes every current head', async () => {
        const h = syncHarness({
            base: 'head-a',
            heads: ['head-b', 'head-c'],
            choice: { kind: 'local' },
        });
        await runDriveV2Sync(h.options);
        expect(h.committedParents.sort()).toEqual(['head-b', 'head-c']);
        expect(h.committedManifest).toMatchObject({ baseCommitId: 'head-a', forced: true });
    });

    it('shows every concurrent Drive head as a distinct choice', async () => {
        const h = syncHarness({ base: 'head-a', heads: ['head-b', 'head-c'] });
        await runDriveV2Sync(h.options);
        expect(h.choiceInput?.heads.map(head => head.commitId).sort()).toEqual(['head-b', 'head-c']);
    });

    it('changes nothing when the owner cancels', async () => {
        const h = syncHarness({
            base: 'head-a',
            heads: ['head-b'],
            choice: { kind: 'cancel' },
        });
        await expect(runDriveV2Sync(h.options)).resolves.toMatchObject({ kind: 'cancelled' });
        expect(h.events).toEqual([]);
        expect(h.savedBases).toEqual([]);
    });
});
