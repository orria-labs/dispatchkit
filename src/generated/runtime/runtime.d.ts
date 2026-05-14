/* eslint-disable */
import type { LoggerLike, RuntimeDefaultConfig } from "../../types.ts";
import type { GeneratedBus, GeneratedInfra, GeneratedTransport } from "./bus.d.ts";

export type GeneratedConfig = RuntimeDefaultConfig;

export interface RuntimeContext {
  config: GeneratedConfig;
  logger: LoggerLike;
  infra: GeneratedInfra;
  bus: GeneratedBus;
  transport: GeneratedTransport;
}
