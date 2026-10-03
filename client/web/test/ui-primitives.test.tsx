// @vitest-environment jsdom

import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "../src/components/ui/button.js";
import { Field } from "../src/components/ui/field.js";
import { Input } from "../src/components/ui/input.js";
import { StatusIcon } from "../src/components/ui/status-icon.js";
import { FormDialog } from "../src/feedback/components/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(element: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

describe("Button", () => {
  it("加载中显示加载圈、标记 aria-busy，点击不触发回调", async () => {
    const onClick = vi.fn();
    const node = await render(
      <Button loading onClick={onClick}>
        保存
      </Button>,
    );
    const button = node.querySelector("button");
    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(node.querySelector('[data-slot="spinner"]')).not.toBeNull();
    await act(async () => button?.click());
    expect(onClick).not.toHaveBeenCalled();
  });

  it("旧变体名仍然可用，主按钮标记 data-variant=primary", async () => {
    const node = await render(<Button variant="default">创建</Button>);
    expect(node.querySelector("button")?.getAttribute("data-variant")).toBe("primary");
  });

  it("带禁用原因的按钮在禁用与可用之间切换时，DOM 节点保持不变", async () => {
    function Toggle() {
      const [disabled, setDisabled] = useState(true);
      return (
        <>
          <Button disabled={disabled} disabledReason="项目已归档">
            新建需求
          </Button>
          <button type="button" data-testid="toggle" onClick={() => setDisabled(false)}>
            切换
          </button>
        </>
      );
    }
    const node = await render(<Toggle />);
    const before = node.querySelector<HTMLButtonElement>("span > button");
    expect(before?.disabled).toBe(true);
    await act(async () => node.querySelector<HTMLButtonElement>("[data-testid='toggle']")?.click());
    const after = node.querySelector<HTMLButtonElement>("span > button");
    expect(after).toBe(before);
    expect(after?.disabled).toBe(false);
  });
});

describe("Field", () => {
  it("把 id、说明与错误接到子控件上", async () => {
    const node = await render(
      <Field label="上下文上限" hint="单位为 token" error="请输入整数">
        <Input />
      </Field>,
    );
    const input = node.querySelector("input");
    const label = node.querySelector("label");
    expect(input?.id).not.toBe("");
    expect(label?.getAttribute("for")).toBe(input?.id);
    expect(input?.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input?.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(describedBy).toHaveLength(2);
    for (const id of describedBy) expect(document.getElementById(id)).not.toBeNull();
    expect(node.querySelector('[role="alert"]')?.textContent).toBe("请输入整数");
  });
});

describe("FormDialog", () => {
  it("有未保存内容时按 Esc 先询问，确认放弃后才关闭", async () => {
    const onOpenChange = vi.fn();
    await render(
      <FormDialog open title="新建需求" hasUnsavedChanges onOpenChange={onOpenChange}>
        <Input defaultValue="订单导出" />
      </FormDialog>,
    );
    const dialog = document.querySelector("[data-testid='form-dialog']");
    await act(async () => {
      dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    const discard = document.querySelector("[data-testid='form-dialog-discard']");
    expect(discard).not.toBeNull();
    const confirm = [...(discard?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "放弃");
    await act(async () => confirm?.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("StatusIcon", () => {
  it("每个状态都有可读名称，形状与颜色一起编码", async () => {
    const node = await render(
      <>
        <StatusIcon status="in_development" />
        <StatusIcon status="completed" />
      </>,
    );
    const icons = [...node.querySelectorAll("svg[role='img']")];
    expect(icons.map((icon) => icon.getAttribute("aria-label"))).toEqual(["开发中", "已完成"]);
    expect(icons[0]?.querySelector("path")).not.toBeNull();
  });
});

describe("cn 与自定义字号令牌", () => {
  it("主按钮同时保留文字颜色与字号，不会被 tailwind-merge 互相吞掉", async () => {
    const node = await render(<Button variant="primary">开始会话</Button>);
    const className = node.querySelector("button")?.className ?? "";
    expect(className).toContain("text-primary-foreground");
    expect(className).toContain("text-small");
  });
});
