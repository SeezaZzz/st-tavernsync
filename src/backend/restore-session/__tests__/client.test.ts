import { describe, expect, it, vi } from 'vitest';

import { RestoreSessionClient } from '../client';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
});

describe('RestoreSessionClient', () => {
    it('uses authenticated same-origin routes and validates protocol limits', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(json({
            protocol: 1,
            maxSegmentBytes: 1_048_576,
            maxBatchBytes: 8_388_608,
            maxBatchSegments: 8,
            maxInFlightBatches: 2,
            itemTypes: [],
            supportsRollback: true,
            supportsCancellation: true,
        }));
        const client = new RestoreSessionClient(fetchImpl, () => ({ 'X-CSRF-Token': 'csrf' }));

        await expect(client.capabilities()).resolves.toMatchObject({ protocol: 1, maxBatchBytes: 8_388_608 });
        expect(fetchImpl).toHaveBeenCalledWith(
            '/api/users/restore/capabilities',
            expect.objectContaining({ method: 'GET', headers: expect.any(Headers) }),
        );
    });

    it('surfaces stable server codes without leaking server details', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(json({
            error: { code: 'RESTORE_BUSY', message: 'Restore rejected' },
        }, 409));
        const client = new RestoreSessionClient(fetchImpl, () => ({}));

        await expect(client.capabilities()).rejects.toEqual(expect.objectContaining({
            name: 'RestoreApiError',
            code: 'RESTORE_BUSY',
            status: 409,
        }));
    });

    it('maps a missing capability endpoint to the update-required code', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response('Not found', { status: 404 }));
        const client = new RestoreSessionClient(fetchImpl, () => ({}));

        await expect(client.capabilities()).rejects.toMatchObject({
            code: 'SILLYTAVERN_UPDATE_REQUIRED',
            status: 404,
        });
    });

    it('uploads FormData without overriding its multipart content type', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(json({
            sessionId: 'session one',
            snapshotId: 'head-a',
            state: 'receiving',
        }));
        const client = new RestoreSessionClient(fetchImpl, () => ({ 'X-CSRF-Token': 'csrf' }));
        const form = new FormData();
        form.append('metadata', '{}');

        await client.uploadBatch('session one', form);

        const [, request] = fetchImpl.mock.calls[0];
        expect(new Headers(request.headers).get('Content-Type')).toBeNull();
        expect(fetchImpl.mock.calls[0][0]).toBe('/api/users/restore/session%20one/batch');
    });
});
