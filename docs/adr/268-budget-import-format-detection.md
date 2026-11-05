---
title: "ADR-268: Detect the bank format of a budget import"
type: adr
status: Accepted
date: 2026-11-05
tags: [adr, import, csv, bank-adapters, saved-custom-parsers, detection, adr-066, adr-078]
description: "The budget import card starts on Detect automatically. It recognises the eight built-in bank formats with the backend adapters' own signatures (moved to shared-utils) and a saved custom parser whose mapped columns are all in the file's header. Overlapping built-in formats resolve in registry order; a file that fits a built-in format and a saved parser, or several saved parsers, waits for a manual choice. Manual choice stays available."
aliases: [adr-268, budget import detection, bank format detection]
related_code:
  [
    "packages/shared-utils/src/bankImportDetection.ts",
    "apps/frontend/src/features/imports/bankImportDetection.ts",
    "apps/frontend/src/features/imports/TransactionImportCard.tsx",
    "apps/node-backend/src/services/importPipeline/adapters/index.ts",
  ]
---

# ADR-268: Detect the bank format of a budget import

## Status

Accepted on 2026-11-05 (Tor asked for detection like the portfolio import's, "built if possible").

## Context

The portfolio import starts on "Detect automatically" and recognises its maintained statement
formats in the browser with shared header signatures
([[docs/adr/078-portfolio-csv-import|ADR-078]] and later). The budget import card made the user
pick the bank for every file, although each bank adapter already had a `detect` function. Nothing
in production called them: `detectBank` was only used by tests.

Two facts shape the design:

- The signatures overlap. An ING header begins with `Rekeningnummer`, which also satisfies KBC's
  signature. The registry order (`belfius`, `revolut`, `ing`, `bnp`, `kbc`, `vision`, `sabb`,
  `wise`) has always settled this in `detectBank`.
- Saved custom parsers ([[docs/adr/066-saved-named-custom-csv-parsers|ADR-066]]) are the user's
  own formats and can be recognised from their column mapping, but generic column names such as
  `Date` and `Amount` can fit more than one file type.

## Decision

- **One set of signatures.** The eight built-in signatures move to
  `@vision/shared-utils/bank-import-detection`. Each backend adapter's `detect` delegates to it,
  so the card and the importers cannot disagree. A leading UTF-8 BOM is ignored.
- **Detection runs in the browser** on the first 64 KiB of the file, decoded as UTF-8 with the
  importers' Latin-1 fallback. No upload or new endpoint is involved.
- **Saved parsers fit** when every column they map (date, payee, amount, and memo when set) is in
  the header row read with that parser's own encoding, separator and skipped rows.
- **Resolution.** Built-in matches only: the first in registry order wins. One saved parser and
  no built-in match: the saved parser wins. A built-in match together with a saved parser, or
  several saved parsers: nothing is chosen, the card lists the candidates and asks the user.
  No match: the card says so and asks for the bank or a custom format.
- **Manual override.** "Detect automatically" is the first option and the default. Picking any
  bank, saved parser or "Custom or other" turns detection off for that import; picking "Detect
  automatically" again turns it back on. Editing a detected saved parser pins it first, so a new
  file cannot swap it mid-edit.
- The onboarding wizard keeps its bank-first step; it asks for the bank before the file exists.

## Consequences

- A supported bank's export imports without a manual bank choice. The status line under the
  select names what was recognised, and the user can still change it before importing.
- The import routes, the pipeline and the adapter parsers are unchanged; detection only fills in
  the `bank_name` the card already sends.
- Overlap between built-in formats still follows registry order, as it always did in
  `detectBank`. A new adapter must take a registry position that keeps existing files resolving
  to the same adapter.
