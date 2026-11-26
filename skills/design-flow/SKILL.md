---
name: design-flow
description: Use before writing code for any feature that has screens or a multi-step user flow (sign-up, onboarding, checkout, settings, a wizard, error and retry paths), or when the user asks for a UX flow, user flow or flow chart. Draws every screen and arrow on an infinite canvas in the browser; the user comments on it and approves before you code.
---

# Design Flow

Before you write code for a feature with screens, write its UX flow as `.design-flow/<feature>/flow.yaml`, open it on the canvas, and wait for the user's approval. The canvas shows every screen, branch, error and way back; the user comments on it, and you change the spec until they approve.

## The command

Every command below is this skill's own launcher. Resolve `scripts/design-flow.mjs` relative to this file's directory to an absolute path and run it with Node 20+; nothing needs installing. In this document `design-flow` means:

```bash
node <this skill's directory>/scripts/design-flow.mjs
```

Run it from the project root (or pass `--project-dir <path>`). One local server on port 27420 serves every project; `open` starts it when needed. In Claude Code, the folder of each command you run is tied to your session, so comments on a canvas in another folder reach you as they do for one in your own.

## Workflow

1. Pick a feature name: lowercase letters, digits, hyphens (`checkout`, `sign-up`).
2. Run `design-flow open <feature>`. It creates a commented template if the file is missing, starts the local server, opens the browser and prints the canvas URL and the check result.
3. Start `design-flow watch` as a **background** task that hands you each line as it is printed (in Claude Code, the Monitor tool; a background shell reports only when it exits). It prints one `[design-flow]` line per new comment or approval, so feedback reaches you without the user typing it; comments left close together arrive together, two seconds after the first. A line only rings the bell: a comment counts as read once `design-flow comments` has shown it to you, and the canvas tells the user whether you have. One watch runs per session: if one already does (the Claude Code plugin starts it), a second says so and ends. If you cannot run background tasks, run `design-flow comments <feature> --unread` whenever the user says they commented.
4. Write `flow.yaml` (the map: lanes, screens, arrows) and `prototype.html` (the screens themselves, as one working page). References below. Draw **every** screen, every branch, every error and interruption, and every way back. A missing line is the most common review comment.
5. Run `design-flow check <feature>`. It checks both files against each other. Fix every issue it prints (file:line:col and a fix). The canvas keeps showing the last valid version while the file is broken.
6. Look at what you drew before the user does: `design-flow check <feature> --visual`, and `design-flow shot` for any screen you are unsure of (see **Seeing the screens**). Fix what they show.
7. Tell the user, in one line, that the canvas is ready, with the URL `open` printed, and that they can press **C** to comment and **Approve** when it is right. Then wait. To send the user to one screen or thread, now or later, add `#screen=<id>` or `#thread=<id>` to that URL.
8. For each comment:
   - run `design-flow comments <feature> --shots` to read the thread, where it is anchored (an element comment names its `prototype.html` line), and a shot of its screen with that element ringed,
   - decide how to answer it (see **Answering a comment**), change `flow.yaml` and `prototype.html` as that calls for, run `check`,
   - `design-flow reply <feature> <thread> --text "<what you changed>"`, with options when the answer calls for them,
   - `design-flow resolve <feature> <thread>` when it is settled. It refuses while the thread holds a message you have not read, and shows it to you.

   A pick arrives like any reply, as `picked B: <the option>`. Apply it, reply with what changed, resolve.
9. **Do not write code for this feature until `design-flow status <feature>` prints `approved`.** Approval arrives as a `[design-flow] … APPROVED` line. Changing `flow.yaml` after approval makes it `stale`; ask for approval again.
10. Build from the approved flow. Screen ids (`P03`) are the names to use when you talk about screens.

Do not edit `comments.json`, `approval.json` or `.last-valid.yaml`; the tool owns them. Approval covers `flow.yaml` and `prototype.html` together: changing either makes it `stale`.

## Answering a comment

Decide by who holds what the choice depends on:

