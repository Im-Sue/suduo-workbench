import {
  formatDoctorText,
  type DoctorResult,
} from "../doctor/doctor-service.js";

export const DOCTOR_PAGE_SCRIPT = String.raw`
const button = document.querySelector("[data-copy-diagnostics]");
const source = document.querySelector("[data-diagnostics]");
const status = document.querySelector("[data-copy-status]");
button?.addEventListener("click", async () => {
  const text = source?.textContent ?? "";
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = "诊断信息已复制";
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    status.textContent = "诊断信息已复制";
  }
});
`;

export function renderDoctorPage(result: DoctorResult): string {
  const diagnostics = formatDoctorText(result);
  const cards = result.checks
    .map(
      (check) => `
        <article class="check ${check.status}">
          <span class="mark">${check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "×"}</span>
          <div><h2>${escapeHtml(check.name)}</h2><p>${escapeHtml(check.message)}</p>${check.remediation ? `<p>官方修复建议：${escapeHtml(check.remediation)}</p>` : ""}</div>
        </article>`,
    )
    .join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#0b1020">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>SuDuo 自检</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,"Microsoft YaHei",sans-serif;background:#0b1020;color:#e8edf7}
    body{margin:0;padding:32px;background:radial-gradient(circle at top,#17213d,#0b1020 58%);min-height:100vh;box-sizing:border-box}
    main{max-width:880px;margin:auto}.eyebrow{color:#75a7ff;font-size:12px;letter-spacing:.16em}h1{font-size:34px;margin:8px 0}.summary{color:#aebbd3;margin-bottom:24px}
    .badge{display:inline-block;padding:5px 10px;border-radius:999px;font-weight:700}.badge.pass{background:#143d31;color:#7de7bd}.badge.fail{background:#4a2029;color:#ff9aaa}
    .checks{display:grid;gap:12px;margin:24px 0}.check{display:flex;gap:14px;padding:16px;border:1px solid #283656;border-radius:14px;background:#11192c}.mark{font-size:24px}.pass .mark{color:#62d9ad}.warn .mark{color:#f4ca64}.fail .mark{color:#ff7b91}
    h2{font-size:16px;margin:0 0 6px}p{margin:0;color:#b9c5d9;line-height:1.5}button{border:0;border-radius:10px;background:#2f6fed;color:white;padding:10px 16px;font-weight:700;cursor:pointer}pre{white-space:pre-wrap;background:#080d19;border:1px solid #283656;border-radius:12px;padding:16px;color:#aebbd3;overflow:auto}.copy-status{margin-left:10px;color:#7de7bd}
  </style>
</head>
<body><main>
  <span class="eyebrow">LOCAL SUDUO DOCTOR</span>
  <h1>本机环境自检</h1>
  <p class="summary"><span class="badge ${result.status.toLowerCase()}">${result.status}</span> · 检查时间 ${escapeHtml(result.checkedAt)}</p>
  <section class="checks">${cards}</section>
  <button type="button" data-copy-diagnostics>复制诊断信息</button><span class="copy-status" data-copy-status aria-live="polite"></span>
  <pre data-diagnostics>${escapeHtml(diagnostics)}</pre>
</main><script src="/doctor/client.js"></script></body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[character] ?? character;
  });
}
