import type { DriveClient } from './client';
import { createDrivePackLayout, type DrivePackLayout } from './pack-layout';
import {
    resolveDriveStorageByPassphrase,
    type DriveStorageResolution,
} from './root-resolver';

export type DriveStorageAction = 'unlock' | 'push' | 'pull' | 'status';

export interface ActivateDriveStorageOptions {
    action: DriveStorageAction;
    client: DriveClient;
    passphrase: string;
    rememberedRootId?: string;
    adopt(layout: DrivePackLayout): Promise<void> | void;
    unlock(passphrase: string): Promise<void> | void;
}

export async function activateDriveStorage(
    options: ActivateDriveStorageOptions,
): Promise<DriveStorageResolution> {
    let resolution = await resolveDriveStorageByPassphrase({
        client: options.client,
        passphrase: options.passphrase,
        rememberedRootId: options.rememberedRootId,
    });
    if (resolution.kind === 'missing') {
        if (options.action !== 'push') return resolution;
        resolution = {
            kind: 'empty',
            layout: await createDrivePackLayout(options.client),
        };
    }
    await options.adopt(resolution.layout);
    await options.unlock(options.passphrase);
    return resolution;
}
