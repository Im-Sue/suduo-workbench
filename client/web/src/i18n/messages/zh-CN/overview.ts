import type { AuditAction } from "@suduo/cloud-contracts";

/** 「更新了 3 条记录」：最近动态里同一人相邻的同类操作归成一组时的一句话。 */
const records = (verb: string) => (count: number) => `${verb} ${String(count)} 条记录`;

/** 项目概览（需求 §4.6）：状态分布、流转趋势、停滞需求、最近动态。 */
export const overview = {
  header: {
    title: "概览",
    intro: (project: string | null) => `${project ?? "当前项目"}的需求分布、流转和停滞情况。`,
    realtime: {
      live: "实时更新中",
      reconnecting: "实时更新已断开，正在重连…",
      connecting: "正在连接实时更新…",
    },
  },
  /** 某个区块没加载出来：label 是区块里的那类数据（下面各区块的 failureLabel）。 */
  failure: (label: string, message: string) => `${label}没能加载：${message}`,
  retry: "重试",
  status: {
    title: "状态分布",
    total: (count: number) => `共 ${String(count)} 条需求`,
    failureLabel: "统计",
    empty: "这个项目还没有需求。",
    createFirst: "去新建第一条",
    /** 状态块的读屏名称。 */
    tile: (status: string, count: number) => `${status}：${String(count)} 条，查看这些需求`,
  },
  trend: {
    title: "流转趋势",
    summary: (days: number, count: number) => `近 ${String(days)} 天共 ${String(count)} 次状态变化`,
    rangeLabel: "时间范围",
    rangeOption: (days: number) => `${String(days)} 天`,
    failureLabel: "流转趋势",
    empty: "这段时间没有需求改过状态。",
    /** 图表的读屏替代表格。 */
    tableCaption: (days: number) => `近 ${String(days)} 天每天进入各状态的次数`,
    date: "日期",
    total: "合计",
    /** 表头与图例：进入某个状态。 */
    entered: (status: string) => `进入${status}`,
    other: "其他",
    /** 图表悬浮提示里的次数。 */
    times: (count: number) => `${String(count)} 次`,
  },
  stale: {
    title: "停滞需求",
    truncated: (total: number, shown: number) => `共 ${String(total)} 条，先列最要紧的 ${String(shown)} 条`,
    legacyRule: "需求服务的版本较旧，这里只列出它给出的停滞需求；升级后按各状态的节奏判断。",
    rule: (rhythm: string) => `按各状态的节奏：${rhythm}没有变化就列出来；停滞较久的在前。`,
    /** 节奏表的一项：「开发中 / 测试中 3 天」（状态名已用「 / 」连好）。 */
    rhythmItem: (statuses: string, days: number) => `${statuses} ${String(days)} 天`,
    rhythmSeparator: "、",
    failureLabel: "停滞需求",
    empty: "没有停滞的需求，都在各自的节奏里有进展。",
    lastUpdated: (name: string, when: string) => `最后由 ${name} 更新 · ${when}`,
    warning: "停滞较久",
    notice: "该推进了",
    idleDays: (days: number) => `${String(days)} 天没动`,
  },
  activity: {
    title: "最近动态",
    failureLabel: "最近动态",
    empty: "这个项目还没有动态。",
    showAll: (count: number) => `显示全部 ${String(count)} 条`,
    showLess: "收起",
  },
  /** 审计记录（类型 + 参数）渲染成接在人名后的整句。 */
  audit: {
    /** 写整句而不是「动作词 + 资源词」拼装（各语言语序不同）；契约新增动作时这里编译期报缺键。 */
    actions: {
      "project.created": "创建了项目",
      "project.updated": "更新了项目",
      "project.archived": "归档了项目",
      "project.restored": "恢复了项目",
      "requirement.created": "创建了需求",
      "requirement.updated": "更新了需求",
      "requirement.status_changed": "变更了需求状态",
      "comment.created": "发表了评论",
      "attachment.created": "上传了附件",
      "attachment.downloaded": "下载了附件",
      "attachment.deleted": "删除了附件",
      "artifact_version.published": "发布了产物版本",
    } satisfies Record<AuditAction, string>,
    /** 不认识的动作回落时用的资源名；不在表里的资源原样显示。 */
    resources: {
      project: "项目",
      requirement: "需求",
      comment: "评论",
      attachment: "附件",
    },
    unknown: (resource: string, action: string) => `对${resource}执行了 ${action}`,
    groups: {
      "project.created": records("创建了"),
      "project.updated": records("更新了"),
      "project.archived": records("归档了"),
      "project.restored": records("恢复了"),
      "requirement.created": records("创建了"),
      "requirement.updated": records("更新了"),
      "requirement.status_changed": records("变更了"),
      "comment.created": records("发表了"),
      "attachment.created": records("上传了"),
      "attachment.downloaded": records("下载了"),
      "attachment.deleted": records("删除了"),
      "artifact_version.published": records("发布了"),
    } satisfies Record<AuditAction, (count: number) => string>,
    groupFallback: records("处理了"),
    statusChanged: "状态已变更",
  },
};
