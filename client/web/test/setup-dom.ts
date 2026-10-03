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
