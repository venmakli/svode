import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const [greeting, setGreeting] = useState("");

  async function testIpc() {
    const result = await invoke<string>("greet", { name: "CombAI" });
    setGreeting(result);
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: "2rem", fontWeight: 600 }}>CombAI</h1>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        AI Workspace Platform
      </p>
      <button
        onClick={testIpc}
        style={{
          padding: "8px 16px",
          borderRadius: "6px",
          border: "1px solid #ccc",
          cursor: "pointer",
        }}
      >
        Test IPC
      </button>
      {greeting && (
        <p style={{ marginTop: "1rem", color: "#22c55e" }}>{greeting}</p>
      )}
    </div>
  );
}
