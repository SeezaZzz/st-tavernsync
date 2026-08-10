import './style.css';
import { HttpStorageAdapter } from './backend/http';
import { requireDriveV2Runtime, requireRuntime } from './backend/runtime';
import { DriveClient } from './backend/drive/client';
import { DriveUploadPausedError } from './backend/drive/pack-uploader';
import { GisTokenProvider, getSharedGisTokenProvider } from './backend/drive/oauth';
import {
    discoverDriveLayout,
    type DriveAdapter,
} from './backend/drive/adapter';
import {
    resetDriveRootToV2,
} from './backend/drive/pack-layout';
import { resolveDriveLayoutForConnect } from './backend/drive/connect-layout';
import {
    activateDriveStorage,
    type DriveStorageAction,
} from './backend/drive/storage-activation';
import { prepareDriveRootKeyTransition } from './backend/drive/root-key-transition';
import {
    canResetDriveV2,
    driveV2Visibility,
    isDriveReconnectRequired,
} from './backend/drive/drive-v2-ui-state';
import { collectGarbage } from './backend/drive/gc';
import { collectDriveV2Garbage } from './backend/drive/gc-v2';
import { encodeSalt } from './crypto';
import { driveSaltFromFolderIdAsync } from './crypto/subkeys';
import {
    BUILD_ID,
    EXTENSION_FOLDER,
    LOG_PREFIX,
    ensureDeviceName,
    getSettings,
    saveSettings,
    type SyncScopeSettings,
} from './settings';
import { clearBackendState, getSyncStore } from './state/store';
import {
    clearBase,
    forgetRememberedE2eeKey,
    getDriveV2Status,
    getStatusDiff,
    hasE2eeKey,
    lockE2ee,
    rememberCurrentE2eeKey,
    resumeDriveV2FullPushFromEngine,
    runScan,
    runSync,
    setGenerationBusy,
    syncAccountSalt,
    tryRestoreE2eeKey,
    unlockE2ee,
    wipeRemoteSyncData,
} from './sync/engine';
import { PullCrashJournal, formatInterruptedPull } from './sync/pull-crash-journal';
import { promptConflicts } from './ui/conflict';
import { promptDriveV2SourceChoice } from './ui/drive-v2-source-choice';
import {
    createPullPerformanceStore,
    recommendPullPerformanceProfile,
    type PullPerformanceProfile,
} from './backend/drive/pull-performance-profile';
import { isTransientPullError } from './backend/drive/pull-stage-error';
import {
    promptPullPerformanceChoice,
    promptPullPerformanceFallback,
} from './ui/pull-performance-choice';

const pullPerformanceStore = createPullPerformanceStore();

function getCtx() {
    return SillyTavern.getContext();
}

// หน้าต่าง popup OAuth: Google redirect กลับมาที่ origin root พร้อม #access_token ใน hash —
// ส่งต่อให้หน้าหลักผ่าน localStorage แล้วปิดตัวเอง
// (ดักจาก hash ล้วน ๆ — window.name/opener โดนเบราว์เซอร์รีเซ็ตหรือ COOP ตัดระหว่าง redirect ข้ามโดเมน)
if (/(^#|[#&])(access_token|error)=/.test(window.location.hash)) {
    try { localStorage.setItem('tavernsync_oauth_hash', window.location.hash); } catch { /* ignore */ }
    console.debug('[TavernSync]', 'oauth hash captured in popup window — closing');
    window.close();
    // ถ้าเบราว์เซอร์ไม่ยอมให้ปิดตัวเอง (COOP ตัดสาย opener) อย่างน้อยก็บอกผู้ใช้แทนที่จะโหลด ST เต็มหน้าต่าง
    // — ST โหลด extension ด้วย dynamic import หลัง DOMContentLoaded ผ่านไปแล้ว
    //   การ addEventListener เฉย ๆ จึงไม่มีวันยิง ต้องเช็ค readyState ก่อน
    const showClosePrompt = (): void => {
        document.body.innerHTML = '<p style="font-family:sans-serif;padding:2em">TavernSync เชื่อมต่อแล้ว — ปิดหน้าต่างนี้ได้เลย</p>';
    };
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', showClosePrompt);
    } else {
        showClosePrompt();
    }
}

function setStatusLine(text: string): void {
    const el = document.getElementById('tavernsync_status_line');
    if (el) {
        el.textContent = text.startsWith('●') ? text : `● ${text}`;
    }
}

function reportInterruptedPull(): void {
    if (typeof localStorage === 'undefined') return;
    const active = new PullCrashJournal(localStorage).read();
    if (active.length === 0) return;

    const details = formatInterruptedPull(active);
    console.error(LOG_PREFIX, 'Previous Pull ended while these items were active:', details);
    setStatusLine(`Pull ดับระหว่าง ${details}`);
    toastr.error(
        `รอบก่อนแอปดับระหว่าง ${details}`,
        'TavernSync crash checkpoint',
    );
}

function updateE2eeUi(): void {
    const s = getSettings();
    const unlocked = hasE2eeKey();
    const $status = $('#tavernsync_e2ee_status');
    const $setup = $('#tavernsync_e2ee_setup');

    if (!s.e2eeEnabled) {
        $status.text('Encryption: off');
        $status.css('color', '');
        $setup.hide();
        return;
    }

    if (unlocked) {
        $status.text(
            s.e2eeRequireSessionUnlock
                ? '● ปลดล็อกแล้ว (เฉพาะหน้านี้)'
                : '● ปลดล็อกแล้ว พร้อมซิงก์',
        );
        $status.css('color', '#66bb6a');
        $setup.hide();
    } else {
        $status.text(
            s.e2eeRequireSessionUnlock
                ? '● ยังไม่ได้ปลดล็อก — ใส่ passphrase ก่อนซิงก์'
                : '● ยังไม่ได้ปลดล็อก — ใส่ passphrase (ครั้งเดียวต่อเครื่อง)',
        );
        $status.css('color', '#ef5350');
        $setup.show();
    }
}

