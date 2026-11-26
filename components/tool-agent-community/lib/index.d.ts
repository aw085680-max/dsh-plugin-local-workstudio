import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
declare const name = "plugin-tool-agent-community";
declare const inject: readonly ["agents", "agentCommunity", "tools"];
interface Config {
  readonly maxListResults?: number;
}
declare const Config: z<Config>;
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { Config, apply, inject, name };