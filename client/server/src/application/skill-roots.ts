/** skills 根目录动态提供者：设置（全局开关）变化时无须重启即可生效。 */
export interface SkillRootsProvider {
  roots(): string[];
}
