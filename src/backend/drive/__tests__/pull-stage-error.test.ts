import { describe, expect, it } from 'vitest';

import { PullStageError, isTransientPullError, withPullStage } from '../pull-stage-error';

describe('Pull stage errors', () => {
    it('records a safe stage/path without leaking query credentials', () => {
        const error = new PullStageError(
            'pack-download', 'GET',
            'https://www.googleapis.com/drive/v3/files/a?alt=media&token=secret',
            new TypeError('Load failed'),
        );
        expect(error.message).toContain('pack-download');
        expect(error.message).toContain('/drive/v3/files/a');
        expect(error.message).not.toContain('secret');
        expect(isTransientPullError(error)).toBe(true);
    });

    it('does not classify integrity failures as transient', () => {
        expect(isTransientPullError(new Error('item hash mismatch'))).toBe(false);
    });

    it('preserves DriveAuthError identity for reconnect handling', async () => {
        const authError = Object.assign(new Error('expired'), { name: 'DriveAuthError' });
        await expect(withPullStage(
            'pack-download', 'GET', 'drive-pack://pack-a',
            async () => { throw authError; },
        )).rejects.toBe(authError);
    });
});
