import { describe, expect, it } from "vitest";
import {
  clampLauncher,
  clampRect,
  DEFAULT_LAUNCHER_POSITION,
  defaultRect,
  FAN_ANCHOR_SLOT,
  fanSlot,
  fanVisibleCount,
  LAUNCHER_MARGIN,
  LAUNCHER_SIZE,
  launcherPoint,
  moveRect,
  parseLauncherPosition,
  parseRect,
  resizeRect,
  sideLayout,
  snapLauncher,
  WINDOW_EDGE,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
} from "../src/features/rooms/window/geometry.js";
import { quickAccessRooms } from "../src/features/rooms/model.js";
import { room } from "./fixtures/rooms.js";

const viewport = { width: 1440, height: 900 };
const start = { x: 600, y: 200, width: 440, height: 600 };

function inside(rect: { x: number; y: number; width: number; height: number }, view = viewport) {
  expect(rect.x).toBeGreaterThanOrEqual(WINDOW_EDGE);
  expect(rect.y).toBeGreaterThanOrEqual(WINDOW_EDGE);
  expect(rect.x + rect.width).toBeLessThanOrEqual(view.width - WINDOW_EDGE);
  expect(rect.y + rect.height).toBeLessThanOrEqual(view.height - WINDOW_EDGE);
}

describe("悬浮窗口几何：拖动", () => {
  it("平移跟手；拖出浏览器时停在四周 6px 处", () => {
    expect(moveRect(start, 30, -40, viewport)).toEqual({ ...start, x: 630, y: 160 });
    const farLeft = moveRect(start, -5000, -5000, viewport);
    expect(farLeft).toMatchObject({ x: WINDOW_EDGE, y: WINDOW_EDGE, width: 440, height: 600 });
    const farRight = moveRect(start, 5000, 5000, viewport);
    expect(farRight).toMatchObject({ x: 1440 - WINDOW_EDGE - 440, y: 900 - WINDOW_EDGE - 600 });
    inside(farRight);
  });

  it("浏览器变小：尺寸先收进来，再把位置推回可见范围", () => {
    const small = { width: 800, height: 500 };
    const clamped = clampRect({ x: 700, y: 400, width: 900, height: 700 }, small);
    expect(clamped).toEqual({ x: WINDOW_EDGE, y: WINDOW_EDGE, width: 800 - 2 * WINDOW_EDGE, height: 500 - 2 * WINDOW_EDGE });
    inside(clamped, small);
  });
});

describe("悬浮窗口几何：八向拉伸", () => {
  it("右下角：向外拉变大，对边不动；拉过浏览器就停在边上", () => {
    expect(resizeRect(start, "se", 100, 50, viewport)).toEqual({ x: 600, y: 200, width: 540, height: 650 });
    const huge = resizeRect(start, "se", 5000, 5000, viewport);
    expect(huge).toMatchObject({ x: 600, y: 200 });
    inside(huge);
  });

  it("左上角：拉动的是左边和上边，右下角固定", () => {
    const next = resizeRect(start, "nw", -100, -50, viewport);
    expect(next).toEqual({ x: 500, y: 150, width: 540, height: 650 });
    expect(next.x + next.width).toBe(start.x + start.width);
    expect(next.y + next.height).toBe(start.y + start.height);
  });

  it("不小于 360×420：往里推到底就停，对边仍不动", () => {
    const narrowed = resizeRect(start, "w", 5000, 0, viewport);
    expect(narrowed.width).toBe(WINDOW_MIN_WIDTH);
    expect(narrowed.x + narrowed.width).toBe(start.x + start.width);
    const shortened = resizeRect(start, "n", 0, 5000, viewport);
    expect(shortened.height).toBe(WINDOW_MIN_HEIGHT);
    expect(shortened.y + shortened.height).toBe(start.y + start.height);
    expect(resizeRect(start, "e", -5000, 0, viewport).width).toBe(WINDOW_MIN_WIDTH);
    expect(resizeRect(start, "s", 0, -5000, viewport).height).toBe(WINDOW_MIN_HEIGHT);
  });

  it("单边只改一个方向；左 / 上边拉出浏览器时停在 6px", () => {
    expect(resizeRect(start, "e", 40, 999, viewport)).toEqual({ ...start, width: 480 });
    expect(resizeRect(start, "s", 999, 40, viewport)).toEqual({ ...start, height: 640 });
    const left = resizeRect(start, "w", -5000, 0, viewport);
    expect(left.x).toBe(WINDOW_EDGE);
    expect(left.x + left.width).toBe(start.x + start.width);
    const top = resizeRect(start, "ne", 0, -5000, viewport);
    expect(top.y).toBe(WINDOW_EDGE);
    inside(top);
  });
});

