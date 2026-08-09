import { expect, it } from 'vitest';

import { RESTORE_UPDATE_REQUIRED_MESSAGE, isRestoreUpdateRequired } from '../update-required';

it('recognizes only the stable core capability error', () => {
    expect(isRestoreUpdateRequired(Object.assign(new Error('update'), {
        code: 'SILLYTAVERN_UPDATE_REQUIRED',
    }))).toBe(true);
    expect(isRestoreUpdateRequired(new Error('network failed'))).toBe(false);
    expect(RESTORE_UPDATE_REQUIRED_MESSAGE).toContain('newer SillyTavern backend');
});
