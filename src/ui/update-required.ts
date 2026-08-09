export const RESTORE_UPDATE_REQUIRED_MESSAGE =
    'Fast Pull needs a newer SillyTavern backend. Update SillyTavern or the app that bundles it, restart, then try Pull again.';

export function isRestoreUpdateRequired(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'SILLYTAVERN_UPDATE_REQUIRED';
}

type Confirm = (message: string) => boolean | Promise<boolean>;

export function promptRestoreReload(
    confirm: Confirm = message => window.confirm(message),
): Promise<boolean> {
    return Promise.resolve(confirm(
        'Fast Pull committed the complete Drive snapshot.\n\nReload now so SillyTavern reads the restored files?',
    ));
}
