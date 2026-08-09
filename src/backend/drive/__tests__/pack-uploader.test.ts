import { describe, expect, it, vi } from 'vitest';

import {
    DriveAuthError,
    DriveHttpError,
    type ResumableRangeResult,
} from '../client';
import { DriveUploadPausedError, uploadPackResumable } from '../pack-uploader';
import type { EncryptedPack } from '../pack-types';

function httpError(status: number): DriveHttpError {
    return new DriveHttpError(status, `status ${status}`);
}

function incomplete(bytes: number): ResumableRangeResult {
    return { kind: 'incomplete', acknowledgedBytes: bytes };
}

function complete(id: string): ResumableRangeResult {
    return { kind: 'complete', file: { id, name: id } };
}

function pack32(): EncryptedPack {
    return { name: 'pack-32', bytes: new Uint8Array(32), chunks: [] };
}

function retryClient(events: Array<ResumableRangeResult | Error>) {
    const queue = [...events];
    const starts: number[] = [];
    const next = (): ResumableRangeResult => {
        const event = queue.shift();
        if (!event) throw new Error('test event queue exhausted');
        if (event instanceof Error) throw event;
        return event;
    };
    return {
        starts,
        async beginResumableFile(): Promise<string> {
            return 'https://upload/session';
        },
        async putResumableRange(
            _sessionUrl: string,
            _data: Uint8Array,
            start: number,
        ): Promise<ResumableRangeResult> {
            starts.push(start);
            return next();
        },
        async queryResumableFile(): Promise<ResumableRangeResult> {
            return next();
        },
    };
}

describe('pack resumable uploader', () => {
    it('retries 429 then continues from Drive acknowledged offset', async () => {
        const sleep = vi.fn(async () => undefined);
        const client = retryClient([httpError(429), incomplete(8), complete('file1')]);
        const file = await uploadPackResumable({
            client,
            parentId: 'packs',
            pack: pack32(),
            rangeBytes: 8,
            sleep,
            random: () => 0,
        });
        expect(file.id).toBe('file1');
        expect(sleep).toHaveBeenCalledWith(1000);
        expect(client.starts).toEqual([0, 8]);
    });

    it('surfaces 401 as DriveUploadPausedError without discarding completed offset', async () => {
        const client = retryClient([incomplete(8), new DriveAuthError()]);
        await expect(uploadPackResumable({
            client,
            parentId: 'packs',
            pack: pack32(),
            rangeBytes: 8,
        })).rejects.toEqual(expect.objectContaining<Partial<DriveUploadPausedError>>({
            name: 'DriveUploadPausedError',
            acknowledgedBytes: 8,
        }));
    });

    it.each([408, 500, 503])('retries transient HTTP %i', async status => {
        const sleep = vi.fn(async () => undefined);
        const client = retryClient([httpError(status), incomplete(0), complete('file1')]);
        await expect(uploadPackResumable({
            client,
            parentId: 'packs',
            pack: pack32(),
            rangeBytes: 32,
            sleep,
            random: () => 0,
        })).resolves.toEqual({ id: 'file1', name: 'file1' });
        expect(sleep).toHaveBeenCalledTimes(1);
    });
});
