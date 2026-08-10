export type PullStage = 'manifest' | 'pack-download' | 'decrypt' | 'local-read' | 'local-write' | 'verify' | 'delete';

function sanitizeTarget(target: string): string {
    try {
        const url = new URL(target, globalThis.location?.origin ?? 'http://localhost');
        return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
        return target.split(/[?#]/, 1)[0];
    }
}

export class PullStageError extends Error {
    readonly safeTarget: string;
    constructor(
        readonly stage: PullStage,
        readonly method: string,
        target: string,
        readonly cause: unknown,
    ) {
        const safeTarget = sanitizeTarget(target);
        super(`Pull ${stage} failed: ${method} ${safeTarget}`);
        this.name = 'PullStageError';
        this.safeTarget = safeTarget;
    }
}

export async function withPullStage<T>(
    stage: PullStage,
    method: string,
    target: string,
    operation: () => Promise<T>,
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof PullStageError) throw error;
        if (error instanceof Error && error.name === 'DriveAuthError') throw error;
        throw new PullStageError(stage, method, target, error);
    }
}

export function isTransientPullError(error: unknown): boolean {
    const candidate = error instanceof PullStageError ? error.cause : error;
    if (candidate instanceof TypeError && /load failed|failed to fetch|network/i.test(candidate.message)) return true;
    if (typeof candidate === 'object' && candidate !== null && 'status' in candidate) {
        const status = Number((candidate as { status: unknown }).status);
        return status === 408 || status === 429 || status >= 500;
    }
    return false;
}
