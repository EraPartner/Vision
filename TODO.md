# TODO

Vision's live implementation queue. Priority: 🔺 highest, ⏫ high, 🔼 medium, 🔽 low,
⏬ lowest.

## Queue contract

- `- [ ]` means open. Revalidate the current code before implementing it.
- A completed and independently verified item is removed. Git history, tests, and the merged pull
  request are the completion record; this file is not an archive.
- Put evidence or a blocker on an indented `Tracking:` line. Do not put history in the title.
- Every finding has one owner-sized outcome. A dependency may be named, but unrelated work must be
  a separate item.
- `🔎 verified-present YYYY-MM-DD` means the issue was reproduced on that date.
- `🔎 partial YYYY-MM-DD` means only the stated remainder is open.
- `🔎 decision-needed YYYY-MM-DD` means implementation waits for a product or data decision.
- `🔎 runtime-unverified YYYY-MM-DD` means source work is complete but a live environment check is
  still required.
- `🔎 needs-GitHub-check YYYY-MM-DD` means the current platform state must be read from GitHub.

Run `bun run todo:list` for the concise queue and `bun run todo:check` for ledger hygiene.

## Continuation checkpoint — 2026-09-08

This is the current hand-off point after the complete TODO normalization audit. Do not repeat a
repository-wide audit before selecting work. Following the product exploration below, the queue
contains **39 open records and no checked records**. The records fall into these states:

- **1 verified-present**: source work is still required; revalidate the named evidence, then
  implement one item at a time.
- **4 runtime-unverified**: source work is complete or substantially complete; perform only the
  named live database, Demo, browser, Electron, or external acceptance check.
- **35 decision-needed**: planned outcomes expanded on 2026-09-08 and 2026-09-09; the shared analysis workspace
  direction is user-requested. This session authorizes planning, not implementation. Resolve the
  remaining engineering/provider choices during design; do not ask the user to reapprove the shared
  manual/visual/SQL/local-AI direction. Portfolio exposure, dossiers, integrated research, stronger
  local AI, and saved analyses/monitoring are part of that direction.
  Commitment-aware budgeting and shared life scenarios remain lower-priority alternatives.
  The September 9 opt-in OpenAI/Codex plan adds eight records. Both API and supported subscription
  access are requested directions; retention and onward disclosure are the user's primary privacy
  concerns. Cloud use remains an explicit exception to the default local/free-only behavior.

Continue as follows:

1. Run `bun run todo:list -- --state verified` and choose one item by priority and subsystem.
2. Read its `Tracking:` line and source evidence. If it is `decision-needed`, resolve and record the
   named decision before implementation, using authorized routine engineering judgment where possible.
   If it is `runtime-unverified`, perform the named acceptance
   instead of reopening the implementation audit.
3. Keep one owner-sized outcome per change. Run the focused tests, `bun run todo:check`, and the
   relevant typecheck/lint before removing the item from this file.
4. Remove an item only after its complete stated scope is implemented and independently verified.
   Leave it here when a required external check is unavailable, with the exact blocker on
   `Tracking:`.

Important current hand-off facts:

- Portfolio per-broker history is deliberately last. Do not start it before the current-point
  broker surfaces have shipped and soaked.
- The queue includes real-export, live-database, and host-tool acceptance obligations. These are
  not reopened implementation defects; complete the named acceptance or leave the record open.
- No publication was performed. Inspect the working-tree diff and preserve unrelated changes
  before making the next implementation change.

## Binding constraints

- Keep the rich aurora, glass, jewel-accent, and hover design direction from ADR-105. Visual work
  refines that system; it does not flatten it into generic defaults.
- Use the Vision Demo app with synthetic data for browser and visual acceptance. Never use the real
  financial stack for UI testing.
- Database migrations require a downgrade path and disposable-database proof. Never apply a
  destructive migration or live-data cleanup without the user's explicit approval.
- Portfolio account work follows ADR-108: whole-lot broker tagging, global tax and cost-basis truth,
  and no synthetic trade cash legs.
- Per-broker history stays last. Do not start it before the current-point broker surfaces have
  shipped and soaked.

## Unified financial analysis plan — 2026-09-08

**Outcome:** anyone can investigate their finances inside Vision, manually or with local AI,
using visual queries, spreadsheet-style analysis, SQL, and optional external evidence. AI is an
optional assistant over the same tools and saved analysis, not a separate calculator or the only
way to reach a feature. Budgeting, Portfolio, and Research share this capability.

**Proposed user journey:** start from a question/template, a selected dataset, an existing chart,
or SQL. Choose scope (accounts, dates, reporting currency); run a query; inspect contributing rows;
add formulas, assumptions, pivots and charts; optionally ask AI to explain or propose an edit;
save the analysis, attach it to a dossier, or monitor an explicit condition. Every AI-generated
query/formula/chart remains editable without AI. Missing coverage is shown, never filled by a guess.

**Shared design:** one versioned analysis definition describes its datasets, query mode, typed
parameters, calculations, assumptions and presentation. Run records retain definition version,
input/source timestamps, metric versions, status and lineage. Frozen results and refreshing
definitions are distinct. The visual builder emits a structured query plan that can compile to SQL;
custom SQL remains a first-class source even when it cannot convert back to visual blocks. Grid,
charts and AI consume the same result contract and authorization/resource boundaries. Analyses
must work with Ollama unavailable; only AI assistance is unavailable. Start with logical interfaces
inside the monorepo, not an assumed separate service or a committed new database dependency.

**Delivery order and exit evidence** (the unchecked records below own the work):

| Stage                             | Outcomes and dependencies                                                                                      | Exit evidence                                                                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Correctness and contracts      | Reconcile AI metrics; define analysis datasets and shared definition/run contract; evaluate executor isolation | Synthetic transfers, refunds, partial sales and mixed currencies agree with canonical calculations; selected execution design documents limits                              |
| 2. First complete manual workflow | Restricted executor, visual builder, SQL editor, result grid and saved analysis                                | A non-AI user compares monthly category spending, drills to records, edits the query and reopens the saved analysis; advanced SQL survives visual-mode switching            |
| 3. Spreadsheet analysis           | Formula/assumption model, pivots/charts, export and guided templates on stages 1–2                             | Same dataset and assumptions yield equivalent manual/SQL/formula results; refresh preserves assumptions and reports incompatible schema changes                             |
| 4. AI-assisted workflow           | Planner, relevant context, structured evidence answers, preferences, recoverable jobs and evaluation suite     | AI drafts and edits the same stage 2–3 artifacts; users inspect changes and undo them; no separate arithmetic or privileged execution path                                  |
| 5. Research evidence and exposure | Existing research tools, controlled web retrieval, documents, dossiers and supported fund holdings             | Cited investigation combines authorized local calculations and dated external evidence; fund exposure reports uncovered weight; public-only research works without holdings |
| 6. Monitoring                     | Saved definitions and stage 4–5 evidence, explicit conditions, scheduler and notification policy               | Meaningful changes notify once with evidence; stale/failed/offline runs are visible and never reported as unchanged success                                                 |

