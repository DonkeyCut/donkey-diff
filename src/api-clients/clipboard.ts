export async function writeClipboardText(text: string): Promise<void> {
  if (window.donkeyDiffDesktop) {
    await window.donkeyDiffDesktop.writeClipboardText(text);
    return;
  }
  if (!navigator.clipboard)
    throw new Error("Clipboard access is unavailable in this browser.");
  await navigator.clipboard.writeText(text);
}