async function withLoader<T>(message: string, fn: () => Promise<T>): Promise<T> {
    const ctx = getCtx();
    const handle = ctx.loader?.show({ blocking: false, message, title: 'TavernSync' });
    try {
        return await fn();
    } finally {
        handle?.hide();
    }
}

/** แสดง/ซ่อนฟิลด์ตาม backendMode — drive: ซ่อน endpoint/token, บังคับ E2EE (disable checkbox) */
function updateBackendFieldsVisibility(): void {
    const s = getSettings();
    const isDrive = s.backendMode === 'drive';
    const isDriveV2 = isDrive && s.driveRootVersion === 2;
    $('#tavernsync_drive_fields').toggle(isDrive);
    $('#tavernsync_http_fields').toggle(!isDrive);
    $('#tavernsync_drive_maintenance').toggle(isDrive);
    const v2Visibility = driveV2Visibility();
    $('#tavernsync_push').toggle(!isDriveV2 || v2Visibility.push);
    $('#tavernsync_pull').toggle(!isDriveV2 || v2Visibility.pull);
    $('#tavernsync_status_btn').toggle(!isDriveV2 || v2Visibility.status);
    $('#tavernsync_auto_startup, #tavernsync_auto_chat_close').prop(
        'disabled',
        isDriveV2 && !v2Visibility.autoSync,
    );
    const $e2ee = $('#tavernsync_e2ee');
    $e2ee.prop('disabled', isDrive);
    $e2ee.closest('label').attr(
        'title',
        isDrive ? 'E2EE ถูกบังคับสำหรับ Google Drive backend — ข้อมูลทุกไบต์เข้ารหัสก่อนถึง Google' : '',
    );
}

function hydrateSettingsUI(): void {
    const s = getSettings();
    ensureDeviceName();

    $('#tavernsync_backend_mode').val(s.backendMode);
    $('#tavernsync_endpoint').val(s.endpoint);
    $('#tavernsync_device_name').val(s.deviceName);
    $('#tavernsync_device_token').val(s.deviceToken);
    $('#tavernsync_client_id').val(s.driveClientId);
    // โชว์ origin ของเครื่องนี้ให้ก็อปไปแปะใน Cloud Console (ทั้ง 2 ช่องใช้ค่าเดียวกัน)
    $('#tavernsync_origin_display').text(window.location.origin);
    updateDriveStatus();

    $('#tavernsync_scope_settings').prop('checked', s.scope.settings);
    $('#tavernsync_scope_characters').prop('checked', s.scope.characters);
    $('#tavernsync_scope_chats').prop('checked', s.scope.chats);
    $('#tavernsync_scope_lorebooks').prop('checked', s.scope.lorebooks);
    $('#tavernsync_scope_presets').prop('checked', s.scope.presets);
    $('#tavernsync_scope_personas').prop('checked', s.scope.personas);
    $('#tavernsync_scope_groups').prop('checked', s.scope.groups);
    $('#tavernsync_scope_quickreplies').prop('checked', s.scope.quickreplies);
    $('#tavernsync_scope_themes').prop('checked', s.scope.themes);

    $('#tavernsync_auto_startup').prop('checked', s.autoSyncOnStartup);
    $('#tavernsync_auto_chat_close').prop('checked', s.autoSyncOnChatClose);
    $('#tavernsync_propagate_deletes').prop('checked', s.propagateDeletes);
    $('#tavernsync_e2ee').prop('checked', s.e2eeEnabled);
    $('#tavernsync_e2ee_session').prop('checked', s.e2eeRequireSessionUnlock);
    $('#tavernsync_pull_performance').val(
        pullPerformanceStore.load() ?? recommendPullPerformanceProfile(),
    );

    setStatusLine(
        s.lastItemCount
            ? `${s.lastStatusMessage} · ${s.lastItemCount} items`
            : s.lastStatusMessage || 'Not set up yet',
    );
    updateBackendFieldsVisibility();
    updateE2eeUi();
}

function bindScopeCheckbox(id: string, key: keyof SyncScopeSettings): void {
    $(document).on('change', id, (e: { target: HTMLInputElement }) => {
        getSettings().scope[key] = !!$(e.target).prop('checked');
        saveSettings();
    });
}

async function adoptDriveStorage(layout: { rootId: string }): Promise<void> {
    const s = getSettings();
    const rootChanged = await prepareDriveRootKeyTransition(
        s.driveFolderId,
        layout.rootId,
        () => lockE2ee({ forgetDevice: true }),
    );
    s.driveFolderId = layout.rootId;
    s.driveRootVersion = 2;
    s.e2eeSalt = encodeSalt(await driveSaltFromFolderIdAsync(layout.rootId));
    saveSettings();
    if (rootChanged) {
        console.info(LOG_PREFIX, 'Google Drive storage changed; invalidated the previous encryption key');
    }
}

async function prepareDriveEncryption(
    action: DriveStorageAction,
    passphrase: string,
): Promise<boolean> {
    const s = getSettings();
    const resolution = await activateDriveStorage({
        action,
        client: makeDriveClient(),
        passphrase,
        rememberedRootId: s.driveFolderId,
        adopt: adoptDriveStorage,
        unlock: unlockE2ee,
    });
    if (resolution.kind === 'missing') {
        toastr.info(
            action === 'pull' || action === 'status'
                ? 'ยังไม่มีข้อมูลสำรองบน Google Drive — กด Push จากเครื่องที่มีข้อมูลก่อน'
                : 'ยังไม่มีข้อมูลสำรอง — กด Push เพื่อสร้างที่เก็บใหม่',
            'TavernSync',
        );
        return false;
    }
    if (resolution.kind === 'ready') {
        const s = getSettings();
        s.lastItemCount = resolution.itemCount;
        s.lastStatusMessage = 'Backup ready';
        saveSettings();
        $('#tavernsync_quota_line').text(`Backup ready · ${resolution.itemCount} items`);
    } else {
        $('#tavernsync_quota_line').text('New storage ready · Push this device');
    }
    $('#tavernsync_passphrase').val('');
    updateE2eeUi();
    return true;
}

