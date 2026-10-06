---
title: "ADR-182: UI copy uses plain words, sentence case and payee"
type: adr
status: accepted
date: 2026-10-06
tags:
  [
    adr,
    frontend,
    i18n,
    copy,
    terminology,
    sentence-case,
    payee,
    excluded,
    design-system,
    adr-178,
    adr-180,
    adr-181,
  ]
description: The English and Dutch UI copy follows the UI Direction's plain-words rule. English uses sentence case everywhere except navigation labels and proper names, calls the counterparty a payee, calls a transaction left out of totals excluded, says income tax instead of PIT and exchange rate instead of FX, and names planned-payment execution marking as paid. Dutch keeps ontvanger and personenbelasting and drops Title Case.
aliases: [adr-182, copy pass, plain words, payee, sentence case, redesign step 4]
---

# ADR-182: UI copy uses plain words, sentence case and payee

## Status

Accepted. Fourth step of the redesign roadmap that started with
[[docs/adr/178-design-system-role-tokens|ADR-178]],
[[docs/adr/179-primitives-adopt-role-tokens|ADR-179]],
[[docs/adr/180-sidebar-sections-replace-workspaces|ADR-180]] and
[[docs/adr/181-home-transactions-redesign|ADR-181]].

## Date

2026-10-06

## Context

The UI Direction asks for copy that names things the way a person says them aloud: no
internals, no codes, no abbreviations a bank customer would not use. The locale sources had
grown by feature and carried the vocabulary of each feature's implementation: *Recipient #12*
and *Category #4* in the filter banner, *FX*, *PIT*, *WHT*, *Database Backup*, *Mark as
inactive*, *Execute payment*, *Search database…*, *Manage widgets*, *Total Net Liquid
Position*, *Drift {amount}*, em dashes joining clauses, `(s)` plurals, and a mix of Title Case
and sentence case across buttons, headings and column labels. ADR-180 renamed only the
duplicate navigation labels and left every other label to this pass.

The repository already had two of the rules: sentence case for English buttons, dialog titles
and action labels ([[docs/i18n/translations|Translations & i18n]]), and American spelling
(*categorize*, *color*, *Uncategorized*). The owner's parity rule holds: no string may change in
a way that removes or hides an action.

## Decision

1. **Plain words.** User-facing English says what the thing is: *income tax*, not PIT;
   *exchange rate* or *currency effect*, not FX; *withholding tax*, not WHT; *backup*, not
   database; *bank* not parser; *rule* not pattern; *setup* not wizard; *Home*, not Dashboard
   (the page was renamed in ADR-180). Clauses are separate sentences instead of em dashes.
   Counts use `tc()` plural keys instead of `(s)`. Ids never appear as `#12` in copy; the filter
   banner resolves a payee id to its name (unknown payee when the lookup fails). Admin and
   developer surfaces (database editor, database maintenance, AI research disclosure profiles,
   endpoint liveness) keep their technical vocabulary because their audience is the operator.
2. **Sentence case** for every English string except navigation labels, page titles that
   repeat a navigation label (*Net Worth*, *Planned Payments*, *Import & Export*, *Exchange
   Rates*, *Who Owes You*), proper names and acronyms (ECB, CSV, ETF, PwC, Reynders, Portfolio
   Performance, KBC). Dutch follows the same rule, so *Geplande Betalingen* becomes *Geplande
   betalingen*.
3. **Payee.** The counterparty of a transaction is a *payee* in English wherever the UI shows
   it (navigation, columns, forms, import review, merge dialog, settings exclusions, insights).
   Locale keys keep *recipient* in their names, the API keeps `/api/recipients`, and the glossary
   keeps *Recipient* as the domain term. Dutch keeps *ontvanger*, which already reads naturally.
   The split dialog keeps *recipient* for the people a split is shared with.
4. **Excluded, not inactive, for transactions.** A transaction left out of totals is
   *excluded*; the actions read *Exclude from totals* and *Include in totals*, the status column
   reads *Included* or *Excluded*, and the View menu offers *Show excluded*. Categories and
   payees keep *inactive* because that flag hides them from pickers rather than from totals.
   Dutch: *uitgesloten* and *telt mee*.
5. **Planned payments are marked as paid.** *Execute payment* becomes *Mark as paid*, *Link &
   Execute* becomes *Link and mark as paid*, the history is *Payment history* and the badge
   reads *Paid (transaction 42)*.
6. **Taxes.** The tax page is titled *Taxes* with the subtitle *Estimated Belgian income tax for
   {year}*; every PIT string becomes income tax and Dutch uses *personenbelasting*.
7. **Statistics.** *Strongest month* and *Toughest month* become *Best month* and *Worst
   month*, which is what the component computes (highest and lowest net), rather than the
   direction page's *Highest spending*.
8. **Smaller renames.** *Manage widgets* becomes *Customize this page* with a *Customize*
   button; *Total Net Liquid Position* becomes *Cash*; the drift badge reads *{amount} off your
   statement*; the Transactions search placeholder names what it searches (*Search payees,
   notes or amounts*); Create buttons in the add dialogs name their object (*Add category*,
   *Add account*, *Add payee*); the exclusion toggle is hidden when Settings has no exclusions
   instead of rendering disabled; error toasts read *Couldn't create the payee* instead of
   *Failed to create recipient*; the Import page cards are titled by what they do (*Import from
   your bank*, *Payees from CSV*, *Categories from CSV*, *Export your data*).

## Consequences

- Positive: one vocabulary across screens; the words match the sidebar from ADR-180 and the
  Home and Transactions screens from ADR-181; Dutch loses its Title Case drift.
- Neutral: locale keys are unchanged except for the plural conversions
  (`bankWidget.acrossAccounts.one/.other`, `tax.dividendConventionIncomplete.one/.other`,
  `merge.mergeCount.one/.other`, `splitDialog.alreadySplit.one/.other`), the
  five new keys (`categories.createButton`, `recipients.createButton`, `filter.recipientUnknown`,
  `txPage.searchPlaceholder`, `txPage.view.showExcluded`) and the three removed ones
  (`exclusion.noExclusions`, `exclusion.tooltipNone` and the now unused `common.create`). `tax.page.subtitle` now takes a `{year}`
  placeholder. Tests that asserted on the old English copy were updated.
- Negative: the glossary term (*Recipient*) and the API vocabulary differ from the English UI
  word (*payee*); the glossary records the mapping. Navigation labels the direction page
  proposed (*Planned*, *Insights*, *Import*, *Holdings*) were not renamed here; their screen
  steps decide.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/180-sidebar-sections-replace-workspaces|ADR-180]]
- [[docs/adr/181-home-transactions-redesign|ADR-181]]
- [[docs/i18n/translations|Translations & i18n]]
- [[docs/glossary|Glossary]]
