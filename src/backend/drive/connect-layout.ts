import {
    discoverDriveLayout,
    MultipleRootsError,
    type DriveLayout,
} from './adapter';
import type { DriveClient, DriveFileMeta } from './client';
import {
    discoverDrivePackLayout,
    findExistingDrivePackLayout,
    recoverExistingDrivePackLayout,
    type DrivePackLayout,
} from './pack-layout';

export type ConnectedDriveLayout =
    | { version: 1; layout: DriveLayout }
    | { version: 2; layout: DrivePackLayout };

export async function resolveDriveLayoutForConnect(options: {
    client: DriveClient;
    currentVersion: 1 | 2;
    knownRootId: string;
    pickLegacyRoot(roots: DriveFileMeta[]): Promise<string | null>;
}): Promise<ConnectedDriveLayout> {
    const knownRootId = options.knownRootId.trim();
    if (options.currentVersion === 2) {
        return {
            version: 2,
            layout: await discoverDrivePackLayout(options.client, knownRootId || undefined),
        };
    }

    const existingV2 = await findExistingDrivePackLayout(options.client);
    if (existingV2) return { version: 2, layout: existingV2 };

    try {
        return {
            version: 1,
            layout: await discoverDriveLayout(options.client, knownRootId || undefined),
        };
    } catch (error) {
        if (error instanceof MultipleRootsError) {
            const picked = await options.pickLegacyRoot(error.roots);
            if (!picked) throw new Error('ยังไม่ได้เลือกโฟลเดอร์ TavernSync');
            return {
                version: 1,
                layout: await discoverDriveLayout(options.client, picked),
            };
        }
        return {
            version: 2,
            layout: await recoverExistingDrivePackLayout(options.client, error),
        };
    }
}
