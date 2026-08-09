import { describe, expect, it } from 'vitest';

import {
    canResetDriveV2,
    formatDriveV2PushProgress,
} from '../drive-v2-ui-state';

describe('Drive v2 UI state', () => {
    it('formats measurable progress with throughput and ETA', () => {
        expect(formatDriveV2PushProgress({
            stage: 'upload',
            completedPacks: 18,
            totalPacks: 31,
            bytesPerSecond: 6.2 * 1024 * 1024,
            etaSeconds: 64,
        })).toBe('Uploading 18/31 · 6.2 MB/s · ETA 01:04');
    });

    it('requires the exact destructive confirmation phrase', () => {
        expect(canResetDriveV2('RESET DRIVE V2', 'RESET DRIVE V2')).toBe(true);
        expect(canResetDriveV2('reset drive v2', 'RESET DRIVE V2')).toBe(false);
        expect(canResetDriveV2(null, 'RESET DRIVE V2')).toBe(false);
    });
});
