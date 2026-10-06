import type { StartupView, SuDuoStartupBridge } from "../shared/ipc.js";

/** 启动页：按主进程发来的视图画进度、失败信息或需要选择的问题（文字与按钮都由主进程按语言填好）。 */
const bridge = (window as unknown as { suDuoStartup?: SuDuoStartupBridge }).suDuoStartup;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error("startup page is missing #" + id);
  return found as T;
}

const panel = document.querySelector<HTMLElement>(".panel");
const title = element("title");
const message = element("message");
const log = element("log");
const actions = element("actions");
const doctor = element("doctor");

function render(view: StartupView): void {
  document.documentElement.lang = view.locale;
  panel?.setAttribute("data-kind", view.kind);
  title.textContent = view.title;
  message.textContent = view.message;
  log.textContent = view.logHint ?? "";
  actions.replaceChildren(
    ...(view.actions ?? []).map((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.dataset["action"] = action.id;
      if (action.primary) button.className = "primary";
      button.disabled = action.disabled ?? false;
      button.addEventListener("click", () => bridge?.act(action.id));
      return button;
    }),
  );
  doctor.textContent = view.doctorOutput ?? "";
}

bridge?.onView(render);
