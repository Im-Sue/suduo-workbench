/**
 * 本机服务的输出里只把警告和错误打到控制台，其余写进日志文件（`pnpm start` 用）。
 * 单独成文件，是为了能被测试导入（start.mjs 一加载就会运行）。
 */
export function importantLine(line) {
  if (line.trim() === "") return null;
  try {
    const record = JSON.parse(line);
    if (typeof record.level === "number" && record.level >= 40) return String(record.msg ?? line);
    return null;
  } catch {
    // 本机服务自己在启动早期写的提醒都以「SuDuo: 」开头，按系统语言输出，不靠文字匹配，一律显示（S8）。
    if (line.startsWith("SuDuo: ")) return line;
    // 其余非 JSON 的行（启动报错、第三方输出）可能是中文也可能是英文，两种都认；这是匹配不是输出，不进消息表。
    return /error|错误|失败|warn|不存在|doesn't exist|not found|failed/i.test(line) ? line : null;
  }
}
