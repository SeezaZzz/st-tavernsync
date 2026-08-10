import { DriveAuthError } from './client';

export interface DriveV2UploadProgressEvent {
    stage: 'upload';
    completedPacks: number;
    totalPacks: number;
    bytesPerSecond: number;
    etaSeconds: number;
}

export type DriveV2PullProgressEvent =
    | {
        stage: 'download';
        completedPacks: number;
        totalPacks: number;
        bytesPerSecond: number;
        etaSeconds: number;
    }
    | {
        stage: 'apply';
        completedItems: number;
        totalItems: number;
        itemType: string;
        itemsPerSecond: number;
        activeWriters: number;
        etaSeconds: number;
    }
    | {
        stage: 'delete';
        totalItems: number;
    };

export type DriveV2ProgressEvent = DriveV2UploadProgressEvent;

export function canResetDriveV2(typed: string | null, expected: string): boolean {
    return typed === expected;
}

export function driveV2Visibility(): {
    readonly push: true;
    readonly pull: true;
    readonly status: true;
    readonly autoSync: true;
} {
    return { push: true, pull: true, status: true, autoSync: true };
}

export function isDriveReconnectRequired(error: unknown): boolean {
    return error instanceof DriveAuthError
        || (error instanceof Error && error.name === 'DriveAuthError');
}

function formatEta(seconds: number): string {
    const safe = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(safe / 60);
    const remainder = safe % 60;
    return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

export function formatDriveV2PushProgress(event: DriveV2ProgressEvent): string {
    const mbps = event.bytesPerSecond / (1024 * 1024);
    return `Uploading ${event.completedPacks}/${event.totalPacks} · ${mbps.toFixed(1)} MB/s · ETA ${formatEta(event.etaSeconds)}`;
}

export function formatDriveV2PullProgress(event: DriveV2PullProgressEvent): string {
    switch (event.stage) {
        case 'download': {
            const mbps = event.bytesPerSecond / (1024 * 1024);
            return `Downloading packs ${event.completedPacks}/${event.totalPacks} · ${mbps.toFixed(1)} MB/s · ETA ${formatEta(event.etaSeconds)}`;
        }
        case 'apply':
            return `Restoring ${event.completedItems}/${event.totalItems} · `
                + `${event.itemsPerSecond.toFixed(1)} items/s · ${event.activeWriters} writers · `
                + `ETA ${formatEta(event.etaSeconds)}`;
        case 'delete':
            return `Deleting ${event.totalItems} items`;
    }
}
