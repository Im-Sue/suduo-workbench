import type { DailyRequirementTransitionDto, RequirementStatus } from "@suduo/cloud-contracts";
import { REQUIREMENT_STATUSES, REQUIREMENT_STATUS_LABELS } from "@suduo/cloud-contracts";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/**
 * 流转趋势（需求 §4.6）：近 7 / 30 天每天进入各状态的次数，堆叠柱，带坐标轴与日期。
 * 颜色取状态令牌（与状态图标同色），亮暗主题自动跟随。Recharts 较大，本模块按需懒加载。
 */
const STATUS_COLOR: Record<RequirementStatus, string> = {
  draft: "var(--status-draft)",
  in_refinement: "var(--status-refine)",
  ready_for_development: "var(--status-todo)",
  in_development: "var(--status-dev)",
  in_testing: "var(--status-test)",
  completed: "var(--status-done)",
  on_hold: "var(--status-hold)",
};

export default function TransitionChart({ transitions }: { transitions: readonly DailyRequirementTransitionDto[] }) {
  const data = transitions.map((day) => ({
    date: day.date.slice(5).replace("-", "/"),
    fullDate: day.date,
    other: Math.max(0, day.count - Object.values(day.byStatus ?? {}).reduce((sum, count) => sum + (count ?? 0), 0)),
    ...day.byStatus,
  }));
  const present = REQUIREMENT_STATUSES.filter((status) => transitions.some((day) => (day.byStatus?.[status] ?? 0) > 0));
  const hasOther = data.some((day) => day.other > 0);
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="date" tickLine={false} axisLine={{ stroke: "var(--border)" }} tick={{ fill: "var(--subtle-foreground)", fontSize: 12 }} interval="preserveStartEnd" />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: "var(--subtle-foreground)", fontSize: 12 }} width={40} />
        <Tooltip
          cursor={{ fill: "var(--muted)" }}
          contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--foreground)" }}
          labelFormatter={(_, payload) => String(payload?.[0]?.payload?.fullDate ?? "")}
          itemSorter={(item) => {
            const index = (REQUIREMENT_STATUSES as readonly unknown[]).indexOf(item.dataKey);
            return index === -1 ? REQUIREMENT_STATUSES.length : index;
          }}
          formatter={(value, name) => [`${String(value)} 次`, name]}
        />
        {/* 图例按流程顺序（与柱子堆叠顺序一致），文字用正文色，色块只在圆点上。 */}
        <Legend
          iconType="circle"
          iconSize={8}
          itemSorter={null}
          wrapperStyle={{ fontSize: 12 }}
          formatter={(value) => <span style={{ color: "var(--muted-foreground)" }}>{String(value)}</span>}
        />
        {present.map((status) => (
          <Bar key={status} dataKey={status} name={`进入${REQUIREMENT_STATUS_LABELS[status]}`} stackId="flow" fill={STATUS_COLOR[status]} maxBarSize={28} />
        ))}
        {hasOther ? <Bar dataKey="other" name="其他" stackId="flow" fill="var(--subtle-foreground)" maxBarSize={28} /> : null}
      </BarChart>
    </ResponsiveContainer>
  );
}
