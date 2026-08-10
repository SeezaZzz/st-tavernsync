import { readFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

it('warns that losing the Encryption passphrase leaves unrecoverable Drive ciphertext', async () => {
    const panel = await readFile(new URL('../../../panel.html', import.meta.url), 'utf8');

    expect(panel).toContain('encrypted sync data cannot be recovered');
    expect(panel).toContain('remains in Google Drive');
    expect(panel).toContain('Drive Trash');
    expect(panel).toContain('delete it permanently');
});