async function ensureE2eeReady(
    action: DriveStorageAction,
    interactive = true,
): Promise<boolean> {
    const s = getSettings();
    if (!s.e2eeEnabled) return true;
    if (hasE2eeKey()) return true;
    if (s.backendMode !== 'drive' || s.driveFolderId.trim()) {
        await tryRestoreE2eeKey();
    }
    if (hasE2eeKey()) {
        updateE2eeUi();
        return true;
    }
    if (!interactive) return false;
    if (s.backendMode === 'drive') {
        const passphrase = String($('#tavernsync_passphrase').val() || '');
        if (!passphrase) {
            toastr.warning('ใส่ Encryption passphrase ก่อน', 'TavernSync');
            updateE2eeUi();
            return false;
        }
        if (!$('#tavernsync_recovery_ack').prop('checked') && !s.e2eeSalt) {
            toastr.warning('ยืนยันก่อนว่าคุณบันทึก passphrase ไว้แล้ว', 'TavernSync');
            return false;
        }
        try {
            return await prepareDriveEncryption(action, passphrase);
        } catch (error) {
            console.error(LOG_PREFIX, error);
            const message = error instanceof Error && error.message === 'Encryption passphrase is incorrect'
                ? 'Encryption passphrase ไม่ถูกต้อง'
                : isDriveReconnectRequired(error)
                    ? 'การเชื่อมต่อ Google หมดอายุ — กด Connect Google แล้วลองใหม่'
                    : 'เปิดข้อมูลสำรองไม่ได้ — ข้อมูลอาจเสียหายหรือเครือข่ายขัดข้อง ดูรายละเอียดใน Console';
            toastr.error(message, 'TavernSync');
            return false;
        }
    }
    toastr.warning(
        s.e2eeRequireSessionUnlock
            ? 'Enter your encryption passphrase under Encryption.'
            : 'Unlock this device once under Encryption, then Push/Pull will work.',
        'TavernSync',
    );
    updateE2eeUi();
    return false;
}

async function handleConnect(): Promise<void> {
    const s = getSettings();
    if (s.backendMode === 'drive') {
        await handleDriveConnect();
        return;
    }
    if (!s.endpoint.trim() || !s.deviceToken.trim()) {
        toastr.warning('Add your server URL and sync token first.', 'TavernSync');
        return;
    }
    try {
        const adapter = new HttpStorageAdapter({
            endpoint: s.endpoint.trim(),
            deviceToken: s.deviceToken.trim(),
        });
        if (s.e2eeEnabled && hasE2eeKey()) {
            await syncAccountSalt();
        }
        const snap = await adapter.getSnapshot();
        const quota = await adapter.quota();
        $('#tavernsync_quota_line').text(
            `Storage: ${formatBytes(quota.usedBytes)} / ${formatBytes(quota.limitBytes)} · ${quota.itemCount} files`,
        );
        toastr.success(`Connected (rev ${snap.revision.slice(0, 12)})`, 'TavernSync');
    } catch (e) {
        console.error(LOG_PREFIX, e);
        toastr.error(`Could not connect: ${String(e)}`, 'TavernSync');
    }
}

/** ไฟสถานะ Drive ในแผง: เขียว = token สดใน memory, เหลือง = เคยเชื่อมต่อแต่ token หายตอนรีเฟรช, เทา = ยังไม่เคย */
function updateDriveStatus(): void {
    const el = document.getElementById('tavernsync_drive_status');
    if (!el) return;
    const s = getSettings();
    if (s.backendMode !== 'drive') return;
    const clientId = s.driveClientId.trim();
    if (clientId && getSharedGisTokenProvider(clientId).hasValidToken()) {
        el.textContent = '● เชื่อมต่อ Google Drive แล้ว';
        el.style.color = '#66bb6a';
    } else if (s.driveFolderId.trim()) {
        el.textContent = '● เคยเชื่อมต่อไว้แล้ว — token อยู่แค่ใน memory กด Connect ใหม่หลังรีเฟรช';
        el.style.color = '#ffb74d';
    } else {
        el.textContent = '● ยังไม่ได้เชื่อมต่อ Google';
        el.style.color = '';
    }
}

