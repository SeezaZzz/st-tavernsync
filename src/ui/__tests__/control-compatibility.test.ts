import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

it('keeps every approved control in the panel', () => {
    const html = readFileSync(new URL('../../../panel.html', import.meta.url), 'utf8');

    for (const id of [
        'tavernsync_push',
        'tavernsync_pull',
        'tavernsync_status_btn',
        'tavernsync_auto_startup',
        'tavernsync_auto_chat_close',
        'tavernsync_propagate_deletes',
        'tavernsync_google_connect',
        'tavernsync_google_disconnect',
        'tavernsync_rebuild_index',
        'tavernsync_view_log',
        'tavernsync_reset_state',
        'tavernsync_wipe_remote',
        'tavernsync_gc',
        'tavernsync_reset_drive_v2',
        'tavernsync_resume_drive_v2_push',
    ]) {
        expect(html).toContain(`id="${id}"`);
    }
});