Stage 4 evaluations and stage 5 data-provider feasibility can begin alongside stage 1 design.
Implement a vertical slice per stage, not all records in one batch. Keep the current app usable
throughout; reuse canonical money/portfolio services, chart primitives, provider quotas, and existing
saved-chart/alert capabilities after checking their actual contracts.

**Reference acceptance questions:**

- Budgeting: explain a category increase after transfers/refunds; compare recurring/discretionary
  costs; compare two contracts using actual payments and editable assumptions.
- Portfolio: compare total return versus cash income in one currency; calculate supported ETF
  overlap and show unknown exposure; explore a hypothetical contribution without ledger writes.
- Research: compare a filing with the previous version and cite passages; connect relevant evidence
  to a position or budget category; identify contradictions and unavailable data.
- Cross-mode: build one analysis visually, inspect generated SQL, add a computed column, request an
  AI edit, undo it, save/reopen, and refresh with the original scope/assumptions intact. Run the
  manual path with AI offline. Verify an equivalent hand-written query on the same snapshot.

**Scope boundaries and decisions:** SQL runtime/isolation, grid/formula libraries and licensing,
snapshot retention, model/hardware profiles, and web/fund providers need bounded evaluations before
selection. Full Excel/VBA compatibility, unrestricted host code execution, automatic ledger writes,
universal market-data coverage and automatic cloud-model fallback are not assumed. The September 9
plan below adds separately enabled cloud assistance; it does not silently relax local-only behavior.
File import is analysis-only
and user-selected; it does not silently enter the transaction import workflow. New APIs/schema,
backup/delete behavior and EN/NL UI require normal project documentation and validation at implementation.

### Conversation handoff: baseline, feasibility and free-only operation

This section preserves the September 8 discussion so continuation does not require chat history.
The user likes the current app and wants broader questions answered using personal data, internet
evidence and local AI. Preserve the existing experience. The favored capabilities are portfolio
exposure, dossiers, integrated research, saved questions/monitoring and stronger local AI, applied
to budgeting as well as investments. The subsequent priority is one accessible manual or AI-assisted
SQL/spreadsheet analysis workspace. The two original cash-reserve/life-scenario ideas remain recorded
for evaluation, not rejected or prerequisites for the favored work.

**Current baseline from source inspection, not live acceptance:**

- Forecasting already includes multiple methods/backtesting and portfolio Monte Carlo; comparisons,
  correlations, macro series, scorecards and cash-aware rebalancing exist. Reuse those engines.
  ADR-098 describes an unwired net-worth projection core; verify current code before extending it.
- AI already has 31 fixed financial tools and persisted conversations/tool results, with a bounded
  loop and background streaming. It is not wholly unintegrated: the missing bridge is from chat to
  the existing research-provider services, general web retrieval and document-passage retrieval.
  Evidence: `apps/node-backend/src/services/aiChat/tools/index.js`, `aiChatService.js`, and
  `apps/node-backend/src/integrations/ollama/prompts.js`. Recheck counts/limits before implementation.
- Transaction attachments are not yet an AI-searchable evidence library. Saved chart layouts and
  watchlist price targets are not equivalent to versioned analyses or a general research scheduler.
  The admin `services/dbEditor.js` is a maintenance editor with structured filters, not a user-facing
  arbitrary SQL analysis engine; do not route AI through its mutation capabilities.
- Static AI metric discrepancies and their required synthetic reproduction are explicitly tracked
  below. A larger model cannot correct an application tool that supplies the wrong financial metric.

**Feasibility assessment (hardware cost/capacity disregarded, as the user requested):**

| Capability                                                                        | Realistic commitment                                               | Boundary                                                                                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Local SQL, visual queries, formulas, pivots, charts, saved analyses and scenarios | High feasibility; no external API required                         | Substantial integration/usability work; full Excel compatibility is not the target                                 |
| AI query/formula drafting, explanation, planning, preferences and recovery        | Feasible with typed tools, deterministic execution and evaluations | Successful SQL or schema-valid output does not prove semantic correctness; models can still misinterpret or invent |
| Local document retrieval and dossiers                                             | Feasible for supported formats with cited passages                 | Scans, tables and ambiguous disclosures need extraction checks and explicit failures                               |
| Macro data and selected security research                                         | Feasible at personal-use scale with quotas and caching             | Endpoint/tier/exchange coverage, delays and source terms vary                                                      |
| ETF look-through                                                                  | Feasible for an explicit supported universe plus manual import     | Historical constituents, synthetic funds, hedges and universal coverage are not promised                           |
| General internet research and monitoring                                          | Feasible with bounded investigations and refresh schedules         | Search quotas, paywalls, blocked pages and sleeping/offline hosts limit completeness/frequency                     |
| Fully autonomous answers to arbitrary financial questions                         | Not a dependable promise                                           | Hardware does not remove missing data, model errors or uncertain interpretation                                    |

Exposure calculation example: EUR 10,000 in a fund with 4% Company X, EUR 5,000 in another with
6% Company X, and EUR 300 directly gives EUR 1,000 effective Company X exposure. Show each
contribution, source date and uncovered portfolio weight. Do not call listing-currency allocation
"actual dollar exposure": trading currency, fund base currency, constituent currencies, hedges and
revenue geography differ. Revenue/supply-chain geography and complex derivatives are later research
scope, not inferred from a simple holdings file. Supported issuer data is the bottleneck, not this math.

**Free-only operating policy proposed for implementation:**

- Deliver the manual workspace locally without an API subscription or an available AI model.
  Local-only AI must make no external requests. Internet-enabled retrieval remains explicit and
  sends public research queries/symbols rather than private transactions, account IDs or conversations.
- Prefer per-user provider keys where needed. Do not assume one shared developer key can support
  all installations, or that personal-use terms permit redistributed/hosted market data.
- Enforce per-provider and per-run limits, with a hard free-usage ceiling; no automatic paid overage,
  plan upgrade or remote-inference fallback. Account for endpoint credit weights, retries and concurrent
  monitors. Where a free allowance cannot be established reliably, stop/defer before risking charges.
- Cache only as permitted, refresh according to source release cadence, and reuse known-source
  retrieval instead of repeating general web searches. Scheduled monitors must share the quota governor
  with interactive work; define an interactive reserve so background jobs cannot consume everything.
- On exhaustion return a dated cached/partial result or defer with the next eligible refresh time.
  Missing sources, stale data and failed runs must never appear as current evidence or unchanged success.
- Publish a provider capability matrix: supported instruments/endpoints, freshness, credit cost,
  storage/retention/redistribution permissions and failure behavior. Search access does not imply
  full-text access, a scraping entitlement or permission to store/redistribute the source.
- Keep user-selected document/holdings/table imports as explicit fallbacks. They improve coverage
  without pretending to be live feeds. Local inference itself does not guarantee research privacy:
  the retrieval provider still sees the outbound request.

**Dated provider evidence from the conversation — reverify before integration:**