function formatBytes(n: number): string {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** provider ล่าสุดจาก Connect — เก็บไว้ให้ Disconnect revoke token ที่ยังจำอยู่ */
let driveProvider: GisTokenProvider | null = null;

function makeDriveClient(): DriveClient {
    const s = getSettings();
    // instance กลางต่อ clientId — ทุก path (Connect/GC/requireRuntime) ใช้ token cache เดียวกัน
    driveProvider = getSharedGisTokenProvider(s.driveClientId.trim());
    return new DriveClient(driveProvider);
}

async function handleDriveConnect(): Promise<void> {
    const s = getSettings();
    if (!s.driveClientId.trim()) {
        toastr.warning('ใส่ Google Client ID ก่อน (สร้างที่ Google Cloud Console)', 'TavernSync');
        return;
    }
    try {
        await withLoader('Connecting to Google Drive…', async () => {
            const client = makeDriveClient();
            // warm token ด้วย consent popup ตรง ๆ ก่อน — ปุ่มนี้คือ gesture
            // (prompt:'' ที่ลองก่อนค้างเงียบ ๆ ในเบราว์เซอร์ที่บล็อก third-party cookies)
            await getSharedGisTokenProvider(s.driveClientId.trim()).getTokenInteractive();
            console.debug(LOG_PREFIX, 'drive connect: discover preferred layout…');
            const resolved = await resolveDriveLayoutForConnect({
                client,
                currentVersion: s.driveRootVersion,
                knownRootId: s.driveFolderId,
                pickLegacyRoot: async () => null,
            });
            const layout = resolved.layout;
            s.driveRootVersion = resolved.version;
            if (!layout) {
                const rootChanged = await prepareDriveRootKeyTransition(
                    s.driveFolderId,
                    '',
                    () => lockE2ee({ forgetDevice: true }),
                );
                s.driveFolderId = '';
                s.e2eeSalt = '';
                saveSettings();
                if (rootChanged) {
                    console.info(LOG_PREFIX, 'Remembered Google Drive storage is no longer available');
                }
                const q = await client.getQuota();
                $('#tavernsync_quota_line').text(
                    `Google Drive: ${formatBytes(q.usedBytes)} / ${formatBytes(q.limitBytes)} · Enter passphrase, then Push or Pull`,
                );
                return;
            }
            console.debug(LOG_PREFIX, `drive connect: remembered storage ready (root=${layout.rootId.slice(0, 8)}…)`);
            await adoptDriveStorage(layout);
            const q = await client.getQuota();
            const files = await client.listChildren('packsId' in layout ? layout.packsId : layout.blobsId);
            $('#tavernsync_quota_line').text(
                `Google Drive: ${formatBytes(q.usedBytes)} / ${formatBytes(q.limitBytes)} · Backup storage contains ${files.length} data files`,
            );
        });
        toastr.success('Connected to Google Drive — ใส่ passphrase แล้วใช้ Push หรือ Pull ได้เลย', 'TavernSync');
        updateDriveStatus();
        updateBackendFieldsVisibility();
        updateE2eeUi();
    } catch (e) {
        console.error(LOG_PREFIX, e);
        toastr.error(`Connect failed: ${String(e)}`, 'TavernSync');
    }
}

async function handleDriveDisconnect(): Promise<void> {
    try {
        await driveProvider?.revoke();
        driveProvider = null;
        toastr.info('Disconnected Google — token บนเครื่องนี้ถูก revoke แล้ว (ข้อมูลบน Drive ยังอยู่)', 'TavernSync');
        updateDriveStatus();
    } catch (e) {
        console.error(LOG_PREFIX, e);
        toastr.error(`Disconnect failed: ${String(e)}`, 'TavernSync');
    }
}

async function handleDriveGc(): Promise<void> {
    const s = getSettings();
    if (s.backendMode !== 'drive') return;
    if (!s.driveClientId.trim() || !s.driveFolderId.trim()) {
        toastr.warning('Connect Google ก่อน แล้วค่อย clean up', 'TavernSync');
        return;
    }
    const ok = window.confirm(
        'ลบข้อมูลเก่าบน Google Drive?\n\n' +
        'จะย้ายไปถังขยะ: blob ที่ไม่มี commit ไหนอ้างถึงและเก่ากว่า 7 วัน + commit เก่าที่เกิน 10 ตัวล่าสุด\n' +
        '(จะไม่ทำถ้ามี fork ค้างอยู่ — ซิงก์ให้เสร็จก่อน)',
    );
    if (!ok) return;
    try {
        const res = await withLoader('Cleaning up old data on Drive…', async () => {
            const client = makeDriveClient();
            if (s.driveRootVersion === 2) {
                const runtime = await requireDriveV2Runtime();
                return collectDriveV2Garbage(runtime.store, client);
            }
            const rt = await requireRuntime();
            const layout = await discoverDriveLayout(client, s.driveFolderId.trim());
            const result = await collectGarbage(client, rt.storage as DriveAdapter, layout, rt.crypto);
            return { trashedPacks: result.trashedBlobs, trashedCommits: result.trashedCommits };
        });
        toastr.success(`Clean up เสร็จ — ย้ายข้อมูลสำรองเก่า ${res.trashedPacks + res.trashedCommits} รายการลงถังขยะ`, 'TavernSync');
    } catch (e) {
        console.error(LOG_PREFIX, e);
        toastr.error(`Clean up failed: ${String(e)}`, 'TavernSync');
    }
}

async function handleScan(opts?: { quiet?: boolean }): Promise<void> {
    const quiet = !!opts?.quiet;
    try {
        const run = () => runScan(quiet ? undefined : (m) => setStatusLine(m));
        const result = quiet
            ? await run()
            : await withLoader('Scanning this device…', run);
        const s = getSettings();
        s.lastItemCount = result.itemCount;
        s.lastStatusMessage = `${result.itemCount} items`;
        saveSettings();
        setStatusLine(s.lastStatusMessage);
        if (!quiet) {
            toastr.success(`Found ${result.itemCount} items on this device.`, 'TavernSync');
        } else {
            console.log(LOG_PREFIX, `Quiet scan: ${result.itemCount} items`);
        }
    } catch (e) {
        console.error(LOG_PREFIX, e);
        if (!quiet) {
            toastr.error(`Rescan failed: ${String(e)}`, 'TavernSync');
        }
    }
}

let quietScanInFlight: Promise<void> | null = null;

function bindDrawerQuietScan(): void {
    // Only the top-level TavernSync drawer — not nested sections
    const drawer = document.querySelector('#tavernsync_settings_root > .inline-drawer');
    if (!drawer) return;
    drawer.addEventListener('inline-drawer-toggle', () => {
        const icon = drawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
        if (!icon?.classList.contains('up')) return;
        if (quietScanInFlight) return;
        quietScanInFlight = handleScan({ quiet: true }).finally(() => {
            quietScanInFlight = null;
        });
    });
}

async function handleStatus(): Promise<void> {
    if (getSettings().backendMode === 'drive' && getSettings().driveRootVersion === 2) {
        if (!(await ensureE2eeReady('status'))) return;
        try {
            const status = await withLoader('Checking Google Drive backup…', () =>
                getDriveV2Status((message) => setStatusLine(message)),
            );
            const s = getSettings();
            const stateLabel = status.state === 'current'
                ? 'Current'
                : status.state === 'empty'
                    ? 'Drive empty'
                    : 'Newer/different snapshot available';
            const headLabel = `${status.headCount} head${status.headCount === 1 ? '' : 's'}`;
            const baseLabel = status.baseCommitId ? status.baseCommitId.slice(0, 8) : 'none';
            s.lastItemCount = status.itemCount;
            s.lastStatusMessage = `${stateLabel} · ${headLabel} · base ${baseLabel}`;
            saveSettings();
            setStatusLine(s.lastStatusMessage);
            const driveHeads = status.heads.length > 0
                ? status.heads.map(head => `${head.device} (${head.itemCount} items)`).join(', ')
                : 'none';
            toastr.info(
                `${status.itemCount} local items · Google Drive backups: ${driveHeads}`,
                'TavernSync status',
            );
        } catch (e) {
            console.error(LOG_PREFIX, e);
            toastr.error(`Status failed: ${String(e)}`, 'TavernSync');
        }
        return;
    }
    try {
        const status = await withLoader('Comparing with server…', () => getStatusDiff());
        const s = getSettings();
        s.lastItemCount = status.itemCount;
        s.lastStatusMessage = `${status.summary.push} to push · ${status.summary.pull} to pull · ${status.summary.conflict} conflict`;
        saveSettings();
        setStatusLine(s.lastStatusMessage);

        const lines = [
            `${status.itemCount} items`,
            s.lastStatusMessage,
            `Device: ${s.deviceName}`,
            `Encryption: ${s.e2eeEnabled ? (hasE2eeKey() ? (s.e2eeRequireSessionUnlock ? 'session' : 'ready') : 'locked') : 'off'}`,
        ];
        console.log(LOG_PREFIX, 'Status\n' + lines.join('\n'));
        toastr.info(lines.join(' · '), 'TavernSync');
    } catch (e) {
        console.error(LOG_PREFIX, e);
        toastr.error(`Status failed: ${String(e)}`, 'TavernSync');
    }
}

async function handlePush(): Promise<void> {
    if (!(await ensureE2eeReady('push'))) return;
    try {
        const { message } = await withLoader('Pushing…', () =>
            runSync({
                direction: 'push',
                onProgress: (m) => setStatusLine(m),
                resolveConflicts: (entries, direction) => promptConflicts(entries, direction),
                chooseDriveV2Source: promptDriveV2SourceChoice,
            }),
        );
        setStatusLine(message);
        $('#tavernsync_resume_drive_v2_push').hide();
        toastr.success(message, 'TavernSync push');
    } catch (e) {
        console.error(LOG_PREFIX, e);
        if (e instanceof DriveUploadPausedError) {
            $('#tavernsync_resume_drive_v2_push').show();
            setStatusLine(`Google login required · upload paused at ${formatBytes(e.acknowledgedBytes)}`);
            toastr.warning('Google token หมด — กด Connect & Resume เพื่อส่งต่อจากตำแหน่งเดิม', 'TavernSync');
            return;
        }
        toastr.error(`Push failed: ${String(e)}`, 'TavernSync');
    }
}

function offerFastPullReload(restoredMessage: string): void {
    if (restoredMessage.startsWith('Fast Pull complete') && window.confirm(
        'Fast Pull restored the complete Google Drive backup.\n\nReload now so SillyTavern reads every updated item?',
    )) {
        location.reload();
    }
}

async function handlePull(interactive = true): Promise<void> {
    if (!(await ensureE2eeReady('pull', interactive))) return;
    let profile = pullPerformanceStore.load();
    if (!profile) {
        if (interactive) {
            const choice = await promptPullPerformanceChoice(recommendPullPerformanceProfile());
            if (!choice) return;
            profile = choice.profile;
            if (choice.remember) pullPerformanceStore.save(profile);
            $('#tavernsync_pull_performance').val(profile);
        } else {
            profile = recommendPullPerformanceProfile();
        }
    }
    const execute = (selected: PullPerformanceProfile) => withLoader('Pulling…', () =>
        runSync({
            direction: 'pull',
            pullPerformanceProfile: selected,
            onProgress: (m) => setStatusLine(m),
            resolveConflicts: (entries, direction) => promptConflicts(entries, direction),
            chooseDriveV2Source: promptDriveV2SourceChoice,
        }),
    );
    try {
        const { message } = await execute(profile);
        setStatusLine(message);
        toastr.success(message, 'TavernSync pull');
        offerFastPullReload(message);
    } catch (e) { // no-excuse-ok: catch -- top-level UI boundary converts restore failures into explicit user choices/toasts.
        console.error(LOG_PREFIX, e);
        if (profile === 'pc' && isTransientPullError(e)) {
            const fallback = await promptPullPerformanceFallback();
            if (fallback !== 'mobile') {
                if (fallback === 'pc') {
                    pullPerformanceStore.save('pc');
                    $('#tavernsync_pull_performance').val('pc');
                }
                return;
            }
            pullPerformanceStore.save('mobile');
            $('#tavernsync_pull_performance').val('mobile');
            toastr.info('Switch to Mobile / Stable and resume', 'TavernSync');
            try {
                const { message } = await execute('mobile');
                setStatusLine(message);
                toastr.success(message, 'TavernSync pull');
                offerFastPullReload(message);
            } catch (retryError) {
                console.error(LOG_PREFIX, retryError);
                toastr.error(`Pull failed: ${String(retryError)}`, 'TavernSync');
            }
            return;
        }
        if (isDriveReconnectRequired(e)) {
            toastr.warning(
                'Google connection expired — Connect Google แล้วกด Pull อีกครั้ง ระบบจะทำต่อจาก checkpoint',
                'TavernSync',
            );
            return;
        }
        toastr.error(`Pull failed: ${String(e)}`, 'TavernSync');
    }
}

async function handleResetDriveV2(): Promise<void> {
    const s = getSettings();
    if (s.backendMode !== 'drive' || !s.driveClientId.trim() || !s.driveFolderId.trim()) {
        toastr.warning('Connect Google กับที่เก็บข้อมูลปัจจุบันก่อนเริ่มใหม่', 'TavernSync');
        return;
    }
    const phrase = 'RESET DRIVE V2';
    const typed = window.prompt(
        'This moves the current TavernSync Drive folder to trash. PC data stays untouched.\n\nType RESET DRIVE V2 to continue:',
        '',
    );
    if (!canResetDriveV2(typed, phrase)) return;

    try {
        await withLoader('Preparing new Google Drive storage…', async () => {
            const client = makeDriveClient();
            await getSharedGisTokenProvider(s.driveClientId.trim()).getTokenInteractive();
            await lockE2ee({ forgetDevice: true });
            const oldRootId = s.driveFolderId;
            const layout = await resetDriveRootToV2({
                client,
                oldRootId,
                oldNamespace: `drive:${oldRootId}`,
                clearBackendState,
            });
            s.driveFolderId = layout.rootId;
            s.driveRootVersion = 2;
            s.e2eeSalt = encodeSalt(await driveSaltFromFolderIdAsync(layout.rootId));
            s.lastStatusMessage = 'New storage ready — unlock then Push';
            s.lastItemCount = 0;
            saveSettings();
        });
        $('#tavernsync_resume_drive_v2_push').hide();
        setStatusLine(s.lastStatusMessage);
        updateBackendFieldsVisibility();
        updateE2eeUi();
        toastr.success('ที่เก็บใหม่พร้อมแล้ว — ปลดล็อก แล้วกด Push จากเครื่องนี้', 'TavernSync');
    } catch (e) {
        console.error(LOG_PREFIX, e);
        toastr.error(`Could not start fresh storage: ${String(e)}`, 'TavernSync');
    }
}

async function handleResumeDriveV2Push(): Promise<void> {
    const s = getSettings();
    try {
        await getSharedGisTokenProvider(s.driveClientId.trim()).getTokenInteractive();
        const { message } = await withLoader('Resuming Google Drive upload…', () =>
            resumeDriveV2FullPushFromEngine(),
        );
        $('#tavernsync_resume_drive_v2_push').hide();
        setStatusLine(message);
        toastr.success(message, 'TavernSync push');
    } catch (e) {
        console.error(LOG_PREFIX, e);
        if (e instanceof DriveUploadPausedError) {
            toastr.warning('Google ยังต้องเชื่อมใหม่ — กด Connect & Resume อีกครั้ง', 'TavernSync');
            return;
        }
        toastr.error(`Resume failed: ${String(e)}`, 'TavernSync');
    }
}

async function handleUnlockE2ee(): Promise<void> {
    const passphrase = String($('#tavernsync_passphrase').val() || '');
    if (!passphrase) {
        toastr.warning('Enter a passphrase.', 'TavernSync');
        return;
    }
    if (!$('#tavernsync_recovery_ack').prop('checked') && !getSettings().e2eeSalt) {
        toastr.warning('Confirm that you saved your passphrase first.', 'TavernSync');
        return;
    }
    try {
        if (getSettings().backendMode === 'drive') {
            if (!(await ensureE2eeReady('unlock'))) return;
        } else {
            await unlockE2ee(passphrase);
            $('#tavernsync_passphrase').val('');
            updateE2eeUi();
        }
        const s = getSettings();
        toastr.success(
            s.e2eeRequireSessionUnlock
                ? 'Unlocked for this page. You can Push or Pull now.'
                : 'Device unlocked. Push and Pull will work until you lock this device.',
            'TavernSync',
        );
    } catch (e) {
        console.error(LOG_PREFIX, e);
        toastr.error(`Unlock failed: ${String(e)}`, 'TavernSync');
    }
}

function bindSettingsHandlers(): void {
    $(document).on('change', '#tavernsync_backend_mode', (e: { target: HTMLSelectElement }) => {
        const value = String($(e.target).val() || 'custom');
        const s = getSettings();
        s.backendMode = value === 'managed' || value === 'drive' ? value : 'custom';
        if (s.backendMode === 'drive') {
            // E2EE บังคับสำหรับ Drive — ล็อก checkbox ไว้เลย
            s.e2eeEnabled = true;
            $('#tavernsync_e2ee').prop('checked', true);
        }
        saveSettings();
        updateBackendFieldsVisibility();
        updateE2eeUi();
    });

    $(document).on('input', '#tavernsync_client_id', (e: { target: HTMLInputElement }) => {
        getSettings().driveClientId = String($(e.target).val() || '').trim();
        saveSettings();
    });

    $(document).on('input', '#tavernsync_endpoint', (e: { target: HTMLInputElement }) => {
        getSettings().endpoint = String($(e.target).val() || '').trim();
        saveSettings();
    });

    $(document).on('input', '#tavernsync_device_name', (e: { target: HTMLInputElement }) => {
        getSettings().deviceName = String($(e.target).val() || '').trim();
        saveSettings();
    });

    $(document).on('input', '#tavernsync_device_token', (e: { target: HTMLInputElement }) => {
        getSettings().deviceToken = String($(e.target).val() || '').trim();
        saveSettings();
    });

    bindScopeCheckbox('#tavernsync_scope_settings', 'settings');
    bindScopeCheckbox('#tavernsync_scope_characters', 'characters');
    bindScopeCheckbox('#tavernsync_scope_chats', 'chats');
    bindScopeCheckbox('#tavernsync_scope_lorebooks', 'lorebooks');
    bindScopeCheckbox('#tavernsync_scope_presets', 'presets');
    bindScopeCheckbox('#tavernsync_scope_personas', 'personas');
    bindScopeCheckbox('#tavernsync_scope_groups', 'groups');
    bindScopeCheckbox('#tavernsync_scope_quickreplies', 'quickreplies');
    bindScopeCheckbox('#tavernsync_scope_themes', 'themes');

    $(document).on('change', '#tavernsync_auto_startup', (e: { target: HTMLInputElement }) => {
        getSettings().autoSyncOnStartup = !!$(e.target).prop('checked');
        saveSettings();
    });

    $(document).on('change', '#tavernsync_pull_performance', (e: { target: HTMLSelectElement }) => {
        const value = String($(e.target).val());
        if (value === 'mobile' || value === 'pc') pullPerformanceStore.save(value);
    });

    $(document).on('change', '#tavernsync_auto_chat_close', (e: { target: HTMLInputElement }) => {
        getSettings().autoSyncOnChatClose = !!$(e.target).prop('checked');
        saveSettings();
    });

    $(document).on('change', '#tavernsync_propagate_deletes', (e: { target: HTMLInputElement }) => {
        getSettings().propagateDeletes = !!$(e.target).prop('checked');
        saveSettings();
    });

    $(document).on('change', '#tavernsync_e2ee', (e: { target: HTMLInputElement }) => {
        getSettings().e2eeEnabled = !!$(e.target).prop('checked');
        saveSettings();
        updateE2eeUi();
    });

    $(document).on('change', '#tavernsync_e2ee_session', (e: { target: HTMLInputElement }) => {
        const on = !!$(e.target).prop('checked');
        const s = getSettings();
        s.e2eeRequireSessionUnlock = on;
        saveSettings();
        void (async () => {
            if (on) {
                await forgetRememberedE2eeKey();
                toastr.info('Passphrase will be required after every refresh.', 'TavernSync');
            } else if (hasE2eeKey()) {
                const ok = await rememberCurrentE2eeKey();
                if (!ok) {
                    await lockE2ee({ forgetDevice: true });
                    toastr.info('Enter your passphrase once more to remember this device.', 'TavernSync');
                } else {
                    toastr.success('This device stays unlocked across refreshes.', 'TavernSync');
                }
            }
            updateE2eeUi();
        })();
    });

    $(document).on('click', '#tavernsync_connect', () => { void handleConnect(); });
    $(document).on('click', '#tavernsync_google_connect', () => { void handleDriveConnect(); });
    $(document).on('click', '#tavernsync_google_disconnect', () => { void handleDriveDisconnect(); });
    $(document).on('click', '#tavernsync_gc', () => { void handleDriveGc(); });
    $(document).on('click', '#tavernsync_reset_drive_v2', () => { void handleResetDriveV2(); });
    $(document).on('click', '#tavernsync_resume_drive_v2_push', () => { void handleResumeDriveV2Push(); });
    $(document).on('click', '#tavernsync_push', () => { void handlePush(); });
    $(document).on('click', '#tavernsync_pull', () => { void handlePull(); });
    $(document).on('click', '#tavernsync_status_btn', () => { void handleStatus(); });
    $(document).on('click', '#tavernsync_unlock_e2ee', () => { void handleUnlockE2ee(); });
    $(document).on('click', '#tavernsync_change_passphrase', () => {
        void lockE2ee({ forgetDevice: true }).then(() => {
            updateE2eeUi();
            toastr.info('Device locked. Unlock again before syncing.', 'TavernSync');
        });
    });
    $(document).on('click', '#tavernsync_rebuild_index', () => { void handleScan(); });
    $(document).on('click', '#tavernsync_view_log', () => {
        toastr.info('Open the browser console and look for [TavernSync] lines.', 'TavernSync');
    });
    $(document).on('click', '#tavernsync_reset_state', () => { void handleResetState(); });
    $(document).on('click', '#tavernsync_wipe_remote', () => { void handleWipeRemote(); });
}

async function handleWipeRemote(): Promise<void> {
    const settings = getSettings();
    if (settings.backendMode !== 'drive'
        && (!settings.endpoint.trim() || !settings.deviceToken.trim())) {
        toastr.warning('Add your server URL and sync token first.', 'TavernSync');
        return;
    }
    const ok = window.confirm(
        'Clear remote sync data?\n\nYour local SillyTavern files stay put.\nAfterward, Push from the device that has the copy you want to keep.',
    );
    if (!ok) return;
    try {
        await wipeRemoteSyncData();
        setStatusLine('Remote sync cleared');
        toastr.success('Remote sync data wiped. Push from your main device next.', 'TavernSync');
    } catch (e) {
        console.error(LOG_PREFIX, e);
        toastr.error(`Wipe failed: ${String(e)}`, 'TavernSync');
    }
}

async function handleResetState(): Promise<void> {
    try {
        await lockE2ee({ forgetDevice: true });
        await getSyncStore().clear();
        await clearBase();
        const s = getSettings();
        s.lastStatusMessage = 'Not set up yet';
        s.lastItemCount = 0;
        saveSettings();
        setStatusLine('Not set up yet');
        updateE2eeUi();
        toastr.success('Sync history on this device was cleared.', 'TavernSync');
    } catch (e) {
        console.error(LOG_PREFIX, e);
        toastr.error('Could not reset sync on this device.', 'TavernSync');
    }
}

async function renderSettingsPanel(): Promise<void> {
    const ctx = getCtx();
    const html = await ctx.renderExtensionTemplateAsync(EXTENSION_FOLDER, 'panel');
    const $target = $('#extensions_settings2');
    if ($target.length) $target.append(html);
    else $('#extensions_settings').append(html);
    bindSettingsHandlers();
    bindDrawerQuietScan();
    hydrateSettingsUI();
}

function registerSlashCommands(): void {
    const ctx = getCtx();
    const { SlashCommandParser, SlashCommand } = ctx;
    if (!SlashCommandParser || !SlashCommand) {
        console.warn(LOG_PREFIX, 'SlashCommandParser unavailable');
        return;
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sync-push',
        aliases: ['tavernsync-push'],
        callback: async () => { await handlePush(); return ''; },
        helpString: 'Push local state to the TavernSync backend.',
        namedArgumentList: [],
        unnamedArgumentList: [],
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sync-pull',
        aliases: ['tavernsync-pull'],
        callback: async () => { await handlePull(false); return ''; },
        helpString: 'Pull remote TavernSync state into this install.',
        namedArgumentList: [],
        unnamedArgumentList: [],
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sync-status',
        aliases: ['tavernsync-status'],
        callback: async () => {
            await handleStatus();
            const s = getSettings();
            return `${s.lastItemCount} items · ${s.lastStatusMessage}`;
        },
        helpString: 'Scan/diff status for TavernSync.',
        namedArgumentList: [],
        unnamedArgumentList: [],
    }));
}

