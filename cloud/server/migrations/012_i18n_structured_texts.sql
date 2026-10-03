-- 中英双语（技术设计 §4.3）：会留存、会被别人看到的系统文字存「类型 + 参数」，各人前端按自己的语言渲染；
-- body 仍是必填，继续存一句兜底文字，老客户端照常显示。
ALTER TABLE requirement_comments
  ADD COLUMN system_kind varchar(32) NULL,
  ADD COLUMN system_params jsonb NULL;

-- 回填：发布确认版时没写说明、由系统代写的评论。判据与之前活动流的做法完全一致——
-- 评论挂在该版本上，且正文逐字等于当时的系统句式（版本号与文件数都要对上）。
UPDATE requirement_comments c
SET system_kind = 'artifact_published',
    system_params = jsonb_build_object('versionNumber', v.version_number, 'fileCount', f.file_count)
FROM requirement_artifact_versions v
CROSS JOIN LATERAL (
  SELECT count(*)::integer AS file_count
  FROM requirement_artifact_version_files file
  WHERE file.version_id = v.id
) f
WHERE c.artifact_version_id = v.id
  AND c.body = '发布了产物 v' || v.version_number::text || '，含 ' || f.file_count::text || ' 个文件。';
