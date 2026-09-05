import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    commitTableMutation,
    getTableRows,
    previewTableMutation,
    type DbChange,
    type DbFilter,
} from "@/lib/api/dbEditor";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { adminKeys } from "@/lib/queryKeys";
import { useBackgroundQueryCue } from "@/components/shared/BackgroundQueryIndicator";

const PAGE_SIZE = 100;

export interface TableSort {
    column: string;
    dir: "asc" | "desc";
}

export function useTableRows(
    table: string,
    page: number,
    sort: TableSort | undefined,
    filters: DbFilter[],
) {
    const queryClient = useQueryClient();
    const query = useQuery({
        queryKey: adminKeys.dbTable(table, page, sort, filters),
        queryFn: () =>
            getTableRows(table, {
                limit: PAGE_SIZE,
                offset: page * PAGE_SIZE,
                orderBy: sort?.column,
                dir: sort?.dir,
                filters,
            }),
        placeholderData: (previous) => previous,
    });
    useBackgroundQueryCue(query.isFetching && query.isPlaceholderData);

    return {
        query,
        refresh: () =>
            queryClient.invalidateQueries({
                queryKey: adminKeys.dbTableAll(table),
            }),
    };
}

export function useTableMutationData(table: string) {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    const preview = useMutation({
        mutationFn: (changes: DbChange[]) =>
            previewTableMutation(table, changes),
        onError: (err: Error) =>
            toast.error(t("dbEditor.previewFailed"), {
                description: apiErrorToMessage(err, t),
            }),
    });
    const commit = useMutation({
        mutationFn: (changes: DbChange[]) =>
            commitTableMutation(table, changes),
        onSuccess: (result) => {
            toast.success(t("dbEditor.commitSuccess"), {
                description: `${result.applied} ${t("dbEditor.statementsApplied")}`,
            });
            queryClient.invalidateQueries({
                queryKey: adminKeys.dbTableAll(table),
            });
        },
        onError: (err: Error) =>
            toast.error(t("dbEditor.commitFailed"), {
                description: apiErrorToMessage(err, t),
            }),
    });

    return { preview, commit };
}
