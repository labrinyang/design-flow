export const TEMPLATE = (feature: string, schemaUrl: string) => `# yaml-language-server: $schema=${schemaUrl}
# Design Flow spec for "${feature}". Every screen, branch, error and way back goes here.
# The screens themselves are in prototype.html, one <section data-screen="ID"> each, in the product's own style.
# Check both with: design-flow check ${feature}
version: 1
title: ${feature}
subtitle: Describe the device and viewpoint, e.g. "Cashier view · portrait"
viewport: { width: 390, height: 844 } # CSS px of one screen; a screen can override it
lanes:
  - id: main
    title: Main flow
    tone: info
  - id: errors
    title: Errors and interruptions
    tone: danger
    enter: any # reachable from any step; no edges needed into this lane
screens:
  - id: H00
    title: Home
  - id: M01
    lane: main
    title: First step
  - id: X01
    lane: errors
    title: Timed out
    badges: [home]
    note: No input for 60 s
edges:
  - { from: H00, to: M01, label: Start }
  - { from: X01, to: H00, kind: back }
notes:
  - Global rules that apply to every screen go here.
`;

export const PROTOTYPE = (feature: string) => `<!doctype html>
<!-- The screens of "${feature}" as one working page. One <section data-screen="ID"> per screen in flow.yaml.
     data-to="ID" goes to another screen, data-back to the one before. Play on the canvas runs this page.
     Screens run sandboxed with no network: inline styles, fonts and images. -->
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; font: 16px/1.45 system-ui, sans-serif; }
  [data-screen] { height: 100vh; box-sizing: border-box; padding: 32px 24px; display: flex; flex-direction: column; gap: 12px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  .btn { display: block; width: 100%; padding: 14px; border: 0; border-radius: 12px; font: inherit; }
  .btn.primary { background: #111; color: #fff; }
  .spacer { flex: 1; }
</style>
</head>
<body>
<section data-screen="H00">
  <h1>Welcome</h1>
  <div class="spacer"></div>
  <button class="btn primary" data-id="start" data-to="M01">Start</button>
</section>

<section data-screen="M01">
  <a data-back>‹ Back</a>
  <h1>First step</h1>
  <input data-id="field" placeholder="Something to enter" style="padding:12px;font:inherit">
  <div class="spacer"></div>
  <button class="btn primary" data-id="continue">Continue</button>
</section>

<section data-screen="X01">
  <h1>Timed out</h1>
  <p>Returning to the start in 5 s.</p>
  <div class="spacer"></div>
  <button class="btn" data-id="home" data-to="H00">Back to start</button>
</section>
</body>
</html>
`;
