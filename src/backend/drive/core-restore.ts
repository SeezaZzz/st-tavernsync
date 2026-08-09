import type { RestoreBatch } from '../restore-session/batch-builder';
import { RestoreApiError, type RestoreSessionClient } from '../restore-session/client';
import type { RestoreStartRequest } from '../restore-session/types';

interface CoreRestoreClient extends Pick<
    RestoreSessionClient,
    'capabilities' | 'start' | 'uploadBatch' | 'commit' | 'cancel'
> {}

export interface DriveV2CoreRestoreOptions {
    readonly client: CoreRestoreClient;
    readonly startRequest: RestoreStartRequest;
    readonly batches: AsyncIterable<RestoreBatch>;
    readonly selectedCommitId: string;
    readonly saveBase: (commitId: string) => Promise<void>;
    readonly signal?: AbortSignal;
    readonly retryDelays?: readonly number[];
    readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
    readonly onProgress?: (message: string) => void;
}

export interface DriveV2CoreRestoreResult {
    readonly commitId: string;
    readonly uploadedBatches: number;
    readonly uploadedBytes: number;
    readonly elapsedMs: number;
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, delayMs);
        signal?.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        }, { once: true });
    });
}

function retryable(error: unknown): boolean {
    if (error instanceof RestoreApiError) {
        return error.status === 408 || error.status === 429 || error.status >= 500;
    }
    return error instanceof TypeError;
}

export async function runDriveV2CoreRestore(
    options: DriveV2CoreRestoreOptions,
): Promise<DriveV2CoreRestoreResult> {
    const startedAt = performance.now();
    await options.client.capabilities();
    const started = await options.client.start(options.startRequest);
    const sessionId = started.sessionId;
    const pending = new Set<Promise<void>>();
    const retryDelays = options.retryDelays ?? [250, 1_000, 4_000];
    const sleep = options.sleep ?? defaultSleep;
    let uploadedBatches = 0;
    let uploadedBytes = 0;
    let committed = false;

    const upload = async (batch: RestoreBatch): Promise<void> => {
        for (let attempt = 0; ; attempt++) {
            options.signal?.throwIfAborted();
            try {
                await options.client.uploadBatch(sessionId, batch.form);
                uploadedBatches += 1;
                uploadedBytes += batch.plaintextBytes;
                options.onProgress?.(`Uploading ${uploadedBatches} batch(es)`);
                return;
            } catch (error) {
                if (!retryable(error) || attempt >= retryDelays.length) throw error;
                await sleep(retryDelays[attempt], options.signal);
            }
        }
    };

    try {
        for await (const batch of options.batches) {
            options.signal?.throwIfAborted();
            while (pending.size >= 2) await Promise.race(pending);
            let task: Promise<void>;
            task = upload(batch).finally(() => {
                batch.release();
                pending.delete(task);
            });
            pending.add(task);
        }
        await Promise.all(pending);
        options.signal?.throwIfAborted();
        const result = await options.client.commit(sessionId);
        committed = true;
        if (result.snapshotId !== options.selectedCommitId) {
            throw new RestoreApiError('RESTORE_SNAPSHOT_MISMATCH', 'Committed snapshot does not match Drive head', 502);
        }
        await options.saveBase(options.selectedCommitId);
        return {
            commitId: options.selectedCommitId,
            uploadedBatches,
            uploadedBytes,
            elapsedMs: performance.now() - startedAt,
        };
    } catch (error) {
        await Promise.allSettled([...pending]);
        if (!committed) await options.client.cancel(sessionId).catch(() => {});
        throw error;
    }
}
