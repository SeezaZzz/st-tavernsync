import { expect, it, vi } from 'vitest';

import { RestoreApiError } from '../../restore-session/client';
import type { RestoreBatch } from '../../restore-session/batch-builder';
import { runDriveV2CoreRestore } from '../core-restore';

function batch(index: number, released: number[]): RestoreBatch {
    return {
        metadata: { segments: [] },
        form: new FormData(),
        plaintextBytes: 1,
        release: () => released.push(index),
    };
}

function harness(options: { fault?: 'upload' | 'wrong-snapshot' | 'cancel' } = {}) {
    let active = 0;
    let peak = 0;
    const released: number[] = [];
    const saveBase = vi.fn();
    const cancel = vi.fn().mockResolvedValue({ sessionId: 'session-1', snapshotId: 'head-a', state: 'cancelled' });
    const controller = new AbortController();
    if (options.fault === 'cancel') controller.abort();
    const client = {
        capabilities: vi.fn().mockResolvedValue({
            protocol: 1, maxSegmentBytes: 1_048_576, maxBatchBytes: 8_388_608,
            maxBatchSegments: 8, maxInFlightBatches: 2,
            itemTypes: [], supportsRollback: true, supportsCancellation: true,
        }),
        start: vi.fn().mockResolvedValue({ sessionId: 'session-1', snapshotId: 'head-a', state: 'receiving' }),
        async uploadBatch() {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active -= 1;
            if (options.fault === 'upload') throw new RestoreApiError('TEMP', 'temporary', 500);
            return { sessionId: 'session-1', snapshotId: 'head-a', state: 'receiving' as const };
        },
        commit: vi.fn().mockResolvedValue({
            sessionId: 'session-1',
            snapshotId: options.fault === 'wrong-snapshot' ? 'head-b' : 'head-a',
            state: 'committed',
        }),
        cancel,
    };
    async function* batches() {
        for (let index = 0; index < 5; index++) yield batch(index, released);
    }
    return {
        options: {
            client,
            startRequest: {
                requestId: 'request-1', snapshotId: 'head-a', scopes: [],
                expectedItems: 0, expectedBytes: 0, items: [],
            },
            batches: batches(),
            selectedCommitId: 'head-a',
            saveBase,
            signal: controller.signal,
            retryDelays: [0, 0],
        },
        client,
        cancel,
        saveBase,
        released,
        peak: () => peak,
    };
}

it('keeps at most two uploads in flight and advances the exact committed head', async () => {
    const h = harness();

    await expect(runDriveV2CoreRestore(h.options)).resolves.toMatchObject({ commitId: 'head-a', uploadedBatches: 5 });
    expect(h.peak()).toBe(2);
    expect(h.client.commit).toHaveBeenCalledOnce();
    expect(h.saveBase).toHaveBeenCalledWith('head-a');
    expect(h.released.sort()).toEqual([0, 1, 2, 3, 4]);
});

it.each(['upload', 'wrong-snapshot', 'cancel'] as const)('%s never advances base', async fault => {
    const h = harness({ fault });

    await expect(runDriveV2CoreRestore(h.options)).rejects.toBeDefined();
    expect(h.saveBase).not.toHaveBeenCalled();
    if (fault !== 'wrong-snapshot') expect(h.cancel).toHaveBeenCalledOnce();
});
