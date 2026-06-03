---
name: ui-design
description: Design a nice UI as a single self-contained HTML mockup (inspiration & exploration) for desktop-proxy's in-app panels. Use when asked to design, mock up, or explore the look of a UI/panel/page for this project.
disable-model-invocation: true
---

# UI Design (desktop-proxy)

Produce a polished, single-file HTML mockup as **inspiration**, then port the look
into the app's settings overlay (closed Shadow DOM, inline styles).

## Output rules (the mockup HTML)

- Only code in HTML/Tailwind in a single self-contained file (Tailwind + lucide via CDN). Put CSS in `style` attributes; keep Tailwind classes on `body` descendants (not the `<html>` tag).
- Start with a short response, then the code (saved to `docs/ui/<name>.html`), then a short response. Don't mention Tailwind/tokens/HTML by name to the user.
- Always include `html`, `head`, `body`. Make it responsive.
- Icons: lucide, `stroke-width: 1.5`. No gradient containers for icons.
- Font weight one level thinner than instinct (Bold → Semibold). Titles > 20px use `tracking-tight`.
- Custom checkboxes/toggles/dropdowns/sliders (only if part of the UI). Subtle dividers and outlines. Subtle contrast. Logos = letters only, tight tracking. No bottom-right floating download button. Animations via Tailwind, not JS. Add hover color/outline interactions.
- Charts (only if needed): chart.js, and wrap the canvas: `div > canvas` (never `canvas` as a sibling of `h2/p`).

## Defaults for this project

- **Light theme** (professional). Style in the vein of Linear / Stripe / Vercel / Tailwind UI (don't name them).
- Match the existing overlay's visual language so ports are faithful:
  - Font: `system-ui, -apple-system, sans-serif`. Body text `#111`, secondary `#6b7280`, muted `#9aa3ad`.
  - Borders/dividers `#e5e7eb` / `#f1f3f5`; surfaces `#fff` on `#f9fafb`.
  - Accent (links/active/badges) blue `#175cd3` on `#eff8ff`. Status: ok `#039855`, warn `#b54708`, error `#b42318`.
  - Rounded `6–8px`, 12–16px padding, 12–13px base font.

## Porting note (important)

The real UI lives in `packages/preload/src/*-page.ts`, injected into a **closed
Shadow DOM with inline styles** — Tailwind classes won't apply there. So the HTML
mockup is a visual reference; reimplement it with inline styles (and small helper
functions for repeated style strings) matching the mockup.
