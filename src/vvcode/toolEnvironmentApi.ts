import { invoke } from "@tauri-apps/api/core";

export interface ToolCommandRepairResult {
  launcher_path: string;
  installation_path: string;
  changed: boolean;
}

export const toolEnvironmentApi = {
  async repairCommand(tool: string): Promise<ToolCommandRepairResult> {
    return await invoke("vvcode_repair_tool_command", { tool });
  },
};
