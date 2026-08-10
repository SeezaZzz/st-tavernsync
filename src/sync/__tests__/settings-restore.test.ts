import { describe, expect, it } from 'vitest';

import { mergePulledSettings } from '../engine';

describe('restored settings merge', () => {
    it('keeps destination TavernSync state while applying other extension settings from the snapshot', () => {
        (globalThis as unknown as { SillyTavern: unknown }).SillyTavern = {
            getContext: () => ({
                extensionSettings: {
                    tavernsync: { deviceName: 'fallback', driveFolderId: 'fallback-root' },
                },
            }),
        };
        const merged = mergePulledSettings({
            extension_settings: {
                tavernsync: { deviceName: 'phone', driveFolderId: 'phone-root' },
                localOnly: { enabled: true },
            },
        }, {
            extension_settings: {
                tavernsync: { deviceName: 'pc', driveFolderId: 'pc-root' },
                syncedExtension: { enabled: true },
            },
            world_info_settings: { world_info: { globalSelect: ['Lore A'] } },
        });

        expect(merged.extension_settings).toEqual({
            tavernsync: { deviceName: 'phone', driveFolderId: 'phone-root' },
            localOnly: { enabled: true },
            syncedExtension: { enabled: true },
        });
        expect(merged.world_info_settings).toEqual({
            world_info: { globalSelect: ['Lore A'] },
        });
    });
});
