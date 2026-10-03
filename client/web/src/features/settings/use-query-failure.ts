import type { UseQueryResult } from "@tanstack/react-query";
import { useEffect } from "react";
import { classifyFailure } from "../../feedback/classify.js";
import { reportFailure } from "../../feedback/report.js";
import type { Failure } from "../../feedback/types.js";

/**
 * 分组读取失败 → 在该区域显示错误（RegionError）；
 * 登录失效这类需要整页处理的失败照样交给反馈出口（去登录），不会被区域吞掉。
 */
export function useQueryFailure(query: Pick<UseQueryResult, "error" | "errorUpdatedAt" | "isError">): Failure | null {
  const { error, errorUpdatedAt, isError } = query;
  useEffect(() => {
    if (isError) reportFailure(error, { surface: "region" });
  }, [error, errorUpdatedAt, isError]);
  return isError ? classifyFailure(error) : null;
}
