---
name: TOPS
description: A clear everyday Persian order desk.
colors:
  paper: '#f5f4ef'
  surface: '#fff'
  ink: '#222c29'
  muted: '#59645f'
  line: '#d8ded8'
  brand: '#194e43'
  soft: '#eaf2ed'
  error: '#9b2828'
  warning: '#735019'
  brand-hover: '#103b32'
  focus: '#b47525'
  field-border: '#9aa99f'
  placeholder: '#65736b'
  warning-surface: '#f8efd9'
  error-surface: '#fae9e6'
  table-heading: '#f2f4ef'
  scrollbar: '#a5b7ac'
typography:
  headline:
    fontFamily: 'Vazirmatn, Tahoma, sans-serif'
    fontSize: '1.85rem'
    fontWeight: 750
    lineHeight: 1.5
  title:
    fontFamily: 'Vazirmatn, Tahoma, sans-serif'
    fontSize: '1.25rem'
    fontWeight: 700
    lineHeight: 1.8
  body:
    fontFamily: 'Vazirmatn, Tahoma, sans-serif'
    fontSize: '16px'
    fontWeight: 400
    lineHeight: 1.8
  label:
    fontFamily: 'Vazirmatn, Tahoma, sans-serif'
    fontSize: '0.9rem'
    fontWeight: 600
    lineHeight: 1.8
  supporting:
    fontFamily: 'Vazirmatn, Tahoma, sans-serif'
    fontSize: '0.875rem'
    lineHeight: 1.8
rounded:
  surface: '12px'
  control: '8px'
  field: '7px'
  badge: '5px'
spacing:
  compact: '8px'
  control-gap: '10px'
  small: '12px'
  medium: '16px'
  mobile-inset: '18px'
  surface: '24px'
  large: '32px'
components:
  button-primary:
    backgroundColor: '{colors.brand}'
    textColor: '{colors.surface}'
    rounded: '{rounded.control}'
    padding: '9px 16px'
  button-primary-hover:
    backgroundColor: '{colors.brand-hover}'
  button-quiet:
    backgroundColor: 'transparent'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    padding: '9px 16px'
  button-quiet-hover:
    backgroundColor: '{colors.soft}'
  field:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.field}'
    padding: '10px 12px'
    width: '100%'
  panel:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.surface}'
    padding: '24px'
  badge:
    backgroundColor: '{colors.soft}'
    textColor: '{colors.brand}'
    rounded: '{rounded.badge}'
    padding: '3px 9px'
  badge-warning:
    backgroundColor: '{colors.warning-surface}'
    textColor: '{colors.warning}'
    rounded: '{rounded.badge}'
    padding: '3px 9px'
---

# Design System: TOPS

## Overview

**Creative North Star: "A clear everyday Persian order desk"**

TOPS uses a deliberately simple, neutral interface for customers and operators. Warm paper surrounds white work surfaces; dark green marks actions and current navigation. Persian right-to-left reading, readable forms and explicit state text organize the work.

The shipped interface is a static gateway client. Its visual language supports catalog and basket work, checkout, payment, item and refund states, and reasoned admin review. It does not establish a marketing identity or an imagery program. This document records `apps/gateway/web/styles.css` and its HTML/ES-module components; token values in the frontmatter are normative.

**Key Characteristics:**

- Persian RTL with isolated LTR money and machine references.
- Warm paper, white bordered surfaces and dark green actions.
- Text-led lists, forms, summaries and locally scrolling tables.
- Visible keyboard focus and status text alongside color.

## Colors

Dark green is the single action accent within a warm, restrained neutral palette. Warning and error colors communicate state.

### Primary

- **Dark green** (`brand`): primary buttons, links, active navigation, timers and positive state text. The deeper `brand-hover` is the primary button hover treatment.
- **Soft green** (`soft`): neutral button hover, ordinary badges and success notices.

### Neutral

- **Warm paper** (`paper`): page background and expanded machine-detail background.
- **White work surface** (`surface`): panels, controls, top bar and dialog.
- **Dark ink** (`ink`): main text; **muted green-gray** (`muted`): supporting text and inactive navigation.
- **Pale divider** (`line`): surface outlines, rows and separators. Fields use the stronger `field-border`; placeholders use `placeholder`.
- **Table heading wash** (`table-heading`) distinguishes column headings. The `scrollbar` color marks local overflow against paper.

Warning badges pair `warning-surface` with `warning`; error text uses `error`. The shipped error badge style pairs `error-surface` with `error`. Amber `focus` marks keyboard focus independently of the action color. Notice variants retain their source CSS fills and borders in the sidecar rather than adding a second palette scale.

**The Text State Rule.** Show state in words; color supports the label.

## Typography

**Body and heading font:** self-hosted Vazirmatn, with Tahoma and sans-serif fallbacks. Arabic and Latin subsets ship as WOFF2 with variable weights (100–900) and `font-display: swap`.

The hierarchy uses one family and generous line spacing. Body text uses the frontmatter body role; ordinary paragraphs have a maximum width of 72ch. Page headings use headline, section headings use title, and third-level headings use body size with browser-default bold weight. Catalog titles use 1.15rem; supporting text uses the supporting role. Form labels use label. Buttons use inherited size with weight 600, money uses weight 650 and tabular numerals, and timers use weight 700.

