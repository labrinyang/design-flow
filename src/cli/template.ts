export const TEMPLATE = (feature: string, schemaUrl: string) => `# yaml-language-server: $schema=${schemaUrl}
# Design Flow spec for "${feature}". Every screen, branch, error and way back goes here.
# Each screen is HTML you write in the product's own style. Check it with: design-flow check ${feature}
version: 1
title: ${feature}
subtitle: Describe the device and viewpoint, e.g. "Cashier view · portrait"
viewport: { width: 390, height: 844 } # CSS px of one screen; a screen can override it
# Shared <head> for every screen: your styles, fonts as data: URLs, design tokens.
# Screens run sandboxed with no network, so inline everything.
style: |
  <style>
    body { font: 16px/1.45 system-ui, sans-serif; padding: 32px 24px; }
    h1 { font-size: 26px; margin: 0 0 16px; }
    .btn { display: block; width: 100%; padding: 14px; border: 0; border-radius: 12px; font: inherit; }
    .btn.primary { background: #111; color: #fff; }
  </style>
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
    html: |
      <h1>Welcome</h1>
      <button class="btn primary" data-id="start">Start</button>
  - id: M01
    lane: main
    title: First step
    html: |
      <h1>First step</h1>
      <input placeholder="Something to enter" style="width:100%;padding:12px;font:inherit">
      <p></p>
      <button class="btn primary" data-id="continue">Continue</button>
  - id: X01
    lane: errors
    title: Timed out
    badges: [home]
    note: No input for 60 s
    html: |
      <h1>Timed out</h1>
      <p>Returning to the start in 5 s.</p>
edges:
  - { from: H00, to: M01, label: Start }
  - { from: X01, to: H00, kind: back }
notes:
  - Global rules that apply to every screen go here.
`;
