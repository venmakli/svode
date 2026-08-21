export {
  getMcpStatus,
  installMcpClient,
  listenMcpStatusChanged,
  printMcpConfig,
  removeMcpClient,
  runMcpDoctor,
} from "@/platform/mcp";
export type {
  McpClientId,
  McpClientStatus,
  McpDoctorReport,
  McpManualConfig,
  McpStatus,
} from "@/platform/mcp";
