/**
 * 测试默认语言固定为 zh-CN（中英双语技术设计 §五）：jsdom 与 Node 的 navigator.language 默认是英文，
 * 不固定的话界面语言会跟着测试环境走，现有中文断言会大面积失效或悄悄变成反向断言。
 * 英文专属的测试自己调用 applyLocalePreference("en")。
 */
if (typeof navigator !== "undefined") {
  Object.defineProperty(navigator, "language", { value: "zh-CN", configurable: true });
  Object.defineProperty(navigator, "languages", { value: ["zh-CN", "zh"], configurable: true });
}

/**
 * jsdom 没有 ResizeObserver：可拖拽面板（react-resizable-panels）、Radix 的尺寸测量都要用。
 * 只在 DOM 环境且缺失时补一个空实现；node 环境的纯逻辑测试不受影响。
 */
if (typeof window !== "undefined" && typeof window.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  globalThis.ResizeObserver = window.ResizeObserver;
}
