/**
 * Trigger a browser download for an in-memory Blob.
 *
 * Centralizes the createObjectURL → anchor.click → revokeObjectURL dance used
 * by export flows (transactions CSV/JSON, owes CSV, etc.) so we don't repeat
 * the URL-leak risk at every call site.
 */
export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    try {
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
    } finally {
        URL.revokeObjectURL(url);
    }
}
