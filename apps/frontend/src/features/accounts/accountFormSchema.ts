/**
 * Zod submit schema for AddAccountDialog (create + edit modes).
 *
 * Validates and normalizes the string fields of AccountFormValues; the
 * enum/boolean fields are Select/Switch-constrained and pass through the
 * dialog untouched (`{ ...form, ...parsed.data }`). Issue messages are i18n
 * keys (see lib/forms/schemas.ts) — though this dialog keeps its historical
 * presentation: a missing name blocks silently (the submit button is also
 * disabled on it).
 */
import { z } from "zod";
import { currencyCode } from "@/lib/forms/schemas";

export function accountFormSchema() {
    return z
        .object({
            name: z.string().refine((value) => value.trim().length > 0, {
                message: "validation.required",
            }),
            display_name: z.string(),
            institution: z.string(),
            currency: currencyCode("EUR"),
        })
        .transform((values) => ({
            ...values,
            name: values.name.trim(),
            display_name: values.display_name.trim(),
            institution: values.institution.trim(),
        }));
}