describe("悬浮窗口几何：默认位置与记忆", () => {
  it("第一次打开在入口那一侧的下方，给入口留出一列，不出浏览器", () => {
    const right = defaultRect(viewport, "right");
    inside(right);
    expect(right.x + right.width).toBeLessThanOrEqual(viewport.width - LAUNCHER_MARGIN - LAUNCHER_SIZE);
    const left = defaultRect(viewport, "left");
    inside(left);
    expect(left.x).toBeGreaterThanOrEqual(LAUNCHER_MARGIN + LAUNCHER_SIZE);
  });

  it("读回的记录：字段不全、不是数字、尺寸非正都当没记过", () => {
    expect(parseRect({ x: 1, y: 2, width: 400, height: 500 })).toEqual({ x: 1, y: 2, width: 400, height: 500 });
    expect(parseRect({ x: 1, y: 2, width: 400 })).toBeNull();
    expect(parseRect({ x: "1", y: 2, width: 400, height: 500 })).toBeNull();
    expect(parseRect({ x: 1, y: 2, width: 0, height: 500 })).toBeNull();
    expect(parseRect(null)).toBeNull();
    expect(parseRect("oops")).toBeNull();
  });
});

describe("窗口右侧话题栏", () => {
  it("够宽并排（宽度限制在 280 到「留给消息流 280」之间），太窄盖住整个窗口", () => {
    expect(sideLayout(360, 900)).toEqual({ mode: "split", width: 360, max: 620 });
    expect(sideLayout(100, 900)).toMatchObject({ mode: "split", width: 280 });
    expect(sideLayout(800, 900)).toMatchObject({ mode: "split", width: 620 });
    expect(sideLayout(360, 500)).toEqual({ mode: "cover" });
    // 还没量到宽度：先按分栏给
    expect(sideLayout(360, 0)).toMatchObject({ mode: "split", width: 360 });
    expect(sideLayout(Number.NaN, 900)).toMatchObject({ mode: "split", width: 360 });
  });
});

describe("悬浮入口：吸附与位置", () => {
  it("松手按中心落在哪半边吸附到左 / 右，高度就地保留", () => {
    expect(snapLauncher({ x: 100, y: 500 }, viewport)).toEqual({ side: "left", bottom: 900 - 500 - LAUNCHER_SIZE });
    expect(snapLauncher({ x: 1000, y: 500 }, viewport)).toEqual({ side: "right", bottom: 352 });
    // 正中线偏左一点也算左边
    expect(snapLauncher({ x: 720 - LAUNCHER_SIZE / 2 - 1, y: 600 }, viewport).side).toBe("left");
  });

  it("高度不贴底、也不高到扇形排不开", () => {
    expect(snapLauncher({ x: 1000, y: 899 }, viewport).bottom).toBe(12);
    const top = snapLauncher({ x: 1000, y: 0 }, viewport);
    expect(top.bottom).toBeLessThanOrEqual(900 - LAUNCHER_SIZE - 320);
    expect(clampLauncher({ side: "right", bottom: -10 }, viewport).bottom).toBe(12);
  });

  it("停靠坐标：右边离右缘 20、左边离左缘 20", () => {
    expect(launcherPoint(DEFAULT_LAUNCHER_POSITION, viewport)).toEqual({ x: 1440 - 20 - 48, y: 900 - 120 - 48 });
    expect(launcherPoint({ side: "left", bottom: 120 }, viewport).x).toBe(20);
  });

  it("读回的位置：边只认 left / right，高度要是数字", () => {
    expect(parseLauncherPosition({ side: "left", bottom: 80 })).toEqual({ side: "left", bottom: 80 });
    expect(parseLauncherPosition({ side: "top", bottom: 80 })).toBeNull();
    expect(parseLauncherPosition({ side: "left" })).toBeNull();
  });
});