function registerEventListeners(): void {
    const ctx = getCtx();
    const { eventSource, event_types } = ctx;

    const appReady = event_types.APP_READY ?? 'app_ready';
    eventSource.on(appReady, () => {
        console.log(LOG_PREFIX, 'APP_READY');
        // Defer auto-sync — never block hooks (5s timeout)
        const startupSettings = getSettings();
        if (startupSettings.autoSyncOnStartup) {
            setTimeout(() => {
                void (async () => {
                    try {
                        if (!(await ensureE2eeReady('pull', false))) return;
                        await runSync({
                            direction: 'pull',
                            pullPerformanceProfile: pullPerformanceStore.load() ?? recommendPullPerformanceProfile(),
                            onProgress: (m) => setStatusLine(m),
                        });
                        toastr.info('Auto-pull on startup finished.', 'TavernSync');
                    } catch (e) {
                        console.error(LOG_PREFIX, 'auto-pull failed', e);
                    }
                })();
            }, 2500);
        }
    });

    const genStart = event_types.GENERATION_STARTED ?? 'generation_started';
    const genEnd = event_types.GENERATION_ENDED ?? 'generation_ended';
    const genStopped = event_types.GENERATION_STOPPED ?? 'generation_stopped';
    // ST ยิง GENERATION_STARTED ทั้งตอน generate จริง และตอน dry run ที่ Prompt Manager
    // ใช้ประกอบ prompt เพื่อนับโทเคน (openai.js → Generate('normal', {}, true)) โดยส่ง
    // dryRun มาเป็นอาร์กิวเมนต์ตัวที่ 3 — dry run ไม่มี GENERATION_ENDED ตามมา เพราะอีเวนต์นั้น
    // ยิงจาก hideStopButton() ซึ่งทำงานเฉพาะตอนปุ่ม stop โชว์อยู่ ถ้าล็อกตาม dry run ด้วย
    // ล็อกจะค้างถาวรและ Push/Pull พังทุกครั้งแม้รีโหลดหน้า
    eventSource.on(genStart, (...args: unknown[]) => {
        if (args[2] === true) return;
        setGenerationBusy(true);
    });
    eventSource.on(genEnd, () => setGenerationBusy(false));
    // กดหยุดกลางคัน: stopGeneration() ยิง GENERATION_STOPPED เสมอ แต่ยิง GENERATION_ENDED
    // เฉพาะสาขา abortController — สตรีมที่ถูกหยุดจึงอาจไม่มี ENDED ตามมาเลย
    eventSource.on(genStopped, () => setGenerationBusy(false));

    // Chat close approximation: CHAT_CHANGED after leaving a chat
    const chatChanged = event_types.CHAT_CHANGED ?? 'chat_changed';
    let prevChat = '';
    eventSource.on(chatChanged, () => {
        const s = getSettings();
        if (!s.autoSyncOnChatClose) return;
        const next = String((ctx as { chatId?: string }).chatId ?? '');
        if (prevChat && prevChat !== next) {
            setTimeout(() => {
                void (async () => {
                    try {
                        if (!(await ensureE2eeReady('push', false))) return;
                        await runSync({
                            direction: 'push',
                            onProgress: (m) => setStatusLine(m),
                            chooseDriveV2Source: promptDriveV2SourceChoice,
                        });
                    } catch (e) {
                        console.error(LOG_PREFIX, 'auto-push on chat close failed', e);
                    }
                })();
            }, 1500);
        }
        prevChat = next;
    });
}

export function onInstall(): void {
    console.log(LOG_PREFIX, 'onInstall');
}

export function onActivate(): void {
    console.log(LOG_PREFIX, 'onActivate');
}

export function onClean(): void {
    console.log(LOG_PREFIX, 'onClean');
}

jQuery(async () => {
    try {
        getSettings();
        ensureDeviceName();
        getSyncStore();
        await tryRestoreE2eeKey();
        await renderSettingsPanel();
        reportInterruptedPull();
        registerSlashCommands();
        registerEventListeners();
        console.log(LOG_PREFIX, 'loaded', `build=${BUILD_ID}`);
        toastr.info(`TavernSync build ${BUILD_ID} loaded`, 'TavernSync');
    } catch (e) {
        console.error(LOG_PREFIX, 'Failed to initialize', e);
        toastr.error('TavernSync failed to load. See console.', 'TavernSync');
    }
});
