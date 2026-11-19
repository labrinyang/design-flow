export type Locale = "en" | "zh";

/** Browser language, unless the URL says ?lang=en|zh. */
export function pickLocale(language: string, search: string): Locale {
  const forced = new URLSearchParams(search).get("lang");
  if (forced === "en" || forced === "zh") return forced;
  return language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export const locale: Locale = typeof location !== "undefined" ? pickLocale(navigator.language, location.search) : "en";
if (typeof document !== "undefined") document.documentElement.lang = locale;

const en = {
  appName: "Design Flow",
  projects: "Projects",
  noProjects: "No projects yet. Run design-flow open <feature> in a project.",
  noFeatures: "No features in this project.",
  openThreads: (n: number) => `${n} open`,
  status: { draft: "Draft", approved: "Approved", stale: "Changed since approval" },
  waiting: "Waiting for your approval",
  approve: "Approve",
  approveTitle: "Approve this flow?",
  approveBody: (n: number) =>
    n === 0
      ? "The agent will be told it can start coding this feature. Changing flow.yaml later withdraws the approval."
      : `${n} comment thread${n === 1 ? " is" : "s are"} still open. The agent will be told it can start coding this feature. Changing flow.yaml later withdraws the approval.`,
  cancel: "Cancel",
  approveChanged: "flow.yaml changed or has problems since this canvas was drawn. Review the current version, then approve again.",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  fit: "Fit to window",
  relayout: "Re-layout",
  exportPng: "Export PNG",
  exportWithComments: "Include comments",
  comment: "Comment",
  commentHint: "Click a block, screen, edge, lane or empty canvas to comment. Esc to stop.",
  comments: "Comments",
  noComments: "No comments yet. Press C, then click anywhere on the canvas.",
  orphaned: "Lost their anchor",
  resolved: "Resolved",
  reply: "Reply",
  send: "Send",
  writeComment: "Write a comment",
  resolve: "Resolve",
  reopen: "Reopen",
  agent: "Agent",
  you: "You",
  close: "Close",
  issuesTitle: (n: number) => `flow.yaml has ${n} problem${n === 1 ? "" : "s"}; showing the last valid version`,
  noValidFlow: "flow.yaml has no valid version yet.",
  notes: "Notes",
  legend: "Legend",
  enterAny: "Reachable from any step",
  badge: { home: "↩ Home", video: "▶ Animated", timer: "⏱ Countdown" },
  disconnected: "Disconnected from the design-flow server. Reconnecting…",
  back: "All features",
  more: (n: number) => `+${n}`,
};

const zh: typeof en = {
  appName: "Design Flow",
  projects: "项目",
  noProjects: "还没有项目。在项目里运行 design-flow open <feature>。",
  noFeatures: "这个项目里还没有功能。",
  openThreads: (n) => `${n} 条未解决`,
  status: { draft: "草稿", approved: "已批准", stale: "批准后已修改" },
  waiting: "等你批准",
  approve: "批准",
  approveTitle: "批准这张流程图？",
  approveBody: (n) =>
    n === 0
      ? "会通知 agent 可以开始写这个功能的代码。之后 flow.yaml 再改，批准自动失效。"
      : `还有 ${n} 条批注未解决。会通知 agent 可以开始写这个功能的代码。之后 flow.yaml 再改，批准自动失效。`,
  cancel: "取消",
  approveChanged: "画布绘制之后 flow.yaml 已改动或有问题。请先看当前版本，再批准。",
  zoomIn: "放大",
  zoomOut: "缩小",
  fit: "适应窗口",
  relayout: "重排",
  exportPng: "导出 PNG",
  exportWithComments: "包含批注",
  comment: "批注",
  commentHint: "点击块、帧、连线、泳道或空白处来批注。按 Esc 退出。",
  comments: "批注",
  noComments: "还没有批注。按 C，然后点击画布上任意位置。",
  orphaned: "失去锚点",
  resolved: "已解决",
  reply: "回复",
  send: "发送",
  writeComment: "写批注",
  resolve: "解决",
  reopen: "重新打开",
  agent: "Agent",
  you: "你",
  close: "关闭",
  issuesTitle: (n) => `flow.yaml 有 ${n} 个问题，显示的是上一个有效版本`,
  noValidFlow: "flow.yaml 还没有有效版本。",
  notes: "说明",
  legend: "图例",
  enterAny: "可从任意步骤进入",
  badge: { home: "↩ 回首页", video: "▶ 动画页", timer: "⏱ 倒计时" },
  disconnected: "与 design-flow 服务断开，正在重连…",
  back: "全部功能",
  more: (n) => `+${n}`,
};

export const t = locale === "zh" ? zh : en;
