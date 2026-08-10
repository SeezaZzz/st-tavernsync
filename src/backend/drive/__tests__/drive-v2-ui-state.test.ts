import { describe, expect, it } from 'vitest';

import {
    canResetDriveV2,
    driveV2Visibility,
    formatDriveV2PullProgress,
    formatDriveV2PushProgress,
    isDriveReconnectRequired,
} from '../drive-v2-ui-state';
import { DriveAuthError } from '../client';

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

    it('formats Pull download apply and deletion progress', () => {
        expect(formatDriveV2PullProgress({
            stage: 'download',
            completedPacks: 8,
            totalPacks: 30,
            bytesPerSecond: 11.2 * 1024 * 1024,
            etaSeconds: 19,
        })).toBe('Downloading packs 8/30 · 11.2 MB/s · ETA 00:19');
        expect(formatDriveV2PullProgress({
            stage: 'apply',
            completedItems: 724,
            totalItems: 2347,
            itemType: 'chat',
            itemsPerSecond: 24.5,
            activeWriters: 7,
            etaSeconds: 66,
        })).toBe('Restoring 724/2347 · 24.5 items/s · 7 writers · ETA 01:06');
        expect(formatDriveV2PullProgress({ stage: 'delete', totalItems: 3 }))
            .toBe('Deleting 3 items');
    });

    it('shows manual and automatic Drive v2 sync controls', () => {
        expect(driveV2Visibility()).toEqual({
            push: true,
            pull: true,
            status: true,
            autoSync: true,
        });
    });

    it('recognizes expired Google authorization as reconnect-and-resume', () => {
        expect(isDriveReconnectRequired(new DriveAuthError())).toBe(true);
        expect(isDriveReconnectRequired(new Error('ordinary failure'))).toBe(false);
    });
});
