import { describe, expect, it } from 'vitest';
import { mapPool } from '../pool';

describe('mapPool', () => {
    it('จำกัดจำนวนงานพร้อมกันและรักษาลำดับผลลัพธ์', async () => {
        let active = 0;
        let peak = 0;

        const results = await mapPool([1, 2, 3, 4, 5], 2, async (value) => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
            return value * 10;
        });

        expect(results).toEqual([10, 20, 30, 40, 50]);
        expect(peak).toBe(2);
    });

    it('คืนรายการว่างโดยไม่เรียก worker', async () => {
        let calls = 0;
        const results = await mapPool([], 4, async (value: number) => {
            calls++;
            return value;
        });

        expect(results).toEqual([]);
        expect(calls).toBe(0);
    });

    it('หยุดแจกงานใหม่หลัง worker แรกพัง', async () => {
        const started: number[] = [];

        await expect(mapPool([0, 1, 2, 3, 4, 5], 2, async (value) => {
            started.push(value);
            if (value === 0) throw new Error('boom');
            await new Promise((resolve) => setTimeout(resolve, 5));
            return value;
        })).rejects.toThrow('boom');

        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(started).toEqual([0, 1]);
    });
});
