import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { qqbotPlugin } from "./src/channel.js";
import { buildQQBotReminderTools, type QQBotReminderToolContext } from "./src/reminder-tools.js";
import { setQQBotRuntime } from "./src/runtime.js";

const plugin = {
  id: "qqbot",
  name: "QQ Bot",
  description: "QQ Bot channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const pluginApi = api as OpenClawPluginApi & {
      registerTool: (tool: unknown, opts?: unknown) => void;
    };
    setQQBotRuntime(api.runtime);
    api.registerChannel({ plugin: qqbotPlugin });
    pluginApi.registerTool((ctx: QQBotReminderToolContext) => buildQQBotReminderTools(ctx));
  },
};

export default plugin;

export { qqbotPlugin } from "./src/channel.js";
export { setQQBotRuntime, getQQBotRuntime } from "./src/runtime.js";
export { qqbotOnboardingAdapter } from "./src/onboarding.js";
export * from "./src/types.js";
export * from "./src/api.js";
export * from "./src/config.js";
export * from "./src/gateway.js";
export * from "./src/outbound.js";