| Source checked 2026-09-08                                                                                                                                                                                       | Published capability/allowance                                      | Planning implication                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Twelve Data pricing](https://twelvedata.com/pricing)                                                                                                                                                           | Basic: 8 API credits/minute, 800/day                                | Credits are not complete analyses; verify endpoint weights and free instrument coverage                        |
| [Alpha Vantage support](https://www.alphavantage.co/support/)                                                                                                                                                   | Standard free allowance: 25 requests/day                            | Supplementary selective source, not frequent broad monitoring; special eligibility not assumed                 |
| [Brave Search API](https://brave.com/search/api/)                                                                                                                                                               | USD 5/month credit; Search USD 5/1,000 requests                     | Roughly 1,000 searches within credit; investigations may use several; confirm signup/attribution/billing terms |
| [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)                                                                                                                   | Public submissions and structured financial data                    | Primary-source company research with SEC coverage and access rules                                             |
| [Eurostat API](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-introduction)                                                                                                     | Public statistical data access                                      | Useful macro source, not security fundamentals                                                                 |
| [iShares Core MSCI World UCITS ETF](https://www.ishares.com/uk/individual/en/products/251882/ishares-core-msci-world-ucits-etf?siteEntryPassthrough=true)                                                       | Published fund holdings information                                 | Evidence for a supported-fund pilot, not a universal stable API or redistribution permission                   |
| [Ollama tools](https://docs.ollama.com/capabilities/tool-calling), [structured outputs](https://docs.ollama.com/capabilities/structured-outputs), [embeddings](https://docs.ollama.com/capabilities/embeddings) | Mechanisms for local tool use, typed answers and semantic retrieval | Supports the architecture; not proof of a model's accuracy on Vision tasks                                     |

These were documentation checks, not live API entitlement or throughput tests. No provider, new
dependency, pricing guarantee or model was selected. Example quota arithmetic: ten searches per
investigation would use about 1% of a 1,000-search monthly allowance; daily monitoring across many
subjects can exhaust it. Budget investigation steps rather than counting only user questions.

**Continuation instructions for this plan:** start with the stage 1 reference cases and shared
contracts when implementation is requested, not a new feature brainstorm or wholesale rewrite.
Bounded design evaluations should record the executor/isolation choice, formula/grid license and
precision, snapshot retention, source coverage/terms, and local-model evaluation criteria. Source
references for SQL boundaries: [PostgreSQL read-only transactions](https://www.postgresql.org/docs/current/sql-set-transaction.html)
and [DuckDB untrusted SQL isolation](https://duckdb.org/docs/current/operations_manual/securing_duckdb/overview).
SQL text checks alone are insufficient; neither candidate runtime is selected yet. Use reproducible
synthetic tests and task-based Demo acceptance before claiming correctness or accessibility.
This conversation changed TODO only; none of these proposed features was implemented or validated
at runtime. The plan/records are the durable handoff; do not create duplicate backlog items for them.

## Opt-in OpenAI and Codex assistance plan — 2026-09-09

**User intent and scope:** support OpenAI first, with both API access and supported ChatGPT/Codex
subscription access. Cloud assistance is opt-in. The user cares especially about provider retention,
advertising-related use and disclosure to other companies, not just model training. This records a
plan and architectural review; it does not authorize implementation, credential access, paid calls,
or transmission of any financial data in this session. Existing local-only functionality remains.

**Feasibility and evidence checked 2026-09-09:**

- [Codex authentication](https://learn.chatgpt.com/docs/auth) documents ChatGPT subscription and
  API-key access. Authentication selects ChatGPT/workspace versus API-organization data controls.
  This supports investigating subscription access; it is not proof that every plan/model or general
  third-party use is supported. Do not conflate subscription Codex with ordinary Responses API access.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server) is an official integration candidate.
  Compare it with the official SDK for the selected use case. Verify distribution/use terms, supported
  login flow, target platforms, account types, available models/tools, session persistence, limits and
  revocation in a synthetic prototype. Browser automation, extracted session cookies and private
  endpoints are not an integration strategy. No compatibility or privacy parity has been demonstrated.
- [API data controls](https://developers.openai.com/api/docs/guides/your-data): default abuse logs may
  contain content and generally persist up to 30 days, with exceptions. Response state, caches and
  tools have distinct retention. `store:false` is not zero retention. Zero Data Retention requires
  approval and has feature/model limits; do not assume personal eligibility or infer it from a flag.
  Recheck the selected endpoint/model and account before claiming a retention profile.
- [ChatGPT ads](https://help.openai.com/en/articles/20001047): OpenAI states advertisers do not receive
  chats or personal details; advertising-supported ChatGPT can use conversation context internally.
  Plus/Pro are currently described as ad-free. Neither claim proves Codex payloads feed advertising,
  nor establishes that subscription access has API retention controls. Keep unknowns explicit.
- [Privacy policy](https://openai.com/policies/row-privacy-policy/) describes service-provider processing
  and specified legal/business disclosures. Distinguish advertiser access, internal advertising use,
  operational subprocessors and legal disclosure; no-training is not a no-sharing/no-retention claim.
  Select the applicable regional/product policy during design rather than assuming one account type.

**Architectural review and preferred enhancement:** prefer cloud planning with local execution over
uploading masked financial records. Local software knows the financial schema and can send a generic
analysis problem and approved schema; cloud proposes a plan/formula, the existing restricted engine
executes locally, and local AI explains private results. For public research send the company/topic
without stating ownership, position size, broker or personal rationale. This meaningfully reduces
what can be retained even if the provider stores the entire request. Less context can reduce cloud
answer quality; measure that trade-off instead of claiming equivalent performance.

| Mode                            | Permitted disclosure                                                                       | Result handling                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Local only (default)            | No cloud-model requests                                                                    | Local tools and local AI only                                     |
| Cloud planning/public research  | Approved generic question/schema/public subjects; no private rows or values                | Validate plan, calculate and combine with private context locally |
| Cloud selected-summary analysis | Explicitly scoped aggregates/excerpts after review; labels alone do not remove sensitivity | Validate output and restore approved references locally           |

**Trust boundaries to implement:**

Current integration constraint: `aiChatService.js` constructs prompts, dispatches repository-backed
tools and persists conversation/tool results. Do not connect cloud inference by merely switching
its client. Introduce a distinct cloud-safe run/transcript contract first. Reuse calculation services
behind the boundary, not raw persisted history. Schema labels, user-defined categories and SQL
identifiers may themselves be private and require classification. Update existing local-only feature
documentation when implementation lands; this planning record does not change current behavior.

1. The local data/execution component holds records and computes deterministic results. It does not
   hand a cloud agent a database connection, unrestricted query tool or private working directory.
2. A local disclosure controller constructs an allowlisted typed request, strips unnecessary fields,
   verifies policy and records what is released. LLM redaction is an assistive classifier, never the
   sole gate. Protect prompts, schema examples, document metadata, filenames, error text, images,
   tool results, retries and conversation summaries. Unknown classifications fail closed for cloud.
3. A separate provider adapter receives only the released payload plus its own scoped credentials.
   Prefer direct provider communication rather than adding a Vision-operated relay. OS/process
   isolation must prevent access to private stores/mappings; module conventions alone are inadequate.
   The trusted disclosure controller necessarily sees raw data: document this residual local trust.
4. Cloud replies enter as untrusted typed plans/text. Validate identifiers, parameters, query limits,
   formulas and citations; render safely with remote content blocked. Use the existing analysis
   executor, never shell/eval or broader privileges. Any result requested back by the cloud passes
   the disclosure controller again, including binary/boolean results that can leak sensitive facts.
5. Rehydrate only known, analysis-scoped placeholders inside local output. Keep private/restored
   conversation state separate from outbound context. Local display does not authorize retransmission.
   New tool permissions, sources or disclosure levels require a new policy decision, not model consent.

**Further privacy enhancements and limits:**

- Generate random scoped tokens, not unsalted hashes of names/ISINs. Keep stable tokens only within
  the required analysis; avoid cross-analysis/provider linkage. Store the mapping locally with
  minimal lifetime and encrypted persistence only when resume needs it. Test collisions, concurrent
  analyses, unknown tokens and backup/delete behavior. No global text replacement of arbitrary output.
- Prefer omission and symbolic execution to perturbing numbers. Exact dates, rare holdings, transaction
  patterns and small aggregates can identify or reveal facts despite replaced names. Percentages also
  disclose information. Repeated/differencing queries can reconstruct values: bound cumulative
  disclosure across a job, not only individual requests. Do not silently round/noise data used for
  financial calculations; any generalized cloud summary is labeled and exact arithmetic remains local.
- Consent binds destination, auth route, source fields, purpose, disclosure level and budget. Show the
  exact outbound content and a concise disclosure summary, including account/network metadata limits.
  Persistent grants must be narrow, visible and revocable. No per-request nagging within an unchanged
  grant; scope expansion pauses. Scheduled cloud work needs an explicit matching grant.
- Turn off provider-native browsing/connectors/shell/computer/file tools by default. Public retrieval
  can run through Vision's controlled path. A Codex runtime must have a sanitized isolated workspace,
  no inherited host tools/plugins/config/context, no real financial mounts, and constrained network
  routes. A read-only filesystem is insufficient because reads can still leak information.
- Keep keys in the supported OS credential store; never in prompts, exports, logs or ordinary backups.
  Use official sign-in and scoped runtime credentials. This plan never authorizes reading existing
  protected Codex auth files. Do not share a user's main Codex runtime state with the integration.
- Minimize local retention too: metadata-only audit by default, optional encrypted short-lived payload
  history for exact review, separate retention for mappings, drafts and provider IDs. Scrub telemetry,
  traces, crash reports and support exports. Expiry/deletion covers caches and documented backup
  behavior; local deletion cannot guarantee deletion of provider logs or copies already disclosed.
- Prefer stateless/minimum-state API requests and local conversation/document storage. Verify caching,
  background tasks, files and tools individually. Subscription retention may remain less configurable;
  if its effective profile cannot meet a chosen privacy mode, disable that combination rather than
  relabeling it. Policies are dated claims, not cryptographic guarantees against the provider.
- Encryption in transit/at rest and tokenization do not hide released plaintext from the model
  provider. This is pseudonymization/data minimization, not guaranteed anonymity, encrypted inference,
  no-third-party processing or zero retention. Local-only is the option when no disclosure is acceptable.

**Delivery and release gates:** (A) resolve provider/auth/retention feasibility and write the boundary
ADR; (B) implement/test disclosure and local-plan execution without real cloud traffic; (C) implement
API adapter with synthetic payloads; (D) independently prove isolated subscription integration before
enabling it; (E) add scoped consent, lifecycle and evaluation. API success does not clear subscription
gates. First useful slice is a cloud-authored spending query executed locally without sending records.
Second is public company research joined locally to holdings. Selected-summary sharing follows only
after cumulative-disclosure and privacy controls pass. Remote capability never bypasses the existing
manual/AI shared analysis contracts, read-only executor or explicit source-access rules.

**Cost/availability:** preserve free-only local/research defaults. Enabling cloud API use creates a
separate explicit spend budget; subscription usage consumes that subscription's allowance. Show the
active route and limits and never switch from exhausted subscription to paid API automatically.
Disable/fail locally when unavailable, or offer an explicitly chosen local continuation. This is an
optional enhancement, not a prerequisite for the original six-stage local analysis plan.

## Findings

### 🔒 Security and access control

- [ ] **Resolve OpenAI API and Codex subscription integration feasibility and privacy profiles** ⏫
  - Tracking: 🔎 decision-needed 2026-09-09 (both routes requested; verify permitted integration, account/model support and effective retention before selecting adapters)
  - ↪ _from: User opt-in OpenAI/Codex plan 2026-09-09 · access and privacy feasibility_
  - Own the dated route matrix and boundary ADR: API versus official Codex SDK/App Server, plan
    eligibility, authentication/revocation, retention/caching, advertising versus subprocessor
    disclosure, supported privacy modes and cost limits. Use synthetic prototypes only until a
    separate transmission grant exists. Exit: documented supported/unsupported/unknown combinations;
    no assumption that subscription grants generic API access or API zero-retention eligibility.

- [ ] **Enforce typed disclosure policies at an isolated cloud egress boundary** ⏫
  - Tracking: 🔎 decision-needed 2026-09-09 (depends on boundary ADR; choose process/network enforcement and field classification rules)
  - ↪ _from: User opt-in OpenAI/Codex plan 2026-09-09 · data minimization architecture_
  - Build allowlisted payloads for each mode and enforce policy on every request, tool result,
    retry and resume. Local AI may suggest sensitive spans but cannot authorize disclosure.
    Include unstructured text, metadata and cumulative small-query leakage. Exit: canary financial
    fields cannot reach the adapter through normal/error/stream/tool paths; unknown scope blocks;
    adapter cannot read the DB, raw transcript, mappings or unapproved local files.

- [ ] **Execute cloud-authored analysis plans locally without exporting private results** ⏫
  - Tracking: 🔎 decision-needed 2026-09-09 (depends on shared analysis executor and disclosure boundary; define safe plan/tool result contracts)
  - ↪ _from: User opt-in OpenAI/Codex plan 2026-09-09 · cloud planning local execution_
  - Send approved schema/questions, validate returned query/formula plans and execute with the same
    restrictions as manual analysis. Keep values and final private synthesis local; public research
    need not disclose ownership. Reject arbitrary code and disclosure requests outside the grant.
    Exit: synthetic spending analysis matches canonical totals with no raw values sent; malformed
    plans, malicious SQL and attempted follow-up extraction cannot expand privileges or disclosure.

- [ ] **Implement scoped reversible references and safe local response restoration** 🔼
  - Tracking: 🔎 decision-needed 2026-09-09 (depends on disclosure contract; settle token lifetime, resume storage and deletion semantics)
  - ↪ _from: User opt-in OpenAI/Codex plan 2026-09-09 · local placeholder mapping_
  - Own random per-analysis references and mapping lifecycle; keep mappings out of provider payloads
    and credentials. Restore only recognized typed references, with safe rendering and clear errors.
    Retain distinct private and outbound conversation representations. Exit: round-trip and negative
    tests cover collisions, cross-analysis references, malformed tokens, restart, deletion and restored
    follow-up leakage; financial/date patterns are never described as anonymous merely due to tokens.

- [ ] **Add an opt-in OpenAI API adapter with explicit storage and spend controls** 🔼
  - Tracking: 🔎 decision-needed 2026-09-09 (depends on feasibility/egress contracts; select endpoint/model profile and verify storage settings)
  - ↪ _from: User opt-in OpenAI/Codex plan 2026-09-09 · API route_
  - Accept released payloads only; use official API access, protected credentials, minimum supported
    state, bounded retries/cancel and local accounting. Treat store:false, caches and abuse retention
    separately; disable unapproved hosted tools/files/conversation storage. Exit: synthetic contract
    tests verify actual request options and no automatic spend/fallback; live synthetic acceptance
    and current account entitlement verification are separately recorded before enabling the route.

- [ ] **Add isolated opt-in Codex subscription access through a supported integration** 🔼
  - Tracking: 🔎 decision-needed 2026-09-09 (depends on subscription feasibility and egress boundary; stop if supported runtime cannot enforce isolation)
  - ↪ _from: User opt-in OpenAI/Codex plan 2026-09-09 · subscription route_
  - Use official login with separate runtime state and a sanitized workspace. Block inherited host
    context, financial files, shell/network/plugin escape and direct database tools. Expose only
    mediated capabilities, account-route status and subscription-limit failure. Exit: synthetic
    network/filesystem traces prove payload confinement, logout/revocation works, runtime updates
    cannot silently enable tools, and exhausted subscription never switches to paid API. Unknown
    retention controls stay visible; do not claim parity with the API implementation.

- [ ] **Manage cloud consent and local retention with inspectable disclosure records** 🔼
  - Tracking: 🔎 decision-needed 2026-09-09 (depends on privacy profiles; choose grant scope, audit retention and encryption/backup behavior)
  - ↪ _from: User opt-in OpenAI/Codex plan 2026-09-09 · privacy controls and lifecycle_
  - Offer local-only, cloud-plan/public and selected-summary modes. Preview payloads and bind grants
    to route/data/purpose/budget; revocation stops queued/retried/scheduled disclosure. Record metadata
    minimally; exact payload history is optional, encrypted and expires. Scrub telemetry/support paths
    and define cache/mapping/backup deletion. Exit: user can inspect what leaves, revoke it and delete
    local history; UI distinguishes provider retention, training, advertising and onward processing.

- [ ] **Evaluate cloud-assistance privacy boundaries and usefulness before release** ⏫
  - Tracking: 🔎 decision-needed 2026-09-09 (depends on privacy contracts; establish adversarial and utility acceptance criteria before enabling either route)
  - ↪ _from: User opt-in OpenAI/Codex plan 2026-09-09 · independent privacy validation_
  - Own a synthetic evaluation suite for direct/indirect identifiers, rare patterns, malicious
    documents/output, arbitrary outbound URLs, error/telemetry leakage, cumulative queries, restored
    context, concurrent sessions, cancellation and resume. Inspect actual serialized/network traffic,
    not just redactor output. Compare local-only versus cloud-plan versus approved-summary accuracy
    on identical financial tasks. Exit: independent boundary review and route-specific acceptance;
    passing tests is bounded evidence, never a guarantee of anonymity or provider deletion.

### 💶 Financial and data correctness

### ⚡ Performance and scale

### 🧠 Insights and product semantics

These records implement the plan above across Budgeting, Portfolio, and Research. Priorities are
provisional; dependencies determine delivery order. Resolve each named design choice before
implementation; do not treat planned features as reproduced defects. Existing forecasting,
chart layouts, alerts and admin tools remain starting points rather than duplicate implementations.

- [ ] **Validate a supported fund-holdings data source and import contract** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (favored direction; choose initial issuers/funds, permitted storage, refresh cadence, and manual-import fallback)
  - ↪ _from: User product exploration 2026-09-08 · portfolio exposure feasibility_
  - Pilot a small explicit fund universe using public issuer holdings or user-supplied files.
    Record fund/share-class identity, constituent identifiers, weights, as-of date, source, and
    coverage; validate matching, stale/partial inputs, cash, and unsupported synthetic exposures.
    A visible download is evidence of availability, not permission for unrestricted redistribution.

- [ ] **Aggregate direct and supported fund holdings into portfolio exposure views** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (favored direction; depends on fund-holdings contract and agreement on supported exposure dimensions)
  - ↪ _from: User product exploration 2026-09-08 · portfolio exposure analysis_
  - Show effective issuer weights, direct/fund contributions, overlap, sector and issuer-country
    breakdowns with drill-through. Keep uncovered weight visible rather than renormalizing it away.
    Distinguish listing currency, underlying currency, hedging, and revenue geography; do not infer
    economic FX exposure from listing currency. Defer derivatives and recursive funds unless modeled.

- [ ] **Create persistent research dossiers linked to investments or budgeting topics** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (favored direction; agree dossier fields, evidence retention, and editing/version behavior)
  - ↪ _from: User product exploration 2026-09-08 · research dossiers_
  - Save the question, user thesis, supporting/opposing evidence, assumptions, unresolved questions,
    linked holdings/categories, conclusion, and review date. Separate user-authored claims from AI
    drafts; retain source dates and references, version conclusions, and include backup/export.

- [ ] **Retrieve cited passages from a local research document library** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (favored AI/dossier extension; select initial document formats, retention policy, and local embedding/OCR requirements)
  - ↪ _from: User product exploration 2026-09-08 · grounded local document research_
  - Index user-selected reports, factsheets, contracts, and permitted web snapshots with keyword
    and semantic retrieval. Preserve document/page/section references and versions; make deletion
    remove derived indexes. Report extraction failures and unsupported scans rather than inventing
    content. Treat retrieved text as evidence, never as tool-execution instructions.

- [ ] **Expose existing research services to local AI through bounded typed tools** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (favored direction; choose first research tools and explicit external-data access behavior)
  - ↪ _from: User product exploration 2026-09-08 · services/aiChat/tools/index.js and services/research/providerRegistry.js_
  - Add selected quote, fundamentals, news, macro, comparison, and forecast capabilities by reusing
    existing services, identity mapping, quota governor, and caches. Return dated provenance and
    partial failures. Preserve a genuinely local-only mode; calling live providers requires a
    documented internet-enabled mode and updates to the current no-external-chat contract.

- [ ] **Add controlled web search and page retrieval for local research synthesis** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (favored direction; choose search provider, query privacy policy, source retention, and per-run limits)
  - ↪ _from: User product exploration 2026-09-08 · integrated internet research assistant_
  - Build public queries without private transaction/account/conversation payloads. Fetch bounded
    sources with network destination controls, provenance, source dates, and explicit unavailable
    results. Keep public retrieval separate from local synthesis; defend against instructions in
    retrieved content. Do not silently fall back to remote model inference.
    Apply the free-only policy above: per-user keys, capability/terms checks, hard usage ceilings,
    shared quota accounting and explicit cached/partial/deferred results. Validate exhaustion paths
    with synthetic provider responses before any claim that the feature stays within free allowances.

- [ ] **Evaluate and improve local AI analysis reliability on representative questions** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (favored direction; agree synthetic evaluation set, hardware target, and latency/accuracy acceptance criteria)
  - ↪ _from: User product exploration 2026-09-08 · stronger local AI_
  - Own the synthetic evaluation harness, not the separate metric/planner/UI implementations below.
    Score tool/query/formula correctness, scope interpretation, numeric reconciliation, source
    support, abstention, prompt-injection resistance, partial failures and follow-up edits across
    all three workspaces. Keep fixed oracle results separate from model-generated expectations.
    Compare candidate local models/context settings on the actual target hardware using repeat runs,
    memory use, latency and completion rate; define thresholds before selecting defaults. A model
    unavailable locally is a visible unavailable result, never a silent remote fallback.

- [ ] **Reconcile AI financial metrics with canonical application calculations** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (stage 1 prerequisite; resolve exact public metric names/compatibility and reproduce source findings before choosing fix slices)
  - ↪ _from: User unified analysis plan 2026-09-08 · local AI correctness review_
  - Static review of `services/aiChat/tools/portfolio.js` found native-currency allocation sums,
    unrealized basis using all historical buy costs after partial sales, and cash-flow measures
    labeled as returns; `tools/tax.js` reports proceeds rather than actual capital gains. These are
    source findings, not runtime-verified results. Reproduce on synthetic data and split confirmed
    corrections into focused fixes. Acceptance: tools use canonical services, distinguish total
    return/income/proceeds/gains, and agree with screens after partial sales and currency conversion.

- [ ] **Plan AI questions and propose inspectable edits to shared analyses** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (stage 4; depends on shared definitions/executor; choose bounded plan schema and ambiguity policy)
  - ↪ _from: User unified analysis plan 2026-09-08 · AI question planning and assistance_
  - Resolve metric, time range, accounts, currency and evidence requirements; ask only when an
    ambiguity materially changes results, otherwise expose the chosen default. Produce a bounded
    typed tool/query/formula/chart plan using the same APIs as manual users. AI edits are previewable,
    versioned and undoable; manual edits remain authoritative. Acceptance: a follow-up such as
    "exclude rent and compare last year" changes the existing definition rather than losing its
    scope; the user can finish without AI. Do not use model arithmetic for financial results.

- [ ] **Select relevant AI tools and context within measured local resource budgets** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (stage 4; choose routing/context budgets through the evaluation harness rather than model-name assumptions)
  - ↪ _from: User unified analysis plan 2026-09-08 · relevant context and model suitability_
  - Select needed tool schemas, dataset descriptions, conversation constraints and evidence passages
    per step. Keep effective filters and missing-data indicators when compacting large results;
    retrieve detail on demand instead of silently truncating decisive evidence. Reuse local retrieval
    and existing caches with scope/version-aware keys. Acceptance: long investigations retain the
    user's constraints, report exhausted budgets, and do not send the full database into context.

- [ ] **Render evidence-backed AI answers with selectable depth and language** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (stage 4; agree structured answer schema and mapping to existing chat/chart UI)
  - ↪ _from: User unified analysis plan 2026-09-08 · structured output and answer depth_
  - Offer quick answers and detailed investigations in the user's selected EN/NL language. Separate
    recorded facts, external claims, deterministic calculations, interpretations, assumptions and
    missing information. Link numbers to run/cell/query evidence and external claims to dated source
    passages; validation checks references exist without claiming this proves every interpretation.
    Conflicting sources stay visible; unsupported conclusions trigger a qualified answer or abstention.
    Acceptance: users can inspect evidence and open/edit a referenced analysis from either depth mode.

- [ ] **Persist recoverable AI investigation jobs with explicit partial-result states** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (stage 4; choose durable job/checkpoint storage and restart semantics; reuse existing background chat streaming)
  - ↪ _from: User unified analysis plan 2026-09-08 · recoverable research jobs_
  - Track queued/running/waiting/partial/completed/failed/cancelled states, bounded steps, progress and
    completed evidence. Cancel propagates to queries/provider calls; retry/resume reuses valid work
    and marks stale inputs for refresh. Navigation, backend restart and model/provider failure must
    not turn incomplete work into success or duplicate persisted outputs. Acceptance: interrupted
    synthetic research resumes with original scope and visible partial evidence; quotas still apply.

- [ ] **Manage visible local AI preferences without hidden financial assumptions** 🔼
  - Tracking: 🔎 decision-needed 2026-09-08 (stage 4; define preference precedence and storage/backup scope)
  - ↪ _from: User unified analysis plan 2026-09-08 · editable durable preferences_
  - Let users view/edit/delete saved reporting currency, benchmark, answer depth and language defaults;
    reuse existing settings instead of conflicting copies. Explicit per-analysis parameters override
    defaults, and saved runs retain their effective values. Do not infer risk tolerance or silently
    save conversation claims as preferences. Acceptance: changing/deleting a default is visible,
    does not rewrite old analyses, and preferences can be exported/backed up and removed.

- [ ] **Specify the shared analysis definition and execution result contract** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (stage 1; settle schema/version/lineage rules in an ADR before implementation; SQL runtime remains a separate decision)
  - ↪ _from: User unified analysis plan 2026-09-08 · one manual and AI-assisted workspace_
  - Define logical datasets, visual-plan/custom-SQL sources, typed parameters, formulas, assumption
    cells, presentations and definition versions. Define run identity, metric/source versions,
    reporting timezone/currency, snapshot consistency, coverage, pagination/truncation and row lineage.
    Visual, SQL, grid and AI paths consume this contract; persistence is owned by saved analyses.
    Acceptance: contract fixtures represent all reference questions, preserve non-convertible SQL,
    and let formula/chart consumers reject incompatible results without corrupting saved work.

- [ ] **Build a visual financial query builder usable without AI or SQL** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (stage 2; depends on dataset/shared contracts and executor; choose initial measures and validated join paths)
  - ↪ _from: User unified analysis plan 2026-09-08 · accessible manual analysis_
  - Select datasets, fields, typed filters, measures, grouping and sorting; offer documented join
    paths with row-grain checks to prevent accidental duplication. Compile the structured plan to
    the shared executor and expose generated SQL. Acceptance: a novice builds monthly spending
    excluding transfers, groups by category and drills to records with AI offline; equivalent SQL
    yields the same result. Unsupported joins/operations explain the limit and allow custom SQL.

- [ ] **Build a SQL editor that interoperates with visual and spreadsheet analyses** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (stage 2; depends on restricted executor/shared contracts; select repository-compatible editor integration)
  - ↪ _from: User unified analysis plan 2026-09-08 · expert analysis and cross-mode editing_
  - Provide schema/metric help, completion, typed parameters, error locations, cancel and saved query
    history. Show generated SQL; editing it creates a custom-SQL definition without destroying the
    visual original. Arbitrary joins/window functions need not round-trip into visual blocks; their
    results still support grids/formulas/charts. AI suggestions use inspectable diffs and undo.
    Acceptance: save/reopen/edit an advanced query and switch views without silent query rewriting.

- [ ] **Implement typed spreadsheet formulas and isolated what-if assumptions** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (stage 3; depends on shared results; evaluate formula engine precision, license and supported function set)
  - ↪ _from: User unified analysis plan 2026-09-08 · Excel-like analytical calculations_
  - Start with calculated columns, named assumption/summary cells, arithmetic, comparisons,
    conditionals, date operations and conditional aggregates. Specify decimal money, units/currency,
    nulls, dates, references, dependency ordering, cycles and error propagation; disallow arbitrary
    JavaScript/macros/network functions. Users can edit scenarios without ledger writes. Acceptance:
    equivalent SQL/canonical/formula calculations agree; refresh preserves assumptions and explicit
    formula errors identify broken references. Expand compatibility only after this subset works.

- [ ] **Add guided analysis templates and progressive controls across workspaces** 🔼
  - Tracking: 🔎 decision-needed 2026-09-08 (stage 3; depends on first manual slice; choose initial templates and task-based usability acceptance)
  - ↪ _from: User unified analysis plan 2026-09-08 · anyone can investigate their finances_
  - Provide entry points from datasets, records/charts, a blank analysis, or examples for spending
    changes, recurring costs, portfolio returns and evidence comparison. Start with understandable
    measures and explain jargon; reveal advanced SQL/formulas on demand. Keyboard access, EN/NL,
    loading/empty/error states and data-coverage explanations are required. Acceptance: novice and
    expert task walkthroughs on synthetic Demo data complete without AI; disabling AI loses no
    manual capability, and templates save as ordinary editable definitions, not special dashboards.

- [ ] **Export reproducible analyses and attach user-selected tabular scenario inputs** 🔼
  - Tracking: 🔎 decision-needed 2026-09-08 (stage 3; choose CSV/XLSX support, formula export subset and analysis-only import limits)
  - ↪ _from: User unified analysis plan 2026-09-08 · spreadsheet interoperability_
  - Export chosen results and supported formulas/assumptions with scope, units, source dates and
    truncation labels; disclose unsupported formulas as values rather than pretending full Excel
    compatibility. Import user-selected tabular files as separate typed analysis datasets with
    explicit joins, provenance and removal. Neutralize untrusted formula payloads without disabling
    intentional supported workbook formulas. Acceptance: exported values reconcile, supported
    formulas recalculate correctly, and scenario imports never mutate ledger tables.

- [ ] **Define analysis datasets with documented financial meanings and reconciliation checks** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (favored SQL/visual-analysis foundation; choose initial datasets and row-level access contract)
  - ↪ _from: User product exploration 2026-09-08 · free database analyses_
  - Expose stable analysis views for transactions, accounts, holdings, and cash flows with documented
    row grain, joins, signs, transfer/refund treatment, currencies, time basis, and metric definitions.
    Reconcile reference queries with existing reports; exclude secrets/admin internals and enforce
    authorized rows. Evaluate broader read-only schema access separately rather than assuming it.

- [ ] **Provide an isolated read-only SQL analysis executor** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (favored direction; choose restricted PostgreSQL connection versus isolated analytical snapshot after a bounded feasibility test)
  - ↪ _from: User product exploration 2026-09-08 · SQL analysis workspace_
  - Query authorized analysis datasets with joins, aggregates, and window functions; provide typed
    parameters, cancellation, timestamps, and explicit result truncation. Enforce isolation,
    privileges, allowed operations, resource limits, and no file/network/extension escape independently
    of SQL text checks. Keep this separate from admin dbEditor and production write credentials.
    AI may draft inspectable queries but cannot bypass the same executor restrictions.
    Dependency: analysis dataset/run contracts. Acceptance includes unauthorized-row and write
    rejection, unsafe-function/extension/file/network attempts, timeout/cancel cleanup, and limits
    on expensive queries even when their returned row count is small. Keep runtime choice provisional.

- [ ] **Add spreadsheet-style transformations over analysis results** 🔼
  - Tracking: 🔎 decision-needed 2026-09-08 (favored direction; agree initial formulas, pivot/chart scope, and export behavior; full Excel compatibility is not assumed)
  - ↪ _from: User product exploration 2026-09-08 · Excel-like analysis_
  - Deliver a basic result grid with sorting, pagination and drill-through in stage 2; it must not
    depend on formulas or export. Add filter/group/pivot and chart UI in stage 3 over the same result
    contract. Use the separately specified formula engine for computed columns/assumptions and
    export service for downloads when available. Distinguish server-wide transformations from the loaded page; never
    calculate a full-total chart from a truncated sample without a visible scope label. Preserve
    drill-through and keyboard operation. Acceptance: chart, pivot and SQL totals agree on the same
    full dataset; no-AI workflows work; schema/refresh errors preserve the last usable analysis.

- [ ] **Persist reusable parameterized analyses across all three workspaces** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (favored direction; agree shared saved-analysis schema and relationship to dossiers, conversations, and chart layouts)
  - ↪ _from: User product exploration 2026-09-08 · saved questions_
  - Save resolved queries/tool plans, parameters, metric definitions, formulas, charts, and source
    references rather than only the natural-language prompt. Distinguish frozen snapshots from live
    refresh; track definition versions and failures. Support both budgeting and investment questions,
    including recurring versus discretionary spending, category changes after refunds/transfers, and
    contract-cost comparisons. Include backup/export and dossier links without duplicating existing
    chart-layout storage.

- [ ] **Monitor saved analysis conditions and evidence changes with meaningful notifications** ⏫
  - Tracking: 🔎 decision-needed 2026-09-08 (favored direction; depends on saved analyses; decide scheduler location, offline catch-up, thresholds, and delivery channels)
  - ↪ _from: User product exploration 2026-09-08 · saved questions and monitoring_
  - Extend/reuse existing alerts where suitable. Evaluate explicit cash-flow/exposure thresholds or
    new dossier evidence; record prior/current values, coverage, and why a notification fired.
    Deduplicate, use cooldowns, cap provider/AI costs, and expose stale/failed runs. AI interpretation
    is a review flag, not proof a thesis failed. Desktop monitoring cannot run while its host sleeps.
    Respect the shared free-only policy and interactive quota reserve. Prefer known-source/release
    checks over repeated web searches; test offline catch-up and quota exhaustion without duplicate
    notifications, paid overage or presenting stale results as a successful unchanged check.

- [ ] **Evaluate commitment-aware available cash for spending and investing** 🔽
  - Tracking: 🔎 decision-needed 2026-09-08 (alternative still under evaluation; agree reserve policy, horizon, earmarks, and handling of irregular expenses)
  - ↪ _from: User product exploration 2026-09-08 · original budgeting suggestion_
  - Extend existing cash-flow forecast/rebalancing with an explained candidate cash cap after bills,
    reserves, and uncertainty. Prevent double-counting recurring/planned obligations and historical
    forecasts. Show the minimum projected balance; do not label an assumption-driven amount guaranteed.

- [ ] **Evaluate saved life scenarios joining budget surplus and portfolio contributions** 🔽
  - Tracking: 🔎 decision-needed 2026-09-08 (alternative still under evaluation; choose first scenario and dated-goal scope before wiring existing projection cores)
  - ↪ _from: User product exploration 2026-09-08 · original shared financial scenarios suggestion_
  - Compare baseline with income interruption, moving costs, or changed contributions using existing
    forecast/portfolio engines and ADR-098 as starting points. Link contributions to available surplus,
    distinguish nominal/real assumptions, and expose sensitivity. Do not rebuild existing Monte Carlo
    tools or treat long-horizon output as a prediction.

### 🎨 User interface and accessibility

### 🏛️ API and architecture

- [ ] **Separate exact import provenance from versioned duplicate identity across every CSV adapter** ⏫
  - Tracking: 🔎 runtime-unverified 2026-09-09 (implementation and ADR-134 are present in the working tree; 346 focused import/backup tests, both typechecks, lint, static Alembic SQL, schema-head, destructive-DDL, docs diagrams, and visualizer checks pass; live migration round-trip and database concurrency evidence remain blocked because managed sandbox policy denies PostgreSQL shared memory, and the full backend route suite is blocked by `listen EPERM`)
  - ↪ _from: User import architecture request 2026-09-09 · preserve literal source records while deduplicating canonical transactions_
  - **Problem and current evidence:** `raw_data` currently serves both audit provenance and hash
    input. Belfius, BNP, ING, KBC, and the IBKR portfolio adapter retain source records, while the
    generic budgeting mapper, Vision, SABB, and Wise store pipe-joined reconstructions; Revolut
    stores a normalized CSV reconstruction. Budgeting validation hashes this mixed representation
    and collapses equal hashes within one batch; `transactions.tx_hash` then provides a legacy
    partial unique index. Portfolio validation also hashes staging provenance, but commit correctly
    uses destination occurrence counts so two legitimate byte-identical fills are preserved. One
    field therefore cannot reliably provide exact evidence, format-stable identity, cross-account
    isolation, and legitimate-repeat handling at the same time.
  - **Target contract:** retain the exact decoded source record without its terminal CR/LF in
    `raw_data`; store a non-unique `source_record_hash = SHA-256(raw_data)` for integrity checks;
    store a separate versioned `dedup_fingerprint` for import idempotence. Fingerprints must use a
    deterministic canonical serialization, include a budgeting/portfolio domain namespace and the
    destination/source-account identity, prefer an immutable source transaction ID when present,
    and otherwise include stable normalized source fields plus a deterministic occurrence ordinal.
    Mutable recipient, category, investment name, review override, or database row ID must not
    silently redefine the same source transaction.
  - **Adapter migration:** make every budgeting and portfolio adapter capture literal CSV records
    with CSV-aware parsing, preserving quoted separators, escaped quotes, embedded newlines, column
    order, and the decoded source text while normalizing only the record delimiter. Move Revolut's
    useful date normalization and every other adapter-specific compatibility transform into the
    canonical fingerprint builder rather than rewriting `raw_data`. Keep parser error/skipped-row
    behavior unchanged. Do not introduce or revive per-bank raw transaction tables.
  - **Duplicate semantics:** use occurrence-aware fingerprints in both domains so a first import
    preserves legitimate identical transactions, a partial re-import inserts only missing
    occurrences, and a complete re-import reports every existing occurrence as a duplicate. A
    source-provided immutable transaction ID takes precedence over occurrence fallback. Define
    deterministic ordering and restart behavior so chunk retries, review commits, reordered files,
    overlapping export windows, and concurrent imports cannot change an occurrence assignment or
    create duplicates. Preserve account and currency boundaries.
  - **Schema and compatibility:** add nullable fingerprint/version/source-hash fields to both
    staging models and the canonical budgeting and portfolio storage surfaces, with partial indexes
    or constraints that match the chosen concurrency rule and a complete Alembic downgrade. Do not
    reinterpret, rewrite, or bulk-backfill historical `tx_hash` values: old staging rows contain
    mixed provenance formats. During a dual-read/dual-write transition, new rows write the new
    fields while duplicate checks fall back to the existing hash and canonical field probes for
    legacy rows. Keep legacy `tx_hash` and its unique index until a separately documented soak and
    compatibility gate proves they can be retired without making old imports re-importable.
  - **Retention and recovery:** continue storing raw records in the existing import batch/staging
    tables, which are already backup-covered; do not duplicate raw financial data into canonical
    ledger rows. Specify what batch deletion, rollback, backup/restore, and data export/delete do to
    provenance and fingerprints. Never expose raw records through ordinary list or preview APIs;
    any future diagnostic access needs an explicit privacy and authorization review.
  - **Required evidence:** add golden raw-record and fingerprint fixtures for all adapters covering
    LF/CRLF, UTF-8/Latin-1, quoted delimiters, escaped quotes, embedded newlines, harmless export
    formatting variants, missing source IDs, multiple accounts/currencies, and intentional repeated
    transactions. Prove first import, partial re-import, full re-import, overlapping windows,
    reorder, retry/resume, rollback, legacy-row fallback, and concurrent-import behavior for both
    budgeting and portfolio pipelines. Run focused and full import suites, lint, both typechecks,
    migration upgrade/downgrade on a disposable database, backup/restore coverage, locale/API/docs
    validation where affected, and an independent financial-correctness review.
  - **Completion boundary:** the migration is complete only when every registered adapter preserves
    exact provenance, new canonical writes use a documented fingerprint version, legacy imports
    remain idempotent, legitimate identical occurrences are not lost, duplicate counts/statuses are
    consistent across one-shot, Server-Sent Events, review, and rollback flows, and the ADR plus
    import/portfolio/API/schema/backup documentation matches verified behavior. UI exposure of raw
    records, historical provenance reconstruction, new per-bank raw tables, and deletion of legacy
    columns are explicitly outside this item.

### 🏦 Accounts and portfolio features

- [ ] **Build forward-only persisted per-broker history after current-point surfaces have soaked** 🔽
  - Tracking: 🔎 verified-present 2026-09-08 (the current-point broker surfaces are still working-tree changes, not an installed real-data build; soak means at least one week of normal local use with checks on three separate days, no partition/global-total discrepancy, and no broker-assignment defect)
  - ↪ _from: ADR-108 implementation plan · WP-C7_
  - Add a dedicated snapshot-by-account table, writer, endpoint, chart, backup coverage, downgrade,
    and per-date sum invariant. Do not retroactively synthesize history.

### 🧪 Runtime and external acceptance

- [ ] **Validate the portfolio import adapter against a real Nexo export** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-09 (requires a user-provided sanitized Nexo export)
  - ↪ _from: ADR-108 · WP-C2 acceptance_
  - Pin real column names, locale decimals, instrument-less rows, and noisy symbol cells in a fixture.

- [ ] **Validate the portfolio import adapter against a real Kinesis Money export** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-09 (requires a user-provided sanitized Kinesis Money export; this is separate from the existing Kinesis market-price provider)
  - ↪ _from: ADR-108 · WP-C2 acceptance_
  - Pin real column names, locale decimals, instrument-less rows, and noisy symbol cells in a fixture.

- [ ] **Validate the portfolio import adapter against a real Saxo export** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-09 (requires a user-provided sanitized Saxo export)
  - ↪ _from: ADR-108 · WP-C2 acceptance_
  - Pin real column names, locale decimals, instrument-less rows, and noisy symbol cells in a fixture.
