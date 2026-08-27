import {
    useCallback,
    useMemo,
    type Dispatch,
    type SetStateAction,
} from "react";
import { useSearchParams } from "react-router";

export interface SearchParamCodec<T> {
    parse(raw: string | null): T;
    format(value: T): string | null;
}

export const booleanSearchParamCodec: SearchParamCodec<boolean> = {
    parse: (raw) => raw === "true",
    format: (value) => (value ? "true" : null),
};

export function enumSearchParamCodec<const T extends string>(
    values: readonly T[],
    defaultValue: T,
): SearchParamCodec<T> {
    const allowed = new Set<string>(values);
    return {
        parse: (raw) => (raw && allowed.has(raw) ? (raw as T) : defaultValue),
        format: (value) => (value === defaultValue ? null : value),
    };
}

export function useSearchParamState<T>(
    key: string,
    codec: SearchParamCodec<T>,
): [T, Dispatch<SetStateAction<T>>] {
    const [searchParams, setSearchParams] = useSearchParams();
    const value = useMemo(
        () => codec.parse(searchParams.get(key)),
        [codec, key, searchParams],
    );

    const setValue = useCallback<Dispatch<SetStateAction<T>>>(
        (nextValue) => {
            setSearchParams(
                (previousParams) => {
                    const nextParams = new URLSearchParams(previousParams);
                    const previousValue = codec.parse(previousParams.get(key));
                    const resolved =
                        typeof nextValue === "function"
                            ? (nextValue as (previous: T) => T)(previousValue)
                            : nextValue;
                    const serialized = codec.format(resolved);
                    if (serialized === null) nextParams.delete(key);
                    else nextParams.set(key, serialized);
                    return nextParams;
                },
                { replace: true },
            );
        },
        [codec, key, setSearchParams],
    );

    return [value, setValue];
}
