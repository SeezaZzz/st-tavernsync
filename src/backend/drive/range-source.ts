import { DriveAuthError, DriveHttpError, type DriveFileMeta } from './client';

export interface DriveChunkRange {
    readonly packName: string;
    readonly offset: number;
    readonly boxedLength: number;
}

interface PackListing {
    listPacks(): Promise<Map<string, DriveFileMeta>>;
}

interface RangeClient {
    getFileRange(id: string, start: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}

interface RangeSourceOptions {
    readonly delays?: readonly number[];
    readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
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
    if (error instanceof DriveAuthError || error instanceof RangeError) return false;
    if (error instanceof DriveHttpError) {
        return error.status === 408 || error.status === 429 || error.status >= 500;
    }
    return error instanceof TypeError;
}

export class DriveRangeSource {
    private readonly listing: Promise<Map<string, DriveFileMeta>>;
    private readonly delays: readonly number[];
    private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;

    constructor(
        store: PackListing,
        private readonly client: RangeClient,
        options: RangeSourceOptions = {},
    ) {
        this.listing = store.listPacks();
        this.delays = options.delays ?? [250, 1_000, 4_000];
        this.sleep = options.sleep ?? defaultSleep;
    }

    async readChunk(ref: DriveChunkRange, signal?: AbortSignal): Promise<Uint8Array> {
        if (!Number.isSafeInteger(ref.offset) || ref.offset < 0
            || !Number.isSafeInteger(ref.boxedLength) || ref.boxedLength <= 0) {
            throw new RangeError('invalid encrypted chunk range');
        }
        const file = (await this.listing).get(ref.packName);
        const size = Number(file?.size);
        if (!file || !Number.isSafeInteger(size) || ref.offset + ref.boxedLength > size) {
            throw new RangeError('encrypted chunk range exceeds its Drive pack');
        }
        for (let attempt = 0; ; attempt++) {
            signal?.throwIfAborted();
            try {
                return await this.client.getFileRange(file.id, ref.offset, ref.boxedLength, signal);
            } catch (error) {
                if (!retryable(error) || attempt >= this.delays.length) throw error;
                await this.sleep(this.delays[attempt], signal);
            }
        }
    }
}
