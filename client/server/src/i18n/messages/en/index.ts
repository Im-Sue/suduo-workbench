import type { ServerMessages } from "../zh-CN/index.js";
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

export const en = { common, checkpoint, session, activity, remote, workspace, config, doctor, http, room, toolText, prompt, toolSpec, roomPrompt, toolReply, cli } satisfies ServerMessages;
