# Deposit Elasticity — Razor Pages app (runnable)

**Fixed for Visual Studio (this version):** the previous zip was missing two
things Visual Studio needs — a `.sln` file (so double-clicking actually
opens a solution instead of a bare folder) and `Properties/launchSettings.json`
(so F5/Run has a launch profile to use; without it, VS often has nothing
valid to launch against). Both are added now. I also went through every
`.cs`/`.cshtml`/`.json` file and checked brace/paren balance and JSON
validity by script to rule out corruption from earlier edits — all clean.

**If it still doesn't build**, please paste the exact error from the Error
List / Output window — "doesn't want to work" covers a lot of different
failure modes (missing SDK, NuGet restore failure, a real compile error I
haven't caught by manual review since I don't have the .NET SDK in my
sandbox to actually run `dotnet build`), and the exact message will get us
there in one pass instead of guessing further. One thing worth checking
first yourself: run `dotnet --list-sdks` — this targets **.NET 8**, so you
need a .NET 8 SDK installed for either Visual Studio or the CLI to build it.

## Run it
```
dotnet restore
dotnet run
```
Then open the URL it prints (e.g. `https://localhost:5001`) — it redirects
straight to `/Login`. Or open `DepositElasticityUI.sln` in Visual Studio
and press F5.


Works out of the box in **demo mode** (`BDE_DEMO_MODE = true` in
`wwwroot/js/chat-app.js`) — no Purple Fabric or Insight API needed to click
around: login screen, chat shell, and a full sample response (the Vodafone
Treasury UK example from the rebuild doc) with a real dual-axis rate/balance
chart, a rate-change table, an insight callout, and suggestion chips.

Charting uses a **locally vendored copy of Chart.js** (`wwwroot/js/vendor/chart.umd.js`)
rather than a CDN — deliberately, since a bank's internal network may not
allow external CDN scripts, and it means the app has zero external script
dependencies at runtime.

## Wiring in the real backend
1. Fill in `appsettings.json` → `PurpleFabric` section.
2. Once the single Deposit Elasticity Analyst agent is published in Purple
   Fabric (backed by the Insight API's `get_summary`/`get_daily`/`get_events`/
   `run_query` tools), put its asset ID in
   `PurpleFabric:Agents:depositelasticity`.
3. In `wwwroot/js/chat-app.js`, set `BDE_DEMO_MODE = false`.
4. `Controllers/ConversationController.cs` and `Services/ConversationAgentService.cs`
   handle the async trigger/poll pattern against the real API — unchanged
   from before, since the backend integration contract didn't change, only
   the JSON *shape* the agent replies with.

## What changed in this version
- `wwwroot/js/chat-app.js` — full rewrite of the renderer: renders a
  `{ blocks: [...], data: {...} }` payload instead of the old fixed-section
  `{ mainTitle, OverAllSummary, subSections, KeyInsights, suggestions }`
  schema. Each block type (text/chart/table/insight/suggestions) has its own
  renderer; chart blocks draw from 5 real chart components (rateVsBalance,
  operationalVsSurplus, elasticityScatter, lagChain, responseCurves) instead
  of the old hand-rolled bar/pie SVG.
- `wwwroot/css/barclays-theme.css` — replaced the fixed numbered-accordion
  report styles with flexible `.bde-block-*` styles.
- Every block renders inside its own try/catch — one malformed or
  unsupported block can't take down the rest of the message.

## What's included
- `Pages/Login.cshtml(.cs)`, `Pages/Chat.cshtml(.cs)` — the two screens
- `Pages/Shared/` — layouts + the shared brand-mark partial (placeholder
  shield mark — swap for the approved Barclays asset before anything
  client-facing)
- `Controllers/ConversationController.cs`, `Services/ConversationAgentService.cs`,
  `Services/IConversationAgentService.cs`, `Models/ConversationModels.cs` —
  Purple Fabric conversation wiring, unchanged from the previous version
- `wwwroot/css/barclays-theme.css`, `wwwroot/js/chat-app.js`,
  `wwwroot/js/vendor/chart.umd.js` — the visual design + block renderer +
  vendored charting library

## Not included (intentionally)
- Auth is still demo-mode (any non-empty email/password) — swap for
  Barclays SSO before this is anything but a POC.
- The data-preview tab from the plan isn't built yet — login + chatbot only.
- The Insight API (FastAPI/DuckDB) and the actual Purple Fabric agent
  registration are separate work — this package is the UI + prompt only.
- No automated tests yet.

## Note
Assembled and screenshot-tested in a sandboxed headless browser (login flow,
empty state, and all 5 chart types confirmed rendering with zero console
errors), but not compiled with the real .NET SDK — no `dotnet` available in
this environment. Run `dotnet build` first and flag anything that doesn't
compile.

