export interface SkillProjectOption {
  localProjectId: string;
  localProjectName: string;
  remoteProjectId: string;
}

/** 同一台本机项目若映射到多个远程项目，catalog 仍只需查询一次。 */
export function skillProjectOptions(
  mappings: readonly SkillProjectOption[],
): SkillProjectOption[] {
  const seen = new Set<string>();
  return mappings.filter((mapping) => {
    if (seen.has(mapping.localProjectId)) return false;
    seen.add(mapping.localProjectId);
    return true;
  });
}

/** 仅一个本机项目时免打扰自动选择；多个时不擅自把任一项目当作当前上下文。 */
export function defaultSkillProjectId(
  projects: readonly SkillProjectOption[],
): string | null {
  return projects.length === 1 ? (projects[0]?.localProjectId ?? null) : null;
}
