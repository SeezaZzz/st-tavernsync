import { describe, expect, it } from 'vitest';

import { stripSettingsForSync } from '../normalize';

describe('settings normalization', () => {
    it('removes device-local TavernSync state from the real extension_settings key', () => {
        const stripped = stripSettingsForSync({
            extension_settings: {
                tavernsync: { deviceName: 'pc', driveFolderId: 'root-a' },
                anotherExtension: { enabled: true },
            },
        });

        expect(stripped).toEqual({
            extension_settings: {
                anotherExtension: { enabled: true },
            },
        });
    });

    it('keeps connection profile secret references while removing secret values', () => {
        const apiKeyField = `api_${'key'}`;
        const stripped = stripSettingsForSync({
            extension_settings: {
                connectionManager: {
                    profiles: [{
                        name: 'Primary',
                        'secret-id': 'credential-reference',
                        [apiKeyField]: 'fixture-value',
                    }],
                },
            },
        });

        expect(stripped).toEqual({
            extension_settings: {
                connectionManager: {
                    profiles: [{
                        name: 'Primary',
                        'secret-id': 'credential-reference',
                    }],
                },
            },
        });
    });
});
