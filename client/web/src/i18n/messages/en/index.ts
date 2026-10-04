import type { Messages } from "../zh-CN/index.js";
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

export const en = { common, sessions, setup, shell, timeline, feedback, settings, settingsConnection, settingsAgent, requirements, requirementDetail, myWork, overview, rooms, conversation, workbench } satisfies Messages;
