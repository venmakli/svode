import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";

if (process.env.SVODE_SPACE_CONFIG_ALERT_DOM !== "1") {
  test("space config warning DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_SPACE_CONFIG_ALERT_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const dom = await createTestDom();
  const doc = dom.document;
  const m = await import("@/paraglide/messages.js");
  const { clearNativeMocks, mockNativeIpc } =
    await import("@/platform/native/testing");
  const { useSpaceStore } = await import("../model/space-store");
  const { SpaceConfigAlert } = await import("./space-config-alert");
  const { registerSpaceConfigResolver } =
    await import("../model/space-config-resolver");
  const { SpaceConfigRecheck } = await import("./space-config-recheck");
  type SpaceInfo = import("../model/types").SpaceInfo;
  const initialState = useSpaceStore.getState();

  const space = (id: string, path: string, extra: Partial<SpaceInfo> = {}) =>
    ({
      id,
      name: id,
      icon: "",
      description: "",
      path,
      hasSpaces: false,
      hasSchema: false,
      lastOpened: null,
      status: "ready",
      lfsState: "n/a",
      ...extra,
    }) satisfies SpaceInfo;
  const buttons = () =>
    [...doc.querySelectorAll("button")].map((button) => button.textContent);
  const click = async (label: string) => {
    const button = [...doc.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    );
    if (!button) throw new Error(`no button ${label}`);
    await act(async () => button.click());
  };

  test("a conflict offers Resolve and Check again; other reasons only Check again", async () => {
    const resolved: string[] = [];
    let rechecked = 0;
    useSpaceStore.setState({
      recheckSpaceConfigs: async () => {
        rechecked += 1;
      },
    });
    const unregister = registerSpaceConfigResolver((target) =>
      resolved.push(target.path),
    );
    const project = space("root", "/project", {
      configUnreadable: { kind: "conflict" },
    });

    await dom.render(<SpaceConfigAlert space={project} owner="project" />);
    const text = doc.body.textContent ?? "";
    expect(text.includes(m.space_config_unreadable_project_title())).toBe(true);
    expect(
      text.includes(
        m.space_config_unreadable_conflict({
          file: m.space_config_file_project(),
        }),
      ),
    ).toBe(true);
    expect(text.includes("/project")).toBe(false);
    expect(buttons()).toEqual([
      m.space_config_unreadable_resolve(),
      m.space_config_unreadable_recheck(),
    ]);
    await click(m.space_config_unreadable_resolve());
    await click(m.space_config_unreadable_recheck());
    expect(resolved).toEqual(["/project"]);
    expect(rechecked).toBe(1);

    await dom.render(
      <SpaceConfigAlert
        space={space("docs", "/project/docs", {
          configUnreadable: { kind: "field", field: "assets" },
        })}
        owner="space"
      />,
    );
    const fieldText = doc.body.textContent ?? "";
    expect(
      fieldText.includes(
        m.space_config_unreadable_field({
          file: m.space_config_file_space(),
          field: "assets",
        }),
      ),
    ).toBe(true);
    expect(fieldText.includes(m.space_config_unreadable_space_title())).toBe(
      true,
    );
    expect(buttons()).toEqual([m.space_config_unreadable_recheck()]);

    unregister();
    await dom.render(<SpaceConfigAlert space={project} owner="project" />);
    expect(buttons()).toEqual([m.space_config_unreadable_recheck()]);

    await dom.render(
      <SpaceConfigAlert space={space("root", "/project")} owner="project" />,
    );
    expect(doc.body.textContent).toBe("");
  });

  test("a project whose config reads again shows its name and spaces without reopening", async () => {
    useSpaceStore.setState(initialState, true);
    const listed: SpaceInfo[] = [
      space("root", "/project", { configUnreadable: { kind: "conflict" } }),
    ];
    const children = [space("docs", "/project/docs")];
    let spaceLists = 0;
    mockNativeIpc((command) => {
      if (command === "list_projects") return listed;
      if (command === "list_spaces") {
        spaceLists += 1;
        return children;
      }
      if (command === "mcp_set_active_context") return null;
      throw new Error(`unexpected ${command}`);
    });
    useSpaceStore.setState({
      activeRootId: "root",
      activeRootName: "project",
      activeRootIcon: "",
      activeRootPath: "/project",
      rootSpaces: listed,
      spaces: [],
    });

    await useSpaceStore.getState().recheckSpaceConfigs();
    expect(useSpaceStore.getState().spaces).toEqual([]);
    expect(spaceLists).toBe(0);

    listed[0] = space("root", "/project", { name: "Project", icon: "P" });
    await useSpaceStore.getState().recheckSpaceConfigs();
    const state = useSpaceStore.getState();
    expect(state.activeRootName).toBe("Project");
    expect(state.activeRootIcon).toBe("P");
    expect(state.rootSpaces[0]?.configUnreadable).toBe(undefined);
    expect(state.spaces).toEqual(children);
    clearNativeMocks();
  });

  test("window focus reads an unreadable config again, a readable one is left alone", async () => {
    useSpaceStore.setState(initialState, true);
    let rechecked = 0;
    useSpaceStore.setState({
      activeRootId: "root",
      activeRootPath: "/project",
      rootSpaces: [space("root", "/project")],
      spaces: [
        space("docs", "/project/docs", {
          configUnreadable: { kind: "notJson" },
        }),
      ],
      recheckSpaceConfigs: async () => {
        rechecked += 1;
      },
    });
    await dom.render(<SpaceConfigRecheck />);
    await act(async () => window.dispatchEvent(new window.Event("focus")));
    expect(rechecked).toBe(1);

    await act(async () =>
      useSpaceStore.setState({ spaces: [space("docs", "/project/docs")] }),
    );
    await act(async () => window.dispatchEvent(new window.Event("focus")));
    expect(rechecked).toBe(1);
    await dom.dispose();
  });
}
