import type { StartupView, SuDuoStartupBridge } from "../shared/ipc.js";

/** 启动页：按主进程发来的视图画进度或失败信息（文字已按语言填好）。 */
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
const retry = element<HTMLButtonElement>("retry");
const openLogs = element<HTMLButtonElement>("open-logs");
const runDoctor = element<HTMLButtonElement>("run-doctor");
const doctor = element("doctor");

function render(view: StartupView): void {
  document.documentElement.lang = view.locale;
  panel?.setAttribute("data-kind", view.kind);
  title.textContent = view.title;
  message.textContent = view.message;
  log.textContent = view.logHint ?? "";
  if (view.actions) {
    retry.textContent = view.actions.retry;
    openLogs.textContent = view.actions.openLogs;
    runDoctor.textContent = view.actions.runDoctor;
  }
  runDoctor.disabled = view.doctor?.running ?? false;
  if (view.doctor?.running) runDoctor.textContent = view.doctor.label;
  doctor.textContent = view.doctor?.output ?? "";
}

retry.addEventListener("click", () => bridge?.retry());
openLogs.addEventListener("click", () => bridge?.openLogs());
runDoctor.addEventListener("click", () => bridge?.runDoctor());
bridge?.onView(render);
