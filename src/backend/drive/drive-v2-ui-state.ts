export interface DriveV2UploadProgressEvent {
    stage: 'upload';
    completedPacks: number;
    totalPacks: number;
    bytesPerSecond: number;
    etaSeconds: number;
}

export type DriveV2ProgressEvent = DriveV2UploadProgressEvent;

export function canResetDriveV2(typed: string | null, expected: string): boolean {
    return typed === expected;
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
