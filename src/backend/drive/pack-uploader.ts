import {
    DriveAuthError,
    DriveClient,
    DriveHttpError,
    type DriveFileMeta,
    type ResumableRangeResult,
} from './client';
import { DRIVE_V2_RANGE_BYTES, type EncryptedPack } from './pack-types';

const MAX_RETRIES = 5;

export class DriveUploadPausedError extends Error {
    constructor(
        readonly sessionUrl: string,
        readonly acknowledgedBytes: number,
        override readonly cause: DriveAuthError,
    ) {
        super('Google authentication required to resume upload');
        this.name = 'DriveUploadPausedError';
    }
}

export interface PackUploadControl {
    signal?: AbortSignal;
    onUploadedBytes?(uploaded: number, total: number): void;
    onRetry?(attempt: number, delayMs: number): void;
}

export interface UploadPackOptions extends PackUploadControl {
    client: Pick<DriveClient, 'beginResumableFile' | 'putResumableRange' | 'queryResumableFile'>;
    parentId: string;
    pack: EncryptedPack;
    rangeBytes?: number;
    sleep?(ms: number): Promise<void>;
    random?(): number;
    resume?: { sessionUrl: string; acknowledgedBytes: number };
}

function isTransient(error: unknown): boolean {
    if (error instanceof DriveHttpError) {
        return error.status === 408 || error.status === 429 || error.status >= 500;
    }
    return error instanceof TypeError;
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function pause(sessionUrl: string, acknowledgedBytes: number, error: DriveAuthError): never {
    throw new DriveUploadPausedError(sessionUrl, acknowledgedBytes, error);
}

export async function uploadPackResumable(options: UploadPackOptions): Promise<DriveFileMeta> {
    const totalBytes = options.pack.bytes.byteLength;
    const rangeBytes = options.rangeBytes ?? DRIVE_V2_RANGE_BYTES;
    if (!Number.isSafeInteger(rangeBytes) || rangeBytes <= 0) {
        throw new RangeError('rangeBytes must be a positive safe integer');
    }
    if (totalBytes === 0) throw new RangeError('pack must not be empty');

    const sleep = options.sleep ?? defaultSleep;
    const random = options.random ?? Math.random;
    let sessionUrl = options.resume?.sessionUrl ?? '';
    let acknowledgedBytes = options.resume?.acknowledgedBytes ?? 0;
    let attempt = 0;

    while (!sessionUrl) {
        options.signal?.throwIfAborted();
        try {
            sessionUrl = await options.client.beginResumableFile(
                options.parentId,
                options.pack.name,
                totalBytes,
                { ts: 'pack-v2' },
            );
        } catch (error) {
            if (error instanceof DriveAuthError) pause('', 0, error);
            if (!isTransient(error) || attempt >= MAX_RETRIES) throw error;
            const delayMs = Math.min(1000 * (2 ** attempt) + random() * 1000, 32_000);
            attempt += 1;
            options.onRetry?.(attempt, delayMs);
            await sleep(delayMs);
        }
    }

    let queryBeforeWrite = Boolean(options.resume);
    attempt = 0;
    while (true) {
        options.signal?.throwIfAborted();
        try {
            let result: ResumableRangeResult;
            const wasQuery = queryBeforeWrite;
            if (queryBeforeWrite) {
                result = await options.client.queryResumableFile(sessionUrl, totalBytes);
            } else {
                const end = Math.min(acknowledgedBytes + rangeBytes, totalBytes);
                result = await options.client.putResumableRange(
                    sessionUrl,
                    options.pack.bytes.subarray(acknowledgedBytes, end),
                    acknowledgedBytes,
                    totalBytes,
                );
            }

            if (result.kind === 'complete') {
                options.onUploadedBytes?.(totalBytes, totalBytes);
                return result.file;
            }
            if (!Number.isSafeInteger(result.acknowledgedBytes)
                || result.acknowledgedBytes < 0
                || result.acknowledgedBytes > totalBytes) {
                throw new RangeError(`invalid acknowledged offset: ${result.acknowledgedBytes}`);
            }
            if (!wasQuery && result.acknowledgedBytes <= acknowledgedBytes) {
                throw new TypeError('Drive resumable upload made no progress');
            }
            acknowledgedBytes = result.acknowledgedBytes;
            options.onUploadedBytes?.(acknowledgedBytes, totalBytes);
            queryBeforeWrite = false;
            attempt = 0;
        } catch (error) {
            if (error instanceof DriveAuthError) pause(sessionUrl, acknowledgedBytes, error);
            if (!isTransient(error) || attempt >= MAX_RETRIES) throw error;
            const delayMs = Math.min(1000 * (2 ** attempt) + random() * 1000, 32_000);
            attempt += 1;
            options.onRetry?.(attempt, delayMs);
            await sleep(delayMs);
            queryBeforeWrite = true;
        }
    }
}
