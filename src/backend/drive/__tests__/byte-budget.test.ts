import { describe, expect, it } from 'vitest';

import { ByteBudget } from '../byte-budget';

describe('ByteBudget', () => {
    it('blocks until enough bytes are released and reports peak usage', async () => {
        const budget = new ByteBudget(10);
        const first = await budget.acquire(8);
        let secondReady = false;
        const secondPromise = budget.acquire(5).then(value => {
            secondReady = true;
            return value;
        });

        await Promise.resolve();
        expect(secondReady).toBe(false);

        first.release();
        const second = await secondPromise;
        expect(budget.peakBytes).toBe(8);
        second.release();
        expect(budget.usedBytes).toBe(0);
    });

    it('allows one oversized item only when the budget is otherwise empty', async () => {
        const budget = new ByteBudget(10);
        const permit = await budget.acquire(15);

        expect(budget.usedBytes).toBe(15);

        permit.release();
        expect(budget.usedBytes).toBe(0);
    });

    it('removes an aborted waiter without leaking capacity', async () => {
        const budget = new ByteBudget(1);
        const held = await budget.acquire(1);
        const abort = new AbortController();
        const waiting = budget.acquire(1, abort.signal);

        abort.abort(new DOMException('cancelled', 'AbortError'));

        await expect(waiting).rejects.toThrow(/cancelled/);
        held.release();
        expect(budget.usedBytes).toBe(0);
    });

    it('releasing a permit twice is harmless', async () => {
        const budget = new ByteBudget(10);
        const permit = await budget.acquire(4);

        permit.release();
        permit.release();

        expect(budget.usedBytes).toBe(0);
    });
});
