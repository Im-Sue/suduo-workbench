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

export const en = { common, sessions, setup, shell, timeline, feedback, settings, settingsConnection, settingsAgent } satisfies Messages;