1. **Just do it.** The comment, the user's earlier answers, the existing screens or plain facts settle it. Make the change and reply with what changed in a sentence or two. Most comments are this.
2. **Do it, and offer the other way.** You would choose one way, but someone with the user's taste could reasonably choose another, and the two look different on the canvas. Apply yours, then reply with both, yours marked applied: `--option "<yours>" --option "<the other>" --applied A`. Say in the text when the other is better. The user switches with one click, or does nothing.
3. **Ask.** The choice turns on something only the user knows (a business rule, a priority, a preference they have not stated), or it would be costly to undo. Change nothing; reply with two or three options and your recommendation: `--option "…" --option "…" --recommend A`, with what each trades in the text.

Always recommend one, when you ask too. Options must differ in what the user would see or do; details you can settle yourself (spacing, wording, which icon) are yours to decide. Give two to four, best two or three, each a short label. If you offer options on most comments, you are asking about what case 1 covers. If the user often picks the option you did not recommend, your sense of their taste is off: where you would have just done it, offer the other way too.

You can ask before the user comments, too. When a screen you are drawing turns on something only the user knows, ask on the canvas where it applies instead of in the chat: `design-flow ask <feature> <screen> --text "…" [--element <selector>] --option "…" --option "…" --recommend A`. The same rule as options holds: ask only what depends on information the user has, and always with a recommendation. The answer arrives like a reply.

## Seeing the screens

You write HTML without seeing it; these commands show you what the canvas shows the user. They render in headless Chrome, Chromium, Edge or Brave, whichever is installed; set `DESIGN_FLOW_CHROME` to a browser's executable to choose.

- `design-flow check <feature> --visual` renders every screen and adds what looks broken to check's issues: content wider than the screen, text cut off by overflow or an ellipsis, and text over other text. Run it before you tell the user the canvas is ready, and after larger changes.
- `design-flow shot <feature> <screen>` writes a PNG of the screen at its viewport, at 2× (`--scale 1` for 1×), into the temp directory, and prints its path; open it to look. `--element <selector>` shoots one element.
- For several screens, name them all in one command (`design-flow shot <feature> P03 P07 P12`), add a lane's screens with `--lane <lane>`, or take every screen with `--all`; one browser renders them all. `--sheet` puts them on labelled overview images, up to ten phone screens or four wider ones on each, prints those, and leaves each screen's own PNG in the temp directory. Compare screens on a sheet; open a screen's own PNG to read small text. Don't write scripts to shoot, tile or compare screens: these commands do it.
- `design-flow comments <feature> --shots` gives each thread on a screen a shot of that screen with the commented element ringed, and a sheet of them all when there are several.
- `design-flow outline <feature>` lists the flow as text, without rendering: screens, edges, and which screens have open or unread threads. Use it to find your way in a long flow.
- `design-flow outline <feature> <screen>` prints the rendered element tree: a ref (`e12`), the tag, its text, its box, the selector a comment on it would carry, and its line in `prototype.html`. Use it to find the element a comment is about and the line to change. `--element` takes a ref as well as a selector.

## prototype.html

Write the screens as **one interactive page** next to `flow.yaml`: `.design-flow/<feature>/prototype.html`. The canvas shows each screen's section in its own frame; **Play** (top right of the canvas) runs the whole page as a clickable demo, so the user can walk the flow before any code exists.

```html
<!doctype html>
<html>
<head>
  <style> /* your product's styles: tokens, components, type */ </style>
  <script> window.app = { email: "" }; /* state shared by every screen */ </script>
</head>
<body>
  <section data-screen="W00">
    <h1>Notes that keep up with you</h1>
    <button class="btn main" data-id="create" data-to="S01">Create account</button>
  </section>
  <section data-screen="S01">
    <a data-back>‹ Back</a>
    <input data-id="email" placeholder="you@example.com">
    <button class="btn main" data-id="continue" data-to="S02">Continue</button>
  </section>
  <!-- one <section data-screen="ID"> per screen in flow.yaml -->
</body>
</html>
```

- One `<section data-screen="ID">` per screen, with the ids from `flow.yaml`. Play shows one at a time, full height of the viewport, so give sections `height: 100vh` if they lay out as a column.
- `data-to="ID"` on anything the user taps to go to another screen; `data-back` goes to the screen before. Play follows them; scripts in `<head>` keep state across screens.
- Every `data-to` needs an arrow in `flow.yaml` (`check` lists the ones missing), and every arrow you draw should have something that triggers it.
- A screen can still use `html:` or `file:` in `flow.yaml` instead; it then has no section here.

## flow.yaml reference