describe("扇形叠放", () => {
  it("一屏最多 8 个；入口上方空间不够时少排几个", () => {
    expect(fanVisibleCount(viewport, DEFAULT_LAUNCHER_POSITION)).toBe(8);
    expect(fanVisibleCount({ width: 1440, height: 480 }, DEFAULT_LAUNCHER_POSITION)).toBe(5);
    expect(fanVisibleCount({ width: 1440, height: 240 }, { side: "right", bottom: 12 })).toBe(2);
  });

  it("沿弧线往上：越远越高、越往里侧偏、越小越淡", () => {
    const slots = [1, 2, 3, 4, 5, 6, 7, 8].map((depth) => fanSlot(depth, 8));
    for (let index = 1; index < slots.length; index += 1) {
      const near = slots[index - 1]!;
      const far = slots[index]!;
      expect(far.y).toBeLessThan(near.y);
      expect(far.inset).toBeGreaterThan(near.inset);
      expect(far.scale).toBeLessThan(near.scale);
      expect(far.opacity).toBeLessThan(near.opacity);
    }
    // 「全部讨论…」紧挨按钮、不缩不淡；房间滚到它的位置之前就消失，不叠在它上面
    expect(FAN_ANCHOR_SLOT).toMatchObject({ inset: 0, scale: 1, opacity: 1 });
    expect(FAN_ANCHOR_SLOT.y).toBeGreaterThan(fanSlot(1, 8).y);
    expect(fanSlot(0, 8).opacity).toBe(0);
    expect(fanSlot(0.3, 8).opacity).toBe(0);
  });

  it("滚出一屏的两端渐隐；那一端还有更多时最外一格先淡一点", () => {
    expect(fanSlot(9, 8).opacity).toBe(0);
    expect(fanSlot(8.5, 8).opacity).toBeGreaterThan(0);
    expect(fanSlot(8.5, 8).opacity).toBeLessThan(fanSlot(8, 8).opacity);
    expect(fanSlot(0.5, 8).opacity).toBeLessThan(fanSlot(1, 8).opacity);
    expect(fanSlot(8, 8, { fadeNear: false, fadeFar: true }).opacity).toBeLessThan(fanSlot(8, 8).opacity);
    expect(fanSlot(1, 8, { fadeNear: true, fadeFar: false }).opacity).toBeLessThan(fanSlot(1, 8).opacity);
  });
});

describe("快捷入口里的房间顺序", () => {
  it("只列未归档：@ 我 > 有未读 > 最近消息", () => {
    const at = (iso: string) => ({ seq: 1, authorName: "小王", preview: "…", createdAt: iso });
    const ordered = quickAccessRooms([
      room({ id: "quiet-new", lastMessage: at("2026-09-30T12:00:00.000Z") }),
      room({ id: "quiet-old", lastMessage: at("2026-09-29T12:00:00.000Z") }),
      room({ id: "unread-old", lastMessage: at("2026-09-28T12:00:00.000Z"), viewer: { joined: true, lastReadSeq: 0, unreadCount: 2, mentionCount: 0 } }),
      room({ id: "mention", lastMessage: at("2026-09-27T12:00:00.000Z"), viewer: { joined: true, lastReadSeq: 0, unreadCount: 1, mentionCount: 1 } }),
      room({ id: "unread-new", lastMessage: at("2026-09-30T13:00:00.000Z"), viewer: { joined: true, lastReadSeq: 0, unreadCount: 5, mentionCount: 0 } }),
      room({ id: "archived", archivedAt: "2026-09-30T00:00:00.000Z", viewer: { joined: true, lastReadSeq: 0, unreadCount: 9, mentionCount: 9 } }),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["mention", "unread-new", "unread-old", "quiet-new", "quiet-old"]);
  });
});
