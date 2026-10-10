import type { FastifyInstance } from "fastify";
import type { ReviewDto } from "@suduo/client-contracts";
import type { ReviewService } from "../../../application/collab/review-service.js";
import { ApiError } from "../../../application/api-error.js";

export interface ReviewsRouteDependencies {
  /** 交叉评审（多 Agent 协作 S9）；optional 保持旧 HTTP 测试工厂兼容。 */
  reviews?: ReviewService;
}

/**
 * 交叉评审（需求 4.4）：在会话头请另一个 Agent 评审、被评会话里的评审卡片（停止、把选中的意见交回原 Agent 修改）。
 * 发布到需求随 S11 云端共享对象一起做。
 */
export function registerReviewsRoutes(server: FastifyInstance, dependencies: ReviewsRouteDependencies): void {
  const reviews = dependencies.reviews;
  if (!reviews) {
    return;
  }
  server.get<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/reviews", async (request) => ({
    items: reviews.listByTarget(request.params.sessionId),
  }));
  server.post<{ Params: { sessionId: string }; Body: { agentId?: unknown; focus?: unknown; note?: unknown } }>(
    "/api/v1/sessions/:sessionId/reviews",
    async (request, reply): Promise<ReviewDto> => {
      const body = request.body ?? {};
      if (typeof body.agentId !== "string" || body.agentId.trim() === "") {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.http.reviewAgentMissing);
      }
      const focus = Array.isArray(body.focus) ? body.focus.filter((item): item is string => typeof item === "string") : undefined;
      const review = await reviews.start({
        targetSessionId: request.params.sessionId,
        agentId: body.agentId.trim(),
        ...(focus === undefined ? {} : { focus }),
        note: typeof body.note === "string" ? body.note : null,
        origin: "user",
      });
      return reply.code(201).send(review);
    },
  );
  server.post<{ Params: { reviewId: string }; Body: { findingIds?: unknown } }>("/api/v1/reviews/:reviewId/apply", async (request) => {
    const ids = request.body?.findingIds;
    const findingIds = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
    if (findingIds.length === 0) throw new ApiError(400, "VALIDATION_ERROR", (t) => t.http.reviewFindingsRequired);
    return reviews.apply(request.params.reviewId, findingIds);
  });
  server.post<{ Params: { reviewId: string } }>("/api/v1/reviews/:reviewId/cancel", async (request) => reviews.cancel(request.params.reviewId));
}
