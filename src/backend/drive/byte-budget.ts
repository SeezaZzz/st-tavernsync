export interface BytePermit {
    readonly bytes: number;
    release(): void;
}

interface Waiter {
    readonly bytes: number;
    readonly signal?: AbortSignal;
    resolve(value: BytePermit): void;
    reject(error: unknown): void;
}

export class ByteBudget {
    usedBytes = 0;
    peakBytes = 0;
    private readonly waiters: Waiter[] = [];

    constructor(readonly capacityBytes: number) {
        if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 1) {
            throw new RangeError('invalid byte budget');
        }
    }

    acquire(bytes: number, signal?: AbortSignal): Promise<BytePermit> {
        if (!Number.isSafeInteger(bytes) || bytes < 1) {
            return Promise.reject(new RangeError('invalid byte request'));
        }
        signal?.throwIfAborted();

        return new Promise((resolve, reject) => {
            const waiter: Waiter = { bytes, resolve, reject, signal };
            const onAbort = (): void => {
                const index = this.waiters.indexOf(waiter);
                if (index < 0) return;
                this.waiters.splice(index, 1);
                reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
                this.drain();
            };

            signal?.addEventListener('abort', onAbort, { once: true });
            const originalResolve = waiter.resolve;
            waiter.resolve = value => {
                signal?.removeEventListener('abort', onAbort);
                originalResolve(value);
            };
            this.waiters.push(waiter);
            this.drain();
        });
    }

    private drain(): void {
        for (;;) {
            const next = this.waiters[0];
            if (!next) return;

            const fits = this.usedBytes + next.bytes <= this.capacityBytes;
            const exclusiveOversize = this.usedBytes === 0 && next.bytes > this.capacityBytes;
            if (!fits && !exclusiveOversize) return;

            this.waiters.shift();
            this.usedBytes += next.bytes;
            this.peakBytes = Math.max(this.peakBytes, this.usedBytes);

            let released = false;
            next.resolve({
                bytes: next.bytes,
                release: () => {
                    if (released) return;
                    released = true;
                    this.usedBytes -= next.bytes;
                    this.drain();
                },
            });
        }
    }
}
