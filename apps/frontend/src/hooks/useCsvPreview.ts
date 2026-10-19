/**
 * useCsvPreview — client-side CSV header detection + row preview.
 *
 * Reads the first PEEK_BYTES bytes of the file, parses headers and up to
 * MAX_PREVIEW_ROWS data rows using the given separator via csv-parse's
 * browser build — the same parser the backend importers use, so the preview
 * and the real import agree on quoting/newline edge cases.
 */

import { useEffect, useState } from "react";
import { parse } from "csv-parse/browser/esm/sync";
import { PEEK_BYTES } from "@/features/imports/csvSeparator";

import {
    decodePreviewBytes,
    parseCsvText,
    type CsvPreview,
} from "@vision/shared-utils/csv-preview";
interface State {
    preview: CsvPreview | null;
    isLoading: boolean;
    error: string | null;
}
export function useCsvPreview(
    file: File | null,
    separator: string,
    encoding = "utf-8",
    skipRows = 0,
): State {
    const [state, setState] = useState<State>({
        preview: null,
        isLoading: false,
        error: null,
    });

    useEffect(() => {
        if (!file) {
            setState({ preview: null, isLoading: false, error: null });
            return;
        }

        let cancelled = false;
        setState({ preview: null, isLoading: true, error: null });

        const slice = file.slice(0, PEEK_BYTES);
        const reader = new FileReader();

        reader.onload = () => {
            if (cancelled) return;
            try {
                const text = decodePreviewBytes(
                    reader.result as ArrayBuffer,
                    encoding,
                    slice.size < file.size,
                );
                const preview = parseCsvText(
                    text,
                    separator,
                    skipRows,
                    (input, options) => parse(input, options),
                );
                setState({ preview, isLoading: false, error: null });
            } catch {
                setState({
                    preview: null,
                    isLoading: false,
                    error: "parse_error",
                });
            }
        };

        reader.onerror = () => {
            if (!cancelled) {
                setState({
                    preview: null,
                    isLoading: false,
                    error: "read_error",
                });
            }
        };

        reader.readAsArrayBuffer(slice);

        return () => {
            cancelled = true;
            reader.abort();
        };
    }, [file, separator, encoding, skipRows]);

    return state;
}
