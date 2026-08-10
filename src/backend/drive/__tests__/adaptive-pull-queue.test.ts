import { describe, expect, it, vi } from 'vitest';

import type { ItemType } from '../../../sync-core/types';
import {
    classifyPullJob,
    runAdaptivePullQueue,
    type AdaptivePullSnapshot,
    type PullCostClass,
    type PullJob,
} from '../adaptive-pull-queue';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function jobs(ids: string[]): PullJob[] {
    const remoteIds = new Set(ids);
    return ids.map(id => classifyPullJob({
        id,
        type: id.split('/')[0] as ItemType,
        size: 1,
        hash: id,
        mtime: 1,
        chunks: [],
    }, remoteIds));
}

function testLimits(overrides: Partial<Record<PullCostClass, number>>) {
    return {
        initial: {
            small: overrides.small ?? 8,
            medium: overrides.medium ?? 4,
            heavy: overrides.heavy ?? 1,
            serial: 1,
        },
        minimum: { small: 1, medium: 1, heavy: 1, serial: 1 },
        maximum: { small: 16, medium: 8, heavy: 2, serial: 1 },
    };
}

describe('adaptive rolling pull queue', () => {
    it('starts the next ready job as soon as one slot frees without a batch barrier', async () => {
        const gate = deferred<void>();
        const started: string[] = [];
        const running = runAdaptivePullQueue({
            jobs: jobs(['preset/a', 'preset/b', 'preset/c']),
            limits: testLimits({ small: 2 }),
            async run(job) {
                started.push(job.item.id);
                if (job.item.id === 'preset/a') await gate.promise;
            },
        });

        await vi.waitFor(() => expect(started).toEqual(['preset/a', 'preset/b', 'preset/c']));
        gate.resolve(undefined);

        await expect(running).resolves.toMatchObject({ completed: 3, maxActiveWriters: 2 });
    });

    it('waits for a matching character before its chat but does not block unrelated small jobs', async () => {
        const events: string[] = [];

        await runAdaptivePullQueue({
            jobs: jobs(['chat/A.png/one', 'preset/x', 'character/A.png']),
            async run(job) { events.push(job.item.id); },
        });

        expect(events.indexOf('character/A.png')).toBeLessThan(events.indexOf('chat/A.png/one'));
        expect(events).toContain('preset/x');
    });

    it('raises a class after stable completions and lowers it after latency doubles', async () => {
        const snapshots: AdaptivePullSnapshot[] = [];
        const durations = [...Array<number>(16).fill(10), ...Array<number>(16).fill(40)];
        let time = 0;
        let durationIndex = 0;

        await runAdaptivePullQueue({
            jobs: jobs(Array.from({ length: 32 }, (_, index) => `preset/${index}`)),
            now: () => time,
            async run() { time += durations[durationIndex++] ?? 1; },
            onSnapshot(value) { snapshots.push(value); },
        });

        expect(snapshots.some(value => value.limits.small > 8)).toBe(true);
        expect(snapshots.at(-1)!.limits.small).toBeLessThanOrEqual(8);
    });

    it('rejects dependency cycles rather than hanging', async () => {
        const cyclic = jobs(['preset/a', 'preset/b']).map((job, index, all) => ({
            ...job,
            dependencies: [all[1 - index].item.id],
        }));

        await expect(runAdaptivePullQueue({ jobs: cyclic, async run() {} }))
            .rejects.toThrow(/dependency deadlock/i);
    });
});
