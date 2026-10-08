import { expect, test } from "bun:test";
import {
  isDrivePath,
  isNetworkPath,
  pathKey,
  withoutVerbatimPrefix,
} from "./local-paths";

test("two leading separators name a network share or a device, except a verbatim drive", () => {
  for (const path of [
    "\\\\server\\share\\a.png",
    "//server/share/a.png",
    "/\\server\\share",
    "\\\\?\\UNC\\server\\share",
    "\\\\.\\pipe\\name",
  ]) {
    expect(isNetworkPath(path)).toBe(true);
  }
  for (const path of [
    "\\\\?\\C:\\Users\\me",
    "C:\\Users\\me",
    "/Users/me",
    "\\Users\\me",
    "relative",
  ]) {
    expect(isNetworkPath(path)).toBe(false);
  }
});

test("a Windows drive path compares by case and separator as Windows does", () => {
  expect(isDrivePath("C:/a")).toBe(true);
  expect(isDrivePath("C:a")).toBe(false);
  expect(withoutVerbatimPrefix("\\\\?\\C:\\a")).toBe("C:\\a");
  expect(withoutVerbatimPrefix("\\\\?\\UNC\\s\\a")).toBe("\\\\?\\UNC\\s\\a");
  expect(pathKey("\\\\?\\C:\\Users\\Me")).toBe(pathKey("c:/users/me"));
  expect(pathKey("/Users/Me") === pathKey("/users/me")).toBe(false);
});
