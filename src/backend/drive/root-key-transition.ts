export async function prepareDriveRootKeyTransition(
    currentRootId: string,
    nextRootId: string,
    invalidateE2ee: () => Promise<void>,
): Promise<boolean> {
    if (currentRootId.trim() === nextRootId.trim()) return false;
    await invalidateE2ee();
    return true;
}
