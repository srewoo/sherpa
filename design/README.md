# Design reference

Static HTML mockups of every Sherpa surface, sharing one `styles.css`. Open
`index.html` for the overview.

**These are a reference, not the product.** Every screen here is now implemented
as live React — the side panel under `src/sidepanel/`, the options surfaces under
`src/options/pages/` — and that implementation is what ships. The mockups are
kept because they carry the visual intent (palette, type scale, spacing rhythm)
in a form that's quick to read and to redline.

## The stylesheet

`src/ui/styles.css` is the one the extension loads. It began as a copy of
`design/styles.css` and has since grown the components the live UI needed (the
site-switcher menu, stat tiles, code blocks in streamed answers).

When you change a shared visual token — a colour, the type scale, a radius —
change it in **`src/ui/styles.css` first**, then mirror it here if you want the
mockups to keep matching. Treat divergence in the mockups as stale
documentation, never as a bug in the product.

## What each file shows

| File | Surface | Built as |
|---|---|---|
| `panel-chat-empty.html` | Side panel, empty state | `src/sidepanel/App.tsx` |
| `panel-chat-answer.html` | Answer with source cards | `src/sidepanel/components.tsx` |
| `panel-chat-refusal.html` | "Not in this index" | `src/sidepanel/components.tsx` |
| `panel-auth-required.html` | Auth wall in the panel | `src/options/pages/CrawlSetup.tsx` |
| `auth-basic.html` | HTTP Basic prompt | Browser-native (see note) |
| `onboarding.html` | First run | `src/options/pages/Welcome.tsx` |
| `crawl-setup.html` | Crawl configuration | `src/options/pages/CrawlSetup.tsx` |
| `index-management.html` | Index list | `src/options/pages/Indexes.tsx` |
| `settings.html` | Settings | `src/options/pages/Settings.tsx` |
| `gap-report.html` | Content gap report | `src/options/pages/GapReport.tsx` |
| `states.html` | Edge and error states | Distributed across the above |

**HTTP Basic** (`auth-basic.html`) is intentionally not implemented as a Sherpa
form. Chrome shows its own credential dialog for a 401, and the crawl reuses the
session it establishes — asking for those credentials inside the extension would
mean handling them, which the privacy model (PRD 5.10) is built to avoid. The
crawl pauses and points the user at the sign-in instead.
