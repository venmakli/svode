import { expect, test } from "bun:test";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { resolvePeekOwner } from "./peek-owner";

const context = {
  spaceId: "other",
  spacePath: "/other-repository",
  projectPath: "/project",
};

testWithWindow(
  "canonical facts separate Collection membership from direct owner capabilities",
  async () => {
    for (const form of ["leaf", "folder", "nestedCollection"]) {
      for (const hasApp of [false, true]) {
        const requests: string[] = [];
        mockNativeIpc((command, args) => {
          if (command === "get_entry_detail_state")
            return { form, subpageCount: 0, otherFileCount: 0 };
          if (command === "path_exists") {
            const path = String(args && "path" in args ? args.path : "");
            requests.push(path);
            return path.endsWith("schema.yaml")
              ? form === "nestedCollection"
              : hasApp;
          }
          throw new Error(`Unexpected command: ${command}`);
        });
        const owner = await resolvePeekOwner({
          ...context,
          path: form === "leaf" ? "Tasks/Member.md" : "Tasks/Member/README.md",
        });
        expect(owner.spacePath).toBe(context.spacePath);
        expect(owner.capabilities).toEqual(
          form === "leaf"
            ? []
            : [
                ...(form === "nestedCollection" ? ["collection"] : []),
                ...(hasApp ? ["app"] : []),
              ],
        );
        expect(
          requests.every((path) =>
            path.startsWith("/other-repository/Tasks/Member/"),
          ),
        ).toBe(true);
      }
    }
  },
);

testWithWindow(
  "failed facts reject instead of publishing a reduced owner; retry can restore capabilities",
  async () => {
    let fail = true;
    mockNativeIpc((command) => {
      if (fail) throw new Error("facts unavailable");
      if (command === "get_entry_detail_state") return { form: "folder" };
      return true;
    });
    let message = "";
    try {
      await resolvePeekOwner({ ...context, path: "Tool/README.md" });
    } catch (error) {
      message = String(error);
    }
    expect(message.includes("facts unavailable")).toBe(true);
    fail = false;
    expect(
      (await resolvePeekOwner({ ...context, path: "Tool/README.md" }))
        .capabilities,
    ).toEqual(["collection", "app"]);
  },
);

testWithWindow(
  "App-only and schema-only owners preserve missing README and invalid marker presence",
  async () => {
    for (const schema of [false, true]) {
      mockNativeIpc((command, args) => {
        if (command !== "path_exists")
          throw new Error("must not read or create a missing README");
        const path = String(args && "path" in args ? args.path : "");
        return path.endsWith("schema.yaml")
          ? schema
          : path.endsWith("app.yaml");
      });
      const owner = await resolvePeekOwner({
        ...context,
        path: "Tool",
        directory: true,
      });
      expect(owner.identityKind).toBe(
        schema ? "collection-directory" : "app-directory",
      );
      expect(owner.readmePath).toBe("Tool/README.md");
    }
  },
);

function testWithWindow(name: string, run: () => Promise<void>) {
  test(name, async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      value: {},
      configurable: true,
    });
    try {
      await run();
    } finally {
      clearNativeMocks();
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
}