The welcome heading is 2.5rem with a 20ch maximum width. At the mobile breakpoint it becomes 2rem; ordinary page headings become 1.5rem. These are existing surface-specific variations, not a separate display family.

**The Exact Money Rule.** Keep the visible rial label and exact, copyable decimal value; isolate the number LTR and retain local wrapping or scrolling for long values.

## Layout

The document uses `lang="fa"` and `dir="rtl"`. The main container is centered with a maximum width of 1240px, horizontal padding of 24px and margins of 40px above and 64px below. The white top bar is a wrapping flex layout with a bottom border; desktop navigation has a 22px gap. Account controls sit at the inline end.

The catalog/order layout pairs flexible content with a 320px side column and a 32px gap. The basket sticks 24px below the viewport top. Catalog entries occupy two columns separated by 28px; row dividers and spacing distinguish products. Panels have 24px internal padding. Forms use two columns with an 18px gap; summaries use three columns with a 22px gap. Action rows wrap.

At widths up to 900px, navigation occupies its own full-width row, the side column becomes 280px, the layout gap becomes 24px and summaries use two columns. At widths up to 640px, the main inset becomes 18px with a 28px top margin, panels use 18px padding, and the content, catalog, forms and summaries become single column. The basket becomes static; heading, row and total flex layouts wrap.

Tables scroll inside a focusable labeled region. On mobile, the order-item table retains a 700px minimum width and keeps headings, action buttons and badges on one line; a Persian hint explains horizontal scrolling. Long money values have local overflow with a maximum height of 8em. Machine identifiers isolate LTR and wrap locally. Avoid page-wide overflow.

## Elevation & Depth

Normal work surfaces are flat: white fills, pale borders and paper surroundings provide separation. The current navigation item uses a small green underline implemented as a shadow. The modal dialog alone receives an ambient shadow (`0 18px 60px #152b2230`) and a translucent dark backdrop (`#17251f66`).

## Shapes

Panels and dialogs share gently rounded surface corners. Buttons use the control radius, fields a slightly smaller field radius, and status badges the compact badge radius. Borders are thin (1px); product and data rows use separators rather than individually elevated cards. The small outline bag SVG in the header is the shipped identity mark; it does not establish an additional icon set.

## Components

### Buttons

Primary buttons use dark green with white text and a matching border; hover deepens the fill. Quiet buttons retain the standard border over a transparent background and gain soft green on hover. Destructive quiet actions use error-colored text. Buttons and button links share the control radius and padding. Disabled buttons use opacity 0.55 and a waiting cursor. Link-style primary actions share the primary fill; their source CSS does not add the button-only hover rule.

All focus-visible elements receive a 3px amber outline with a 4px offset. Buttons and links transition background and text color over 0.15s ease-out only when reduced motion is not requested.

### Inputs / Fields

Inputs, selects and textareas are full-width white controls with a stronger border, inherited font and green caret. Labels are stacked above controls with a 5px gap. Textareas start at 95px and resize vertically. Quantity inputs are 72px wide, centered and LTR. Standard field controls use the shared keyboard outline; validation messages appear as text. Admin mutation dialogs include a labeled reason field where required by the implemented action.

### Cards / Containers

Panels use the surface radius, pale border and white fill without a shadow. Catalog entries remain divided rows within the grid. Empty states use centered muted text and 40px by 24px padding. Summary data uses definition lists with horizontal separators.

### Navigation

Navigation links are muted, unadorned text until current. `aria-current="page"` adds dark green, weight 750 and the underline. The header wraps at the intermediate breakpoint and navigation text reduces to 0.8rem on mobile. The visible-on-focus skip link leads to the main region.

### Status and notices

Badges use compact rounded rectangles, weight 600 and 0.78rem text. The view helper assigns warning treatment to pending, unknown, review, changed, expired and failure-like states; it supplies Persian state text. Notices announce via a polite live status region and offer a close action. Success, warning and error notices use their corresponding tonal fills and borders. Dialog errors use an alert region. Event summaries use translated text; expanded raw metadata remains isolated LTR.

### Dialogs and tables

Native modal dialogs use a width of `min(560px, calc(100vw - 32px))`, a maximum height of 90vh and 28px padding, reduced to 22px on mobile. Forms use an 18px gap; field groups use 16px. Tables retain semantic column headings, start-aligned cells and 13px by 16px cell padding. The local table region remains keyboard focusable.

## Do's and Don'ts

### Do:

- **Do** preserve Persian RTL reading and isolate LTR amounts and machine references.
- **Do** show state text alongside color and retain the visible rial unit.
- **Do** retain the shared visible keyboard outline, labeled fields and local table scrolling.
- **Do** use flat bordered work surfaces and the shipped responsive column changes.

### Don't:

- **Don't** turn pending or unknown money into visually confirmed success or failure.
- **Don't** convert exact monetary strings through JavaScript Number or silently display toman.
- **Don't** introduce a marketing, imagery or animation program into this deliberately simple operational interface.
- **Don't** compress the mobile order-item table until headings and actions become unreadable.
