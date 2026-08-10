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

it('keeps storage schema jargon out of public Drive copy', () => {
    const html = readFileSync(new URL('../../../panel.html', import.meta.url), 'utf8');
    const source = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
    const engine = readFileSync(new URL('../../sync/engine.ts', import.meta.url), 'utf8');

    expect(html).not.toMatch(/>[^<]*(?:Drive v[12]|packs?\/blobs?|Root)[^<]*</i);
    expect(`${html}\n${source}\n${engine}`).not.toMatch(/Drive v[12]/);
    for (const text of [
        'Connected to Drive v2',
        'TavernSync ${files.length} packs',
        'Creating fresh Drive v2 root',
        'Drive v2 Root ready',
        'packs/blobs',
        'เปิดข้อมูลสำรองไม่ได้: ${String(error)}',
    ]) {
        expect(source).not.toContain(text);
    }
});

it('routes each manual Drive action through storage activation', () => {
    const source = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');

    expect(source).toContain("ensureE2eeReady('push')");
    expect(source).toContain("ensureE2eeReady('pull')");
    expect(source).toContain("ensureE2eeReady('status')");
    expect(source).toContain('activateDriveStorage({');
});

it('hides progress toasts while the snapshot-choice popup is open', () => {
    const css = readFileSync(new URL('../../style.css', import.meta.url), 'utf8');

    expect(css).toMatch(
        /body:has\(\.popup\[open\] \.tavernsync-drive-v2-choice\) #toast-container\s*\{[^}]*visibility:\s*hidden/s,
    );
});
