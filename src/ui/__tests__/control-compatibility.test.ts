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

it('keeps destructive Drive maintenance controls inside Advanced with readable widths', () => {
    const html = readFileSync(new URL('../../../panel.html', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../../style.css', import.meta.url), 'utf8');
    const advancedStart = html.indexOf('<b>Advanced</b>');

    expect(advancedStart).toBeGreaterThan(-1);
    for (const id of ['tavernsync_reset_drive_v2', 'tavernsync_gc', 'tavernsync_wipe_remote']) {
        const controlStart = html.indexOf(`id="${id}"`);
        expect(controlStart).toBeGreaterThan(advancedStart);
        expect(html.slice(controlStart, controlStart + 240)).toContain('tavernsync-maintenance-button');
    }
    expect(css).toMatch(/\.tavernsync-maintenance-button\s*\{[^}]*width:\s*min\(100%,\s*16rem\)/s);
});
