import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setGenerationBusy, isGenerationBusy } from '../engine';

describe('generation lock', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        setGenerationBusy(false);
    });

    afterEach(() => {
        setGenerationBusy(false);
        vi.useRealTimers();
    });

    it('ว่างโดยดีฟอลต์', () => {
        expect(isGenerationBusy()).toBe(false);
    });

    it('ล็อกตอน generate จริง แล้วปลดตอนจบ', () => {
        setGenerationBusy(true);
        expect(isGenerationBusy()).toBe(true);
        setGenerationBusy(false);
        expect(isGenerationBusy()).toBe(false);
    });

    it('ยังล็อกอยู่ถ้ายังไม่ถึงเพดานเวลา', () => {
        setGenerationBusy(true);
        vi.advanceTimersByTime(4 * 60_000);
        expect(isGenerationBusy()).toBe(true);
    });

    // กันเคสที่ทำให้ Push พังถาวร: ST ยิง "เริ่ม" แล้วไม่ยิง "จบ" (dry run / path ใหม่)
    it('ปลดล็อกเองเมื่อเกิน 5 นาทีโดยไม่มีอีเวนต์จบ', () => {
        setGenerationBusy(true);
        vi.advanceTimersByTime(5 * 60_000);
        expect(isGenerationBusy()).toBe(false);
    });

    it('ปลดล็อกเองแล้วยังล็อกใหม่ได้ปกติ', () => {
        setGenerationBusy(true);
        vi.advanceTimersByTime(6 * 60_000);
        expect(isGenerationBusy()).toBe(false);
        setGenerationBusy(true);
        expect(isGenerationBusy()).toBe(true);
    });
});
