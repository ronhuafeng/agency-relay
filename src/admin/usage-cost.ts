import { executionPlanPresentation } from "../plans/execution-plans";
import type { UsageSummaryTotals, MediaUsageSummaryTotals } from "../types";

/** Keep reported amounts and API valuation distinct in all Usage views. */
export function usageCost(plan: string, row: UsageSummaryTotals | MediaUsageSummaryTotals) {
  switch (executionPlanPresentation(plan).costBasis) {
    case "openai_standard":
      return "api_equivalent_usd_ticks" in row ? {
        label: "API 费率折算", ticks: row.api_equivalent_usd_ticks,
        measurements: row.api_equivalent_measurements,
        help: "OpenAI Standard · 仅令牌；不是订阅实付金额。缺少计价字段的请求未计入。"
      } : null;
    case "provider_reported":
      return { label: "上游计量金额", ticks: row.provider_cost_usd_ticks,
        measurements: row.cost_measurements,
        help: "上游返回的暂定美元金额；含已计量的工具费用，不是结算账单。" };
    case "none": return null;
  }
}
