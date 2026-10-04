import { common } from "./common.js";
import { checkpoint } from "./checkpoint.js";
import { session } from "./session.js";
import { activity } from "./activity.js";
import { remote } from "./remote.js";
import { workspace } from "./workspace.js";
import { config } from "./config.js";
import { doctor } from "./doctor.js";
import { http } from "./http.js";
import { room } from "./room.js";
import { toolText } from "./toolText.js";
import { prompt } from "./prompt.js";
import { toolSpec } from "./toolSpec.js";
import { roomPrompt } from "./roomPrompt.js";
import { toolReply } from "./toolReply.js";
import { cli } from "./cli.js";

/**
 * 本机服务的中文字典，也是英文字典必须对齐的样板（中英双语技术设计 §4.2）。
 * 按功能区分文件；英文各分区用 `satisfies ServerMessages["分区"]` 约束，少键、多键、参数不一致都是类型错误。
 */
export const zhCN = { common, checkpoint, session, activity, remote, workspace, config, doctor, http, room, toolText, prompt, toolSpec, roomPrompt, toolReply, cli };

export type ServerMessages = typeof zhCN;
