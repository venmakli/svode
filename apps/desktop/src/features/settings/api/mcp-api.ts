export {
  getMcpStatus,
  installMcpClient,
  listenMcpStatusChanged,
  removeMcpClient,
  removeMcpSharedSkill,
  runMcpDoctor,
} from "@/platform/mcp";
export type {
  McpClientId,
  McpClientAttentionCode,
  McpClientStatus,
  McpArtifactStatus,
  McpDoctorReport,
  McpManualConfig,
  McpSharedSkillStatus,
  McpStatus,
} from "@/platform/mcp";
