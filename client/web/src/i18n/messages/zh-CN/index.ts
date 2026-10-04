import { common } from "./common.js";
import { sessions } from "./sessions.js";
import { setup } from "./setup.js";
import { shell } from "./shell.js";
import { timeline } from "./timeline.js";
import { feedback } from "./feedback.js";
import { settings } from "./settings.js";
import { settingsConnection } from "./settingsConnection.js";
import { settingsAgent } from "./settingsAgent.js";
import { requirements } from "./requirements.js";
import { requirementDetail } from "./requirementDetail.js";
import { myWork } from "./myWork.js";
import { overview } from "./overview.js";
import { rooms } from "./rooms.js";
import { conversation } from "./conversation.js";
import { workbench } from "./workbench.js";

/**
 * 前端的中文字典，也是英文字典必须对齐的样板（中英双语技术设计 §4.2）：
 * 英文各分区用 `satisfies Messages["分区"]` 约束，少键、多键、参数不一致都是类型错误。
 */
export const zhCN = { common, sessions, setup, shell, timeline, feedback, settings, settingsConnection, settingsAgent, requirements, requirementDetail, myWork, overview, rooms, conversation, workbench };

export type Messages = typeof zhCN;
