import { expect, test } from "vitest";
import {
  baselineEntries,
  compareTestIdEntries,
  readBaseline,
  scanTestIdSource,
  scanWorkspace,
} from "./testid-baseline.js";

test("only static data-testid attributes become baseline entries", () => {
  const scan = scanTestIdSource(
    "fixture.tsx",
    [
      "const id = 'row';",
      "export const Fixture = () => (",
      "  <>",
      '    <div data-testid="static-id" />',
      "    <div data-testid={id} />",
      "    <div data-testid={`row-${id}`} />",
      "  </>",
      ");",
    ].join("\n"),
  );

  expect(scan.staticEntries).toEqual([{ file: "fixture.tsx", id: "static-id" }]);
  expect(scan.dynamicEntries).toHaveLength(2);
});

test("the repository's dynamic data-testid attributes do not create baseline drift", () => {
  const scan = scanWorkspace();
  const comparison = compareTestIdEntries(baselineEntries(readBaseline()), scan.staticEntries);

  // 12 -> 17：合并 suduo-v2-overview-and-my-workbench-001 后新增 5 处动态 testid
  // （MyWorkbenchMode 的 workbench-action/requirement/session-${id} 四处、
  // OverviewTimeline 的 overview-audit-${action} 一处），均为带运行时 ID 的模板串，
  // 属应排除项。改动此数字前必须逐处确认新增项确实是动态而非笔误。
  // 17 -> 13：UI/UX 重设计 P2 删除旧需求看板与详情，随之移除 4 处动态 testid
  // （board-column-${status}、board-count-${status}、board-load-more-${status}、
  // 评论条目的 comment-item / artifact-published-comment 三元式）；新看板改用
  // data-status-column / data-requirement-id 属性定位，不新增动态 testid。
  // 13 -> 12：UI/UX 重设计 P4 重做「我的工作」，旧页 4 处动态 testid（workbench-action-invalid_mapping-${id}、
  // workbench-action-${kind}-${id}、workbench-requirement-${id}、workbench-session-${id}）换成新页 3 处：
  // 「需要你处理」各行共用一个 data-testid={props.testId}（仍为 workbench-action-<种类>-<id>），
  // 需求行与会话卡各一处模板串；区块级 testid 改为在调用处写死，成为静态项。
  // 12 -> 9：UI/UX 重设计 P4 重做设置页，旧设置页 6 处动态 testid（settings-nav-${id}、
  // settings-approval-${mode}、settings-group-${id}、状态条 status-item-${key} 两处、
  // mcp-transport-${type}）换成 3 处（settings-nav-${id}、settings-group-${id}、
  // settings-approval-${mode}）；状态条并入诊断页，连接方式改用分段控件。
  // 9 -> 13：多 Agent S5 新增 4 处动态 testid，均为带运行时值的写法：审批坞更多菜单按卡上的选项出项
  // （CHOICE_TEST_ID[choice.decision]，取值仍是 approval-accept-session / approval-cancel 等固定名）、
  // 开工选项里每家 Agent 一项（start-agent-${id}）、AI Agent 设置里每家一行与「设为默认」
  // （agent-row-${id}、agent-set-default-${id}）。
  // 13 -> 14：多 Agent S6「共享本机的其他 Agent」菜单每家一项（share-another-${id}）；「我的 Agent」每家一行
  // 仍用静态的 my-agent-switch，按行上的 data-agent-kind 区分。
  expect(scan.dynamicEntries).toHaveLength(14);
  expect(comparison.missingFromSource).toEqual([]);
  expect(comparison.missingFromBaseline).toEqual([]);
});
