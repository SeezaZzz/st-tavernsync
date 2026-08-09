import type { RestoreItemType } from './types';

export interface RestorePlainSegment {
    readonly itemId: string;
    readonly itemType: RestoreItemType;
    readonly index: number;
    readonly hash: string;
    readonly bytes: Uint8Array;
}

export interface RestoreBatchLimits {
    readonly maxBatchBytes: number;
    readonly maxBatchSegments: number;
}

export interface RestoreBatch {
    readonly metadata: {
        readonly segments: readonly {
            readonly itemId: string;
            readonly index: number;
            readonly length: number;
            readonly hash: string;
        }[];
    };
    readonly form: FormData;
    readonly plaintextBytes: number;
    release(): void;
}

function makeBatch(segments: RestorePlainSegment[]): RestoreBatch {
    const metadata = {
        segments: segments.map(segment => ({
            itemId: segment.itemId,
            index: segment.index,
            length: segment.bytes.byteLength,
            hash: segment.hash,
        })),
    };
    const form = new FormData();
    form.append('metadata', JSON.stringify(metadata));
    for (const segment of segments) {
        form.append('segments', new Blob([segment.bytes as unknown as BlobPart]), `${segment.index}.part`);
    }
    let released = false;
    return {
        metadata,
        form,
        plaintextBytes: segments.reduce((total, segment) => total + segment.bytes.byteLength, 0),
        release() {
            if (released) return;
            released = true;
            for (const segment of segments) segment.bytes.fill(0);
            segments.length = 0;
        },
    };
}

export async function* buildRestoreBatches(
    source: AsyncIterable<RestorePlainSegment>,
    limits: RestoreBatchLimits,
): AsyncGenerator<RestoreBatch> {
    if (!Number.isSafeInteger(limits.maxBatchBytes) || limits.maxBatchBytes <= 0
        || !Number.isSafeInteger(limits.maxBatchSegments) || limits.maxBatchSegments <= 0) {
        throw new RangeError('invalid restore batch limits');
    }
    let pending: RestorePlainSegment[] = [];
    let pendingBytes = 0;
    try {
        for await (const segment of source) {
            if (segment.bytes.byteLength > limits.maxBatchBytes) {
                segment.bytes.fill(0);
                throw new RangeError('restore segment exceeds batch byte limit');
            }
            if (pending.length > 0 && (
                pending.length >= limits.maxBatchSegments
                || pendingBytes + segment.bytes.byteLength > limits.maxBatchBytes
            )) {
                const ready = pending;
                pending = [];
                pendingBytes = 0;
                yield makeBatch(ready);
            }
            pending.push(segment);
            pendingBytes += segment.bytes.byteLength;
        }
        if (pending.length > 0) {
            const ready = pending;
            pending = [];
            pendingBytes = 0;
            yield makeBatch(ready);
        }
    } finally {
        for (const segment of pending) segment.bytes.fill(0);
    }
}
