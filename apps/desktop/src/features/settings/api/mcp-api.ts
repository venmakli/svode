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
  McpClientAttentionCode,
  McpClientStatus,
  McpArtifactStatus,
  McpDoctorReport,
  McpStatus,
} from "@/platform/mcp";
