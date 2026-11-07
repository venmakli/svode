import { expect, test } from "bun:test";
import { act } from "react";
import type { SpaceInfoDto } from "@/platform/space/space-types";

const project = (id: string, name: string): SpaceInfoDto => ({
  id,
  name,
  icon: "",
  description: "",
  path: `/projects/${id}`,
  hasSpaces: false,
  hasSchema: false,
  lastOpened: null,
  status: "ready",
  lfsState: "n/a",
});

/**
 * Another process registers a project and later the list loses one: Home
 * shows the projects of the list after each change without an action of
 * the user, and a list that cannot be read keeps the shown projects.
 */
test("Home follows the project list of the device on disk", async () => {
  const { createTestDom } = await import("@/shared/testing/dom");
  const { clearNativeMocks, mockNativeIpc } =
    await import("@/platform/native/testing");
  const { emit } = await import("@/platform/native/events");
  const dom = await createTestDom();
  let listed: SpaceInfoDto[] | null = [project("a", "Alpha")];
  const warn = console.warn;
  console.warn = () => {};
  let reads = 0;
  mockNativeIpc(
    async (command) => {
      if (command === "list_projects") {
        reads += 1;
        if (!listed) throw new Error("The project list cannot be read");
        return listed;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const { useSpace } = await import("../model/public-space");
  const { useSpaceStore } = await import("../model/space-store");
  const { RootSpacesFollower } = await import("./root-spaces-follower");
  useSpaceStore.setState({ rootSpaces: [project("a", "Alpha")] });

  function HomeProjects() {
    const projects = useSpace((state) => state.rootSpaces);
    return (
      <ul>
        {projects.map((item) => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    );
  }
  const shown = () =>
    [...dom.document.querySelectorAll("li")].map((item) => item.textContent);
  const change = async () => {
    await act(async () => {
      await emit("projects:changed");
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };

  try {
    await dom.render(
      <>
        <RootSpacesFollower />
        <HomeProjects />
      </>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(shown()).toEqual(["Alpha"]);
    expect(reads).toBe(0);

    listed = [project("a", "Alpha"), project("b", "Created by CLI")];
    await change();
    expect(shown()).toEqual(["Alpha", "Created by CLI"]);

    listed = null;
    await change();
    expect(shown()).toEqual(["Alpha", "Created by CLI"]);

    listed = [project("b", "Created by CLI")];
    await change();
    expect(shown()).toEqual(["Created by CLI"]);
    expect(reads).toBe(3);
  } finally {
    await dom.render(null);
    clearNativeMocks();
    await dom.dispose();
    console.warn = warn;
  }
});
