import { describe, expect, it } from 'vitest';

import {
    createLocalStorageCheckpointStore,
    DriveV2PullCheckpoint,
    type DriveV2PullCheckpointState,
} from '../pull-checkpoint';

describe('DriveV2PullCheckpoint', () => {
    it('persists resume state in local storage without touching global settings', () => {
        const values = new Map<string, string>();
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => { values.set(key, value); },
            removeItem: (key: string) => { values.delete(key); },
        };
        const store = createLocalStorageCheckpointStore(storage);
        const state: DriveV2PullCheckpointState = {
            commitId: 'head-a',
            completedItemIds: ['preset/one'],
            updatedAt: 1,
        };

        store.save(state);
        expect(store.load()).toEqual(state);
        store.save(null);
        expect(store.load()).toBeNull();
    });

    it('flushes after 25 completions or two seconds and resumes only the same commit', () => {
        const saved: Array<DriveV2PullCheckpointState | null> = [];
        let now = 0;
        const checkpoint = new DriveV2PullCheckpoint('head-a', {
            load: () => ({
                commitId: 'head-a',
                completedItemIds: ['preset/old'],
                updatedAt: 0,
            }),
            save: value => { saved.push(value); },
        }, () => now);

        expect(checkpoint.completedIds.has('preset/old')).toBe(true);
        for (let index = 0; index < 24; index++) checkpoint.markCompleted(`preset/${index}`);
        expect(saved).toHaveLength(0);
        checkpoint.markCompleted('preset/24');
        expect(saved).toHaveLength(1);

        now = 2_100;
        checkpoint.markCompleted('preset/25');
        checkpoint.flushIfDue();
        expect(saved).toHaveLength(2);
    });

    it('discards a checkpoint from another Drive head', () => {
        let stored: DriveV2PullCheckpointState | null = {
            commitId: 'head-a',
            completedItemIds: ['chat/a/one'],
            updatedAt: 1,
        };
        const checkpoint = new DriveV2PullCheckpoint('head-b', {
            load: () => stored,
            save: value => { stored = value; },
        });

        expect([...checkpoint.completedIds]).toEqual([]);
    });

    it('force-flushes on error and clears only after success', () => {
        const saved: Array<DriveV2PullCheckpointState | null> = [];
        const checkpoint = new DriveV2PullCheckpoint('head-a', {
            load: () => null,
            save: value => { saved.push(value); },
        });

        checkpoint.markCompleted('preset/one');
        checkpoint.flushIfDue(true);
        checkpoint.finish();

        expect(saved[0]).toMatchObject({
            commitId: 'head-a',
            completedItemIds: ['preset/one'],
        });
        expect(saved[1]).toBeNull();
    });

    it('force-flushes a loaded checkpoint even when no new item completed', () => {
        const saved: Array<DriveV2PullCheckpointState | null> = [];
        const checkpoint = new DriveV2PullCheckpoint('head-a', {
            load: () => ({
                commitId: 'head-a',
                completedItemIds: ['preset/done'],
                updatedAt: 1,
            }),
            save: value => { saved.push(value); },
        });

        checkpoint.flushIfDue(true);

        expect(saved).toHaveLength(1);
        expect(saved[0]?.completedItemIds).toEqual(['preset/done']);
    });
});
