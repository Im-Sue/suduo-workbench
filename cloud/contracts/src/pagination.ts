export interface RequirementsCursorQuery {
  cursor?: string;
  limit?: number;
}

export interface RequirementsCursorPage<T> {
  items: T[];
  nextCursor: string | null;
}