`flow.yaml` is the map: lanes, screens with titles and notes, and the arrows between them. Each screen is **HTML you write in the product's own style**: its colors, type, components and copy, in `prototype.html` (above) or inline here with `html:`. The canvas draws it inside a sandboxed frame at the screen's viewport size; it does not impose a design system. Shared styles go in `prototype.html`'s `<head>`, or in `style` once.

```yaml
version: 1
title: Checkout
subtitle: Cashier tablet · portrait
viewport: { width: 360, height: 720 } # CSS px of one screen; any screen can override it
style: | # placed in every screen's <head>; inline only (no network)
  <style>
    body { margin: 0; font: 15px system-ui; color: #17352c; }
    .btn { padding: 14px; border-radius: 999px; border: 0; }
    .btn.pay { background: #346cc4; color: #fff; }
  </style>
lanes: # rows, top to bottom
  - id: checkout
    title: Checkout
    tone: info # success | info | danger | neutral: colors the lane and its arrows on the canvas
  - id: errors
    title: Errors and interruptions
    tone: danger
    enter: any # reachable from any step: no edges needed into it; screens tile left to right
    note: One line shown at the bottom of the lane
screens:
  - id: H00 # unique; shown as the screen's number
    title: Home # no lane: the entry column on the far left
    html: |
      <h1>Welcome</h1>
      <button class="btn pay" data-id="charge">Charge</button>
  - id: P01
    lane: checkout
    title: Enter amount
    file: screens/p01.html # or keep the HTML in a file next to flow.yaml
  - id: X04
    lane: errors
    title: Timed out
    badges: [home] # home (↩ Home) | video (▶ animated page) | timer (countdown)
    note: No valid input in 60 s → retry
    html: <h1>Timed out</h1><p>Back to Home in 5 s</p>
edges:
  - { from: H00, to: P01, label: Charge } # label = the user's action or the trigger
  - { from: P01, to: X04, label: Timeout, kind: error } # error: red
  - { from: X04, to: H00, kind: back } # back: dashed, ignored by layout
notes:
  - Global rules: idle timeouts, footers, locale, anything true of every screen.
```

Screen HTML rules:

- Draw the real screen at the viewport size: real copy, real states (empty, loading, error), the one primary action. Use the project's existing design system, tokens and component styles when it has them; otherwise choose a style and keep it consistent across screens.
- Frames are sandboxed: scripts run, but there is no network, no `fetch`, no external fonts or images. Inline images as `data:` URLs or draw placeholders in CSS.
- Put `data-id="…"` on the elements people will talk about (buttons, fields, list items). Comments on them are anchored by that id, so they survive edits; without it they anchor by position.
- A comment on an element arrives as `Screen P02 Choose payment · button "Bank card" ([data-id="card"])`.

Layout is automatic: lanes are rows, the flow runs left to right, branches of one step stack in one column. Never compute coordinates.

## Commands

| Command | Does |
| --- | --- |
| `design-flow open <feature> [--no-open]` | Start server, create template, open canvas |
| `design-flow check <feature> [--visual]` | Validate; exit 0 clean, 3 issues; `--visual` renders every screen and adds overflow, cut-off and overlapping text |
| `design-flow shot <feature> <screen>… [--lane <lane>]… [--sheet] [--element <selector>] [--scale 1\|2] [--out <file>] [--dir <dir>]` | PNGs of screens or one element, in the temp directory unless `--out` or `--dir`; several screens render in one browser; `--sheet` puts them on labelled overview images; `shot <feature> --all` for every screen |
| `design-flow outline <feature> [<screen>] [--json]` | The flow as text; with a screen, its rendered element tree with refs, boxes, selectors and lines |
| `design-flow comments <feature> [--unread] [--json] [--shots]` | Threads with anchors; what it shows counts as read; `--shots` adds each commented screen with its element ringed |
| `design-flow reply <feature> <thread> --text "…" [--option "…"]… [--recommend A] [--applied A]` | Reply as the agent, with options the user picks with one click |
| `design-flow ask <feature> <screen> --text "…" [--element <selector>] [--option "…"]… [--recommend A] [--applied A]` | Start a thread on the canvas, on a screen or one of its elements |
| `design-flow resolve <feature> <thread>` | Resolve a thread you have read to the end |
| `design-flow status <feature>` | `draft`, `approved` or `stale`, open and unread threads |
| `design-flow list` | Features in this project |
