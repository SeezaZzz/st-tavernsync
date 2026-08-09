import type {
    RestoreCapabilities,
    RestoreCommittedResult,
    RestoreSessionState,
    RestoreSessionStatus,
    RestoreStartRequest,
} from './types';

const SESSION_STATES: readonly RestoreSessionState[] = [
    'receiving', 'ready', 'applying', 'deleting', 'rolling_back',
    'committed', 'cancelled', 'failed', 'rolled_back',
];

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSessionState(value: unknown): value is RestoreSessionState {
    return typeof value === 'string' && SESSION_STATES.some(state => state === value);
}

function parseCapabilities(value: unknown): RestoreCapabilities {
    if (!isRecord(value)
        || value.protocol !== 1
        || value.maxSegmentBytes !== 1_048_576
        || value.maxBatchBytes !== 8_388_608
        || value.maxBatchSegments !== 8
        || value.maxInFlightBatches !== 2
        || !Array.isArray(value.itemTypes)
        || typeof value.supportsRollback !== 'boolean'
        || typeof value.supportsCancellation !== 'boolean') {
        throw new RestoreApiError('SILLYTAVERN_UPDATE_REQUIRED', 'Incompatible SillyTavern restore API', 426);
    }
    return value as unknown as RestoreCapabilities;
}

function parseStatus(value: unknown): RestoreSessionStatus {
    if (!isRecord(value)
        || typeof value.sessionId !== 'string'
        || typeof value.snapshotId !== 'string'
        || !isSessionState(value.state)) {
        throw new RestoreApiError('RESTORE_RESPONSE_INVALID', 'Invalid SillyTavern restore response', 502);
    }
    return value as unknown as RestoreSessionStatus;
}

export class RestoreApiError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = 'RestoreApiError';
    }
}

export class RestoreSessionClient {
    constructor(
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly requestHeaders: () => Record<string, string> = () => SillyTavern.getContext().getRequestHeaders(),
    ) {}

    async capabilities(): Promise<RestoreCapabilities> {
        try {
            return parseCapabilities(await this.request('/api/users/restore/capabilities', { method: 'GET' }));
        } catch (error) {
            if (error instanceof RestoreApiError && (error.status === 404 || error.status === 405)) {
                throw new RestoreApiError(
                    'SILLYTAVERN_UPDATE_REQUIRED',
                    'SillyTavern restore API is unavailable',
                    error.status,
                );
            }
            throw error;
        }
    }

    async start(body: RestoreStartRequest): Promise<RestoreSessionStatus> {
        return parseStatus(await this.request('/api/users/restore/start', {
            method: 'POST',
            body: JSON.stringify(body),
        }));
    }

    async uploadBatch(sessionId: string, form: FormData): Promise<RestoreSessionStatus> {
        return parseStatus(await this.request(`/api/users/restore/${encodeURIComponent(sessionId)}/batch`, {
            method: 'POST',
            body: form,
        }));
    }

    async status(sessionId: string): Promise<RestoreSessionStatus> {
        return parseStatus(await this.request(`/api/users/restore/${encodeURIComponent(sessionId)}`, { method: 'GET' }));
    }

    async commit(sessionId: string): Promise<RestoreCommittedResult> {
        const status = parseStatus(await this.request(`/api/users/restore/${encodeURIComponent(sessionId)}/commit`, {
            method: 'POST',
            body: '{}',
        }));
        if (status.state !== 'committed') {
            throw new RestoreApiError('RESTORE_RESPONSE_INVALID', 'Restore did not commit', 502);
        }
        return status as RestoreCommittedResult;
    }

    async cancel(sessionId: string): Promise<RestoreSessionStatus> {
        return parseStatus(await this.request(`/api/users/restore/${encodeURIComponent(sessionId)}/cancel`, {
            method: 'POST',
            body: '{}',
        }));
    }

    private async request(url: string, init: RequestInit): Promise<unknown> {
        const headers = new Headers(this.requestHeaders());
        if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
        const response = await this.fetchImpl(url, { ...init, headers });
        let body: unknown;
        try {
            body = await response.json();
        } catch {
            body = null;
        }
        if (!response.ok) {
            const error = isRecord(body) && isRecord(body.error) ? body.error : null;
            throw new RestoreApiError(
                typeof error?.code === 'string' ? error.code : 'RESTORE_REQUEST_FAILED',
                'Restore request failed',
                response.status,
            );
        }
        return body;
    }
}

export type {
    RestoreCapabilities,
    RestoreCommittedResult,
    RestoreSessionStatus,
    RestoreStartRequest,
} from './types';
