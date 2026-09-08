import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type { Account } from "@/types/api";
import { accountLabel } from "@/features/accounts/groupAccounts";

const UNASSIGNED = "__unassigned__";

interface Props {
    id: string;
    accounts: readonly Account[];
    value?: string;
    onChange: (value: string) => void;
    compactDefault?: boolean;
    t: (key: string) => string;
}

export function PortfolioBrokerField({
    id,
    accounts,
    value,
    onChange,
    compactDefault = false,
    t,
}: Props) {
    const [editing, setEditing] = useState(!compactDefault);
    const selected = accounts.find((account) => String(account.id) === value);
    const label = selected
        ? accountLabel(selected)
        : t("addPortTxn.broker.unassigned");

    if (!editing) {
        return (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ArrowRight className="h-3 w-3" aria-hidden="true" />
                <span className="truncate">{label}</span>
                <span aria-hidden="true">·</span>
                <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 text-xs text-muted-foreground"
                    onClick={() => setEditing(true)}
                >
                    {t("addPortTxn.broker.change")}
                </Button>
            </div>
        );
    }

    return (
        <div className="space-y-2">
            <Label htmlFor={id}>{t("addPortTxn.broker")}</Label>
            <Select
                value={value || UNASSIGNED}
                onValueChange={(next) =>
                    onChange(next === UNASSIGNED ? "" : next)
                }
            >
                <SelectTrigger id={id}>
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value={UNASSIGNED}>
                        {t("addPortTxn.broker.unassigned")}
                    </SelectItem>
                    {accounts.map((account) => (
                        <SelectItem key={account.id} value={String(account.id)}>
                            {accountLabel(account)}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}
